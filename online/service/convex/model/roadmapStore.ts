// Where a board's roadmap is stored. A board's state row holds a small index
// (the roadmap's own fields, the cards' order, positions and the chunk each
// card is in, and the dashboard's counts); the cards themselves are in
// boardCards rows of about CHUNK_BYTES each. Reading one card reads the index
// and one chunk; an edit rewrites only the chunks whose cards changed, and a
// move that renumbers a column rewrites only the index. Chunks are the size
// of deflate's window, so the whole board compresses about as well as one
// blob did and reading all of it costs about the same.
//
// Boards stored before this keep their whole roadmap in the state row
// (`roadmap`). They are read as before, written in the same shape, and moved
// over by maintenance:splitRoadmaps; maintenance:joinRoadmaps moves them back.
import type { PlanbanRoadmap, PlanbanRoadmapItem } from "../../../../src/core/types";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { packJson, unpackJson } from "./codec";
import { fail } from "./errors";
import type { BoardRows } from "./history";
import { addStored, sizeOf } from "./limits";

/** Raw JSON per chunk: deflate looks back 32 KB, so bigger chunks would barely compress better. */
export const CHUNK_BYTES = 32 * 1024;

/** A card's position fields: they change for a whole column when one card moves, so they live in the index. */
const PLACES = ["priority", "boardRank", "groupRank"] as const;
/** In the index, for a card that has no such field at all (kept apart from null so a card reads back exactly). */
const ABSENT = "-";

export interface BoardSummary {
  /** Cards (not Groups) per column. */
  cardCounts: Record<string, number>;
  /** Active cards (In Progress, Up Next) whose next action is the owner's: the board's own "Needs you". */
  needYou: number;
}

interface RoadmapIndex {
  format: 1;
  meta: Omit<PlanbanRoadmap, "roadmapItems">;
  ids: string[];
  chunks: number[];
  places: unknown[][];
  /** Each card's Group, so a Group's children can be found without reading every card. */
  parents: Array<string | null>;
  nextChunk: number;
  summary: BoardSummary;
}

export function boardSummary(roadmap: PlanbanRoadmap): BoardSummary {
  const cardCounts: Record<string, number> = {};
  let needYou = 0;
  for (const item of roadmap.roadmapItems) {
    if (item.isGroup) continue;
    cardCounts[item.status] = (cardCounts[item.status] ?? 0) + 1;
    if ((item.status === "in-progress" || item.status === "up-next") && /^\s*Owner:/.test(item.nextAction ?? "")) needYou += 1;
  }
  return { cardCounts, needYou };
}

/**
 * A position field the card has. One set to undefined counts as absent: the
 * whole roadmap was stored as JSON, which drops it, so it never read back.
 */
function hasPlace(item: Record<string, unknown>, field: string) {
  return item[field] !== undefined;
}

/** The card as a chunk stores it: position fields kept in place (so key order survives) but blanked. */
function stored(item: PlanbanRoadmapItem): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...item };
  for (const field of PLACES) {
    if (hasPlace(copy, field)) copy[field] = null;
    else delete copy[field];
  }
  return copy;
}

function placesOf(item: PlanbanRoadmapItem): unknown[] {
  const fields = item as unknown as Record<string, unknown>;
  return PLACES.map((field) => (hasPlace(fields, field) ? fields[field] : ABSENT));
}

function restored(card: Record<string, unknown>, places: unknown[]): PlanbanRoadmapItem {
  const item = { ...card };
  PLACES.forEach((field, index) => { if (places[index] !== ABSENT) item[field] = places[index]; });
  return item as unknown as PlanbanRoadmapItem;
}

function metaOf(roadmap: PlanbanRoadmap): RoadmapIndex["meta"] {
  const { roadmapItems: _items, ...meta } = roadmap;
  return meta;
}

/** Puts the roadmap's own fields back in their original order around the cards. */
function assemble(meta: RoadmapIndex["meta"], items: PlanbanRoadmapItem[], itemsAt: number): PlanbanRoadmap {
  const entries: Array<[string, unknown]> = Object.entries(meta);
  entries.splice(itemsAt, 0, ["roadmapItems", items]);
  return Object.fromEntries(entries) as unknown as PlanbanRoadmap;
}

