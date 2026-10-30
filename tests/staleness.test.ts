import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
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
  prRefsInText,
  stalenessAttention,
  stalenessChipLabel,
  stalenessLine,
  type StalenessInput,
} from "../src/core/staleness";
import { clearStalenessCaches, collectStaleness, readMergeLog } from "../src/core/stalenessSources";
import { createCard, initializeProject, loadState, updateCard } from "../src/core/storage";
import { committedRoadmap, createEmptyRoadmap, planCreateCard, planMoveCard, planUpdateCard } from "../src/core/boardOperations";
import { githubMerges, githubRepoFromRemote, runCommand } from "../src/core/githubMerges";
import { pathToFileURL } from "node:url";
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

/**
 * A stand-in GitHub. `prs` holds each pull request's merge time (null: open) by "owner/name#123";
 * repositories in `hidden` answer 404 like a private one the account can't see; `fail` makes one
 * pull request's lookup fail with that error text.
 */
function fakeGitHub(prs: Map<string, string | null>, options: { hidden?: Set<string>; fail?: Map<string, string> } = {}) {
  const asked: string[] = [];
  let failure: Error | null = null;
  const exec = async (_command: string, args: string[]) => {
    if (failure) throw failure;
    const path = args.find((arg) => arg.startsWith("repos/"))!;
    const match = /^repos\/([\w.-]+\/[\w.-]+)(?:\/pulls\/(\d+))?$/u.exec(path);
    assert.ok(match, `only one pull request or repository is asked for at a time, never a list (${path})`);
    const repo = match[1]!;
    asked.push(match[2] ? `${repo}#${match[2]}` : repo);
    const notFound = () => Object.assign(new Error("gh exited 1"), { stderr: "gh: Not Found (HTTP 404)" });
    if (options.hidden?.has(repo)) throw notFound();
    if (!match[2]) return JSON.stringify(repo);
    const key = `${repo}#${match[2]}`;
    if (options.fail?.has(key)) throw Object.assign(new Error("gh exited 1"), { stderr: options.fail.get(key) });
    if (!prs.has(key)) throw notFound();
    return JSON.stringify({ number: Number(match[2]), merged_at: prs.get(key) });
  };
  return { exec, asked, fail(error: Error | null) { failure = error; } };
}

async function withPlanbanHome(run: (home: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "planban-github-"));
  const previousHome = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = root;
  try {
    clearStalenessCaches();
    await run(root);
  } finally {
    if (previousHome === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = previousHome;
    clearStalenessCaches();
    rmSync(root, { recursive: true, force: true });
  }
}

const refs = (...keys: string[]) => keys.map((key) => ({ repo: key.split("#")[0]!, number: Number(key.split("#")[1]) }));
const prsOf = (result: { merges: Array<{ repo: string; number: number }> }) => result.merges.map((merge) => `${merge.repo}#${merge.number}`).sort();

test("references keep their repository: owner/name#123 and github.com addresses name theirs, #123 names this project's", () => {
  const found = prRefsInText("See other/lib#42, https://github.com/acme/site/pull/43 and #44; PR 45.");
  assert.deepEqual(found.map((ref) => `${ref.repo ?? ""}#${ref.number}`).sort(), ["#44", "#45", "acme/site#43", "other/lib#42"]);
  // A merge of other/lib#42 flags the card naming it, not one naming this project's #42.
  const result = compute({
    items: [
      item({ id: "theirs", updatedAt: iso(NOW - 2 * DAY), nextAction: "Wait for other/lib#42." }),
      item({ id: "ours", updatedAt: iso(NOW - 2 * DAY), nextAction: "Wait for #42." }),
    ],
    merges: [{ pr: 42, repo: "Other/Lib", mergedAt: iso(NOW - DAY) }],
  });
  assert.equal(result.cards.theirs?.[0]?.detail, "other/lib#42 merged 30 Sep");
  assert.equal(result.cards.ours, undefined);
});

