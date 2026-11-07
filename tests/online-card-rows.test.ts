// Online boards keep their cards in chunk rows (online/service/convex/model/
// roadmapStore.ts), so one card is read and written without the whole board.
// What agents and the page see must not change, and the bytes a one-card
// read or edit touches on a large board are pinned here so they can't creep
// back up.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import { createEmptyRoadmap, normalizeColumnPriorities } from "../src/core/boardOperations";
import { deflateSync, strToU8 } from "fflate";
import type { PlanbanRoadmap } from "../src/core/types";
import { onlineLogin } from "../src/core/online/login";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { takeOnline } from "../src/core/online/transfers";
import { CHUNK_BYTES, currentRoadmap, insertState, writeRoadmap } from "../online/service/convex/model/roadmapStore";
import { internal } from "../online/service/convex/_generated/api";
import { memoryService } from "./hosted-harness";
import { serviceBridge } from "./service-bridge";
import { largeBoardItems, largeRoadmap } from "./large-board";

const at = { boardId: "big", generation: 1 };
const rowsOf = (service: ReturnType<typeof memoryService>, table: string) => service.rows.filter((row) => row._table === table && row.boardId === at.boardId);
const stored = (service: ReturnType<typeof memoryService>) => rowsOf(service, "boardSizes")[0]?.bytes ?? 0;

function roadmap(): PlanbanRoadmap {
  return largeRoadmap(createEmptyRoadmap({ repoId: "big", title: "Big", now: "2026-11-07T00:00:00.000Z" }));
}

test("a board reads back exactly as written, field order included, and only changed chunks are rewritten", async () => {
  const service = memoryService();
  const board = roadmap();
  // Odd cards read back too: no position fields at all, and a card with very many metadata keys.
  const odd = { ...board.roadmapItems[5]! } as Record<string, unknown>;
  delete odd.priority;
  board.roadmapItems[5] = odd as never;
  board.roadmapItems[6] = { ...board.roadmapItems[6]!, metadata: Object.fromEntries(Array.from({ length: 1100 }, (_, index) => [`k${index}`, index])) };
  await insertState(service.ctx, at, board);
  assert.equal(JSON.stringify(await currentRoadmap(service.ctx, at)), JSON.stringify(board));
  const chunks = rowsOf(service, "boardCards");
  assert.ok(chunks.length > 10, `${chunks.length} chunks`);
  assert.equal(stored(service), chunks.reduce((sum, row) => sum + row.cards.byteLength, 0) + rowsOf(service, "boardState")[0].index.byteLength);

  // One card's text changes: one chunk is written, and the index.
  const before = service.meter.written;
  const edited = { ...board, revision: board.revision + 1, roadmapItems: board.roadmapItems.map((item) => item.id === "card-200" ? { ...item, summary: "Changed" } : item) };
  await writeRoadmap(service.ctx, at, board, edited);
  const written = service.meter.written - before;
  assert.ok(written < 20_000, `one card edit wrote ${written} bytes`);
  assert.equal(JSON.stringify(await currentRoadmap(service.ctx, at)), JSON.stringify(edited));

  // A whole column renumbered (a move) rewrites only the index.
  const renumbered = { ...edited, revision: edited.revision + 1, roadmapItems: edited.roadmapItems.map((item) => item.status === "archived" ? { ...item, boardRank: (item.boardRank ?? 0) + 1000 } : item) };
  const beforeMove = service.meter.written;
  await writeRoadmap(service.ctx, at, edited, renumbered);
  assert.ok(service.meter.written - beforeMove < 8_000, `renumbering wrote ${service.meter.written - beforeMove} bytes`);
  assert.equal(JSON.stringify(await currentRoadmap(service.ctx, at)), JSON.stringify(renumbered));

  // A card that grows past a chunk's size splits that chunk; deleted cards leave it; stored size stays right.
  const grown = { ...renumbered, revision: renumbered.revision + 1, roadmapItems: renumbered.roadmapItems.filter((item) => item.id !== "card-300").map((item) => item.id === "card-201" ? { ...item, summary: "x".repeat(CHUNK_BYTES) } : item) };
  await writeRoadmap(service.ctx, at, renumbered, grown);
  const added = [...grown.roadmapItems, { ...grown.roadmapItems[0]!, id: "brand-new", title: "New" }];
  const withNew = { ...grown, revision: grown.revision + 1, roadmapItems: added };
  await writeRoadmap(service.ctx, at, grown, withNew);
  assert.equal(JSON.stringify(await currentRoadmap(service.ctx, at)), JSON.stringify(withNew));
  for (const row of rowsOf(service, "boardCards")) {
    const cards = JSON.stringify(row.cards).length;
    assert.ok(cards > 0);
  }
  assert.equal(stored(service), rowsOf(service, "boardCards").reduce((sum, row) => sum + row.cards.byteLength, 0) + rowsOf(service, "boardState")[0].index.byteLength);
});

