// Housekeeping: idempotency records expire after seven days, uploads
// abandoned for a day are cancelled so their board id is released, and used
// command-line sign-in tokens are forgotten once too old to exchange anyway.
import { PRESENCE_KEEP_MS } from "./model/presence";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { abortTransfer } from "./model/transfer";

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
