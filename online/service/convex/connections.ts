// Connections: every credential resolves to one row, re-checked on every
// request. Bearer secrets Planban issues itself are stored only as hashes.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { BOARD_ID_PATTERN, boardAccess, connectionIsUsable, liveConnection, resolvedConnection } from "./model/access";
import { connectionOrigin, publicOrigin } from "./model/auth";
import { MAX_REGISTRATIONS_PER_PERSON, REGISTERED_CLIENT_NAME, registeredClientId } from "./model/oauthClient";
import { fail } from "./model/errors";
import { chargeAdmin } from "./model/limits";
import { endWebSession } from "./webSessions";

/** Bounds from the security review: active keys per person, and how many connections a listing reads. */
export const MAX_ACTIVE_KEYS = 50;
const HISTORY_LIMIT = 100;
const REVOKE_BATCH = 200;

/** A person's connections that haven't been revoked: complete, through the by_user_revoked index. */
async function notRevoked(ctx: QueryCtx, userId: string) {
  return ctx.db.query("connections").withIndex("by_user_revoked", (q) => q.eq("userId", userId).eq("revokedAt", undefined)).collect();
}
import { agentLevel } from "./schema";
import { refuseDeletedAccount } from "./model/erasureGate";

/** A connection is marked used at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export const resolveToken = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const connection = await ctx.db.query("connections").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    // A browser session's cookie is never a bearer credential.
    if (connection?.kind === "web") return null;
    const resolved = connection ? await resolvedConnection(ctx, connection._id) : null;
    if (!connection || !resolved) return null;
    return {
      connectionId: connection._id, lastUsedAt: connection.lastUsedAt,
      ...(resolved.kind === "oauth" || resolved.oauthResource !== undefined ? { oauthResource: resolved.oauthResource ?? "" } : {}),
      ...(resolved.serviceOrigin ? { serviceOrigin: resolved.serviceOrigin } : {}),
    };
  },
});

export const touch = internalMutation({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await resolvedConnection(ctx, connectionId);
    if (!connection) return;
    if (Date.now() - Date.parse(connection.lastUsedAt) < TOUCH_INTERVAL_MS) return;
    await ctx.db.patch(connection._id, { lastUsedAt: new Date().toISOString() });
  },
});


/** Development sign-in: only reachable when the HTTP layer allows it (local backends). */
export const createDevConnection = internalMutation({
  args: {
    tokenHash: v.string(),
    userId: v.string(),
    clientName: v.string(),
    boards: v.union(v.literal("all"), v.array(v.string())),
    level: agentLevel,
  },
  handler: async (ctx, args) => {
    await refuseDeletedAccount(ctx, args.userId);
    const now = new Date().toISOString();
    const id = await ctx.db.insert("connections", {
      userId: args.userId,
      kind: "dev",
      name: args.clientName,
      clientName: args.clientName,
      tokenHash: args.tokenHash,
      boards: args.boards,
      level: args.level,
      // A development sign-in for all boards stands for the person; one with a
      // lower level or fewer boards stands for one of their agents.
      canAdminister: args.boards === "all" && args.level === "complete",
      createdAt: now,
      lastUsedAt: now,
      serviceOrigin: publicOrigin(),
    });
    return { connectionId: id };
  },
});

function describe(connection: Doc<"connections">, currentId: string) {
  return {
    id: connection._id,
    kind: connection.kind,
    name: connection.name,
    clientName: connection.clientName,
    boards: connection.boards,
    level: connection.level,
    createdAt: connection.createdAt,
    lastUsedAt: connection.lastUsedAt,
    ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}),
    ...(connection.revokedAt ? { revokedAt: connection.revokedAt } : {}),
    active: connectionIsUsable(connection),
    current: connection._id === currentId,
  };
}

/**
 * The connections page: a person's own connection sees every machine, agent
 * and key of theirs; anything narrower sees only itself.
 */