test("boards stored whole move into chunks and back, reading the same throughout", async () => {
  const service = memoryService();
  const board = roadmap();
  // The rollback's switch: new boards are stored whole, as before this change.
  await service.call(internal.maintenance.joinRoadmaps, {});
  await insertState(service.ctx, at, board);
  const state = rowsOf(service, "boardState")[0];
  assert.ok(state.roadmap && !state.index, "stored whole");
  const whole = stored(service);
  // A board stored whole is still written whole.
  const edited = { ...board, revision: board.revision + 1, roadmapItems: board.roadmapItems.map((item) => item.id === "card-001" ? { ...item, title: "Edited whole" } : item) };
  await writeRoadmap(service.ctx, at, board, edited);
  assert.ok(rowsOf(service, "boardState")[0].roadmap);
  assert.equal(rowsOf(service, "boardCards").length, 0);

  await service.call(internal.maintenance.splitRoadmaps, {});
  await service.runJobs();
  const afterSplit = await service.call(internal.maintenance.roadmapStorage, {});
  assert.deepEqual([afterSplit.whole, afterSplit.chunked, afterSplit.unmoved, afterSplit.newBoards, afterSplit.isDone], [0, 1, [], "chunked", true]);
  assert.deepEqual([afterSplit.runs.split.finished, afterSplit.runs.split.moved, afterSplit.runs.split.kept], [true, 1, 0]);
  assert.ok(!rowsOf(service, "boardState")[0].roadmap && rowsOf(service, "boardState")[0].index);
  assert.equal(JSON.stringify(await currentRoadmap(service.ctx, at)), JSON.stringify(edited));
  assert.equal(stored(service), rowsOf(service, "boardCards").reduce((sum, row) => sum + row.cards.byteLength, 0) + rowsOf(service, "boardState")[0].index.byteLength);
  // Running it again changes nothing.
  await service.call(internal.maintenance.splitRoadmaps, {});
  await service.runJobs();
  const again = (await service.call(internal.maintenance.roadmapStorage, {})).runs.split;
  assert.deepEqual([again.finished, again.moved, again.unchanged], [true, 0, 1]);
  // And after the split, new boards are stored in chunks again.
  await insertState(service.ctx, { boardId: "another", generation: 2 }, roadmap());
  assert.ok(service.rows.find((row) => row._table === "boardState" && row.boardId === "another").index);

  await service.call(internal.maintenance.joinRoadmaps, {});
  await service.runJobs();
  const afterJoin = await service.call(internal.maintenance.roadmapStorage, {});
  assert.deepEqual([afterJoin.whole, afterJoin.chunked, afterJoin.newBoards, afterJoin.runs.join.finished, afterJoin.runs.join.moved], [2, 0, "whole", true, 2]);
  assert.equal(rowsOf(service, "boardCards").length, 0);
  assert.equal(JSON.stringify(await currentRoadmap(service.ctx, at)), JSON.stringify(edited));
  assert.ok(Math.abs(stored(service) - whole) < 2_000, "the stored size is back to the whole roadmap's");
});

test("a board that can't be moved is recorded and skipped, and the rest still move", async () => {
  const service = memoryService();
  await service.call(internal.maintenance.joinRoadmaps, {});
  await insertState(service.ctx, { boardId: "first", generation: 1 }, roadmap());
  await insertState(service.ctx, { boardId: "broken", generation: 2 }, roadmap());
  await insertState(service.ctx, { boardId: "last", generation: 3 }, roadmap());
  // Bytes that don't unpack: the step fails on this board.
  service.rows.find((row) => row._table === "boardState" && row.boardId === "broken").roadmap = new Uint8Array([1, 2, 3]).buffer;
  await service.call(internal.maintenance.splitRoadmaps, {});
  await service.runJobs();
  const status = await service.call(internal.maintenance.roadmapStorage, {});
  assert.deepEqual([status.whole, status.chunked, status.runs.split.finished, status.runs.split.moved, status.runs.split.kept], [1, 2, true, 2, 1]);
  assert.equal(status.unmoved.length, 1);
  assert.deepEqual([status.unmoved[0].boardId, status.unmoved[0].storedAs], ["broken", "whole"]);
  assert.match(status.unmoved[0].reason, /the step failed/);
});

test("a write planned from another revision than the one stored is refused", async () => {
  const service = memoryService();
  const board = roadmap();
  await insertState(service.ctx, at, board);
  const stale = { ...board, revision: board.revision - 1 };
  await assert.rejects(writeRoadmap(service.ctx, at, stale, { ...board, revision: board.revision + 1 }), /planned from revision/);
});

