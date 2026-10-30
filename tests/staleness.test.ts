import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computeStaleness,
  LARGE_DOC_BYTES,
  largeDocNote,
  parseMergeLog,
  prNumbersInText,
  stalenessAttention,
  stalenessChipLabel,
  stalenessLine,
  type StalenessInput,
} from "../src/core/staleness";
import { clearStalenessCaches, collectStaleness, readMergeLog } from "../src/core/stalenessSources";
import { createCard, initializeProject, loadState } from "../src/core/storage";
import { committedRoadmap, createEmptyRoadmap, planCreateCard, planMoveCard, planUpdateCard } from "../src/core/boardOperations";
import { githubMerges, githubRepoFromRemote } from "../src/core/githubMerges";
import type { PlanbanRoadmapItem } from "../src/core/types";
import { planbanStalenessLine } from "../plugins/planban/scripts/claude-session-context.mjs";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function item(overrides: Partial<PlanbanRoadmapItem> & { id: string }): PlanbanRoadmapItem {
  return {
    title: overrides.id,
    status: "in-progress",
    priority: null,
    summary: null,
    nextAction: null,
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: null,
    planDoc: null,
    completedAt: null,
    updatedAt: iso(NOW - DAY),
    isGroup: false,
    parentId: null,
    boardRank: null,
    groupRank: null,
    ...overrides,
  };
}

function compute(input: Partial<StalenessInput> & { items: PlanbanRoadmapItem[] }) {
  return computeStaleness({ history: [], docMtimes: [], merges: [], now: NOW, ...input });
}

test("PR references are read from common phrasings", () => {
  assert.deepEqual(prNumbersInText("Merged (PR #259, merge commit 04499372d)."), [259]);
  assert.deepEqual(prNumbersInText("Merge PR 267 into the branch").sort(), [267]);
  assert.deepEqual(prNumbersInText("built in https://github.com/o/r/pull/267, into main"), [267]);
  assert.deepEqual(prNumbersInText("PRs #337/#338 and launch PRs 386–388").sort(), [337, 338, 386, 387, 388]);
  assert.deepEqual(prNumbersInText("Draft order #D4, colour &#123; and no numbers"), []);
});

test("merge log parsing keeps the earliest merge of each PR, from merge and squash subjects", () => {
  const merges = parseMergeLog([
    "2026-09-30T13:50:05+01:00\tMerge pull request #379 from o/branch",
    "2026-09-27T20:28:35+01:00\tperf(ci): preflight frozen references (#380)",
    "2026-09-28T09:00:00+01:00\tperf(ci): preflight frozen references (#380)",
    "2026-09-27T20:00:00+01:00\tfix: mention #12 mid-subject",
    "not a log line",
  ].join("\n"));
  assert.deepEqual(merges.sort((a, b) => a.pr - b.pr), [
    { pr: 379, mergedAt: "2026-09-30T12:50:05.000Z" },
    { pr: 380, mergedAt: "2026-09-27T19:28:35.000Z" },
  ]);
});

test("merged: a referenced PR that merged after the card's last update", () => {
  const updatedAt = NOW - 2 * DAY;
  const result = compute({
    items: [
      item({ id: "stale", updatedAt: iso(updatedAt), nextAction: "Merge PR 267, then deploy the preview." }),
      item({ id: "current", updatedAt: iso(updatedAt), summary: "Merged in #100." }),
      item({ id: "via-metadata", updatedAt: iso(updatedAt), metadata: { prs: [301, "#302"] } }),
      item({ id: "done", status: "complete", updatedAt: iso(updatedAt), summary: "PR 267" }),
    ],
    merges: [
      { pr: 267, mergedAt: iso(updatedAt + 2 * 60 * 1000) },
      { pr: 100, mergedAt: iso(updatedAt - 60 * 1000) },
      { pr: 302, mergedAt: iso(updatedAt + DAY) },
    ],
  });
  assert.deepEqual(result.cards.stale, [{ kind: "merged", detail: "#267 merged 29 Sep", since: iso(updatedAt + 2 * 60 * 1000) }]);
  assert.equal(result.cards.current, undefined, "a PR merged before the update is already reflected");
  assert.equal(result.cards["via-metadata"]?.[0]?.detail, "#302 merged 30 Sep");
  assert.equal(result.cards.done, undefined, "only active cards get signals");
});

