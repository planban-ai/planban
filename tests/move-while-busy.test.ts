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
import { takeOnline } from "../src/core/online/transfers";
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