test("position fields set to undefined read back as absent, as when the whole roadmap was stored", async () => {
  const service = memoryService();
  const board = roadmap();
  board.roadmapItems[0] = { ...board.roadmapItems[0]!, priority: undefined as never, groupRank: undefined as never };
  await insertState(service.ctx, at, board);
  const back = await currentRoadmap(service.ctx, at);
  // What the whole roadmap stored as JSON gave back: those keys gone.
  assert.deepEqual(back, JSON.parse(JSON.stringify(board)));
  assert.equal("priority" in back.roadmapItems[0]!, false);
});

let root: string;
let bridge: Awaited<ReturnType<typeof serviceBridge>>;
const savedHome = process.env.PLANBAN_HOME;

async function startBridge() {
  root = await mkdtemp(join(tmpdir(), "planban-card-rows-"));
  process.env.PLANBAN_HOME = join(root, "home");
  bridge = await serviceBridge();
  resetCopyChecks();
}

async function bigOnlineBoard() {
  const cwd = join(root, "project");
  const state = await storage.initializeProject({ cwd, repoId: "revival-sized", title: "Revival sized", updateAgents: false });
  const items = largeBoardItems();
  // A Group with a child, so get-card's ancestry has something to show.
  items[1] = { ...items[1]!, isGroup: true };
  items[2] = { ...items[2]!, parentId: items[1]!.id, boardRank: null, groupRank: 1, status: items[1]!.status };
  await storage.saveRoadmap(state, { ...state.roadmap, roadmapItems: normalizeColumnPriorities(items) });
  await storage.writeDoc({ cwd, cardId: "card-000", kind: "spec", markdown: "# Spec\n\nText." });
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, cwd);
  return cwd;
}

async function closeBridge() {
  await bridge.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
}

const readOf = async <T>(run: () => Promise<T>) => {
  const before = bridge.service.meter.read;
  const value = await run();
  return { value, read: bridge.service.meter.read - before };
};

test("on a Revival-sized board, one card is read and edited without reading the whole board", { timeout: 180_000 }, async () => {
  await startBridge();
  try {
    const cwd = await bigOnlineBoard();
    const full = await readOf(() => storage.loadState(cwd));
    const card = await readOf(() => storage.loadCard(cwd, "card-002"));
    const fromBoard = full.value.roadmap.roadmapItems.find((item) => item.id === "card-002")!;
    // What get-card shows is the same as from the whole board.
    assert.deepEqual(card.value, { revision: full.value.roadmap.revision, card: fromBoard, ancestry: storage.cardAncestry(full.value.roadmap, "card-002") });
    assert.equal(JSON.stringify(card.value.card), JSON.stringify(fromBoard), "field order too");
    // Pinned: a whole-board read costs about what one compressed copy did (chunk overhead aside).
    const blob = deflateSync(strToU8(JSON.stringify(full.value.roadmap)), { level: 6 }).byteLength;
    assert.ok(full.read < 1.3 * blob, `board read ${full.read} bytes, one compressed copy ${blob}`);
    // Pinned: a one-card read stays a small fraction of a board read.
    assert.ok(card.read < 25_000, `get-card read ${card.read} bytes`);
    assert.ok(full.read > 8 * card.read, `board read ${full.read} bytes, card ${card.read}`);
    const doc = await readOf(() => storage.readDoc({ cwd, cardId: "card-000", kind: "spec" }));
    assert.ok(doc.read < 25_000, `read-doc read ${doc.read} bytes`);
    const goals = await readOf(() => storage.readGoals({ cwd }));
    assert.ok(goals.read < 10_000, `goals read ${goals.read} bytes`);

    // An edit writes the card's chunk, not the board.
    const before = bridge.service.meter.written;
    const edit = await readOf(() => storage.updateCard({ cwd, cardId: "card-050", summary: "Edited", baseRevision: full.value.roadmap.revision, actor: "agent" }));
    const written = bridge.service.meter.written - before;
    assert.ok(written < 40_000, `update-card wrote ${written} bytes`);
    // Pinned: an edit reads the board once (the planning rules need all of it), never twice.
    assert.ok(edit.read < 1.4 * blob, `update-card read ${edit.read} bytes, one compressed copy ${blob}`);

    // A card that isn't there says so, as before.
    await assert.rejects(storage.loadCard(cwd, "no-such-card"), /Card not found: no-such-card/);
    // A service from before this change has no /cards address: the whole board is read instead.
    bridge.control.intercept = async (path) => (path.includes("/cards/") ? { status: 404, body: { error: { code: "not_found", message: "Unknown endpoint." } } } : undefined);
    const older = await storage.loadCard(cwd, "card-050");
    assert.equal(older.card.summary, "Edited");
    bridge.control.intercept = undefined;
  } finally {
    await closeBridge();
  }
});
