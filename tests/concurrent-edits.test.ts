// Editing at the same time (Spec point 20), end to end against the service's
// real handlers: two agents working from the same read of an online board.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import { errorReport } from "../src/core/errorReport";
import { onlineLogin } from "../src/core/online/login";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { takeOnline } from "../src/core/online/transfers";
import { serviceBridge } from "./service-bridge";

let root: string;
let bridge: Awaited<ReturnType<typeof serviceBridge>>;
const savedHome = process.env.PLANBAN_HOME;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-concurrent-"));
  process.env.PLANBAN_HOME = join(root, "home");
  bridge = await serviceBridge();
  resetCopyChecks();
});

test.afterEach(async () => {
  await bridge.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
});

async function onlineBoard(...titles: string[]) {
  const cwd = join(root, "project");
  await storage.initializeProject({ cwd, repoId: "roadmap", title: "Roadmap", updateAgents: false });
  for (const title of titles) await storage.createCard({ cwd, title });
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, cwd);
  return cwd;
}

const agent = "agent" as const;
const card = async (cwd: string, id: string) => (await storage.loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === id)!;
const column = async (cwd: string, status = "pending") => (await storage.loadState(cwd)).roadmap.roadmapItems.filter((item) => item.status === status).map((item) => item.id);
const refusal = (promise: Promise<unknown>) => promise.then(() => assert.fail("expected a refusal"), (error: unknown) => errorReport(error));

test("two agents on different cards, and on different fields of one card, both land", async () => {
  const cwd = await onlineBoard("Alpha", "Beta");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  await storage.updateCard({ cwd, cardId: "alpha", summary: "First agent", baseRevision: read, actor: agent });
  await storage.updateCard({ cwd, cardId: "beta", summary: "Second agent", baseRevision: read, actor: agent });
  await storage.updateCard({ cwd, cardId: "alpha", nextAction: "Second agent, other field", baseRevision: read, actor: agent });
  assert.deepEqual([(await card(cwd, "alpha")).summary, (await card(cwd, "alpha")).nextAction, (await card(cwd, "beta")).summary], ["First agent", "Second agent, other field", "Second agent"]);
});

test("moves never clash: two agents rearranging different cards from the same read both land", async () => {
  const cwd = await onlineBoard("A", "B", "C", "D");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  await storage.moveCard({ cwd, cardId: "d", afterId: null, baseRevision: read, actor: agent });
  await storage.moveCard({ cwd, cardId: "a", afterId: "c", baseRevision: read, actor: agent });
  assert.deepEqual(await column(cwd), ["d", "b", "c", "a"]);
});

test("the same field clashes; the refused edit waits as an unresolved change until a reconsidered version is saved", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  await storage.updateCard({ cwd, cardId: "alpha", summary: "First agent", baseRevision: read, actor: agent });
  const report = await refusal(storage.updateCard({ cwd, cardId: "alpha", summary: "Second agent", baseRevision: read, actor: agent }));
  assert.equal(report.category, "conflict");
  assert.match(report.message, /changed the summary of card "Alpha" since you read it/);
  const changeId = (report.details as { conflict: { unresolvedChange: string } }).conflict.unresolvedChange;
  assert.match(report.message, new RegExp(`kept as unresolved change ${changeId} on this card, for agents to see`));
  assert.equal((await card(cwd, "alpha")).summary, "First agent", "nothing overwritten");

  // Agents see it: on the board, and on the card.
  const waiting = (await storage.unresolvedChanges({ cwd })).changes;
  assert.deepEqual(waiting.map((change) => [change.changeId, change.cardId, change.fields, (change.proposed as { summary: string }).summary, change.by]), [[changeId, "alpha", ["summary"], "Second agent", "Ana's agent (Planban CLI)"]]);
  assert.equal((await storage.unresolvedChanges({ cwd, cardId: "alpha" })).changes.length, 1);

  // A reconsidered version, saved from the current revision, settles it, and the history says so plainly.
  const now = (await storage.loadState(cwd)).roadmap.revision;
  await storage.updateCard({ cwd, cardId: "alpha", summary: "First agent, and the second agent's point", baseRevision: now, actor: agent });
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes, []);
  const latest = (await storage.historyPayload(cwd)).entries[0]!;
  assert.match(latest.summary, /\(reconsidered after an earlier clash\)$/);
});

