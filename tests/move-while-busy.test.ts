// Taking a busy board online: other agents keep reading and writing it while
// it moves, and every write either lands on the online board or fails loudly.
// Nothing may land in the local copy the board leaves behind.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import { onlineLogin } from "../src/core/online/login";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { stopTakeOnline, takeOnline } from "../src/core/online/transfers";
import { onlineCacheRoot } from "../src/core/online/adapter";
import { carryIdempotencyRecords, idempotencyFingerprint } from "../src/core/persistence";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { startServer } from "../src/server/server";
import { createServer } from "node:http";
import { serviceBridge } from "./service-bridge";

let root: string;
let bridge: Awaited<ReturnType<typeof serviceBridge>>;
const savedHome = process.env.PLANBAN_HOME;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-move-busy-"));
  process.env.PLANBAN_HOME = join(root, "home");
  bridge = await serviceBridge();
  resetCopyChecks();
});

test.afterEach(async () => {
  bridge.control.intercept = undefined;
  await bridge.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
});

async function localBoard(...titles: string[]) {
  const cwd = join(root, "project");
  await storage.initializeProject({ cwd, repoId: "roadmap", title: "Roadmap", updateAgents: false });
  for (const title of titles) await storage.createCard({ cwd, title });
  await onlineLogin(bridge.url, { devUser: "ana" });
  return cwd;
}

/** Holds the move just before it commits, with the board's write lock held, until released. */
function holdAtCommit() {
  let reached!: () => void;
  let release!: () => void;
  const atCommit = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  bridge.control.intercept = async (path) => {
    if (!path.endsWith("/commit")) return;
    reached();
    await released;
  };
  return { atCommit, release };
}

const onlineCard = async (cwd: string, id: string) => (await storage.loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === id)!;
const planningRoot = () => join(process.env.PLANBAN_HOME!, "repos", "roadmap");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a write that started while the board was local and waited for the move lands on the online board", async () => {
  const cwd = await localBoard("Alpha");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  const spec = await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" });
  const { atCommit, release } = holdAtCommit();
  const moving = takeOnline(bridge.url, cwd);
  await atCommit;
  // Still local as far as anyone can tell: this write goes the local way and queues for the board.
  assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
  const writing = storage.updateCard({ cwd, cardId: "alpha", summary: "Written during the move", baseRevision: read, actor: "agent" });
  const doc = storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Spec\n\nWritten during the move.\n", expectedMtimeMs: spec.mtimeMs, baseRevision: read, actor: "agent" }).then(() => null, (error: Error) => error);
  // An agent's edit that says nothing about what it read is refused by the online board, loudly.
  const unstated = storage.updateCard({ cwd, cardId: "alpha", nextAction: "No revision given", actor: "agent" }).then(() => null, (error: Error) => error);
  await sleep(300);
  release();
  await moving;
  await writing;
  assert.match(String((await unstated)?.message), /baseRevision/);
  // The move gives every document a new online version, so a document edit read
  // before it is refused as a clash, and kept online as an unresolved change.
  const refused = await doc;
  assert.ok(refused instanceof storage.PlanbanConflictError && /unresolved change/.test(refused.message), String(refused));
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  assert.equal((await onlineCard(cwd, "alpha")).summary, "Written during the move");
  const waiting = (await storage.unresolvedChanges({ cwd, cardId: "alpha" })).changes;
  assert.match(JSON.stringify(waiting), /Written during the move/);
});

test("a long-running process that read the board before the move sends its next writes online", async () => {
  const cwd = await localBoard("Alpha");
  const before = await storage.loadState(cwd);
  assert.equal(before.manifest.storage?.kind ?? "local", "local");
  await takeOnline(bridge.url, cwd);
  await storage.updateCard({ cwd, cardId: "alpha", summary: "After the move", baseRevision: before.roadmap.revision, actor: "agent" });
  assert.equal((await onlineCard(cwd, "alpha")).summary, "After the move");
  // A write built from the state it read before the move is refused, loudly, not saved locally.
  await assert.rejects(
    storage.saveRoadmap(before, { ...before.roadmap, roadmapItems: before.roadmap.roadmapItems.map((item) => ({ ...item, summary: "stale" })) }),
    /now lives online|moved online/,
  );
  assert.equal((await onlineCard(cwd, "alpha")).summary, "After the move");
});

