// A board's goals (owner decisions, 16 October 2026): people change them;
// agents only suggest; every change is a revision with a history entry; the
// same clash rules as other fields; and goals travel with the board.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import { addSuggestion, applyGoalEdit, assertGoalsSize, decideSuggestion, emptyGoals, goalsBlock, type GoalsFile } from "../src/core/goals";
import { onlineLogin } from "../src/core/online/login";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { backupRoot, refreshBackup } from "../src/core/online/backup";
import { restoreBackup, takeLocal, takeOnline } from "../src/core/online/transfers";
import { serviceBridge } from "./service-bridge";

let root: string;
let cwd: string;
const savedHome = process.env.PLANBAN_HOME;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-goals-"));
  process.env.PLANBAN_HOME = join(root, "home");
  cwd = join(root, "revival");
  await storage.initializeProject({ cwd, repoId: "revival", title: "Revival", updateAgents: false });
  await storage.createCard({ cwd, title: "Alpha" });
  resetCopyChecks();
});

test.afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
});

const revision = async () => (await storage.loadState(cwd)).roadmap.revision;
const statements = async () => (await storage.readGoals({ cwd })).page.goals.map((goal) => goal.statement);
const edit = async (change: Record<string, unknown>, baseRevision?: number) => storage.editGoals({ cwd, edit: change, baseRevision: baseRevision ?? await revision() });

async function revivalGoals() {
  for (const statement of ["Win clubs", "Onboard and deliver without the owner", "Keep clubs for life", "Faster building"]) await edit({ kind: "add", statement });
}

test("people add, reword, reorder, retire and restore goals and set the context; each change is a revision with a history entry", async () => {
  const before = await revision();
  await revivalGoals();
  assert.deepEqual(await statements(), ["Win clubs", "Onboard and deliver without the owner", "Keep clubs for life", "Faster building"]);
  const [win, onboard, , faster] = (await storage.readGoals({ cwd })).page.goals;
  await edit({ kind: "reword", goalId: onboard!.id, notes: "Log every step of the next order." });
  await edit({ kind: "move", goalId: faster!.id, afterId: win!.id });
  assert.deepEqual(await statements(), ["Win clubs", "Faster building", "Onboard and deliver without the owner", "Keep clubs for life"]);
  await edit({ kind: "retire", goalId: faster!.id });
  await edit({ kind: "context", context: "Constraints. The owner is part-time until June 2027." });
  let page = (await storage.readGoals({ cwd })).page;
  assert.equal(page.retired[0]!.statement, "Faster building");
  assert.equal(page.goals[1]!.notes, "Log every step of the next order.");
  assert.match(page.context, /part-time/);
  await edit({ kind: "restore", goalId: faster!.id });
  page = (await storage.readGoals({ cwd })).page;
  assert.equal(page.goals.at(-1)!.statement, "Faster building");
  assert.equal(await revision(), before + 9);
  const history = (await storage.historyPayload(cwd)).entries.filter((entry) => entry.operation === "goals.edit").map((entry) => entry.summary);
  assert.equal(history.length, 9);
  assert.ok(history.includes('Goals: retired "Faster building"'));
  // Goals never touch the cards.
  assert.deepEqual((await storage.loadState(cwd)).roadmap.roadmapItems.map((item) => item.title), ["Alpha"]);
});