test("an agent drops a refused edit with a reason, and the card's history keeps it quietly", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  await storage.updateCard({ cwd, cardId: "alpha", nextAction: "Owner: pick a supplier", baseRevision: read, actor: agent });
  const report = await refusal(storage.updateCard({ cwd, cardId: "alpha", nextAction: "Agent: pick a supplier", baseRevision: read, actor: agent }));
  const changeId = (report.details as { conflict: { unresolvedChange: string } }).conflict.unresolvedChange;
  await assert.rejects(storage.dropChange({ cwd, changeId, reason: " ", baseRevision: (await storage.loadState(cwd)).roadmap.revision, actor: agent }), /Say why/);
  await storage.dropChange({ cwd, changeId, reason: "The owner is choosing the supplier.", baseRevision: (await storage.loadState(cwd)).roadmap.revision, actor: agent });
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes, []);
  assert.equal((await storage.historyPayload(cwd)).entries[0]!.summary, "Dropped an edit to Alpha: The owner is choosing the supplier.");
  assert.equal((await card(cwd, "alpha")).nextAction, "Owner: pick a supplier");
});

test("a clashing document write waits too, and a write of the current document settles it", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" });
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# First", expectedMtimeMs: read.mtimeMs, actor: agent });
  const report = await refusal(storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Second", expectedMtimeMs: read.mtimeMs, actor: agent }));
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes.map((change) => change.fields), [["spec"]]);
  const current = (report.details as { conflict: { document: { mtimeMs: number } } }).conflict.document;
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# First, with the second's point", expectedMtimeMs: current.mtimeMs, actor: agent });
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes, []);
});

test("a person's own refused edit isn't kept: the page shows them what changed", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  await storage.updateCard({ cwd, cardId: "alpha", summary: "An agent's", baseRevision: read, actor: agent });
  const report = await refusal(storage.updateCard({ cwd, cardId: "alpha", summary: "The person's", baseRevision: read }));
  assert.equal(report.category, "conflict");
  assert.doesNotMatch(report.message, /unresolved/);
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes, []);
});

test("a clash older than the recent changes still names who made it", async () => {
  const cwd = await onlineBoard("Alpha", "Beta");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  await storage.updateCard({ cwd, cardId: "alpha", summary: "The first agent's", baseRevision: read, actor: agent });
  for (let i = 0; i < 22; i += 1) await storage.updateCard({ cwd, cardId: "beta", summary: `Beta ${i}`, baseRevision: (await storage.loadState(cwd)).roadmap.revision, actor: agent });
  const report = await refusal(storage.updateCard({ cwd, cardId: "alpha", summary: "The second agent's", baseRevision: read, actor: agent }));
  assert.match(report.message, /^Not saved: Ana's agent \(Planban CLI\) changed the summary of card "Alpha" since you read it \(Updated Alpha,/);
});

test("an agent reading or editing a card is seen as working on it, until 15 quiet minutes have passed", async () => {
  const cwd = await onlineBoard("Alpha");
  await bridge.service.ctx.db.insert("members", { boardId: "roadmap", userId: "ben", role: "editor" });
  // Ana's agent reads the card.
  await storage.notePresence({ cwd, cardId: "alpha", agentName: "claude-code" });
  assert.deepEqual(await storage.workingOnCard({ cwd, cardId: "alpha", agentName: "claude-code" }), [], "an agent doesn't see itself");

  // Ben's agent, on another computer's sign-in, sees it.
  await onlineLogin(bridge.url, { devUser: "ben", switchAccount: true });
  const seen = await storage.workingOnCard({ cwd, cardId: "alpha" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.who, "Claude (Ana)");
  assert.equal(seen[0]!.note, "Claude (Ana) is working on this card, started just now.");
  // People get a quiet sign: the board's people data says who is working on which card.
  const people = await (await import("../src/core/online/client")).onlineRequest<{ working: Record<string, Array<{ userId: string; app: string }>> }>(bridge.url, "/api/v1/boards/roadmap/people");
  assert.deepEqual(people.working.alpha!.map((entry) => [entry.userId, entry.app]), [["ana", "Claude"]]);

  // Fifteen minutes after its last activity it ends by itself.
  for (const row of bridge.service.rows.filter((row) => row._table === "presence")) row.lastActiveAt = Date.now() - 15 * 60 * 1000 - 1000;
  assert.deepEqual(await storage.workingOnCard({ cwd, cardId: "alpha" }), []);
});

test("two apps on one computer's sign-in see each other working on a card, each not itself", async () => {
  const cwd = await onlineBoard("Alpha");
  await storage.notePresence({ cwd, cardId: "alpha", agentName: "claude-code" });
  await storage.notePresence({ cwd, cardId: "alpha", agentName: "codex-mcp-client" });
  assert.deepEqual((await storage.workingOnCard({ cwd, cardId: "alpha", agentName: "claude-code" })).map((entry) => entry.who), ["Codex (Ana)"]);
  assert.deepEqual((await storage.workingOnCard({ cwd, cardId: "alpha", agentName: "codex-mcp-client" })).map((entry) => entry.who), ["Claude (Ana)"]);
});

test("a refused edit keeps every field it wanted, not only the one that clashed", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = await revisionOf(cwd);
  await storage.updateCard({ cwd, cardId: "alpha", summary: "Theirs", baseRevision: read, actor: agent });
  await refusal(storage.updateCard({ cwd, cardId: "alpha", summary: "Mine", nextAction: "Also mine", baseRevision: read, actor: agent }));
  await storage.updateCard({ cwd, cardId: "alpha", summary: "Reconsidered", baseRevision: await revisionOf(cwd), actor: agent });
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes.map((change) => change.fields), [["nextAction"]], "the next action it wanted still waits");
});