test("another checkout still pointing at the local copy fails loudly, and says the board moved online", async () => {
  const cwd = await localBoard("Alpha");
  const other = join(root, "other-checkout");
  await mkdir(join(other, ".planban"), { recursive: true });
  await cp(join(cwd, ".planban", "project.json"), join(other, ".planban", "project.json"));
  await takeOnline(bridge.url, cwd);
  await assert.rejects(storage.loadState(other), /moved online/);
  await assert.rejects(storage.updateCard({ cwd: other, cardId: "alpha", summary: "lost?", actor: "agent" }), /moved online/);
  assert.equal((await storage.getStatus(other)).roadmapExists, false);
  assert.equal((await onlineCard(cwd, "alpha")).summary, null);
});

/**
 * Planban 1.x, as released (v1.1.7), reduced to the steps that decide where
 * its writes go: `init` creates roadmap.json only when none exists, and every
 * read or write first parses roadmap.json (JSON.parse) and fails if it is missing.
 */
const legacy = {
  async init(planningRootPath: string) {
    const path = join(planningRootPath, "roadmap.json");
    if (!(await stat(path).then(() => true, () => false))) {
      await rm(path, { force: true });
      await mkdir(planningRootPath, { recursive: true });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, JSON.stringify({ version: 2, writerVersion: 6, revision: 0, roadmapItems: [] }));
    }
    return this.load(planningRootPath);
  },
  async load(planningRootPath: string) {
    const path = join(planningRootPath, "roadmap.json");
    if (!(await stat(path).then(() => true, () => false))) throw new Error(`Planban roadmap is missing at ${path}`);
    return JSON.parse(await readFile(path, "utf8")) as { roadmapItems: unknown[] };
  },
};

test("Planban 1.x can neither read, write nor re-create the local copy after the move, and is told to restart", async () => {
  const cwd = await localBoard("Alpha");
  await takeOnline(bridge.url, cwd);
  const legacyError = await legacy.load(planningRoot()).then(() => assert.fail("1.x read the retired copy"), (error: Error) => error.message);
  assert.match(legacyError, /Restart: Planban 2\.0/);
  // `planban init` in 1.x would otherwise make a fresh, empty board here that its agents then write to.
  await assert.rejects(legacy.init(planningRoot()), /Restart: Planban 2\.0/);
  assert.equal(await readFile(join(planningRoot(), "roadmap.json"), "utf8"), storage.RETIRED_ROADMAP);
  // The copy from before the move is still kept for recovery.
  assert.match(await readFile(join(planningRoot(), "ONLINE-BOARD.txt"), "utf8"), /Authority moved to/);
});

test("a local write that reaches the board's lock after the project already points online never runs locally", async () => {
  const cwd = await localBoard("Alpha");
  await takeOnline(bridge.url, cwd);
  // The state a writer is in when the move finishes between its routing check and the lock:
  // every read of the project now says online, yet it is on the local path.
  let ran = false;
  await assert.rejects(storage.withRoadmapWriteLock(cwd, async () => { ran = true; }), (error: unknown) => error instanceof storage.PlanbanBoardMovedError);
  assert.equal(ran, false, "nothing ran against the local cache of the online board");
});

test("a move whose commit fails puts the board back on this machine, and local writes work again", async () => {
  const cwd = await localBoard("Alpha");
  bridge.control.intercept = async (path) => (path.endsWith("/commit") ? { status: 500, body: { error: { code: "internal", message: "commit failed" } } } : undefined);
  await assert.rejects(takeOnline(bridge.url, cwd), /still on this machine, unchanged/);
  bridge.control.intercept = undefined;
  assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
  const state = await storage.loadState(cwd);
  await storage.updateCard({ cwd, cardId: "alpha", summary: "After the failed move", baseRevision: state.roadmap.revision });
  assert.equal((await storage.loadState(cwd)).roadmap.roadmapItems[0]!.summary, "After the failed move");
});

