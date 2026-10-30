// Browser sessions: enrolled from a Clerk session at /web/session, stored as
// a hashed opaque token, rechecked with Clerk hourly, and ended for good when
// signed out or revoked (see model/webSession.ts for the cookie rules).
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { resolvedConnection } from "./model/access";
import { publicOrigin } from "./model/auth";
import { fail } from "./model/errors";
import { sessionClient } from "./model/humanSession";
import { WEB_SESSION_MS } from "./model/webSession";
import { refuseDeletedAccount } from "./model/erasureGate";

/** Barriers outlive any Clerk session they could refer to. */
const BARRIER_MS = 60 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Enrolls this browser for the person's Clerk session. A valid browser
 * session for the same Clerk session keeps its expiry and gets a new token; a
 * cookie from another Clerk session or account is ended. A Clerk session
 * whose browser session was ended can't enroll again.
 */
export const enroll = internalMutation({
  args: {
    userId: v.string(),
    clerkSessionId: v.string(),
    clerkExpiresAt: v.optional(v.number()),
    tokenHash: v.string(),
    previousTokenHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (await barred(ctx, args.clerkSessionId)) fail("unauthorized", "This sign-in has ended. Sign in again.");
    const now = Date.now(), nowIso = new Date(now).toISOString();
    if (args.previousTokenHash) {
      const previous = await ctx.db.query("connections").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.previousTokenHash)).unique();
      if (previous?.kind === "web" && !previous.revokedAt && (previous.clerkSessionId !== args.clerkSessionId || previous.userId !== args.userId)) {
        await ctx.db.patch(previous._id, { revokedAt: nowIso });
      }
    }
    const sameSession = await ctx.db.query("connections").withIndex("by_clerkSession", (q) => q.eq("clerkSessionId", args.clerkSessionId)).collect();
    // The 7 days run from this Clerk session's first browser sign-in; after
    // that the person signs in afresh, however long Clerk's own session lasts.
    const first = Math.min(now, ...sameSession.filter((row) => row.kind === "web").map((row) => Date.parse(row.createdAt)));
    const cutoff = first + WEB_SESSION_MS;
    if (cutoff <= now) fail("unauthorized", "This sign-in has ended. Sign in again.");
    for (const row of sameSession) {
      if (row.kind !== "web" || row.revokedAt) continue;
      if (row.userId === args.userId && await resolvedConnection(ctx, row._id)) {
        await ctx.db.patch(row._id, { tokenHash: args.tokenHash, clerkCheckedAt: nowIso, lastUsedAt: nowIso });
        return { connectionId: row._id, expiresAt: row.expiresAt! };
      }
      await ctx.db.patch(row._id, { revokedAt: nowIso });
    }
    const expiresAt = new Date(Math.min(cutoff, args.clerkExpiresAt ?? Infinity)).toISOString();
    if (Date.parse(expiresAt) <= now) fail("unauthorized", "This sign-in has ended. Sign in again.");
    await refuseDeletedAccount(ctx, args.userId);
    const connectionId = await ctx.db.insert("connections", {
      userId: args.userId,
      kind: "web",
      name: "Web browser",
      clientName: "Planban on the web",
      tokenHash: args.tokenHash,
      // The person's own sign-in, acting with their role on their boards.
      boards: "all",
      level: "complete",
      canAdminister: true,
      createdAt: nowIso,
      lastUsedAt: nowIso,
      expiresAt,
      serviceOrigin: publicOrigin(),
      clerkSessionId: args.clerkSessionId,
      clerkCheckedAt: nowIso,
      ...(args.clerkExpiresAt ? { clerkExpiresAt: args.clerkExpiresAt } : {}),
    });
    await ctx.scheduler.runAfter(0, internal.people.refresh, { userId: args.userId });
    return { connectionId, expiresAt };
  },
});