test("merged: only PRs merged after the card first appears in history count", () => {
  const result = compute({
    items: [item({ id: "late-card", updatedAt: null, summary: "Follows on from #50." })],
    history: [{ createdAt: iso(NOW - DAY), affectedCards: ["late-card"], affectedDocs: [] }],
    merges: [{ pr: 50, mergedAt: iso(NOW - 3 * DAY) }],
  });
  assert.equal(result.cards["late-card"], undefined);
});

test("merged: only a change to the summary or next action, or completing the card, settles a merge", () => {
  let clock = NOW - 3 * DAY;
  const at = () => new Date(clock).toISOString();
  const step = (plan: (roadmap: ReturnType<typeof createEmptyRoadmap>) => { roadmap: ReturnType<typeof createEmptyRoadmap> }) => {
    clock += 60 * 60 * 1000;
    board = committedRoadmap(plan(board).roadmap, at());
  };
  let board = createEmptyRoadmap({ repoId: "r", title: "R", now: at() });
  step((roadmap) => planCreateCard(roadmap, { title: "Ship", status: "in-progress", nextAction: "Merge PR 41." }, { now: at() }));
  const merge = { pr: 41, mergedAt: iso(clock + 30 * 60 * 1000) };
  const signals = () => compute({ items: board.roadmapItems, merges: [merge] }).cards.ship?.map((signal) => signal.kind) ?? [];
  step((roadmap) => ({ roadmap }));
  assert.deepEqual(signals(), ["merged"]);

  // A metadata-only update and a no-op update are touches: the merge stays flagged.
  step((roadmap) => planUpdateCard(roadmap, { cardId: "ship", metadata: { thread: "t1" } }, { now: at() }));
  assert.deepEqual(signals(), ["merged"], "a metadata edit doesn't settle the merge");
  const before = board.roadmapItems[0]!.updatedAt;
  step((roadmap) => planUpdateCard(roadmap, { cardId: "ship", nextAction: "Merge PR 41." }, { now: at() }));
  assert.equal(board.roadmapItems[0]!.updatedAt, before, "an update that changes nothing isn't activity");
  assert.deepEqual(signals(), ["merged"]);

  // Changing the next action settles it.
  step((roadmap) => planUpdateCard(roadmap, { cardId: "ship", nextAction: "Deploy what PR 41 merged." }, { now: at() }));
  assert.deepEqual(signals(), []);

  // Completing settles a later merge, and moving back doesn't bring it back.
  step((roadmap) => planUpdateCard(roadmap, { cardId: "ship", summary: "Follow-up in PR 42." }, { now: at() }));
  const later = { pr: 42, mergedAt: iso(clock + 30 * 60 * 1000) };
  step((roadmap) => ({ roadmap }));
  assert.deepEqual(compute({ items: board.roadmapItems, merges: [later] }).cards.ship?.map((signal) => signal.kind), ["merged"]);
  step((roadmap) => planMoveCard(roadmap, { cardId: "ship", status: "complete" }, { now: at() }));
  step((roadmap) => planMoveCard(roadmap, { cardId: "ship", status: "in-progress" }, { now: at() }));
  assert.equal(compute({ items: board.roadmapItems, merges: [later] }).cards.ship, undefined);
});

test("merged: a card written before progressNotedAt keeps its last update as the floor when touched", () => {
  const old = item({ id: "legacy", nextAction: "Merge PR 7.", updatedAt: iso(NOW - 3 * DAY) });
  const board = { ...createEmptyRoadmap({ repoId: "r", title: "R", now: iso(NOW - 3 * DAY) }), roadmapItems: [old] };
  const touched = planUpdateCard(board, { cardId: "legacy", metadata: { a: 1 } }, { now: iso(NOW - DAY) }).roadmap.roadmapItems;
  assert.equal(touched[0]!.progressNotedAt, iso(NOW - 3 * DAY));
  assert.deepEqual(compute({ items: touched, merges: [{ pr: 7, mergedAt: iso(NOW - 2 * DAY) }] }).cards.legacy?.map((signal) => signal.kind), ["merged"]);
});

test("quiet: a real update clears it, a metadata-only one included", () => {
  const board = { ...createEmptyRoadmap({ repoId: "r", title: "R", now: iso(NOW - 9 * DAY) }), roadmapItems: [item({ id: "q", updatedAt: iso(NOW - 9 * DAY) })] };
  assert.deepEqual(compute({ items: board.roadmapItems }).cards.q?.map((signal) => signal.kind), ["quiet"]);
  const updated = planUpdateCard(board, { cardId: "q", metadata: { checked: true } }, { now: iso(NOW - 1000) }).roadmap.roadmapItems;
  assert.equal(compute({ items: updated }).cards.q, undefined);
});

