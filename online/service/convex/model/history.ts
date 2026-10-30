// Board history: one small row per version (what happened, who, when) and a
// separate payload row. Full roadmaps are kept every SNAPSHOT_EVERY versions;
// versions in between store only the cards that changed, which keeps a busy
// board inside the free plan's database traffic. Listing history reads only
// the small rows.
import type { PlannedHistory } from "../../../../src/core/boardOperations";
import type { PlanbanHistoryEntry, PlanbanRoadmap, PlanbanRoadmapItem } from "../../../../src/core/types";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { noteCardChanges } from "./cardChanges";
import { addStored, sizeOf } from "./limits";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { packJson, packText, unpackJson } from "./codec";

export const SNAPSHOT_EVERY = 25;
export const MAX_HISTORY_VERSIONS = 1000;
const PRUNE_BATCH = 25;

/** Who made a change: the signed-in person, the connected app and whether a person or an agent acted. */
export interface Attribution {
  userId: string;
  clientName: string;
  actor: "user" | "agent";
  connectionId: string;
}

/** A board's rows in one generation. */
export interface BoardRows {
  boardId: string;
  generation: number;
}

interface Delta {
  meta: Omit<PlanbanRoadmap, "roadmapItems">;
  order: string[];
  /** Cards that changed since the previous version. A list, never an object keyed by card id. */
  changed: PlanbanRoadmapItem[];
}

function diff(previous: PlanbanRoadmap, next: PlanbanRoadmap): Delta {
  const before = new Map(previous.roadmapItems.map((item) => [item.id, JSON.stringify(item)]));
  const changed = next.roadmapItems.filter((item) => before.get(item.id) !== JSON.stringify(item));
  const { roadmapItems, ...meta } = next;
  return { meta, order: roadmapItems.map((item) => item.id), changed };
}

function apply(previous: PlanbanRoadmap, delta: Delta): PlanbanRoadmap {
  const items = new Map(previous.roadmapItems.map((item) => [item.id, item]));
  for (const item of delta.changed) items.set(item.id, item);
  return {
    ...delta.meta,
    roadmapItems: delta.order.map((id) => {
      const item = items.get(id);
      if (!item) throw new Error(`History is missing card ${id}.`);
      return item;
    }),
  } as PlanbanRoadmap;
}

async function payload(ctx: QueryCtx, at: BoardRows, version: number) {
  const row = await ctx.db.query("historyPayloads")
    .withIndex("by_board_version", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("version", version)).unique();
  if (!row) throw new Error(`History version ${version} of ${at.boardId} has no stored roadmap.`);
  return row;
}

export async function roadmapAtVersion(ctx: QueryCtx, at: BoardRows, version: number): Promise<PlanbanRoadmap | null> {
  const chain: Doc<"history">[] = [];
  for await (const row of ctx.db.query("history")
    .withIndex("by_board_version", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).lte("version", version))
    .order("desc")) {
    chain.push(row);
    if (row.snapshot) break;
  }
  if (chain.length === 0 || chain[0]!.version !== version) return null;
  const base = chain.pop()!;
  if (!base.snapshot) throw new Error(`History for ${at.boardId} has no snapshot before version ${version}.`);
  let roadmap = unpackJson<PlanbanRoadmap>((await payload(ctx, at, base.version)).snapshot!);
  for (const row of chain.reverse()) roadmap = apply(roadmap, unpackJson<Delta>((await payload(ctx, at, row.version)).delta!));
  return roadmap;
}

/** History versions after `after`, oldest first, each with its full roadmap. */
/**
 * Versions after `after`, rebuilt in order. `accept` sees each one as it is rebuilt and can stop
 * the page there (that version left out), so a caller with a byte budget never holds more than it allows.
 */
export async function historyPage(ctx: QueryCtx, at: BoardRows, after: number, limit: number, accept?: (version: { entry: PlanbanHistoryEntry; roadmap: PlanbanRoadmap }) => boolean) {
  const rows = await ctx.db.query("history")
    .withIndex("by_board_version", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).gt("version", after))
    .take(limit);
  const page: Array<{ entry: PlanbanHistoryEntry; roadmap: PlanbanRoadmap }> = [];
  let previous: PlanbanRoadmap | null = null;
  for (const row of rows) {
    const stored = await payload(ctx, at, row.version);
    const roadmap: PlanbanRoadmap | null = stored.snapshot
      ? unpackJson<PlanbanRoadmap>(stored.snapshot)
      : previous
        ? apply(previous, unpackJson<Delta>(stored.delta!))
        : await roadmapAtVersion(ctx, at, row.version);
    const version = { entry: row.entry as PlanbanHistoryEntry, roadmap: roadmap! };
    if (accept && !accept(version)) break;
    page.push(version);
    previous = roadmap;
  }
  return page;
}

/** The small per-version rows only, newest first; with `after`, only versions newer than it. */
export async function historyEntries(ctx: QueryCtx, at: BoardRows, after = 0): Promise<PlanbanHistoryEntry[]> {
  const entries: PlanbanHistoryEntry[] = [];
  const rows = ctx.db.query("history").withIndex("by_board_version", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).gt("version", after));
  for await (const row of rows.order("desc")) entries.push(row.entry as PlanbanHistoryEntry);
  return entries;
}

