// Housekeeping: idempotency records expire after seven days, uploads
// abandoned for a day are cancelled so their board id is released, and used
// command-line sign-in tokens are forgotten once too old to exchange anyway.
import { PRESENCE_KEEP_MS } from "./model/presence";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
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
 * (model/roadmapStore.ts), a few boards per step, continuing in the
 * background until done. Safe to run again: a board already moved is left
 * alone, and one that would not read back exactly stays as it was.
 * Run once after deploying:  npx convex run maintenance:splitRoadmaps
 */
export const splitRoadmaps = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    // New boards are stored in chunks again (a rollback may have asked for whole ones).
    if (!cursor) await setWholeRoadmaps(ctx, false);
    const page = await ctx.db.query("boardState").paginate({ numItems: ROADMAP_STEP, cursor: cursor ?? null, maximumBytesRead: ROADMAP_STEP_BYTES });
    let moved = 0;
    let kept = 0;
    for (const row of page.page) {
      if (!row.roadmap) continue;
      if (await splitState(ctx, row)) moved += 1;
      else kept += 1;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.maintenance.splitRoadmaps, { cursor: page.continueCursor });
    return { moved, kept, done: page.isDone };
  },
});

/**
 * The rollback of splitRoadmaps: every board back to one whole roadmap, and
 * new boards made that way, so the code from before can be deployed again
 * once it has finished.  npx convex run maintenance:joinRoadmaps
 */
export const joinRoadmaps = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    if (!cursor) await setWholeRoadmaps(ctx, true);
    const page = await ctx.db.query("boardState").paginate({ numItems: ROADMAP_STEP, cursor: cursor ?? null, maximumBytesRead: ROADMAP_STEP_BYTES });
    let moved = 0;
    for (const row of page.page) if (await joinState(ctx, row)) moved += 1;
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.maintenance.joinRoadmaps, { cursor: page.continueCursor });
    return { moved, done: page.isDone };
  },
});

/** How many boards each step moves: each can be several hundred KB to read and write. */
const ROADMAP_STEP = 4;
const ROADMAP_STEP_BYTES = 2_000_000;

async function setWholeRoadmaps(ctx: MutationCtx, whole: boolean) {
  const flag = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", WHOLE_ROADMAPS)).unique();
  if (flag) await ctx.db.patch(flag._id, { value: whole ? 1 : 0 });
  else if (whole) await ctx.db.insert("counters", { name: WHOLE_ROADMAPS, value: 1 });
}
