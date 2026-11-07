// Housekeeping: idempotency records expire after seven days, uploads
// abandoned for a day are cancelled so their board id is released, and used
// command-line sign-in tokens are forgotten once too old to exchange anyway.
import { PRESENCE_KEEP_MS } from "./model/presence";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { abortTransfer } from "./model/transfer";
import { joinState, splitState, WHOLE_ROADMAPS } from "./model/roadmapStore";

const OPERATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ABANDONED_TRANSFER_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;

export const expireOperations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = new Date(Date.now() - OPERATION_TTL_MS).toISOString();
    const old = await ctx.db.query("operations").withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff)).take(BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === BATCH) await ctx.scheduler.runAfter(0, internal.maintenance.expireOperations, {});
  },
});

/** "Working on a card" rows quiet for a day are removed, in batches (Spec point 20). */
export const expirePresence = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db.query("presence").withIndex("by_active", (q) => q.lt("lastActiveAt", Date.now() - PRESENCE_KEEP_MS)).take(BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === BATCH) await ctx.scheduler.runAfter(0, internal.maintenance.expirePresence, {});
  },
});

export const cancelAbandonedTransfers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = new Date(Date.now() - ABANDONED_TRANSFER_MS).toISOString();
    const abandoned = await ctx.db.query("transfers").withIndex("by_state_updated", (q) => q.eq("state", "open").lt("updatedAt", cutoff)).take(BATCH);
    for (const transfer of abandoned) await abortTransfer(ctx, transfer);
    if (abandoned.length === BATCH) await ctx.scheduler.runAfter(0, internal.maintenance.cancelAbandonedTransfers, {});
  },
});

export const expireMachineExchanges = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = new Date().toISOString();
    const old = await ctx.db.query("machineExchanges").withIndex("by_expiresAt", (q) => q.lt("expiresAt", now)).take(BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === BATCH) await ctx.scheduler.runAfter(0, internal.maintenance.expireMachineExchanges, {});
  },
});

/** Daily usage records are needed only for the current day; a week is kept. */
export const expireUsage = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const old = await ctx.db.query("usage").withIndex("by_day", (q) => q.lt("day", cutoff)).take(BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === BATCH) await ctx.scheduler.runAfter(0, internal.maintenance.expireUsage, {});
  },
});

/** Expired invitations are kept a week for the owner's list, then removed in batches. */
export const expireInvites = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const old = await ctx.db.query("invites").withIndex("by_expiry", (q) => q.lt("expiresAt", cutoff)).take(BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === BATCH) await ctx.scheduler.runAfter(0, internal.maintenance.expireInvites, {});
  },
});

/**
 * Moves every board stored as one whole roadmap into per-card chunks
 * (model/roadmapStore.ts), one board per step, continuing in the background
 * until done. A board that can't be moved (it wouldn't read back exactly, or
 * a step failed) keeps its whole roadmap, gets the reason recorded on it and
 * is skipped, so the rest still move. Safe to run again: moved boards are
 * left alone and skipped ones are tried again.
 * Run once after deploying:  npx convex run maintenance:splitRoadmaps
 * Then check:                npx convex run maintenance:roadmapStorage
 */
export const splitRoadmaps = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => roadmapStep(ctx, "split", cursor ?? null),
});

/**
 * The rollback of splitRoadmaps: every board back to one whole roadmap, and
 * new boards made that way, so the code from before can be deployed again
 * once roadmapStorage says it has finished with every board stored whole.
 * npx convex run maintenance:joinRoadmaps
 */
export const joinRoadmaps = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => roadmapStep(ctx, "join", cursor ?? null),
});