test("large-doc: a Spec or Plan over 100 KB says rewrite, don't append", () => {
  assert.equal(largeDocNote("plan", LARGE_DOC_BYTES), null);
  assert.equal(largeDocNote("plan", 150 * 1024), "Plan is 150 KB; rewrite it to the current state, don't append");
  const result = compute({
    items: [item({ id: "big", updatedAt: iso(NOW - 1000) }), item({ id: "small", updatedAt: iso(NOW - 1000) })],
    docMtimes: [
      { cardId: "big", kind: "spec", mtimeMs: NOW - 2000, bytes: 120 * 1024 },
      { cardId: "small", kind: "plan", mtimeMs: NOW - 2000, bytes: 20 * 1024 },
    ],
  });
  assert.deepEqual(result.cards.big, [{ kind: "large-doc", detail: "Spec is 120 KB; rewrite it to the current state, don't append", since: iso(NOW - 2000) }]);
  assert.equal(result.cards.small, undefined);
  assert.equal(stalenessAttention(result, [item({ id: "big" })]).total, 1, "agents are asked to fix it");
});

test("GitHub remotes are read in every form git writes them", () => {
  for (const remote of ["https://github.com/planban-ai/planban.git", "https://github.com/planban-ai/planban", "git@github.com:planban-ai/planban.git", "ssh://git@github.com/planban-ai/planban.git", "https://token@github.com/planban-ai/planban.git\n"]) {
    assert.equal(githubRepoFromRemote(remote), "planban-ai/planban", remote);
  }
  assert.equal(githubRepoFromRemote("https://gitlab.com/o/r.git"), null);
});