const changeIdOf = (report: { details?: unknown }) => (report.details as { conflict: { unresolvedChange: string } }).conflict.unresolvedChange;
const revisionOf = async (cwd: string) => (await storage.loadState(cwd)).roadmap.revision;

test("saving one field of a refused edit leaves the rest of it waiting", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = await revisionOf(cwd);
  await storage.updateCard({ cwd, cardId: "alpha", summary: "Theirs", nextAction: "Theirs too", baseRevision: read, actor: agent });
  await refusal(storage.updateCard({ cwd, cardId: "alpha", summary: "Mine", nextAction: "Mine too", baseRevision: read, actor: agent }));
  await storage.updateCard({ cwd, cardId: "alpha", summary: "Reconsidered", baseRevision: await revisionOf(cwd), actor: agent });
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes.map((change) => change.fields), [["nextAction"]]);
  await storage.updateCard({ cwd, cardId: "alpha", nextAction: "Reconsidered too", baseRevision: await revisionOf(cwd), actor: agent });
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes, []);
});

test("a retried refusal with the same key keeps one unresolved change", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = await revisionOf(cwd);
  await storage.updateCard({ cwd, cardId: "alpha", summary: "Theirs", baseRevision: read, actor: agent });
  const edit = { cwd, cardId: "alpha", summary: "Mine", baseRevision: read, actor: agent, idempotencyKey: "refused-retry-01" };
  const first = changeIdOf(await refusal(storage.updateCard(edit)));
  const again = changeIdOf(await refusal(storage.updateCard(edit)));
  assert.equal(again, first);
  assert.equal((await storage.unresolvedChanges({ cwd })).changes.length, 1);
});