/** Where roadmapItems sits among the roadmap's keys, so it reads back in the same order. */
function itemsPosition(roadmap: PlanbanRoadmap) {
  const at = Object.keys(roadmap).indexOf("roadmapItems");
  return at < 0 ? Object.keys(roadmap).length : at;
}

type StateRow = Doc<"boardState">;

export async function stateRow(ctx: QueryCtx, at: BoardRows): Promise<StateRow> {
  const row = await ctx.db.query("boardState")
    .withIndex("by_board_generation", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).unique();
  if (!row) fail("not_found", `Online Board not found: ${at.boardId}`);
  return row!;
}

function indexOf(state: StateRow): RoadmapIndex & { itemsAt?: number } {
  return unpackJson<RoadmapIndex & { itemsAt?: number }>(state.index!);
}

async function chunkRows(ctx: QueryCtx, at: BoardRows) {
  return ctx.db.query("boardCards").withIndex("by_board_generation_chunk", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).collect();
}

async function chunkRow(ctx: QueryCtx, at: BoardRows, chunk: number) {
  return ctx.db.query("boardCards").withIndex("by_board_generation_chunk", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("chunk", chunk)).unique();
}

/** The whole roadmap. */
export async function currentRoadmap(ctx: QueryCtx, at: BoardRows, state?: StateRow): Promise<PlanbanRoadmap> {
  const row = state ?? await stateRow(ctx, at);
  if (row.roadmap) return unpackJson<PlanbanRoadmap>(row.roadmap);
  const index = indexOf(row);
  const cards = new Map<string, Record<string, unknown>>();
  for (const chunk of await chunkRows(ctx, at)) {
    for (const card of unpackJson<Array<Record<string, unknown>>>(chunk.cards)) cards.set(card.id as string, card);
  }
  const items = index.ids.map((id, position) => {
    const card = cards.get(id);
    if (!card) throw new Error(`Online Board ${at.boardId} is missing card ${id}.`);
    return restored(card, index.places[position]!);
  });
  return assemble(index.meta, items, index.itemsAt ?? Object.keys(index.meta).length);
}

/**
 * Some cards of the board, reading only the chunks they are in, with the
 * board's revision. Cards that don't exist are left out.
 */
export async function someCards(ctx: QueryCtx, at: BoardRows, state?: StateRow) {
  const row = state ?? await stateRow(ctx, at);
  if (row.roadmap) {
    const roadmap = unpackJson<PlanbanRoadmap>(row.roadmap);
    const byId = new Map(roadmap.roadmapItems.map((item) => [item.id, item]));
    return {
      revision: roadmap.revision,
      card: async (id: string) => byId.get(id) ?? null,
      childIds: (id: string) => roadmap.roadmapItems.filter((item) => item.parentId === id).map((item) => item.id),
    };
  }
  const index = indexOf(row);
  const position = new Map(index.ids.map((id, at) => [id, at]));
  const loaded = new Map<number, Map<string, Record<string, unknown>>>();
  return {
    revision: index.meta.revision,
    async card(id: string): Promise<PlanbanRoadmapItem | null> {
      const at_ = position.get(id);
      if (at_ === undefined) return null;
      const chunk = index.chunks[at_]!;
      if (!loaded.has(chunk)) {
        const found = await chunkRow(ctx, at, chunk);
        loaded.set(chunk, new Map((found ? unpackJson<Array<Record<string, unknown>>>(found.cards) : []).map((card) => [card.id as string, card])));
      }
      const card = loaded.get(chunk)!.get(id);
      if (!card) throw new Error(`Online Board ${at.boardId} is missing card ${id}.`);
      return restored(card, index.places[at_]!);
    },
    /** A Group's direct children, in board order. */
    childIds: (id: string) => index.ids.filter((_, position) => index.parents[position] === id),
  };
}