test("GitHub merges are looked up per pull request: kept for good once merged, open ones asked about again later", async () => {
  await withPlanbanHome(async () => {
    const prs = new Map<string, string | null>([["o/r#2550", iso(NOW - 40 * DAY)], ["o/r#41", null], ["acme/site#7", iso(NOW - DAY)]]);
    const github = fakeGitHub(prs);
    const first = await githubMerges(refs("o/r#2550", "o/r#41", "o/r#999999", "acme/site#7"), { now: NOW, exec: github.exec });
    assert.deepEqual(prsOf(first), ["acme/site#7", "o/r#2550"]);
    assert.deepEqual(first.notes, [], "a number that isn't a pull request, in a repository the account can see, is not a failure");
    assert.deepEqual(github.asked.sort(), ["acme/site#7", "o/r", "o/r#2550", "o/r#41", "o/r#999999"], "the repository is checked once before a 404 counts as absent");

    // PR 41 merges. Within a minute nothing is asked again; after it, only what isn't merged.
    prs.set("o/r#41", iso(NOW + DAY));
    github.asked.length = 0;
    await githubMerges(refs("o/r#2550", "o/r#41", "o/r#999999"), { now: NOW + 30_000, exec: github.exec });
    assert.deepEqual(github.asked, []);
    const later = await githubMerges(refs("o/r#2550", "o/r#41", "o/r#999999"), { now: NOW + 2 * DAY, exec: github.exec });
    assert.deepEqual(github.asked.sort(), ["o/r", "o/r#41", "o/r#999999"], "a day on, the repository is checked again before a 404 counts");
    assert.deepEqual(prsOf(later), ["o/r#2550", "o/r#41"], "no duplicates");

    // GitHub out of reach: the merges seen so far, and a note saying why.
    github.fail(Object.assign(new Error("gh failed"), { stderr: "To get started with GitHub CLI, please run:  gh auth login" }));
    const offline = await githubMerges(refs("o/r#2550", "o/r#41", "o/r#7"), { now: NOW + 4 * DAY, exec: github.exec });
    assert.deepEqual(prsOf(offline), ["o/r#2550", "o/r#41"]);
    assert.match(offline.notes.join(" "), /isn't signed in here/u);

    // gh not installed, with a real spawn on every platform: a note, never an error or a silent gap.
    const missing = await githubMerges(refs("o/r#2550", "o/r#8"), { now: NOW + 6 * DAY, exec: (_command, args, options) => runCommand("planban-no-such-gh", args, options) });
    assert.deepEqual(prsOf(missing), ["o/r#2550"]);
    assert.match(missing.notes.join(" "), /the GitHub CLI \(gh\) isn't installed here/u);
  });
});

test("one failing lookup doesn't lose the others, and is retried later with a growing wait", async () => {
  await withPlanbanHome(async () => {
    const prs = new Map<string, string | null>([["o/r#1", iso(NOW - DAY)], ["o/r#2", iso(NOW - DAY)], ["o/r#3", iso(NOW - DAY)]]);
    const github = fakeGitHub(prs, { fail: new Map([["o/r#2", "gh: Server Error (HTTP 502)"]]) });
    const first = await githubMerges(refs("o/r#1", "o/r#2", "o/r#3"), { now: NOW, exec: github.exec });
    assert.deepEqual(prsOf(first), ["o/r#1", "o/r#3"], "the answers that came back are kept");
    assert.match(first.notes.join(" "), /GitHub couldn't be reached/u);
    github.asked.length = 0;
    const waiting = await githubMerges(refs("o/r#1", "o/r#2", "o/r#3"), { now: NOW + 90_000, exec: github.exec });
    assert.deepEqual(github.asked, [], "a failed lookup waits two minutes before it's tried again");
    assert.match(waiting.notes.join(" "), /GitHub couldn't be reached/u, "and the note stays while it waits");
    await githubMerges(refs("o/r#1", "o/r#2", "o/r#3"), { now: NOW + 3 * 60_000, exec: github.exec });
    assert.deepEqual(github.asked, ["o/r#2"]);
    github.asked.length = 0;
    await githubMerges(refs("o/r#2"), { now: NOW + 5 * 60_000, exec: github.exec });
    assert.deepEqual(github.asked, [], "after a second failure, four minutes");
  });
});

test("a 404 from a repository the account can't see is reported, not read as no such pull request", async () => {
  await withPlanbanHome(async () => {
    const github = fakeGitHub(new Map([["o/r#5", iso(NOW - DAY)]]), { hidden: new Set(["secret/app"]) });
    const result = await githubMerges(refs("secret/app#12", "o/r#5"), { now: NOW, exec: github.exec });
    assert.deepEqual(prsOf(result), ["o/r#5"]);
    assert.deepEqual(result.notes, ["Merged-PR warnings can't see secret/app: the GitHub CLI (gh) account here has no access to it."]);
    github.asked.length = 0;
    const again = await githubMerges(refs("secret/app#12"), { now: NOW + 2 * 60_000, exec: github.exec });
    assert.deepEqual(github.asked, [], "the repository isn't asked about again for an hour");
    assert.match(again.notes.join(" "), /can't see secret\/app/u);
  });
});

test("GitHub's rate limit pauses lookups, and the pause is said", async () => {
  await withPlanbanHome(async () => {
    const github = fakeGitHub(new Map([["o/r#1", null]]), { fail: new Map([["o/r#1", "gh: API rate limit exceeded for user ID 1. (HTTP 403)"]]) });
    const first = await githubMerges(refs("o/r#1"), { now: NOW, exec: github.exec });
    assert.match(first.notes.join(" "), /rate limit was reached, so merged-PR checks pause until 00:15 UTC/u);
    github.asked.length = 0;
    const paused = await githubMerges(refs("o/r#1", "o/r#2"), { now: NOW + 5 * 60_000, exec: github.exec });
    assert.deepEqual(github.asked, []);
    assert.match(paused.notes.join(" "), /pause until 00:15 UTC/u);
  });
});

/** Runs githubMerges in a separate Node process against a stand-in GitHub that logs each request. */
function childLookup(home: string, keys: string[], merged: string[], log: string, now: number) {
  const script = join(home, "child-lookup.mts");
  writeFileSync(script, `
import { appendFileSync } from "node:fs";
import { githubMerges } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/core/githubMerges.ts")).href)};
const [keys, merged, log, now] = JSON.parse(process.argv[2]);
const exec = async (_command, args) => {
  const path = args.find((arg) => arg.startsWith("repos/"));
  appendFileSync(log, path + "\\n");
  const [, repo, number] = /^repos\\/(.+?)\\/pulls\\/(\\d+)$/.exec(path);
  return JSON.stringify({ number: Number(number), merged_at: merged.includes(repo + "#" + number) ? "2026-09-01T00:00:00.000Z" : null });
};
const refs = keys.map((key) => ({ repo: key.split("#")[0], number: Number(key.split("#")[1]) }));
const result = await githubMerges(refs, { now, exec });
process.stdout.write(JSON.stringify(result));
`);
  return new Promise<{ merges: unknown[]; notes: string[] }>((resolveChild, rejectChild) => {
    execFile(process.execPath, ["--import", "tsx/esm", script, JSON.stringify([keys, merged, log, now])], { env: { ...process.env, PLANBAN_HOME: home } }, (error, stdout, stderr) => {
      if (error) rejectChild(new Error(`${error.message}\n${stderr}`));
      else resolveChild(JSON.parse(stdout));
    });
  });
}

test("separate processes looking up at once lose none of each other's answers", async () => {
  await withPlanbanHome(async (home) => {
    const log = join(home, "requests.log");
    const sets = [0, 1, 2].map((child) => Array.from({ length: 5 }, (_, index) => `o/r#${child * 10 + index + 1}`));
    await Promise.all(sets.map((keys) => childLookup(home, keys, keys, log, NOW)));
    const all = sets.flat();
    const github = fakeGitHub(new Map());
    const after = await githubMerges(refs(...all), { now: NOW + 30_000, exec: github.exec });
    assert.equal(prsOf(after).length, 15, "every process's merges were saved");
    assert.deepEqual(github.asked, []);
  });
});

test("separate processes share one lookup budget, so fresh processes can't multiply requests", async () => {
  await withPlanbanHome(async (home) => {
    const log = join(home, "requests.log");
    const keys = Array.from({ length: 30 }, (_, index) => `o/r#${index + 1}`);
    await Promise.all([0, 1, 2].map(() => childLookup(home, keys, [], log, NOW)));
    await childLookup(home, keys, [], log, NOW + 10_000);
    const requests = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(requests.length, 20, "twenty lookups a minute across every process");
    assert.equal(new Set(requests).size, 20, "and none asked twice");
    const next = await childLookup(home, keys, [], log, NOW + 61_000);
    const all = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(all.length, 40, "twenty more in the next minute");
    assert.equal(new Set(all).size, 30, "never-asked ones first, so every named pull request has now been asked about");
    assert.deepEqual(next.notes, []);
  });
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

test("an edit that changes nothing is not activity, with the saved history included", async () => {
  const root = mkdtempSync(join(tmpdir(), "planban-staleness-noop-"));
  const previousHome = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = join(root, "home");
  try {
    const cwd = join(root, "repo");
    await initializeProject({ cwd, repoId: "noop-test", title: "No-op Test", updateAgents: false });
    await createCard({ cwd, title: "Parked", status: "in-progress", nextAction: "Wait for the supplier." });
    // Push the card and its history a month into the past.
    const { roadmapPath } = await loadState(cwd);
    const roadmap = JSON.parse(readFileSync(roadmapPath, "utf8"));
    roadmap.roadmapItems[0].updatedAt = iso(Date.now() - 30 * DAY);
    writeFileSync(roadmapPath, JSON.stringify(roadmap));
    const indexPath = join(process.env.PLANBAN_HOME, "repos/noop-test/history/index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    for (const entry of index.entries) entry.createdAt = iso(Date.now() - 30 * DAY);
    writeFileSync(indexPath, JSON.stringify(index));
    const month = new Date(Date.now() - 30 * DAY);
    utimesSync(join((await loadState(cwd)).planningRoot, "items/parked/spec.md"), month, month);
    const kinds = async () => {
      clearStalenessCaches();
      const state = await loadState(cwd);
      return (await collectStaleness({ cwd, planningRoot: state.planningRoot, items: state.roadmap.roadmapItems })).cards.parked?.map((signal) => signal.kind) ?? [];
    };
    assert.deepEqual(await kinds(), ["quiet"]);
    await updateCard({ cwd, cardId: "parked", nextAction: "Wait for the supplier." });
    assert.deepEqual(await kinds(), ["quiet"], "the same next action again is not activity");
    await updateCard({ cwd, cardId: "parked", nextAction: "Chase the supplier." });
    assert.deepEqual(await kinds(), []);
  } finally {
    if (previousHome === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = previousHome;
    clearStalenessCaches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the session-start line says when it ran out of time, with the last warnings it saw", async () => {
  const root = mkdtempSync(join(tmpdir(), "planban-staleness-slow-"));
  const previousHome = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = join(root, "home");
  try {
    const cwd = join(root, "repo");
    await initializeProject({ cwd, repoId: "slow-test", title: "Slow Test", updateAgents: false });
    const never = () => new Promise<string | null>(() => undefined);
    assert.equal(await planbanStalenessLine({ projectDir: cwd, budgetMs: 10, compute: never }), "Planban couldn't check which cards look stale in time; check with planban_status.");
    await planbanStalenessLine({ projectDir: cwd, compute: async () => "2 active cards look stale (a, b); fix any you touch." });
    assert.match(await planbanStalenessLine({ projectDir: cwd, budgetMs: 10, compute: never }) ?? "",
      /^Planban couldn't check which cards look stale in time; at the last check \(\d{4}-\d\d-\d\d \d\d:\d\d UTC\): 2 active cards look stale \(a, b\); fix any you touch\.$/u);
  } finally {
    if (previousHome === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = previousHome;
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