test("when a board already has 200 waiting, a new refusal says it isn't kept, and nothing waiting is removed", async () => {
  const cwd = await onlineBoard("Alpha");
  for (let i = 0; i < 200; i += 1) {
    await bridge.service.ctx.db.insert("unresolvedChanges", { boardId: "roadmap", generation: 1, cardId: "alpha", changeId: `old-${i}`, userId: "ana", clientName: "x", createdAt: new Date(2026, 0, 1, 0, i).toISOString(), op: "updateCard", proposed: {}, fields: ["title"], refusedAtRevision: 1, message: "old" });
  }
  const generation = bridge.service.rows.find((row) => row._table === "boards" && row.boardId === "roadmap").generation;
  for (const row of bridge.service.rows.filter((row) => row._table === "unresolvedChanges")) row.generation = generation;
  const read = await revisionOf(cwd);
  await storage.updateCard({ cwd, cardId: "alpha", summary: "Theirs", baseRevision: read, actor: agent });
  const report = await refusal(storage.updateCard({ cwd, cardId: "alpha", summary: "Mine", baseRevision: read, actor: agent }));
  assert.match(report.message, /already has 200 unresolved changes waiting, so this one is not kept/);
  assert.equal(bridge.service.rows.filter((row) => row._table === "unresolvedChanges").length, 200);
  assert.ok(bridge.service.rows.some((row) => row._table === "unresolvedChanges" && row.changeId === "old-0"));
});

test("a clash names who changed that field, not who changed another field of the card since", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = await revisionOf(cwd);
  await storage.updateCard({ cwd, cardId: "alpha", summary: "By the agent", baseRevision: read, actor: agent });
  await storage.updateCard({ cwd, cardId: "alpha", nextAction: "By Ana", baseRevision: await revisionOf(cwd) });
  const report = await refusal(storage.updateCard({ cwd, cardId: "alpha", summary: "Mine", baseRevision: read, actor: agent }));
  assert.match(report.message, /^Not saved: Ana's agent \(Planban CLI\) changed the summary of card "Alpha"/);
});

test("a reconsidered metadata save that keeps their value settles the refusal", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = await revisionOf(cwd);
  await storage.updateCard({ cwd, cardId: "alpha", metadata: { x: 2 }, baseRevision: read, actor: agent });
  await refusal(storage.updateCard({ cwd, cardId: "alpha", metadata: { x: 3 }, baseRevision: read, actor: agent }));
  await storage.updateCard({ cwd, cardId: "alpha", metadata: { x: 2 }, baseRevision: await revisionOf(cwd), actor: agent });
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes, []);
});

test("a reconsidered document write says so in the card's history", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" });
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# First", expectedMtimeMs: read.mtimeMs, actor: agent });
  const report = await refusal(storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Second", expectedMtimeMs: read.mtimeMs, actor: agent }));
  const current = (report.details as { conflict: { document: { mtimeMs: number } } }).conflict.document;
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# First, and the second's point", expectedMtimeMs: current.mtimeMs, actor: agent });
  assert.match((await storage.historyPayload(cwd)).entries[0]!.summary, /\(reconsidered after an earlier clash\)$/);
});

test("two agents editing different sections of a Spec both land; the same section clashes and waits", async () => {
  const cwd = await onlineBoard("Alpha");
  const read0 = await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" });
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Alpha\n\n## Purpose\n\nWhy.\n\n## Current state\n\nNow.\n", expectedMtimeMs: read0.mtimeMs, actor: agent });
  const read = await storage.readDocSections({ cwd, cardId: "alpha", kind: "spec" });
  const version = (heading: string) => read.sections.find((section) => section.heading === heading)!.version;
  await storage.writeDocSection({ cwd, cardId: "alpha", kind: "spec", heading: "Purpose", expectedSectionVersion: version("Purpose"), markdown: "## Purpose\n\nWhy, sharper.", actor: agent });
  await storage.writeDocSection({ cwd, cardId: "alpha", kind: "spec", heading: "Current state", expectedSectionVersion: version("Current state"), markdown: "## Current state\n\nNow, updated.", actor: agent });
  const both = (await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown;
  assert.match(both, /Why, sharper\./);
  assert.match(both, /Now, updated\./);

  const report = await refusal(storage.writeDocSection({ cwd, cardId: "alpha", kind: "spec", heading: "Purpose", expectedSectionVersion: version("Purpose"), markdown: "## Purpose\n\nWhy, my way.", actor: agent }));
  assert.equal(report.category, "conflict");
  assert.match(report.message, /changed the "Purpose" section of the Spec of card "Alpha" since you read it/);
  assert.match((report.details as { conflict: { section: { text: string } } }).conflict.section.text, /Why, sharper\./);
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes.map((change) => change.fields), [["spec:Purpose#0"]]);
  // A reconsidered write of that section, from its current version, settles it.
  const now = (await storage.readDocSections({ cwd, cardId: "alpha", kind: "spec" })).sections.find((section) => section.heading === "Purpose")!.version;
  await storage.writeDocSection({ cwd, cardId: "alpha", kind: "spec", heading: "Purpose", expectedSectionVersion: now, markdown: "## Purpose\n\nWhy, sharper, and my point.", actor: agent });
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes, []);
});