test("agents can't change goals; they suggest, and the person accepts or dismisses", async () => {
  await revivalGoals();
  await assert.rejects(storage.editGoals({ cwd, edit: { kind: "add", statement: "Mine" }, actor: "agent" }), /Only people change a board's goals/);
  await assert.rejects(storage.decideGoalSuggestion({ cwd, suggestionId: "x", decision: "accept", actor: "agent" }), /Only people change a board's goals/);
  const suggested = await storage.suggestGoalChange({ cwd, change: { kind: "add", statement: "Win back lapsed clubs", position: 4 }, reason: "Three clubs from last year haven't reordered.", agentName: "Claude" });
  assert.equal(suggested.page.suggestions[0]!.summary, 'add "Win back lapsed clubs" as goal 4');
  assert.equal(suggested.page.suggestions[0]!.by, "Claude");
  // The same suggestion again is not added twice.
  assert.match((await storage.suggestGoalChange({ cwd, change: { kind: "add", statement: "win back lapsed clubs!" }, reason: "Again." })).notAdded!, /already waiting/);
  await storage.decideGoalSuggestion({ cwd, suggestionId: suggested.page.suggestions[0]!.id, decision: "dismiss" });
  const again = await storage.suggestGoalChange({ cwd, change: { kind: "add", statement: "Win back lapsed clubs" }, reason: "Still true." });
  assert.match(again.notAdded!, /was dismissed on .* isn't shown again until 30 days after that/);
  assert.equal(again.page.recentlyDismissed[0]!.summary, 'add "Win back lapsed clubs" as goal 4');
  // Accepting makes the change, as the person's.
  const retire = await storage.suggestGoalChange({ cwd, change: { kind: "retire", goal: "4" }, reason: "No work on it for six weeks." });
  const accepted = await storage.decideGoalSuggestion({ cwd, suggestionId: retire.page.suggestions[0]!.id, decision: "accept" });
  assert.deepEqual(accepted.page.goals.map((goal) => goal.statement), ["Win clubs", "Onboard and deliver without the owner", "Keep clubs for life"]);
  assert.equal(accepted.page.suggestions.length, 0);
});

test("a dismissed suggestion can come back once 30 days have passed", () => {
  let file: GoalsFile = { ...emptyGoals(), goals: [{ id: "g1", statement: "Win clubs", notes: "", createdAt: "", updatedAt: "" }] };
  const stamp = (now: string) => ({ revision: 2, by: "Claude", now, id: now });
  const first = addSuggestion(file, { change: { kind: "retire", goal: "1" }, reason: "Quiet." }, stamp("2026-10-01T00:00:00.000Z"));
  assert.ok(first.goals);
  file = decideSuggestion(first.goals!, { suggestionId: first.suggestion.id, decision: "dismiss" }, stamp("2026-10-01T01:00:00.000Z")).goals;
  assert.equal(addSuggestion(file, { change: { kind: "retire", goal: "1" }, reason: "Quiet." }, stamp("2026-10-30T00:00:00.000Z")).goals, null);
  assert.ok(addSuggestion(file, { change: { kind: "retire", goal: "1" }, reason: "Quiet still." }, stamp("2026-11-01T00:00:00.000Z")).goals);
});

test("edits clash only over the same part, changed since it was read; moves never clash", async () => {
  await revivalGoals();
  const read = await revision();
  const [win, onboard] = (await storage.readGoals({ cwd })).page.goals;
  await edit({ kind: "reword", goalId: win!.id, statement: "Win clubs this term" }, read);
  // Another goal, the same goal's notes, and moves go through.
  await edit({ kind: "reword", goalId: onboard!.id, statement: "Deliver without the owner" }, read);
  await edit({ kind: "reword", goalId: win!.id, notes: "Pitch each club with its own design." }, read);
  await edit({ kind: "move", goalId: win!.id, afterId: onboard!.id }, read);
  // The same statement, changed since: refused, saying who and what it is now.
  await assert.rejects(edit({ kind: "reword", goalId: win!.id, statement: "Win more clubs" }, read), /Not saved: goal "Win clubs this term" was changed by you since you read it\. It is now: "Win clubs this term"/);
  // The same value is no clash.
  await edit({ kind: "reword", goalId: win!.id, statement: "Win clubs this term" }, read);
  await edit({ kind: "context", context: "First." }, read);
  await assert.rejects(edit({ kind: "context", context: "Second." }, read), /the goals' context was changed/);
});

test("the agents' Goals block lists the statements only, and only when there are goals", async () => {
  assert.equal(goalsBlock(emptyGoals()), null);
  assert.equal(await storage.readGoalsBlock(cwd), null);
  await revivalGoals();
  await edit({ kind: "reword", goalId: "g1", notes: "Secret detail" });
  const block = (await storage.readGoalsBlock(cwd))!;
  assert.match(block, /^Goals, most important first:\n1\. Win clubs\n2\. Onboard and deliver without the owner\n3\. Keep clubs for life\n4\. Faster building\nRead the Goals page for notes and context/);
  assert.doesNotMatch(block, /Secret detail/);
});

test("goals are text only and one line each", async () => {
  await assert.rejects(edit({ kind: "add", statement: "" }), /can't be empty/);
  await assert.rejects(edit({ kind: "add", statement: "x".repeat(201) }), /one line of at most 200 characters/);
  await assert.rejects(edit({ kind: "add", statement: "Logo", notes: `data:image/png;base64,${"A".repeat(400)}` }), /text only|Planban/);
});

test("online: the same rules on the service, and goals move with the board, into backups and back", async () => {
  const bridge = await serviceBridge([["ana", "Ana"], ["ben", "Ben"]]);
  try {
    await revivalGoals();
    await edit({ kind: "context", context: "Ambition. Win the club-only market." });
    await onlineLogin(bridge.url, { devUser: "ana" });
    await takeOnline(bridge.url, cwd);
    assert.deepEqual(await statements(), ["Win clubs", "Onboard and deliver without the owner", "Keep clubs for life", "Faster building"]);
    await edit({ kind: "reword", goalId: "g4", statement: "Faster building, when apt" });
    await assert.rejects(storage.editGoals({ cwd, edit: { kind: "add", statement: "Mine" }, actor: "agent" }), /Only people change a board's goals/);
    // An agent going straight to the service is refused too.
    const { onlineRequest, boardPath } = await import("../src/core/online/client");
    await assert.rejects(onlineRequest(bridge.url, boardPath("revival", "/ops/editGoals"), { edit: { kind: "add", statement: "Mine" }, actor: "agent" }), /Only people change a board's goals/);
    const suggested = await storage.suggestGoalChange({ cwd, change: { kind: "reorder", goal: "3", position: 1 }, reason: "Two clubs churned this month.", agentName: "Codex" });
    assert.equal(suggested.page.suggestions[0]!.by, "Ana's agent (Codex)");
    const history = (await storage.historyPayload(cwd)).entries.filter((entry) => entry.operation === "goals.edit");
    assert.ok(history.some((entry) => /Ana's agent \(Codex\) suggested to move goal 3/.test(entry.summary)));
    await storage.decideGoalSuggestion({ cwd, suggestionId: suggested.page.suggestions[0]!.id, decision: "accept" });
    assert.equal((await statements())[0], "Keep clubs for life");
    // The computer's backup keeps the goals, and a restored copy has them.
    await refreshBackup(bridge.url, "revival", { force: true });
    const restored = join(root, "restored");
    await restoreBackup(join(backupRoot(bridge.url, "revival"), "latest"), restored, "revival-restored");
    assert.equal((await storage.readGoals({ cwd: restored })).page.goals[0]!.statement, "Keep clubs for life");
    // Back to this computer, goals and all.
    await takeLocal(cwd);
    const back = (await storage.readGoals({ cwd })).page;
    assert.equal(back.goals[0]!.statement, "Keep clubs for life");
    assert.match(back.context, /club-only market/);
    assert.match(await readFile(join((await storage.loadState(cwd)).planningRoot, "goals.json"), "utf8"), /Faster building, when apt/);
  } finally {
    await bridge.close();
  }
});

// ---- Review round 1 (16 October 2026) ----

test("the local server lets only the board page change goals; an agent's request is refused, whatever it says", async () => {
  await revivalGoals();
  const { createServer } = await import("node:http");
  const { startServer } = await import("../src/server/server");
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const post = (headers: Record<string, string>, body: unknown) => fetch(`${server.url}/api/boards/revival/goals`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const edit = { edit: { kind: "context", context: "Changed by an agent" } };
    assert.equal((await post({}, edit)).status, 403);
    assert.equal((await post({ "X-Planban-Client": "web" }, edit)).status, 403);
    assert.equal((await post({ "X-Planban-Client": "web", "Sec-Fetch-Site": "same-origin" }, { ...edit, actor: "agent" })).status, 403);
    const decide = await fetch(`${server.url}/api/boards/revival/goals/suggestions/x`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "accept" }) });
    assert.equal(decide.status, 403);
    assert.equal((await storage.readGoals({ cwd })).page.context, "");
    const page = await post({ "X-Planban-Client": "web", "Sec-Fetch-Site": "same-origin", Origin: server.url }, { edit: { kind: "context", context: "From the page" } });
    assert.equal(page.status, 200, await page.clone().text());
    assert.equal((await storage.readGoals({ cwd })).page.context, "From the page");
  } finally {
    await server.close();
  }
});

test("retiring never drops an earlier retired goal; the goals' size limit refuses instead of trimming", () => {
  let file: GoalsFile = emptyGoals();
  const stamp = (revision: number) => ({ revision, by: "you", now: new Date(Date.UTC(2026, 9, 1, 0, revision)).toISOString() });
  for (let i = 1; i <= 60; i += 1) {
    file = applyGoalEdit(file, { kind: "add", statement: `Goal ${i}`, notes: "Notes kept" }, stamp(i * 2)).goals;
    file = applyGoalEdit(file, { kind: "retire", goalId: `g${i}` }, stamp(i * 2 + 1)).goals;
  }
  assert.equal(file.retired.length, 60);
  assert.equal(applyGoalEdit(file, { kind: "restore", goalId: "g1" }, stamp(200)).goals.goals[0]!.notes, "Notes kept");
  const huge = { ...file, context: "x".repeat(300 * 1024) };
  assert.throws(() => assertGoalsSize(huge), /too large to keep/);
});

test("accepting a suggestion is checked against what the person read, like any edit", () => {
  let file: GoalsFile = { ...emptyGoals(), goals: [{ id: "g1", statement: "Win clubs", notes: "", createdAt: "", updatedAt: "" }] };
  const added = addSuggestion(file, { change: { kind: "reword", goal: "1", statement: "Win more clubs" }, reason: "Growth." }, { revision: 2, by: "Claude", now: "2026-10-16T00:00:00.000Z", id: "s1" });
  file = added.goals!;
  // Someone rewords the goal at revision 3; the person read the page at revision 2.
  file = applyGoalEdit(file, { kind: "reword", goalId: "g1", statement: "Win university clubs" }, { revision: 3, baseRevision: 2, by: "Sam", now: "2026-10-16T00:01:00.000Z" }).goals;
  assert.throws(() => decideSuggestion(file, { suggestionId: "s1", decision: "accept" }, { revision: 4, baseRevision: 2, by: "you", now: "2026-10-16T00:02:00.000Z" }), /changed by Sam since you read it/);
  // Having seen the new wording, accepting is the person's choice.
  assert.equal(decideSuggestion(file, { suggestionId: "s1", decision: "accept" }, { revision: 4, baseRevision: 3, by: "you", now: "2026-10-16T00:02:00.000Z" }).goals.goals[0]!.statement, "Win more clubs");
});

test("a goals change that stopped part way either stands, if its revision was committed, or never happened", async () => {
  await revivalGoals();
  const state = await storage.loadState(cwd);
  const next = join(state.planningRoot, "goals.next.json");
  const { writeFile } = await import("node:fs/promises");
  const current = JSON.parse(await readFile(join(state.planningRoot, "goals.json"), "utf8"));
  // Stopped before the board's revision was committed: it never happened.
  await writeFile(next, JSON.stringify({ ...current, context: "Never committed", revision: state.roadmap.revision + 1 }));
  assert.equal((await storage.readGoals({ cwd })).page.context, "");
  await edit({ kind: "reword", goalId: "g1", notes: "Settled" });
  assert.equal((await storage.readGoals({ cwd })).page.context, "");
  assert.equal(await storage.pathExists(next), false);
  // Abandoned, then another kind of edit reaches its revision number: still never happened.
  const before = await storage.loadState(cwd);
  await writeFile(next, JSON.stringify({ ...current, context: "Abandoned", revision: before.roadmap.revision + 1 }));
  await storage.createCard({ cwd, title: "A card edit takes that revision" });
  assert.equal((await storage.readGoals({ cwd })).page.context, "");
  await edit({ kind: "reword", goalId: "g3", notes: "Settles it" });
  assert.equal((await storage.readGoals({ cwd })).page.context, "");
  // Stopped after the revision was committed, before the rename: it stands.
  const now = await storage.loadState(cwd);
  const stored = JSON.parse(await readFile(join(now.planningRoot, "goals.json"), "utf8"));
  await writeFile(next, JSON.stringify({ ...stored, context: "Committed", revision: now.roadmap.revision }));
  assert.equal((await storage.readGoals({ cwd })).page.context, "Committed");
  await edit({ kind: "reword", goalId: "g2", notes: "After" });
  assert.equal((await storage.readGoals({ cwd })).page.context, "Committed");
});

test("a retried suggestion with the same key is added once, on a computer as online", async () => {
  await revivalGoals();
  const first = await storage.suggestGoalChange({ cwd, change: { kind: "add", statement: "Win back lapsed clubs" }, reason: "Three haven't reordered.", idempotencyKey: "suggest-once-1" });
  await storage.decideGoalSuggestion({ cwd, suggestionId: first.page.suggestions[0]!.id, decision: "accept" });
  const retried = await storage.suggestGoalChange({ cwd, change: { kind: "add", statement: "Win back lapsed clubs" }, reason: "Three haven't reordered.", idempotencyKey: "suggest-once-1" });
  assert.equal(retried.page.suggestions.length, 1);
  assert.equal((await storage.readGoals({ cwd })).page.suggestions.length, 0);
  assert.equal((await statements()).filter((statement) => statement === "Win back lapsed clubs").length, 1);
});

test("a backup isn't saved without the goals when they can't be read; the next refresh gets them", async () => {
  const bridge = await serviceBridge([["ana", "Ana"]]);
  try {
    await revivalGoals();
    await onlineLogin(bridge.url, { devUser: "ana" });
    await takeOnline(bridge.url, cwd);
    const latest = join(backupRoot(bridge.url, "revival"), "latest");
    const { rm: remove } = await import("node:fs/promises");
    await remove(backupRoot(bridge.url, "revival"), { recursive: true, force: true });
    bridge.control.intercept = async (path) => (path.endsWith("/goals") ? { status: 503, body: { error: { message: "Unavailable" } } } : undefined);
    assert.equal(await refreshBackup(bridge.url, "revival", { force: true }), null);
    assert.equal(await storage.pathExists(join(latest, "roadmap.json")), false);
    bridge.control.intercept = undefined;
    await refreshBackup(bridge.url, "revival", { force: true });
    assert.match(await readFile(join(latest, "goals.json"), "utf8"), /Win clubs/);
  } finally {
    await bridge.close();
  }
});

// ---- Review round 2 (16 October 2026) ----

test("dismissed suggestions are kept for their full 30 days, however many there are", () => {
  let file: GoalsFile = emptyGoals();
  const stamp = (i: number) => ({ revision: i + 2, by: "Claude", now: "2026-10-16T00:00:00.000Z", id: `s${i}` });
  for (let i = 0; i < 101; i += 1) {
    const added = addSuggestion(file, { change: { kind: "add", statement: `Idea ${i}` }, reason: "Because." }, stamp(i));
    file = decideSuggestion(added.goals!, { suggestionId: `s${i}`, decision: "dismiss" }, { revision: i + 3, by: "you", now: "2026-10-16T00:00:00.000Z" }).goals;
  }
  assert.equal(addSuggestion(file, { change: { kind: "add", statement: "Idea 0" }, reason: "Again." }, stamp(500)).goals, null);
});

test("online and on a computer, goals are measured the same way, so goals that fit online still fit after Take Local", async () => {
  const bridge = await serviceBridge([["ana", "Ana"]]);
  try {
    await onlineLogin(bridge.url, { devUser: "ana" });
    await takeOnline(bridge.url, cwd);
    const notes = "Pitch each club with a design made for it. ".repeat(180);
    let refused: unknown = null;
    for (let i = 1; i <= 40 && !refused; i += 1) {
      try {
        await edit({ kind: "add", statement: `Goal ${i}`, notes });
        await edit({ kind: "retire", goalId: (await storage.readGoals({ cwd })).page.goals.at(-1)!.id });
      } catch (error) {
        refused = error;
      }
    }
    assert.match(String(refused), /too large to keep/);
    await takeLocal(cwd);
    // Back on this computer, an ordinary edit still fits.
    await edit({ kind: "add", statement: "Short goal" });
  } finally {
    await bridge.close();
  }
});

test("a backup never pairs goals from a later revision with an older board", async () => {
  const bridge = await serviceBridge([["ana", "Ana"]]);
  try {
    await revivalGoals();
    await onlineLogin(bridge.url, { devUser: "ana" });
    await takeOnline(bridge.url, cwd);
    // A change since the last backup, so the refresh reads the board again.
    await storage.updateCard({ cwd, cardId: "alpha", summary: "Changed", baseRevision: await revision() });
    let changed = false;
    bridge.control.intercept = async (path) => {
      if (!changed && path.endsWith("/goals")) {
        changed = true;
        await edit({ kind: "context", context: "Changed while backing up" });
      }
      return undefined;
    };
    await refreshBackup(bridge.url, "revival", { force: true });
    bridge.control.intercept = undefined;
    const latest = join(backupRoot(bridge.url, "revival"), "latest");
    const meta = JSON.parse(await readFile(join(latest, "backup.json"), "utf8"));
    const goals = JSON.parse(await readFile(join(latest, "goals.json"), "utf8"));
    assert.equal(goals.context, "Changed while backing up");
    assert.ok(Object.values(goals.changed as Record<string, { revision: number }>).every((field) => field.revision <= meta.revision));
  } finally {
    await bridge.close();
  }
});

test("suggested goals 1 to 4 on an empty board, accepted in order, end up in that order", () => {
  let file: GoalsFile = emptyGoals();
  const names = ["Win clubs", "Onboard and deliver without the owner", "Keep clubs for life", "Faster building"];
  names.forEach((statement, i) => {
    const added = addSuggestion(file, { change: { kind: "add", statement, position: i + 1 }, reason: "From the agreed plan." }, { revision: i + 2, by: "Claude", now: "2026-10-16T00:00:00.000Z", id: `s${i}` });
    file = added.goals!;
  });
  names.forEach((_, i) => { file = decideSuggestion(file, { suggestionId: `s${i}`, decision: "accept" }, { revision: 10 + i, by: "you", now: "2026-10-16T00:00:00.000Z" }).goals; });
  assert.deepEqual(file.goals.map((goal) => goal.statement), names);
});

// ---- Review round 3 (16 October 2026) ----

test("a committed goals change still waiting to be renamed survives later edits and history pruning", async () => {
  await storage.editGoals({ cwd, edit: { kind: "context", context: "Old context" }, baseRevision: await revision() });
  const state = await storage.loadState(cwd);
  const path = join(state.planningRoot, "goals.json");
  const old = await readFile(path, "utf8");
  await storage.editGoals({ cwd, edit: { kind: "context", context: "Committed new context" }, baseRevision: await revision() });
  // The disk as a crash between committing the revision and the rename leaves it.
  const { rename: move, writeFile } = await import("node:fs/promises");
  await move(path, join(state.planningRoot, "goals.next.json"));
  await writeFile(path, old);
  assert.equal((await storage.readGoals({ cwd })).page.context, "Committed new context");
  for (let i = 0; i < 102; i += 1) await storage.updateCard({ cwd, cardId: "alpha", summary: `Edit ${i}`, baseRevision: await revision() });
  assert.equal((await storage.readGoals({ cwd })).page.context, "Committed new context");
});

test("board content of any shape goes online and comes back: over 1,024 metadata fields, and over 1,024 changed goal fields", async () => {
  const bridge = await serviceBridge([["ana", "Ana"]]);
  try {
    const wide = Object.fromEntries(Array.from({ length: 1_100 }, (_, i) => [`field${i}`, i]));
    await storage.updateCard({ cwd, cardId: "alpha", metadata: wide, baseRevision: await revision() });
    await storage.updateCard({ cwd, cardId: "alpha", metadata: { narrow: true }, baseRevision: await revision() });
    await onlineLogin(bridge.url, { devUser: "ana" });
    await takeOnline(bridge.url, cwd);
    // An edit with that shape online, and reads of the board and its history. Metadata edits are
    // patches, so the narrow key set in between stays: 1,101 keys.
    await storage.updateCard({ cwd, cardId: "alpha", metadata: wide, baseRevision: await revision() });
    assert.equal(Object.keys((await storage.loadState(cwd)).roadmap.roadmapItems[0]!.metadata!).length, 1_101);
    const history = await storage.historyPayload(cwd);
    assert.ok(history.entries.length > 0);
    // Goals whose record of changed fields passes 1,024 entries.
    for (let i = 0; i < 345; i += 1) {
      await edit({ kind: "add", statement: `Goal ${i}` });
      const id = (await storage.readGoals({ cwd })).page.goals.at(-1)!.id;
      await edit({ kind: "reword", goalId: id, statement: `Goal ${i} reworded`, notes: "Note." });
      await edit({ kind: "retire", goalId: id });
    }
    assert.ok((await storage.readGoals({ cwd })).page.retired.length >= 345);
    await refreshBackup(bridge.url, "revival", { force: true });
    await takeLocal(cwd);
    assert.equal(Object.keys((await storage.loadState(cwd)).roadmap.roadmapItems[0]!.metadata!).length, 1_101);
    assert.ok((await storage.readGoals({ cwd })).page.retired.length >= 345);
  } finally {
    await bridge.close();
  }
});

// ---- Review round 4: the online service's limits for large boards (16 October 2026) ----

test("large boards: export pages count real bytes, People and export work past 1,024 cards, and a wide refused edit is kept", async () => {
  const bridge = await serviceBridge([["ana", "Ana"], ["ben", "Ben"]]);
  try {
    // Over 1,024 cards, and Specs in non-Latin text.
    for (let batch = 0; batch < 1_030; batch += 100) {
      await storage.createCards({ cwd, titles: Array.from({ length: Math.min(100, 1_030 - batch) }, (_, i) => `Card ${batch + i}`) });
    }
    const wide = Array.from({ length: 3_000 }, (_, i) => `第${i}行：俱乐部的球衣设计需要更多颜色，我们下周再讨论第${i % 7}个方案。`).join("\n");
    const spec = await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" });
    await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: `# Spec\n\n${wide}\n`, expectedMtimeMs: spec.exists ? spec.mtimeMs : null });
    await onlineLogin(bridge.url, { devUser: "ana" });
    await takeOnline(bridge.url, cwd);
    const { onlineRequest, boardPath } = await import("../src/core/online/client");
    const people = await onlineRequest<{ cards: Record<string, unknown> }>(bridge.url, boardPath("revival", "/people"));
    assert.ok(Object.keys(people.cards).length > 1_024);
    const page = await onlineRequest<{ docs: Array<{ markdown: string }> }>(bridge.url, boardPath("revival", "/export/docs?offset=0&limit=200"));
    assert.ok(page.docs.length >= 1);
    // A refused agent edit with over 1,024 metadata fields is still kept as an unresolved change.
    const read = await revision();
    await storage.updateCard({ cwd, cardId: "alpha", metadata: { theirs: "Ana's" }, baseRevision: read });
    const wideMeta = { theirs: "the agent's", ...Object.fromEntries(Array.from({ length: 1_100 }, (_, i) => [`k${i}`, i])) };
    await assert.rejects(storage.updateCard({ cwd, cardId: "alpha", metadata: wideMeta, baseRevision: read, actor: "agent" }));
    const { changes } = await storage.unresolvedChanges({ cwd, cardId: "alpha" });
    assert.equal(changes.length, 1);
    assert.equal(Object.keys((changes[0]!.proposed as { metadata: object }).metadata).length, 1_101);
    // The whole-board export of a board this size still answers, packed.
    const whole = await onlineRequest<{ roadmap: { roadmapItems: unknown[] } }>(bridge.url, boardPath("revival", "/export"));
    assert.ok(whole.roadmap.roadmapItems.length > 1_024);
  } finally {
    await bridge.close();
  }
});