test("while it is unknown whether the commit landed, every local writer stays shut out until the move is finished or stopped", async () => {
  const cwd = await localBoard("Alpha");
  const fail = { status: 500, body: { error: { code: "internal", message: "unreachable" } } };
  bridge.control.intercept = async (path) => (path.endsWith("/commit") || path.endsWith("/abort") ? fail : undefined);
  await assert.rejects(takeOnline(bridge.url, cwd));
  // Planban 2.0 and 1.x alike are refused, loudly.
  await assert.rejects(storage.createCard({ cwd, title: "Lost?" }), /moving online/);
  await assert.rejects(legacy.load(planningRoot()), /Restart: Planban 2\.0/);
  bridge.control.intercept = undefined;
  assert.equal((await stopTakeOnline(cwd)).stopped, true);
  const back = await storage.loadState(cwd);
  assert.deepEqual(back.roadmap.roadmapItems.map((item) => item.title), ["Alpha"]);
  await storage.createCard({ cwd, title: "After stopping" });
});

test("a board-page change queued behind the move is applied once, even when the page retries it with the same key", async () => {
  const cwd = await localBoard("Alpha");
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const read = (await storage.loadState(cwd)).roadmap.revision;
    const create = () => fetch(`${server.url}/api/cards`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "page-create-1" }, body: JSON.stringify({ title: "Beta", baseRevision: read }),
    });
    const { atCommit, release } = holdAtCommit();
    const moving = takeOnline(bridge.url, cwd);
    await atCommit;
    const first = create();
    await sleep(300);
    release();
    await moving;
    assert.equal((await first).status, 200, await (await first).clone().text());
    const retried = await create();
    assert.equal(retried.status, 200);
    const titles = (await storage.loadState(cwd)).roadmap.roadmapItems.map((item) => item.title);
    assert.deepEqual(titles.filter((title) => title === "Beta"), ["Beta"], `applied once: ${titles.join(", ")}`);
  } finally { await server.close(); }
});

test("a board-page change applied just before the move is not applied again when the page retries it afterwards", async () => {
  const cwd = await localBoard("Alpha");
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const read = (await storage.loadState(cwd)).roadmap.revision;
    const create = () => fetch(`${server.url}/api/cards`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "page-create-2" }, body: JSON.stringify({ title: "Beta", baseRevision: read }),
    });
    assert.equal((await create()).status, 200);
    await takeOnline(bridge.url, cwd);
    // The reply was lost, say: the page sends the same request again, now that the board is online.
    const retried = await create();
    assert.equal(retried.status, 200, await retried.clone().text());
    const titles = (await storage.loadState(cwd)).roadmap.roadmapItems.map((item) => item.title);
    assert.deepEqual(titles.filter((title) => title === "Beta"), ["Beta"], `applied once: ${titles.join(", ")}`);
  } finally { await server.close(); }
});

// Retry records cross the move with the same meaning they had here.
const record = (key: string, fingerprint: string, response?: unknown) => ({
  key, scope: "POST /api/cards", fingerprint, createdAt: new Date().toISOString(),
  ...(response === undefined ? {} : { completedAt: new Date().toISOString(), response }),
});
async function stores(local: unknown[], online: unknown[]) {
  const from = join(root, "from");
  const to = join(root, "to");
  await mkdir(from, { recursive: true });
  await mkdir(to, { recursive: true });
  await writeFile(join(from, ".idempotency.json"), JSON.stringify({ version: 1, records: local }));
  await writeFile(join(to, ".idempotency.json"), JSON.stringify({ version: 1, records: online }));
  return { from, to, carried: async () => JSON.parse(await readFile(join(to, ".idempotency.json"), "utf8")).records as Array<{ key: string; fingerprint: string; response?: unknown }> };
}