test("GitHub merges are read from a cursor, kept between reads, and degrade with a note", async () => {
  const root = mkdtempSync(join(tmpdir(), "planban-github-"));
  const previousHome = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = root;
  try {
    const calls: string[][] = [];
    const page = (rows: Array<{ number: number; merged_at: string | null; updated_at: string }>) => JSON.stringify(rows);
    let answer: (args: string[]) => string = () => page([
      { number: 5, merged_at: iso(NOW - DAY), updated_at: iso(NOW - DAY) },
      { number: 6, merged_at: null, updated_at: iso(NOW - 2 * DAY) },
    ]);
    const exec = async (_command: string, args: string[]) => { calls.push(args); return answer(args); };
    const first = await githubMerges("o/r", NOW - 10 * DAY, { now: NOW, exec });
    assert.deepEqual(first, { merges: [{ pr: 5, mergedAt: iso(NOW - DAY) }] });
    assert.ok(calls[0]!.includes("repos/o/r/pulls") && calls[0]!.includes("state=closed") && calls[0]!.includes("sort=updated"));

    // A later read in another process fetches only what's new and keeps what was seen.
    answer = () => page([{ number: 8, merged_at: iso(NOW + DAY), updated_at: iso(NOW + DAY) }]);
    const later = await githubMerges("o/r", NOW - 10 * DAY, { now: NOW + 2 * DAY, exec });
    assert.deepEqual(later.merges.map((merge) => merge.pr).sort(), [5, 8]);

    // GitHub out of reach: the merges seen so far, and a note saying why.
    answer = () => { throw Object.assign(new Error("gh failed"), { stderr: "To get started with GitHub CLI, please run:  gh auth login" }); };
    const offline = await githubMerges("o/r", NOW - 10 * DAY, { now: NOW + 4 * DAY, exec });
    assert.deepEqual(offline.merges.map((merge) => merge.pr).sort(), [5, 8]);
    assert.match(offline.note ?? "", /isn't signed in here/u);
  } finally {
    if (previousHome === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = previousHome;
    clearStalenessCaches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("doc-edited: a doc changed outside Planban after its last tool write and the card's update", () => {
  const lastWrite = NOW - 3 * DAY;
  const history = [{ createdAt: iso(lastWrite), affectedCards: ["a", "b", "c"], affectedDocs: [
    { cardId: "a", kind: "plan" as const, path: "items/a/plan.md" },
    { cardId: "b", kind: "spec" as const, path: "items/b/spec.md" },
    { cardId: "c", kind: "spec" as const, path: "items/c/spec.md" },
  ] }];
  const result = compute({
    items: [
      item({ id: "a", updatedAt: iso(lastWrite) }),
      item({ id: "b", updatedAt: iso(lastWrite) }),
      item({ id: "c", updatedAt: iso(NOW - DAY) }),
    ],
    history,
    docMtimes: [
      { cardId: "a", kind: "plan", mtimeMs: NOW - 2 * DAY },
      { cardId: "b", kind: "spec", mtimeMs: lastWrite - 500 },
      { cardId: "c", kind: "spec", mtimeMs: NOW - 2 * DAY },
    ],
  });
  assert.deepEqual(result.cards.a, [{ kind: "doc-edited", detail: "Plan edited outside Planban 29 Sep", since: iso(NOW - 2 * DAY) }]);
  assert.equal(result.cards.b, undefined, "a tool write does not trigger it");
  assert.equal(result.cards.c, undefined, "updating the card after the edit clears it");
});

test("quiet: In Progress Items with no activity for more than five days", () => {
  const result = compute({
    items: [
      item({ id: "parked", updatedAt: iso(NOW - 6 * DAY - 1000) }),
      item({ id: "recent-doc", updatedAt: iso(NOW - 9 * DAY) }),
      item({ id: "up-next", status: "up-next", updatedAt: iso(NOW - 20 * DAY) }),
      item({ id: "fresh", updatedAt: iso(NOW - 4 * DAY) }),
    ],
    history: [{ createdAt: iso(NOW - DAY), affectedCards: ["recent-doc"], affectedDocs: [] }],
  });
  assert.deepEqual(result.cards.parked, [{ kind: "quiet", detail: "No update for 6d", since: iso(NOW - 6 * DAY - 1000) }]);
  assert.equal(result.cards["recent-doc"], undefined, "recorded doc activity counts");
  assert.equal(result.cards["up-next"], undefined);
  assert.equal(result.cards.fresh, undefined);
});

test("awaiting-owner: next actions that start with Owner:", () => {
  const waiting = ["Owner: review PR #380 and the verification record.", "  Owner: pick the next garment work."];
  const notWaiting = [
    "Owner-approved timing change: this moves ahead of 7F.",
    "Owner deferred sending the drafted report.",
    "Agent done. owner to confirm the copy.",
    "Keep this card In Progress until the owner accepts it.",
    "",
  ];
  const result = compute({
    items: [
      ...waiting.map((nextAction, index) => item({ id: `w${index}`, nextAction, updatedAt: iso(NOW - DAY) })),
      ...notWaiting.map((nextAction, index) => item({ id: `n${index}`, nextAction, updatedAt: iso(NOW - DAY) })),
    ],
  });
  for (const [index] of waiting.entries()) assert.equal(result.cards[`w${index}`]?.[0]?.kind, "awaiting-owner", waiting[index]);
  for (const [index] of notWaiting.entries()) assert.equal(result.cards[`n${index}`], undefined, notWaiting[index]);
});

test("group-behind: a Group updated more than a day before a child", () => {
  const result = compute({
    items: [
      item({ id: "group", isGroup: true, updatedAt: iso(NOW - 10 * DAY) }),
      item({ id: "child", parentId: "group", updatedAt: iso(NOW - DAY) }),
      item({ id: "fresh-group", isGroup: true, updatedAt: iso(NOW - DAY - 1000) }),
      item({ id: "fresh-child", parentId: "fresh-group", updatedAt: iso(NOW - DAY) }),
    ],
  });
  assert.deepEqual(result.cards.group, [{ kind: "group-behind", detail: "Child cards changed after this Group (30 Sep)", since: iso(NOW - DAY) }]);
  assert.equal(result.cards["fresh-group"], undefined);
  assert.equal(result.cards.group?.some((signal) => signal.kind === "quiet"), false, "Groups are never quiet");
});

test("wip is reported above twelve In Progress Items, and attention lists every card in order", () => {
  const items = Array.from({ length: 13 }, (_, index) => item({ id: `card-${index}`, updatedAt: iso(NOW - (index < 11 ? 7 : 1) * DAY) }));
  items.push(item({ id: "merged-card", status: "up-next", summary: "PR 9", updatedAt: iso(NOW - DAY) }));
  items.push(item({ id: "owner-card", status: "up-next", nextAction: "Owner: review", updatedAt: iso(NOW - DAY) }));
  const staleness = compute({ items, merges: [{ pr: 9, mergedAt: iso(NOW - 1000) }] });
  assert.deepEqual(staleness.wip, { count: 13, threshold: 12 });
  const attention = stalenessAttention(staleness, items);
  assert.equal(attention.total, 12);
  assert.equal(attention.cards.length, 12, "the full list, never capped");
  assert.equal(attention.cards[0]?.id, "merged-card");
  assert.equal(attention.awaitingOwner, 1);
  assert.equal(attention.cards.some((card) => card.id === "owner-card"), false, "awaiting-owner alone is not stale");
  assert.match(stalenessLine(attention) ?? "", /^12 active cards look stale \(merged-card, card-0, .*\+7 more\); fix any you touch\. 13 Items are In Progress \(over 12\)\.$/u);
  assert.match(stalenessLine(attention, "planban_status") ?? "", /\+7 more; planban_status lists them all\); fix any you touch\./u);
  assert.equal(stalenessLine(stalenessAttention(compute({ items: [] }), [])), null);
  assert.equal(compute({ items: items.slice(0, 12) }).wip, null);
});

test("chip labels are short", () => {
  assert.equal(stalenessChipLabel({ kind: "awaiting-owner", detail: "", since: iso(NOW) }), "Needs you");
  for (const kind of ["merged", "doc-edited", "quiet", "group-behind", "large-doc"] as const) {
    assert.equal(stalenessChipLabel({ kind, detail: "", since: iso(NOW) }), null, kind);
  }
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

test("the merge log comes from remote-tracking branches and fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "planban-staleness-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "Merge pull request #12 from o/feature");
    git(repo, "commit", "-q", "--allow-empty", "-m", "fix: squash merged (#13)");
    git(repo, "commit", "-q", "--allow-empty", "-m", "Merge pull request #14 from o/local-only");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD~1");
    assert.deepEqual((await readMergeLog(repo)).map((merge) => merge.pr).sort(), [12, 13], "only remote-tracking history counts");

    const plain = join(root, "plain");
    mkdirSync(plain);
    assert.deepEqual(await readMergeLog(join(root, "missing")), [], "a missing directory yields no merges");

    // A non-git board still gets its other signals, with no error.
    clearStalenessCaches();
    const planningRoot = join(root, "planning");
    mkdirSync(join(planningRoot, "items/a"), { recursive: true });
    writeFileSync(join(planningRoot, "items/a/spec.md"), "# A\n");
    const updatedAt = Date.now() - 7 * DAY;
    utimesSync(join(planningRoot, "items/a/spec.md"), new Date(updatedAt - DAY), new Date(updatedAt - DAY));
    const staleness = await collectStaleness({
      cwd: plain,
      planningRoot,
      items: [item({ id: "a", specDoc: "items/a/spec.md", summary: "PR 12", updatedAt: iso(updatedAt) })],
    });
    assert.deepEqual(staleness.cards.a?.map((signal) => signal.kind), ["quiet"]);
  } finally {
    clearStalenessCaches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the session-start line names stale cards and stays silent otherwise", async () => {
  const root = mkdtempSync(join(tmpdir(), "planban-staleness-hook-"));
  const previousHome = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = join(root, "home");
  try {
    const cwd = join(root, "repo");
    await initializeProject({ cwd, repoId: "hook-test", title: "Hook Test", updateAgents: false });
    assert.equal(await planbanStalenessLine({ projectDir: cwd }), null, "an empty board has nothing to report");
    await createCard({ cwd, title: "Parked", status: "in-progress" });
    const { roadmapPath } = await loadState(cwd);
    const roadmap = JSON.parse(readFileSync(roadmapPath, "utf8"));
    roadmap.roadmapItems[0].updatedAt = iso(Date.now() - 30 * DAY);
    writeFileSync(roadmapPath, JSON.stringify(roadmap));
    // The card's history entry would count as activity; move it out of the window too.
    const indexPath = join(process.env.PLANBAN_HOME, "repos/hook-test/history/index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    for (const entry of index.entries) entry.createdAt = iso(Date.now() - 30 * DAY);
    writeFileSync(indexPath, JSON.stringify(index));
    clearStalenessCaches();
    assert.equal(await planbanStalenessLine({ projectDir: cwd }), "1 active card looks stale (parked); fix any you touch.");
    assert.equal(await planbanStalenessLine({ projectDir: join(root, "elsewhere") }), null);
  } finally {
    if (previousHome === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = previousHome;
    clearStalenessCaches();
    rmSync(root, { recursive: true, force: true });
  }
});