/** The dashboard's counts for a board, without reading its cards. */
export async function storedSummary(ctx: QueryCtx, at: BoardRows): Promise<BoardSummary> {
  const row = await stateRow(ctx, at);
  if (row.roadmap) return boardSummary(unpackJson<PlanbanRoadmap>(row.roadmap));
  return indexOf(row).summary;
}

function rawSize(card: Record<string, unknown>) {
  return JSON.stringify(card).length;
}

/** Splits cards, in board order, into runs of about CHUNK_BYTES (a bigger card is a chunk of its own). */
function runs<T>(cards: T[], size: (card: T) => number): T[][] {
  const out: T[][] = [];
  let bytes = Infinity;
  for (const card of cards) {
    const add = size(card);
    if (bytes + add > CHUNK_BYTES) {
      out.push([]);
      bytes = 0;
    }
    out.at(-1)!.push(card);
    bytes += add;
  }
  return out;
}

function packedIndex(index: RoadmapIndex & { itemsAt?: number }) {
  return packJson(index);
}

/** A roadmap laid out in chunks from scratch, in memory: each chunk's packed cards, and the index. */
function chunked(roadmap: PlanbanRoadmap) {
  const cards = roadmap.roadmapItems.map((item) => ({ item, card: stored(item) }));
  const chunkOf = new Map<string, number>();
  const chunks: ArrayBuffer[] = [];
  for (const run of runs(cards, ({ card }) => rawSize(card))) {
    for (const { item } of run) chunkOf.set(item.id, chunks.length);
    chunks.push(packJson(run.map(({ card }) => card)));
  }
  const index: RoadmapIndex & { itemsAt: number } = {
    format: 1, meta: metaOf(roadmap), itemsAt: itemsPosition(roadmap),
    ids: roadmap.roadmapItems.map((item) => item.id),
    chunks: roadmap.roadmapItems.map((item) => chunkOf.get(item.id)!),
    places: roadmap.roadmapItems.map(placesOf), parents: roadmap.roadmapItems.map((item) => item.parentId ?? null),
    nextChunk: chunks.length, summary: boardSummary(roadmap),
  };
  return { chunks, index: packedIndex(index), bytes: chunks.reduce((sum, chunk) => sum + sizeOf(chunk), 0) };
}

/** Reads a chunked layout back in memory, as currentRoadmap would read it from its rows. */
function fromChunks(layout: ReturnType<typeof chunked>): PlanbanRoadmap {
  const index = unpackJson<RoadmapIndex & { itemsAt: number }>(layout.index);
  const cards = new Map(layout.chunks.flatMap((chunk) => unpackJson<Array<Record<string, unknown>>>(chunk)).map((card) => [card.id as string, card]));
  return assemble(index.meta, index.ids.map((id, position) => restored(cards.get(id)!, index.places[position]!)), index.itemsAt);
}

/** The cards written into chunk rows from scratch, and the index for them. Inserts the rows. */
async function insertChunks(ctx: MutationCtx, at: BoardRows, roadmap: PlanbanRoadmap, layout = chunked(roadmap)) {
  for (const [chunk, cards] of layout.chunks.entries()) await ctx.db.insert("boardCards", { ...at, chunk, cards });
  return layout;
}

/** New boards are stored in chunks, unless maintenance:joinRoadmaps asked for the old shape (a rollback under way). */
async function newBoardsWhole(ctx: QueryCtx) {
  const flag = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", WHOLE_ROADMAPS)).unique();
  return (flag?.value ?? 0) === 1;
}
export const WHOLE_ROADMAPS = "wholeRoadmaps";

/** A new board generation's state row, with its roadmap and goals. Counts what it stores. */
export async function insertState(ctx: MutationCtx, at: BoardRows, roadmap: PlanbanRoadmap, goals?: ArrayBuffer) {
  if (await newBoardsWhole(ctx)) {
    const packed = packJson(roadmap);
    await ctx.db.insert("boardState", { ...at, roadmap: packed, ...(goals ? { goals } : {}) });
    await addStored(ctx, at, sizeOf(packed) + (goals ? sizeOf(goals) : 0));
    return;
  }
  const { index, bytes } = await insertChunks(ctx, at, roadmap);
  await ctx.db.insert("boardState", { ...at, index, ...(goals ? { goals } : {}) });
  await addStored(ctx, at, bytes + sizeOf(index) + (goals ? sizeOf(goals) : 0));
}