async function insertVersion(ctx: MutationCtx, at: BoardRows, version: number, entry: unknown, stored: { snapshot: PlanbanRoadmap } | { delta: Delta }) {
  const snapshot = "snapshot" in stored;
  const packed = snapshot ? packJson(stored.snapshot) : packJson(stored.delta);
  await ctx.db.insert("history", { ...at, version, entry, snapshot });
  await ctx.db.insert("historyPayloads", { ...at, version, ...(snapshot ? { snapshot: packed } : { delta: packed }) });
  await addStored(ctx, at, sizeOf(packed) + sizeOf(entry));
}

export async function recordHistory(ctx: MutationCtx, input: {
  board: Doc<"boards">;
  /** Defaults to the board's live generation. */
  generation?: number;
  previous: PlanbanRoadmap | null;
  committed: PlanbanRoadmap;
  history: PlannedHistory;
  docs: Array<{ cardId: string; kind: "spec" | "plan"; markdown: string }>;
  attribution: Attribution;
  now: string;
}): Promise<number> {
  const { board, previous, committed, history, docs, attribution, now } = input;
  const at = { boardId: board.boardId, generation: input.generation ?? board.generation };
  const version = board.historyVersion + 1;
  const entry: PlanbanHistoryEntry & { attribution: Omit<Attribution, "connectionId"> } = {
    version,
    roadmapRevision: committed.revision,
    createdAt: now,
    actor: attribution.actor,
    operation: history.operation,
    summary: history.summary,
    affectedCards: [...new Set(history.affectedCards)],
    affectedDocs: history.affectedDocs ?? [],
    attribution: { userId: attribution.userId, clientName: attribution.clientName, actor: attribution.actor },
  };
  const snapshot = !previous || version % SNAPSHOT_EVERY === 0;
  await insertVersion(ctx, at, version, entry, snapshot ? { snapshot: committed } : { delta: diff(previous!, committed) });
  for (const doc of docs) {
    const markdown = packText(doc.markdown);
    await ctx.db.insert("historyDocs", { ...at, version, cardId: doc.cardId, kind: doc.kind, markdown });
    await addStored(ctx, at, sizeOf(markdown));
  }
  // Faces on shared boards: who last changed each card this version touched.
  await noteCardChanges(ctx, at, [...entry.affectedCards, ...entry.affectedDocs.map((doc) => doc.cardId)], {
    userId: attribution.userId, agent: attribution.actor === "agent", clientName: attribution.actor === "agent" ? attribution.clientName : null, at: now, summary: history.summary,
  });
  await ctx.db.patch(board._id, { historyVersion: version });
  await pruneHistory(ctx, at, version - MAX_HISTORY_VERSIONS);
  return version;
}

/** Stores an uploaded history version as written by the local board. */
export async function importHistoryVersion(ctx: MutationCtx, at: BoardRows, entry: PlanbanHistoryEntry, roadmap: PlanbanRoadmap) {
  await insertVersion(ctx, at, entry.version, entry, { snapshot: roadmap });
}

/**
 * Drops versions at or below the cutoff in small batches, continuing in the
 * background until done. The first kept version becomes a snapshot, and the
 * last body of each document from the dropped versions moves to it, so every
 * kept version can still show its documents.
 */
export async function pruneHistory(ctx: MutationCtx, at: BoardRows, cutoff: number) {
  if (cutoff <= 0) return;
  const { boardId, generation } = at;
  const old = await ctx.db.query("history")
    .withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", generation).lte("version", cutoff))
    .take(PRUNE_BATCH);
  if (old.length === 0) return;
  const first = await ctx.db.query("history")
    .withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", generation).gt("version", old.at(-1)!.version))
    .first();
  // Pruning shrinks a board overall: the snapshot it may add is counted after
  // the removals, so it is never refused for being near the board's limit.
  let growth = 0;
  if (first && !first.snapshot) {
    const roadmap = await roadmapAtVersion(ctx, at, first.version);
    await ctx.db.patch(first._id, { snapshot: true });
    const was = await payload(ctx, at, first.version);
    const packed = packJson(roadmap);
    await ctx.db.patch(was._id, { snapshot: packed, delta: undefined });
    growth = sizeOf(packed) - sizeOf(was.delta ?? was.snapshot ?? new Uint8Array());
  }
  for (const row of old) {
    for (const doc of await ctx.db.query("historyDocs").withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", generation).eq("version", row.version)).collect()) {
      // The body that applies at the first kept version is the newest one at
      // or before it. If that is this pruned body, it moves to the first kept
      // version; otherwise a later body already covers the kept versions.
      const applies = first && await ctx.db.query("historyDocs")
        .withIndex("by_board_doc_version", (q) => q.eq("boardId", boardId).eq("generation", generation).eq("cardId", doc.cardId).eq("kind", doc.kind).lte("version", first.version))
        .order("desc")
        .first();
      if (first && applies?._id === doc._id) await ctx.db.patch(doc._id, { version: first.version });
      else {
        await ctx.db.delete(doc._id);
        await addStored(ctx, at, -sizeOf(doc.markdown));
      }
    }
    const gone = await payload(ctx, at, row.version);
    await ctx.db.delete(gone._id);
    await ctx.db.delete(row._id);
    await addStored(ctx, at, -(sizeOf(gone.snapshot ?? gone.delta ?? new Uint8Array()) + sizeOf(row.entry)));
  }
  await addStored(ctx, at, growth, { allowOverLimit: true });
  if (old.length === PRUNE_BATCH) await ctx.scheduler.runAfter(0, internal.historyMaintenance.prune, { ...at, cutoff });
}