export const list = internalQuery({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await liveConnection(ctx, connectionId);
    if (!connection.canAdminister) return { connections: [describe(connection, connection._id)] };
    // Everything not revoked is always listed, read through its own index so
    // no amount of revoked history can push a live credential off the list.
    // Recent revoked history follows, bounded. Access credentials are aliases
    // of grants and aren't listed.
    const unrevoked = await notRevoked(ctx, connection.userId);
    const recent = await ctx.db.query("connections").withIndex("by_user", (q) => q.eq("userId", connection.userId)).order("desc").take(HISTORY_LIMIT);
    const seen = new Set(unrevoked.map((row) => row._id));
    const grants = [...unrevoked, ...recent.filter((row) => row.revokedAt && !seen.has(row._id))].filter((row) => !row.oauthConnectionId);
    const registrations = await ctx.db.query("oauthRegistrations").withIndex("by_user", (q) => q.eq("userId", connection.userId)).take(MAX_REGISTRATIONS_PER_PERSON);
    return {
      connections: grants.map((row) => describe(row, connectionId)),
      // Every claude.ai registration this person approved, connected or not (owner decision 22).
      registrations: registrations.map((row) => ({
        id: row._id, name: REGISTERED_CLIENT_NAME, registeredAt: new Date(row.createdAt).toISOString(),
        connected: grants.some((grant) => grant.oauthClientId === row.clientId && connectionIsUsable(grant)),
      })),
    };
  },
});

/**
 * Cuts off every other machine, agent, key and Claude registration of this
 * person, keeping only the connection making the request. Works on the
 * complete unrevoked set in bounded batches; call again while `more` is true.
 */
export const revokeAllOthers = internalMutation({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await liveConnection(ctx, connectionId);
    if (!connection.canAdminister) fail("forbidden", "Cut off connections from your own sign-in, not from an agent or key.");
    const now = new Date().toISOString();
    const keep = new Set<string>([connection._id, ...(connection.oauthConnectionId ? [connection.oauthConnectionId] : [])]);
    const others = (await ctx.db.query("connections").withIndex("by_user_revoked", (q) => q.eq("userId", connection.userId).eq("revokedAt", undefined)).take(REVOKE_BATCH + keep.size + 1))
      .filter((row) => !keep.has(row._id));
    for (const row of others.slice(0, REVOKE_BATCH)) {
      if (row.kind === "web") await endWebSession(ctx, row);
      else await ctx.db.patch(row._id, { revokedAt: now });
    }
    let registrations = 0;
    for (const registration of await ctx.db.query("oauthRegistrations").withIndex("by_user", (q) => q.eq("userId", connection.userId)).take(REVOKE_BATCH)) {
      await ctx.db.delete(registration._id);
      registrations += 1;
    }
    // One row past the batch shows whether more remain once this batch is done.
    return { revoked: Math.min(others.length, REVOKE_BATCH), registrations, more: others.length > REVOKE_BATCH };
  },
});

/** Cuts a connection off at once. Signing out revokes the machine's own connection. */
export const revoke = internalMutation({
  args: { connectionId: v.id("connections"), targetId: v.string() },
  handler: async (ctx, { connectionId, targetId }) => {
    const connection = await liveConnection(ctx, connectionId);
    const registrationId = targetId === "self" ? null : ctx.db.normalizeId("oauthRegistrations", targetId);
    if (registrationId) {
      const registration = await ctx.db.get(registrationId);
      if (!registration || !connection.canAdminister || registration.userId !== connection.userId) fail("not_found", "Connection not found.");
      await endRegistration(ctx, registration!, new Date().toISOString());
      return { revoked: true, id: registration!._id };
    }
    const id = targetId === "self" ? connection._id : ctx.db.normalizeId("connections", targetId);
    const target = id ? await ctx.db.get(id) : null;
    const allowed = target && !target.oauthConnectionId && (target._id === connection._id || (connection.canAdminister && target.userId === connection.userId));
    if (!allowed) fail("not_found", "Connection not found.");
    const now = new Date().toISOString();
    // A browser session also ends at Clerk, and its Clerk session can't enroll again.
    if (target!.kind === "web") await endWebSession(ctx, target!);
    else if (!target!.revokedAt) await ctx.db.patch(target!._id, { revokedAt: now });
    if (target!.oauthClientId && registeredClientId(target!.oauthClientId)) {
      // A claude.ai registration ends with its connection.
      const registration = await ctx.db.query("oauthRegistrations").withIndex("by_clientId", (q) => q.eq("clientId", target!.oauthClientId!)).unique();
      if (registration) await endRegistration(ctx, registration, now);
    }
    return { revoked: true, id: target!._id };
  },
});

/**
 * Removing the registration is authoritative at once: with its row gone,
 * every connection made through it is refused (see registrationLive), and no
 * history accumulates. Grants are also marked revoked, a bounded batch at a time.
 */
async function endRegistration(ctx: MutationCtx, registration: Doc<"oauthRegistrations">, now: string) {
  await ctx.db.delete(registration._id);
  if (!registration.userId) return;
  const grants = await ctx.db.query("connections").withIndex("by_user_client", (q) => q.eq("userId", registration.userId!).eq("oauthClientId", registration.clientId))
    .filter((q) => q.eq(q.field("revokedAt"), undefined)).take(50);
  for (const grant of grants) await ctx.db.patch(grant._id, { revokedAt: now });
}