/**
 * Stores `next` in place of `previous` (the roadmap as read in this same
 * transaction). Only the chunks whose cards changed are written. Counts the
 * change in stored size.
 */
export async function writeRoadmap(ctx: MutationCtx, at: BoardRows, previous: PlanbanRoadmap, next: PlanbanRoadmap, state?: StateRow) {
  const row = state ?? await stateRow(ctx, at);
  if (row.roadmap) {
    const was = sizeOf(row.roadmap);
    const packed = packJson(next);
    await ctx.db.patch(row._id, { roadmap: packed });
    await addStored(ctx, at, sizeOf(packed) - was);
    return;
  }
  // Read before anything is patched: a document read earlier may be the same object.
  const indexWas = sizeOf(row.index!);
  const index = indexOf(row);
  // The chunks to rewrite are worked out from `previous`, so it must be what is stored.
  if (index.meta.revision !== previous.revision) {
    throw new Error(`Online Board ${at.boardId} is at revision ${index.meta.revision}, but the change was planned from revision ${previous.revision}.`);
  }
  const chunkOf = new Map(index.ids.map((id, position) => [id, index.chunks[position]!]));
  const before = new Map(previous.roadmapItems.map((item) => [item.id, JSON.stringify(stored(item))]));
  const dirty = new Set<number>();
  // Each chunk's raw size now, so new cards can join the last chunk while it has room.
  const chunkBytes = new Map<number, number>();
  for (const item of previous.roadmapItems) {
    const chunk = chunkOf.get(item.id)!;
    chunkBytes.set(chunk, (chunkBytes.get(chunk) ?? 0) + before.get(item.id)!.length);
  }
  let nextChunk = index.nextChunk;
  const nextIds = new Set(next.roadmapItems.map((item) => item.id));
  for (const item of previous.roadmapItems) if (!nextIds.has(item.id)) dirty.add(chunkOf.get(item.id)!);
  const chunks: number[] = [];
  const cards = new Map<string, Record<string, unknown>>();
  for (const item of next.roadmapItems) {
    const card = stored(item);
    cards.set(item.id, card);
    let chunk = chunkOf.get(item.id);
    if (chunk === undefined) {
      const last = nextChunk - 1;
      const size = rawSize(card);
      if (last >= 0 && chunkBytes.has(last) && chunkBytes.get(last)! + size <= CHUNK_BYTES) chunk = last;
      else chunk = nextChunk++;
      chunkBytes.set(chunk, (chunkBytes.get(chunk) ?? 0) + size);
      chunkOf.set(item.id, chunk);
      dirty.add(chunk);
    } else if (before.get(item.id) !== JSON.stringify(card)) {
      dirty.add(chunk);
    }
    chunks.push(chunk);
  }
  let delta = 0;
  for (const chunk of [...dirty].sort((a, b) => a - b)) {
    const members = next.roadmapItems.filter((item) => chunkOf.get(item.id) === chunk);
    const existing = await chunkRow(ctx, at, chunk);
    if (existing) delta -= sizeOf(existing.cards);
    if (members.length === 0) {
      if (existing) await ctx.db.delete(existing._id);
      continue;
    }
    // A chunk that grew past its size splits: the first run keeps its number.
    const [first, ...rest] = runs(members, (item) => rawSize(cards.get(item.id)!));
    const write = async (number: number, run: PlanbanRoadmapItem[], row: Doc<"boardCards"> | null) => {
      const packed = packJson(run.map((item) => cards.get(item.id)!));
      if (row) await ctx.db.patch(row._id, { cards: packed });
      else await ctx.db.insert("boardCards", { ...at, chunk: number, cards: packed });
      delta += sizeOf(packed);
    };
    await write(chunk, first!, existing);
    for (const run of rest) {
      const number = nextChunk++;
      for (const item of run) chunkOf.set(item.id, number);
      await write(number, run, null);
    }
  }
  const packed = packedIndex({
    format: 1, meta: metaOf(next), itemsAt: itemsPosition(next),
    ids: next.roadmapItems.map((item) => item.id),
    chunks: next.roadmapItems.map((item) => chunkOf.get(item.id)!),
    places: next.roadmapItems.map(placesOf), parents: next.roadmapItems.map((item) => item.parentId ?? null),
    nextChunk, summary: boardSummary(next),
  });
  await ctx.db.patch(row._id, { index: packed });
  await addStored(ctx, at, delta + sizeOf(packed) - indexWas);
}