/** The browser session a cookie names, if it is still usable. Never resolves any other kind of credential. */
export const resolve = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const connection = await ctx.db.query("connections").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!connection || connection.kind !== "web" || !connection.clerkSessionId) return null;
    if (!await resolvedConnection(ctx, connection._id)) return null;
    return {
      connectionId: connection._id,
      userId: connection.userId,
      clerkSessionId: connection.clerkSessionId,
      clerkCheckedAt: connection.clerkCheckedAt ?? connection.createdAt,
      lastUsedAt: connection.lastUsedAt,
      serviceOrigin: connection.serviceOrigin ?? "",
    };
  },
});

/** Clerk confirmed the session is still active. */
export const confirm = internalMutation({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await resolvedConnection(ctx, connectionId);
    if (!connection || connection.kind !== "web") return;
    await ctx.db.patch(connection._id, { clerkCheckedAt: new Date().toISOString() });
  },
});

export const touch = internalMutation({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await resolvedConnection(ctx, connectionId);
    if (!connection || connection.kind !== "web" || Date.now() - Date.parse(connection.lastUsedAt) < TOUCH_INTERVAL_MS) return;
    await ctx.db.patch(connection._id, { lastUsedAt: new Date().toISOString() });
  },
});

/** Ends the browser session a cookie names (signing out). Returns the Clerk session to end too, if any. */
export const endByToken = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const connection = await ctx.db.query("connections").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!connection || connection.kind !== "web") return { clerkSessionId: null };
    await endWebSession(ctx, connection, false);
    return { clerkSessionId: connection.clerkSessionId ?? null };
  },
});

/** Clerk says the session is no longer active: end the browser session too. */
export const endForClerk = internalMutation({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await ctx.db.get(connectionId);
    if (connection?.kind === "web") await endWebSession(ctx, connection, false);
  },
});

/**
 * Revokes a browser session for good: its row, a barrier so its Clerk
 * session can't enroll again, and (when asked) the Clerk session itself.
 */
export async function endWebSession(ctx: MutationCtx, connection: Doc<"connections">, revokeAtClerk = true) {
  if (connection.kind !== "web") return;
  if (!connection.revokedAt) await ctx.db.patch(connection._id, { revokedAt: new Date().toISOString() });
  const clerkSessionId = connection.clerkSessionId;
  if (!clerkSessionId) return;
  if (!await barred(ctx, clerkSessionId)) {
    // Kept until the Clerk session would have ended anyway, and never less than BARRIER_MS.
    const until = Math.max(Date.now() + BARRIER_MS, connection.clerkExpiresAt ?? 0);
    await ctx.db.insert("webSessionBarriers", { clerkSessionId, createdAt: Date.now(), until });
  }
  if (revokeAtClerk) await ctx.scheduler.runAfter(0, internal.webSessions.revokeClerkSession, { clerkSessionId });
}

async function barred(ctx: MutationCtx, clerkSessionId: string) {
  return !!await ctx.db.query("webSessionBarriers").withIndex("by_clerkSession", (q) => q.eq("clerkSessionId", clerkSessionId)).first();
}

/** Signs the Clerk session out too, so the browser can't quietly enroll again from it. */
export const revokeClerkSession = internalAction({
  args: { clerkSessionId: v.string() },
  handler: async (_ctx, { clerkSessionId }) => {
    if (!/^sess_[A-Za-z0-9]+$/.test(clerkSessionId)) return;
    try {
      const client = await sessionClient();
      await client?.sessions.revokeSession(clerkSessionId);
    } catch {
      // Already ended, or Clerk unreachable: the barrier still refuses it here.
    }
  },
});

/** Barriers older than any Clerk session can last are removed, a bounded batch at a time. */
export const pruneBarriers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db.query("webSessionBarriers").withIndex("by_until", (q) => q.lt("until", Date.now())).take(200);
    for (const row of old) await ctx.db.delete(row._id);
    return { removed: old.length };
  },
});