test("after many unrelated changes, a clash still never blames whoever changed another field of the card", async () => {
  const cwd = await onlineBoard("Alpha", "Beta");
  const read = await revisionOf(cwd);
  for (let i = 0; i < 51; i += 1) await storage.updateCard({ cwd, cardId: "beta", summary: `Beta ${i}`, baseRevision: await revisionOf(cwd), actor: agent });
  await storage.updateCard({ cwd, cardId: "alpha", summary: "The agent's", baseRevision: await revisionOf(cwd), actor: agent });
  await storage.updateCard({ cwd, cardId: "alpha", nextAction: "Ana's", baseRevision: await revisionOf(cwd) });
  const report = await refusal(storage.updateCard({ cwd, cardId: "alpha", summary: "Mine", baseRevision: read, actor: agent }));
  assert.match(report.message, /^Not saved: Ana's agent \(Planban CLI\) changed the summary of card "Alpha"/);
});

test("with two sections of the same name, editing one never settles a refused edit to the other", async () => {
  const cwd = await onlineBoard("Alpha");
  const read0 = await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" });
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "## Same\n\nFirst.\n\n## Same\n\nSecond.\n", expectedMtimeMs: read0.mtimeMs, actor: agent });
  const read = await storage.readDocSections({ cwd, cardId: "alpha", kind: "spec" });
  const [first, second] = read.sections;
  await storage.writeDocSection({ cwd, cardId: "alpha", kind: "spec", heading: "Same", occurrence: 0, expectedSectionVersion: first!.version, markdown: "## Same\n\nFirst, theirs.", actor: agent });
  await refusal(storage.writeDocSection({ cwd, cardId: "alpha", kind: "spec", heading: "Same", occurrence: 0, expectedSectionVersion: first!.version, markdown: "## Same\n\nFirst, mine.", actor: agent }));
  await storage.writeDocSection({ cwd, cardId: "alpha", kind: "spec", heading: "Same", occurrence: 1, expectedSectionVersion: second!.version, markdown: "## Same\n\nSecond, edited.", actor: agent });
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes.map((change) => change.fields), [["spec:Same#0"]]);
});

test("an agent's current card always shows, even after it has marked many others", async () => {
  const cwd = await onlineBoard("Alpha");
  for (let i = 0; i < 52; i += 1) await storage.notePresence({ cwd, cardId: `invented-${i}`, agentName: "claude-code" });
  await storage.notePresence({ cwd, cardId: "alpha", agentName: "codex-mcp-client" });
  const live = bridge.service.rows.filter((row) => row._table === "presence" && row.lastActiveAt >= Date.now() - 15 * 60 * 1000);
  assert.ok(live.length <= 50, `at most 50 live (${live.length})`);
  assert.deepEqual((await storage.workingOnCard({ cwd, cardId: "alpha", agentName: "claude-code" })).map((entry) => entry.who), ["Codex (Ana)"]);
});

test("a card's current agent shows however many old markers the card has", async () => {
  const cwd = await onlineBoard("Alpha");
  const generation = bridge.service.rows.find((row) => row._table === "boards" && row.boardId === "roadmap").generation;
  const connectionId = bridge.service.rows.find((row) => row._table === "connections" && row.userId === "ana")._id;
  for (let i = 0; i < 201; i += 1) await bridge.service.ctx.db.insert("presence", { boardId: "roadmap", generation, cardId: "alpha", connectionId, userId: "ana", app: `Old ${i}`, startedAt: 1, lastActiveAt: 1 });
  await storage.notePresence({ cwd, cardId: "alpha", agentName: "codex-mcp-client" });
  assert.deepEqual((await storage.workingOnCard({ cwd, cardId: "alpha", agentName: "claude-code" })).map((entry) => entry.who), ["Codex (Ana)"]);
});