/** The largest packed chunk a move will write, well inside Convex's 1 MB per document. */
const MAX_CHUNK_BYTES = 900 * 1024;

/**
 * Why a board stored whole can't be moved into chunks as it is, or null when
 * it can. Worked out in memory, before anything is written.
 */
function cannotSplit(roadmap: PlanbanRoadmap, layout: ReturnType<typeof chunked>): string | null {
  const largest = Math.max(0, ...layout.chunks.map((chunk) => sizeOf(chunk)));
  if (largest > MAX_CHUNK_BYTES || sizeOf(layout.index) > MAX_CHUNK_BYTES) return `a chunk would be ${Math.ceil(Math.max(largest, sizeOf(layout.index)) / 1024)} KB, over the ${MAX_CHUNK_BYTES / 1024} KB a move writes`;
  if (JSON.stringify(fromChunks(layout)) !== JSON.stringify(roadmap)) return "the board would not read back exactly from chunks";
  return null;
}

/**
 * Moves a state row stored whole into chunks. Returns "moved", "already" when
 * it was not stored whole, or the reason it was left as it was. The check is
 * made before writing; the card rows are written first and the state row last,
 * so a step that fails part way leaves the board reading its whole roadmap
 * (and any stray card rows are cleared by the next attempt).
 */
export async function splitState(ctx: MutationCtx, row: StateRow): Promise<"moved" | "already" | { kept: string }> {
  if (!row.roadmap) return "already";
  const at = { boardId: row.boardId, generation: row.generation };
  const whole = row.roadmap;
  const roadmap = unpackJson<PlanbanRoadmap>(whole);
  const layout = chunked(roadmap);
  const reason = cannotSplit(roadmap, layout);
  if (reason) return { kept: reason };
  for (const stray of await chunkRows(ctx, at)) await ctx.db.delete(stray._id);
  await insertChunks(ctx, at, roadmap, layout);
  await ctx.db.patch(row._id, { index: layout.index, roadmap: undefined, moveIssue: undefined });
  await addStored(ctx, at, layout.bytes + sizeOf(layout.index) - sizeOf(whole), { allowOverLimit: true });
  return "moved";
}

/** Moves a chunked state row back to one whole roadmap (the rollback). */
export async function joinState(ctx: MutationCtx, row: StateRow): Promise<"moved" | "already" | { kept: string }> {
  if (row.roadmap || !row.index) return "already";
  const at = { boardId: row.boardId, generation: row.generation };
  const roadmap = await currentRoadmap(ctx, at, row);
  const packed = packJson(roadmap);
  // A board that grew past what one document holds can't go back to one whole roadmap.
  if (sizeOf(packed) > MAX_CHUNK_BYTES) return { kept: `the whole roadmap would be ${Math.ceil(sizeOf(packed) / 1024)} KB, over the ${MAX_CHUNK_BYTES / 1024} KB one document can safely hold` };
  let bytes = sizeOf(row.index);
  for (const chunk of await chunkRows(ctx, at)) {
    bytes += sizeOf(chunk.cards);
    await ctx.db.delete(chunk._id);
  }
  await ctx.db.patch(row._id, { roadmap: packed, index: undefined, moveIssue: undefined });
  await addStored(ctx, at, sizeOf(packed) - bytes, { allowOverLimit: true });
  return "moved";
}

/** Stored bytes of a state row's roadmap, for measuring a board from scratch (limits:backfillBoard). */
export function stateBytes(row: StateRow) {
  return sizeOf(row.roadmap ?? row.index ?? new Uint8Array());
}