test("carried retry records: a completed record replaces a pending one with the same request", async () => {
  const { from, to, carried } = await stores([record("k", "same", { ok: 1 })], [record("k", "same")]);
  await carryIdempotencyRecords(from, to);
  assert.deepEqual((await carried()).map((entry) => entry.response), [{ ok: 1 }]);
});

test("carried retry records: a pending record never replaces a completed one, and two completed ones count as one", async () => {
  let { from, to, carried } = await stores([record("k", "same")], [record("k", "same", { ok: 1 })]);
  await carryIdempotencyRecords(from, to);
  assert.deepEqual((await carried()).map((entry) => entry.response), [{ ok: 1 }]);
  ({ from, to, carried } = await stores([record("k", "same", { ok: 1 })], [record("k", "same", { ok: 1 })]));
  await carryIdempotencyRecords(from, to);
  assert.equal((await carried()).length, 1);
});

test("carried retry records: a pending record crosses as pending", async () => {
  const { from, to, carried } = await stores([record("k", "same")], []);
  await carryIdempotencyRecords(from, to);
  assert.deepEqual((await carried()).map((entry) => [entry.key, "response" in entry]), [["k", false]]);
});

test("the same retry key recorded for different requests here and online refuses the move, which leaves the board unchanged", async () => {
  const cwd = await localBoard("Alpha");
  const before = await storage.loadState(cwd);
  await writeFile(join(before.planningRoot, ".idempotency.json"), JSON.stringify({ version: 1, records: [record("k", "here", { ok: 1 })] }));
  const cache = onlineCacheRoot({ kind: "online", url: bridge.url, boardId: "roadmap" });
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, ".idempotency.json"), JSON.stringify({ version: 1, records: [record("k", "elsewhere", { ok: 2 })] }));
  await assert.rejects(takeOnline(bridge.url, cwd), /retry key/);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
  assert.deepEqual(JSON.parse(await readFile(before.roadmapPath, "utf8")), before.roadmap, "still the live board, unchanged");
  assert.equal(await storage.pathExists(join(before.planningRoot, "online-transfer.json")), false);
});

test("a page request whose writer died after saving, before recording its answer, is not applied again when retried after the move", async () => {
  const cwd = await localBoard("Alpha");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  const body = { title: "Beta", baseRevision: read };
  // The board server's own steps for that request, in a process killed right after the card is saved.
  const script = `
    import { runIdempotentBoardMutation, idempotencyFingerprint } from "./src/core/persistence.ts";
    import { createCard, loadState } from "./src/core/storage.ts";
    const cwd = ${JSON.stringify(cwd)};
    const { planningRoot } = await loadState(cwd);
    await runIdempotentBoardMutation({ planningRoot, idempotencyKey: "page-create-3", scope: "POST /api/cards",
      fingerprint: idempotencyFingerprint({ params: {}, body: ${JSON.stringify(body)} }),
      run: async () => { await createCard({ cwd, ...${JSON.stringify(body)} }); process.kill(process.pid, "SIGKILL"); } });`;
  const killed = await promisify(execFile)(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], { env: process.env }).then(() => null, (error) => error);
  assert.equal(killed?.signal, "SIGKILL", String(killed?.stderr ?? "it finished"));
  await takeOnline(bridge.url, cwd);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const retried = await fetch(`${server.url}/api/cards`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "page-create-3" }, body: JSON.stringify(body) });
    // As on this machine: the request's answer is unknown, so it is refused rather than applied again.
    assert.notEqual(retried.status, 200);
    assert.match(await retried.text(), /already in progress/);
    const titles = (await storage.loadState(cwd)).roadmap.roadmapItems.map((item) => item.title);
    assert.deepEqual(titles.filter((title) => title === "Beta"), ["Beta"], `applied once: ${titles.join(", ")}`);
  } finally { await server.close(); }
});