/** Scheduled step of a move: one board, so a step never reads or writes more than about one board's worth. */
export const roadmapMoveStep = internalMutation({
  args: { direction: v.union(v.literal("split"), v.literal("join")), boardStateId: v.id("boardState"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { direction, boardStateId, cursor }) => {
    const row = await ctx.db.get(boardStateId);
    let outcome: Awaited<ReturnType<typeof splitState>> | "gone" = "gone";
    try {
      if (row) outcome = direction === "split" ? await splitState(ctx, row) : await joinState(ctx, row);
    } catch (error) {
      // Convex keeps what this step wrote before the failure. The state row is written last, so the board still
      // reads as it was; any card rows written for it are cleared by the next attempt.
      outcome = { kept: `the step failed: ${String(error instanceof Error ? error.message : error).slice(0, 300)}` };
    }
    if (row && typeof outcome === "object") await ctx.db.patch(row._id, { moveIssue: outcome.kept });
    await bump(ctx, direction, outcome === "moved" ? "moved" : typeof outcome === "object" ? "kept" : "unchanged");
    await roadmapStep(ctx, direction, cursor);
  },
});

async function roadmapStep(ctx: MutationCtx, direction: "split" | "join", cursor: string | null) {
  if (cursor === null) {
    // The first step: say which way new boards are stored, and start the progress record afresh.
    await setCounter(ctx, WHOLE_ROADMAPS, direction === "join" ? 1 : 0);
    for (const name of ["moved", "kept", "unchanged"] as const) await setCounter(ctx, `${MOVE}.${direction}.${name}`, 0);
    await setCounter(ctx, `${MOVE}.${direction}.started`, Date.now());
    await setCounter(ctx, `${MOVE}.${direction}.finished`, 0);
  }
  // Only the next row's id: the board itself is read by its own step.
  const page = cursor === DONE ? null : await ctx.db.query("boardState").paginate({ numItems: 1, cursor, maximumBytesRead: ROADMAP_PAGE_BYTES });
  const next = page?.page[0];
  if (next) {
    await ctx.scheduler.runAfter(0, internal.maintenance.roadmapMoveStep, { direction, boardStateId: next._id, cursor: page!.isDone ? DONE : page!.continueCursor });
    return { scheduled: true };
  }
  await setCounter(ctx, `${MOVE}.${direction}.finished`, Date.now());
  return { scheduled: false };
}

/**
 * Where a move between whole and chunked storage has got to: how many boards
 * are stored each way, which were left unmoved and why, and whether the last
 * move has finished. Reads a page of boards at a time; pass back `cursor`
 * until `isDone` to see them all.  npx convex run maintenance:roadmapStorage
 */
export const roadmapStorage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("boardState").paginate({ numItems: 50, cursor: cursor ?? null, maximumBytesRead: STATUS_PAGE_BYTES });
    let whole = 0;
    let chunked = 0;
    const unmoved: Array<{ boardId: string; generation: number; storedAs: "whole" | "chunked"; reason: string }> = [];
    for (const row of page.page) {
      if (row.roadmap) whole += 1;
      else chunked += 1;
      if (row.moveIssue) unmoved.push({ boardId: row.boardId, generation: row.generation, storedAs: row.roadmap ? "whole" : "chunked", reason: row.moveIssue });
    }
    const runs: Record<string, unknown> = {};
    for (const direction of ["split", "join"] as const) {
      const value = async (name: string) => (await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", `${MOVE}.${direction}.${name}`)).unique())?.value ?? 0;
      const started = await value("started");
      if (!started) continue;
      const finished = await value("finished");
      runs[direction] = {
        startedAt: new Date(started).toISOString(), finished: finished >= started, ...(finished >= started ? { finishedAt: new Date(finished).toISOString() } : {}),
        moved: await value("moved"), kept: await value("kept"), unchanged: await value("unchanged"),
      };
    }
    const newBoards = (await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", WHOLE_ROADMAPS)).unique())?.value === 1 ? "whole" : "chunked";
    return { whole, chunked, unmoved, newBoards, runs, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

const MOVE = "roadmapMove";
/** The cursor a step is given when no rows are left after its own: the chain finishes after it. */
const DONE = "done";
/** Finding the next row reads at most one board's state; a status page reads at most this. */
const ROADMAP_PAGE_BYTES = 1_000_000;
const STATUS_PAGE_BYTES = 4_000_000;

async function bump(ctx: MutationCtx, direction: "split" | "join", name: "moved" | "kept" | "unchanged") {
  const key = `${MOVE}.${direction}.${name}`;
  const row = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", key)).unique();
  await setCounter(ctx, key, (row?.value ?? 0) + 1);
}

async function setCounter(ctx: MutationCtx, name: string, value: number) {
  const row = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();
  if (row) await ctx.db.patch(row._id, { value });
  else if (value !== 0 || name.startsWith(MOVE)) await ctx.db.insert("counters", { name, value });
}