/**
 * Personal access keys (owner decision 5): named, for one board, at one
 * level, optionally expiring. Created from the person's own connection; the
 * key itself is shown once and only its hash is kept.
 */
export const createKey = internalMutation({
  args: {
    connectionId: v.id("connections"),
    tokenHash: v.string(),
    name: v.string(),
    boardId: v.string(),
    level: agentLevel,
    expiresAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const connection = await liveConnection(ctx, args.connectionId);
    if (!connection.canAdminister) fail("forbidden", "Personal access keys are created from your own sign-in, not from an agent or another key.");
    const name = args.name.trim();
    if (!name || name.length > 80) fail("validation", "Give the key a name of up to 80 characters.");
    if (!BOARD_ID_PATTERN.test(args.boardId)) fail("not_found", `Online Board not found: ${args.boardId}`);
    const access = await boardAccess(ctx, args.connectionId, args.boardId);
    // A key can do at most what its person's role allows; what the person lets
    // their agents do caps it again whenever it acts.
    if (access.role === "viewer" && args.level !== "read") fail("forbidden", "A viewer's key can only read.");
    if (args.expiresAt && !(Date.parse(args.expiresAt) > Date.now())) fail("validation", "The expiry must be in the future.");
    const held = await notRevoked(ctx, connection.userId);
    if (held.filter((row) => row.kind === "key" && connectionIsUsable(row)).length >= MAX_ACTIVE_KEYS) {
      fail("rate_limited", `You have ${MAX_ACTIVE_KEYS} active personal access keys. Revoke one before creating another.`);
    }
    await refuseDeletedAccount(ctx, connection.userId);
    await chargeAdmin(ctx, connection.userId, "keys");
    const now = new Date().toISOString();
    const id = await ctx.db.insert("connections", {
      userId: connection.userId, kind: "key", name, clientName: `Key: ${name}`, tokenHash: args.tokenHash,
      boards: [args.boardId], level: args.level, canAdminister: false, createdAt: now, lastUsedAt: now,
      serviceOrigin: connectionOrigin(connection),
      ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}),
    });
    return { id, name, boardId: args.boardId, level: args.level, ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}) };
  },
});

/** Legacy user/client lookup must never reopen a grant after new enrollment. */
export const forOAuthClient = internalMutation({
  args: { userId: v.string(), clientId: v.string(), clientName: v.string() },
  handler: async () => null,
});

/** From the person's own sign-in: change which boards an app or key reaches and what it may do. */
export const setAccess = internalMutation({
  args: { connectionId: v.id("connections"), targetId: v.string(), level: v.optional(agentLevel), boards: v.optional(v.union(v.literal("all"), v.array(v.string()))) },
  handler: async (ctx, { connectionId, targetId, level, boards }) => {
    const connection = await liveConnection(ctx, connectionId);
    if (!connection.canAdminister) fail("forbidden", "Change access from your own sign-in.");
    const id = ctx.db.normalizeId("connections", targetId);
    const target = id ? await ctx.db.get(id) : null;
    if (!target || target.oauthConnectionId || target.userId !== connection.userId) fail("not_found", "Connection not found.");
    if (target!.canAdminister) fail("validation", "A machine's own sign-in always has full access; sign it out instead.");
    if (target!.kind === "key" && boards !== undefined) fail("validation", "A key always reaches the one board it was made for.");
    if (boards !== undefined && boards !== "all" && boards.some((board) => !BOARD_ID_PATTERN.test(board))) fail("validation", "Unknown board id.");
    await ctx.db.patch(target!._id, { ...(level ? { level } : {}), ...(boards !== undefined ? { boards } : {}) });
    return describe((await ctx.db.get(target!._id))!, connectionId);
  },
});

/** Revocation is permanent for this connection; reconnect enrolls a new one. */
export const restore = internalMutation({
  args: { connectionId: v.id("connections"), targetId: v.string() },
  handler: async (ctx, { connectionId, targetId }) => {
    const connection = await liveConnection(ctx, connectionId);
    if (!connection.canAdminister) fail("forbidden", "Re-enable apps from your own sign-in.");
    const id = ctx.db.normalizeId("connections", targetId);
    const target = id ? await ctx.db.get(id) : null;
    if (!target || target.userId !== connection.userId || target.kind !== "oauth") fail("not_found", "Connection not found.");
    fail("validation", "A connection cannot be restored. Reconnect through a new explicit authorization; old credentials stay revoked.");
  },
});
