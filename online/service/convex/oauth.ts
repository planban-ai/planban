// Internal enrollment state machine. The HTTP boundary validates client
// metadata and verifies human session identity; these mutations atomically
// bind approval, code redemption and rotating credentials to one connection.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { connectionIsUsable, liveConnection, registrationLive } from "./model/access";
import { fail } from "./model/errors";
import { agentLevel } from "./schema";
import { MAX_REGISTRATIONS_PER_PERSON, metadataClientAllowed, REGISTERED_CLIENT_NAME, registeredClientId, type OAuthClient } from "./model/oauthClient";
import { refuseDeletedAccount } from "./model/erasureGate";

export const REQUEST_MS = 10 * 60_000;
export const MACHINE_REQUEST_MS = 5 * 60_000;
export const CODE_MS = 60_000;
export const ACCESS_MS = 5 * 60_000;
export const REFRESH_IDLE_MS = 90 * 24 * 60 * 60_000;
export const GRANT_MS = 365 * 24 * 60 * 60_000;
/** An unused claude.ai registration lasts this long. */
export const REGISTRATION_MS = 24 * 60 * 60_000;
const REGISTRATION_METER = "registration:claude.ai";
/**
 * Sign-in starts per client in each ten-minute window. Every person using a
 * client shares its budget, so it is a cost ceiling, not a per-caller limit;
 * the edge Worker limits each caller address (6 a minute).
 */
export const AUTHORIZE_REQUESTS_PER_WINDOW = 1000;
/** claude.ai self-registrations in each window, which create rows without a signed-in person. */
const REGISTRATIONS_PER_WINDOW = 100;
/** How long a fetched client metadata document is reused. */
export const CLIENT_CACHE_MS = 60 * 60_000;
const invalid = () => ({ error: "invalid_grant" as const });
const hash = v.string();
const SCOPES = new Set(["planban:read", "planban:plan", "planban:complete", "offline_access"]);
export const MACHINE_CLIENT_ID = "planban-cli";
export function scopeLevel(scopes: string[]) {
  return scopes.includes("planban:complete") ? "complete" as const : scopes.includes("planban:plan") ? "plan" as const : "read" as const;
}

async function requestRow(ctx: MutationCtx, requestHash: string) {
  return ctx.db.query("oauthRequests").withIndex("by_requestHash", (q) => q.eq("requestHash", requestHash)).unique();
}

async function meterRequest(ctx: MutationCtx, clientId: string, limit = AUTHORIZE_REQUESTS_PER_WINDOW) {
  const bucket = Math.floor(Date.now() / REQUEST_MS);
  const usage = await ctx.db.query("oauthUsage").withIndex("by_client_bucket", (q) => q.eq("clientId", clientId).eq("bucket", bucket)).unique();
  if ((usage?.requests ?? 0) >= limit) fail("rate_limited", "Too many authorization requests. Try again later.");
  if (usage) await ctx.db.patch(usage._id, { requests: usage.requests + 1 });
  else await ctx.db.insert("oauthUsage", { clientId, bucket, requests: 1 });
}

/** One service-owned lease begins before browser opening; no client wall clock is trusted. */
export const startMachine = internalMutation({
  args: { launchHash: hash, requestHash: hash, redirectUri: v.string(), resource: v.string(), challenge: v.string(), state: v.string() },
  handler: async (ctx, args) => {
    if (![args.launchHash, args.requestHash].every((h) => /^[a-f0-9]{64}$/.test(h)) || !/^[A-Za-z0-9_-]{43}$/.test(args.challenge) || !args.state || args.state.length > 2048 || args.resource.length > 2048 || !/^http:\/\/127\.0\.0\.1:5368[2-6]\/callback$/.test(args.redirectUri)) fail("validation", "Invalid machine start.");
    await meterRequest(ctx, MACHINE_CLIENT_ID);
    const serverNow = Date.now(), expiresAt = serverNow + MACHINE_REQUEST_MS;
    await ctx.db.insert("oauthRequests", { ...args, clientId: MACHINE_CLIENT_ID, clientName: "Planban CLI", scopes: ["planban:machine"], level: "complete", purpose: "machine", status: "awaiting_browser", expiresAt });
    await scheduleCleanup(ctx, MACHINE_REQUEST_MS + CODE_MS);
    return { serverNow, expiresAt };
  },
});

/** Launch is a single claim; replay cannot replace the browser binding or renew a lease. */
export const claimMachine = internalMutation({
  args: { launchHash: hash, requestHash: hash, browserHash: hash, csrfHash: hash },
  handler: async (ctx, args) => {
    if (!Object.values(args).every((h) => /^[a-f0-9]{64}$/.test(h))) return false;
    const row = await ctx.db.query("oauthRequests").withIndex("by_launchHash", (q) => q.eq("launchHash", args.launchHash)).unique();
    if (!row || row.purpose !== "machine" || row.status !== "awaiting_browser" || row.browserHash || row.csrfHash || row.expiresAt <= Date.now()) return false;
    await ctx.db.patch(row._id, { requestHash: args.requestHash, browserHash: args.browserHash, csrfHash: args.csrfHash, status: "pending" });
    return true;
  },
});

/** PKCE ownership can end only this unredeemed request, never another connection or session. */
export const cancelMachine = internalMutation({
  args: { launchHash: hash, challenge: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("oauthRequests").withIndex("by_launchHash", (q) => q.eq("launchHash", args.launchHash)).unique();
    if (!row || row.purpose !== "machine" || row.challenge !== args.challenge || row.status === "consumed") return;
    const grant = row.connectionId ? await ctx.db.get(row.connectionId) : null;
    if (grant && !grant.oauthPending) return;
    if (grant?.oauthPending && !grant.revokedAt) await ctx.db.patch(grant._id, { revokedAt: new Date().toISOString() });
    await ctx.db.patch(row._id, { status: "denied" });
  },
});

async function cleanupState(ctx: MutationCtx) {
  return ctx.db.query("oauthCleanup").withIndex("by_name", (q) => q.eq("name", "requests")).unique();
}

async function scheduleCleanup(ctx: MutationCtx, delay: number) {
  const state = await cleanupState(ctx);
  if (state?.dueAt !== undefined) return;
  const ticket = (state?.ticket ?? 0) + 1;
  const fields = { name: "requests", ticket, dueAt: Date.now() + delay };
  if (state) await ctx.db.patch(state._id, fields);
  else await ctx.db.insert("oauthCleanup", fields);
  await ctx.scheduler.runAfter(delay, internal.oauth.cleanupRequests, { ticket });
}

/** Reserve outbound work atomically, even if metadata fails or no row is created. */
export const reserveMetadataFetch = internalMutation({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    if (!metadataClientAllowed(clientId)) return false;
    const bucket = Math.floor(Date.now() / REQUEST_MS);
    const usage = await ctx.db.query("oauthUsage").withIndex("by_client_bucket", (q) => q.eq("clientId", clientId).eq("bucket", bucket)).unique();
    if ((usage?.requests ?? 0) >= AUTHORIZE_REQUESTS_PER_WINDOW || (usage?.fetches ?? 0) >= 100) return false;
    if (usage) await ctx.db.patch(usage._id, { fetches: (usage.fetches ?? 0) + 1 });
    else await ctx.db.insert("oauthUsage", { clientId, bucket, requests: 0, fetches: 1 });
    await scheduleCleanup(ctx, REQUEST_MS + CODE_MS);
    return true;
  },
});

/** A reviewed client's validated metadata fetched within the last hour, or null. */
export const cachedMetadataClient = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }): Promise<OAuthClient | null> => {
    if (!metadataClientAllowed(clientId)) return null;
    const row = await ctx.db.query("oauthClientCache").withIndex("by_clientId", (q) => q.eq("clientId", clientId)).unique();
    if (!row || Date.now() - row.fetchedAt >= CLIENT_CACHE_MS) return null;
    return { clientId, name: row.name, redirectUris: row.redirectUris, native: row.native };
  },
});

/** Keeps a freshly fetched and validated metadata document for reuse. */
export const cacheMetadataClient = internalMutation({
  args: { clientId: v.string(), name: v.string(), redirectUris: v.array(v.string()), native: v.boolean() },
  handler: async (ctx, args) => {
    if (!metadataClientAllowed(args.clientId) || !args.name || args.name.length > 200 || !args.redirectUris.length || args.redirectUris.length > 20) return;
    const row = await ctx.db.query("oauthClientCache").withIndex("by_clientId", (q) => q.eq("clientId", args.clientId)).unique();
    const value = { ...args, fetchedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, value);
    else await ctx.db.insert("oauthClientCache", value);
  },
});

/** Records a validated claude.ai registration. The HTTP layer validates its metadata. */
export const register = internalMutation({
  args: { clientId: v.string(), redirectUris: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (!registeredClientId(args.clientId)) fail("validation", "Invalid registration.");
    await meterRequest(ctx, REGISTRATION_METER, REGISTRATIONS_PER_WINDOW);
    const now = Date.now();
    await ctx.db.insert("oauthRegistrations", { clientId: args.clientId, redirectUris: args.redirectUris, createdAt: now, expiresAt: now + REGISTRATION_MS });
    await scheduleCleanup(ctx, REQUEST_MS + CODE_MS);
    return { createdAt: now };
  },
});

async function registrationRow(ctx: QueryCtx, clientId: string) {
  return ctx.db.query("oauthRegistrations").withIndex("by_clientId", (q) => q.eq("clientId", clientId)).unique();
}

function registrationUsable(row: Doc<"oauthRegistrations"> | null, userId?: string): row is Doc<"oauthRegistrations"> {
  if (!row) return false;
  if (row.userId) return userId === undefined || row.userId === userId;
  return row.expiresAt !== undefined && row.expiresAt > Date.now();
}

/** A live claude.ai registration as an OAuth client, or null. */
export const registeredClient = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }): Promise<OAuthClient | null> => {
    if (!registeredClientId(clientId)) return null;
    const row = await registrationRow(ctx, clientId);
    if (!registrationUsable(row)) return null;
    return { clientId, name: REGISTERED_CLIENT_NAME, redirectUris: row.redirectUris, native: false };
  },
});

/** Sign-in approvals one person may make in an hour (stateless sign-in start). */
export const APPROVALS_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;

/** Counts one approval against the person's own hourly limit. */
async function chargeApproval(ctx: MutationCtx, userId: string) {
  const hour = Math.floor(Date.now() / HOUR_MS);
  const row = await ctx.db.query("signInApprovals").withIndex("by_user_hour", (q) => q.eq("userId", userId).eq("hour", hour)).unique();
  if ((row?.count ?? 0) >= APPROVALS_PER_HOUR) fail("rate_limited", `You've approved ${APPROVALS_PER_HOUR} sign-ins in the last hour. Try again later.`);
  if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
  else await ctx.db.insert("signInApprovals", { userId, hour, count: 1 });
}

/** Hourly approval counts older than a day are removed, a bounded batch at a time. */
export const pruneApprovals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db.query("signInApprovals").withIndex("by_hour", (q) => q.lt("hour", Math.floor(Date.now() / HOUR_MS) - 24)).take(500);
    for (const row of old) await ctx.db.delete(row._id);
    return { removed: old.length };
  },
});

/**
 * Creates the sign-in record from a verified note, only once a signed-in
 * person approves (stateless sign-in start). Each note is used once, a
 * computer's launch is approved once, and approvals count against the
 * person's own hourly limit, never a shared one.
 */
export const createRequest = internalMutation({
  args: { requestHash: hash, browserHash: hash, csrfHash: hash, clientId: v.string(), clientName: v.string(), redirectUri: v.string(), resource: v.string(), scopes: v.array(v.string()), level: agentLevel, challenge: v.string(), state: v.string(), purpose: v.union(v.literal("oauth"), v.literal("machine")), userId: v.string(), sessionId: v.optional(v.string()), expiresAt: v.number(), launchHash: v.optional(hash) },
  handler: async (ctx, args) => {
    if ([args.requestHash, args.browserHash, args.csrfHash].some((value) => !/^[a-f0-9]{64}$/.test(value)) || !/^[A-Za-z0-9_-]{43}$/.test(args.challenge)) fail("validation", "Invalid authorization request.");
    if (args.clientId.length > 2048 || args.redirectUri.length > 2048 || args.resource.length > 2048 || args.state.length > 2048 || args.clientName.length > 200 || args.scopes.length > 4) fail("validation", "Authorization request is too large.");
    if (args.purpose === "machine") {
      if (args.clientId !== MACHINE_CLIENT_ID || args.scopes.length !== 1 || args.scopes[0] !== "planban:machine" || args.level !== "complete") fail("validation", "Invalid machine authorization.");
    } else if (!args.scopes.some((scope) => scope.startsWith("planban:")) || args.scopes.some((scope) => !SCOPES.has(scope)) || args.level !== scopeLevel(args.scopes)) fail("validation", "Invalid authorization scopes.");
    if (args.expiresAt <= Date.now() || args.expiresAt > Date.now() + REQUEST_MS) fail("unauthorized", "Start a fresh authorization request.");
    // A note is used once; a computer's launch link is approved once.
    if (await requestRow(ctx, args.requestHash)) fail("unauthorized", "Start a fresh authorization request.");
    if (args.launchHash && await ctx.db.query("oauthRequests").withIndex("by_launchHash", (q) => q.eq("launchHash", args.launchHash)).first()) fail("unauthorized", "Start a fresh authorization request.");
    await refuseDeletedAccount(ctx, args.userId);
    await chargeApproval(ctx, args.userId);
    await ctx.db.insert("oauthRequests", { ...args, status: "pending" });
    await scheduleCleanup(ctx, Math.max(0, args.expiresAt - Date.now()) + CODE_MS);
    return { created: true };
  },
});

/** Whether a sign-in note (or its computer's launch) has already been approved. A read only. */
export const noteUsed = internalQuery({
  args: { requestHash: hash, launchHash: v.optional(hash) },
  handler: async (ctx, { requestHash, launchHash }) => {
    if (await ctx.db.query("oauthRequests").withIndex("by_requestHash", (q) => q.eq("requestHash", requestHash)).first()) return true;
    return !!launchHash && !!await ctx.db.query("oauthRequests").withIndex("by_launchHash", (q) => q.eq("launchHash", launchHash)).first();
  },
});

/** Only the browser holding the interaction nonce can inspect or bind consent. */
export const inspect = internalQuery({
  args: { requestHash: hash, browserHash: hash },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("oauthRequests").withIndex("by_requestHash", (q) => q.eq("requestHash", args.requestHash)).unique();
    if (!row || row.browserHash !== args.browserHash || row.expiresAt <= Date.now() || row.status !== "pending") return null;
    return { clientId: row.clientId, clientName: row.clientName, redirectUri: row.redirectUri, resource: row.resource, scopes: row.scopes, purpose: row.purpose, userId: row.userId, expiresAt: row.expiresAt, serverNow: Date.now() };
  },
});

export const bindIdentity = internalMutation({
  args: { requestHash: hash, browserHash: hash, csrfHash: hash, userId: v.string(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await requestRow(ctx, args.requestHash);
    if (!row || row.status !== "pending" || row.expiresAt <= Date.now() || row.browserHash !== args.browserHash || row.csrfHash !== args.csrfHash || (row.userId && row.userId !== args.userId)) fail("unauthorized", "Start a fresh authorization request.");
    if (row!.sessionId && row!.sessionId !== args.sessionId) fail("unauthorized", "The signed-in session changed. Start again.");
    await refuseDeletedAccount(ctx, args.userId);
    await ctx.db.patch(row!._id, { userId: args.userId, ...(args.sessionId ? { sessionId: args.sessionId } : {}) });
    return { bound: true };
  },
});

/** Cancellation cannot create a grant and does not require a signed-in user. */
export const denyRequest = internalMutation({
  args: { requestHash: hash, browserHash: hash, csrfHash: hash },
  handler: async (ctx, args) => {
    const row = await requestRow(ctx, args.requestHash);
    if (!row || row.status !== "pending" || row.expiresAt <= Date.now() || row.browserHash !== args.browserHash || row.csrfHash !== args.csrfHash) fail("unauthorized", "Start a fresh authorization request.");
    await ctx.db.patch(row!._id, { status: "denied" });
    return { redirectUri: row!.redirectUri, state: row!.state };
  },
});

export const approve = internalMutation({
  args: { requestHash: hash, browserHash: hash, csrfHash: hash, userId: v.string(), sessionId: v.optional(v.string()), approverConnectionId: v.optional(v.id("connections")), codeHash: hash, deny: v.boolean() },
  handler: async (ctx, args) => {
    const row = await requestRow(ctx, args.requestHash);
    if (!row || row.status !== "pending" || row.expiresAt <= Date.now() || row.browserHash !== args.browserHash || row.csrfHash !== args.csrfHash || row.userId !== args.userId) fail("unauthorized", "Start a fresh authorization request.");
    if (row!.sessionId && row!.sessionId !== args.sessionId) fail("unauthorized", "The signed-in session changed. Start again.");
    if (args.approverConnectionId) {
      const approver = await liveConnection(ctx, args.approverConnectionId);
      if (!approver.canAdminister || approver.userId !== args.userId) fail("forbidden", "Approve from your own sign-in.");
    } else if (!args.sessionId || row!.sessionId !== args.sessionId) fail("unauthorized", "Approve from your current signed-in session.");
    if (args.deny) {
      await ctx.db.patch(row!._id, { status: "denied" });
      return { denied: true, redirectUri: row!.redirectUri, state: row!.state };
    }
    if (!/^[a-f0-9]{64}$/.test(args.codeHash)) fail("validation", "Invalid authorization code.");
    if (registeredClientId(row!.clientId)) {
      // The first approval makes the registration that person's; it no longer expires.
      const registration = await registrationRow(ctx, row!.clientId);
      if (!registrationUsable(registration, args.userId)) fail("unauthorized", "This connection request has ended. Add the connector again.");
      if (!registration!.userId) {
        const held = await ctx.db.query("oauthRegistrations").withIndex("by_user", (q) => q.eq("userId", args.userId)).take(MAX_REGISTRATIONS_PER_PERSON);
        if (held.length >= MAX_REGISTRATIONS_PER_PERSON) fail("rate_limited", `You have ${MAX_REGISTRATIONS_PER_PERSON} Claude connections. Remove one on the connections page first.`);
        await ctx.db.patch(registration!._id, { userId: args.userId, expiresAt: undefined });
      }
    }
    await refuseDeletedAccount(ctx, args.userId);
    const now = new Date().toISOString();
    // Pending grants are visible and revocable before code redemption; they
    // have no credential and cannot authorize resource work.
    const connectionId = await ctx.db.insert("connections", {
      userId: args.userId, kind: row!.purpose, name: row!.clientName, clientName: row!.clientName,
      boards: "all", level: row!.purpose === "machine" ? "complete" : row!.level,
      canAdminister: row!.purpose === "machine", createdAt: now, lastUsedAt: now,
      oauthClientId: row!.clientId, oauthResource: row!.resource, authorizationVersion: 2, oauthPending: true,
      ...(row!.purpose === "oauth" ? { expiresAt: new Date(Date.now() + GRANT_MS).toISOString() } : {}),
    });
    const codeExpiresAt = row!.purpose === "machine" ? Math.min(Date.now() + CODE_MS, row!.expiresAt) : Date.now() + CODE_MS;
    await ctx.db.patch(row!._id, { status: "approved", connectionId, codeHash: args.codeHash, codeExpiresAt, // Kept until the note itself expires, so clean-up never makes an approved note usable again.
      expiresAt: row!.purpose === "machine" ? row!.expiresAt : Math.max(row!.expiresAt, codeExpiresAt), ...(args.approverConnectionId ? { approverConnectionId: args.approverConnectionId } : {}) });
    return { denied: false, redirectUri: row!.redirectUri, state: row!.state };
  },
});

async function issueOAuth(ctx: MutationCtx, connection: Doc<"connections">, accessHash: string, refreshHash: string, scopes: string[]) {
  const expiresAt = new Date(Date.now() + ACCESS_MS).toISOString();
  const accessId = await ctx.db.insert("connections", {
    userId: connection.userId, kind: "oauth", name: "Access credential", clientName: connection.clientName,
    tokenHash: accessHash, boards: connection.boards, level: scopeLevel(scopes), canAdminister: false,
    createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), expiresAt,
    oauthClientId: connection.oauthClientId, oauthResource: connection.oauthResource,
    authorizationVersion: 2, oauthConnectionId: connection._id,
  });
  await ctx.scheduler.runAfter(ACCESS_MS + CODE_MS, internal.oauth.cleanupCredential, { accessId });
  if (scopes.includes("offline_access")) {
    const refreshId = await ctx.db.insert("oauthRefresh", {
      tokenHash: refreshHash, connectionId: connection._id, clientId: connection.oauthClientId!, resource: connection.oauthResource!, scopes,
      expiresAt: Math.min(Date.now() + REFRESH_IDLE_MS, Date.parse(connection.expiresAt!)),
    });
    await ctx.scheduler.runAfter(Math.max(0, Date.parse(connection.expiresAt!) - Date.now()) + CODE_MS, internal.oauth.cleanupCredential, { refreshId });
  }
  return { machine: false, expiresIn: ACCESS_MS / 1000, scope: scopes.join(" "), refresh: scopes.includes("offline_access") };
}

export const redeem = internalMutation({
  args: { codeHash: hash, clientId: v.string(), redirectUri: v.string(), resource: v.string(), challenge: v.string(), accessHash: hash, refreshHash: hash, sessionId: v.optional(v.string()), sessionUserId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("oauthRequests").withIndex("by_codeHash", (q) => q.eq("codeHash", args.codeHash)).unique();
    if (!row || row.status !== "approved" || !row.connectionId || (row.purpose === "machine" && row.expiresAt <= Date.now()) || (row.codeExpiresAt ?? 0) <= Date.now() || row.clientId !== args.clientId || row.redirectUri !== args.redirectUri || row.resource !== args.resource || row.challenge !== args.challenge) return invalid();
    const connection = await ctx.db.get(row.connectionId);
    if (!connection || connection.revokedAt || !connection.oauthPending || !await registrationLive(ctx, connection)) return invalid();
    if (row.approverConnectionId && !connectionIsUsable(await ctx.db.get(row.approverConnectionId))) return invalid();
    if (!row.approverConnectionId && (!row.sessionId || args.sessionId !== row.sessionId || args.sessionUserId !== row.userId)) return invalid();
    await ctx.db.patch(row._id, { status: "consumed" });
    await ctx.db.patch(connection._id, { oauthPending: false });
    if (row.purpose === "machine") {
      await ctx.db.patch(connection._id, { tokenHash: args.accessHash });
      await ctx.scheduler.runAfter(0, internal.people.refresh, { userId: connection.userId });
      return { machine: true, userId: connection.userId, scope: "planban:machine", expiresIn: REFRESH_IDLE_MS / 1000, refresh: false };
    }
    return issueOAuth(ctx, connection, args.accessHash, args.refreshHash, row.scopes);
  },
});

/** HTTP token action rechecks the active provider session before redemption. */
export const redemptionContext = internalQuery({
  args: { codeHash: hash },
  handler: async (ctx, { codeHash }) => {
    const row = await ctx.db.query("oauthRequests").withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash)).unique();
    return row?.status === "approved" && (row.purpose !== "machine" || row.expiresAt > Date.now()) && (row.codeExpiresAt ?? 0) > Date.now()
      ? { sessionId: row.approverConnectionId ? undefined : row.sessionId, userId: row.userId }
      : null;
  },
});

export const revokeToken = internalMutation({
  args: { tokenHash: hash, clientId: v.string() },
  handler: async (ctx, args) => {
    const access = await ctx.db.query("connections").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash)).unique();
    // A direct machine credential has no OAuth alias/family relationship.
    // Its exact token and frozen public machine client identify only this machine.
    if (access?.kind === "machine" && access.authorizationVersion === 2 && access.oauthClientId === MACHINE_CLIENT_ID && args.clientId === MACHINE_CLIENT_ID && !access.oauthPending && !access.revokedAt) {
      await ctx.db.patch(access._id, { revokedAt: new Date().toISOString() });
      return { revoked: true };
    }
    const refresh = await ctx.db.query("oauthRefresh").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash)).unique();
    const id = access?.oauthConnectionId ?? refresh?.connectionId;
    const connection = id ? await ctx.db.get(id) : null;
    if (connection?.kind === "oauth" && connection.authorizationVersion === 2 && connection.oauthClientId === args.clientId && !connection.revokedAt) await ctx.db.patch(connection._id, { revokedAt: new Date().toISOString() });
    return { revoked: true };
  },
});

/** Expired request/counter cleanup is bounded; permanent grant rows are retained. */
export const cleanupRequests = internalMutation({
  args: { ticket: v.number() },
  handler: async (ctx, { ticket }) => {
    const state = await cleanupState(ctx);
    if (!state || state.dueAt === undefined || state.ticket !== ticket) return;
    await ctx.db.patch(state._id, { dueAt: undefined });
    const requests = await ctx.db.query("oauthRequests").withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now())).take(100);
    const usage = await ctx.db.query("oauthUsage").withIndex("by_bucket", (q) => q.lt("bucket", Math.floor(Date.now() / REQUEST_MS))).take(100);
    const registrations = await ctx.db.query("oauthRegistrations").withIndex("by_expiry", (q) => q.gt("expiresAt", 0).lte("expiresAt", Date.now())).take(100);
    for (const row of registrations) await ctx.db.delete(row._id);
    for (const row of requests) {
      const grant = row.connectionId ? await ctx.db.get(row.connectionId) : null;
      if (grant?.oauthPending && !grant.revokedAt) await ctx.db.patch(grant._id, { revokedAt: new Date().toISOString() });
      await ctx.db.delete(row._id);
    }
    for (const row of usage) await ctx.db.delete(row._id);
    if (requests.length === 100 || usage.length === 100 || registrations.length === 100) {
      await scheduleCleanup(ctx, 0);
    } else {
      // Later requests or late approval can outlive the bucket's first job.
      // Keep a bounded job alive until the last outstanding deadline passes.
      const next = await ctx.db.query("oauthRequests").withIndex("by_expiry").order("asc").first();
      const nextUsage = await ctx.db.query("oauthUsage").withIndex("by_bucket").order("asc").first();
      const nextRegistration = await ctx.db.query("oauthRegistrations").withIndex("by_expiry", (q) => q.gt("expiresAt", 0)).order("asc").first();
      const deadline = Math.min(next?.expiresAt ?? Infinity, nextUsage ? (nextUsage.bucket + 1) * REQUEST_MS : Infinity, nextRegistration?.expiresAt ?? Infinity);
      if (Number.isFinite(deadline)) await scheduleCleanup(ctx, Math.max(0, deadline - Date.now()) + 1);
    }
  },
});

export const cleanupCredential = internalMutation({
  args: { accessId: v.optional(v.id("connections")), refreshId: v.optional(v.id("oauthRefresh")) },
  handler: async (ctx, args) => {
    if (args.accessId) {
      const access = await ctx.db.get(args.accessId);
      if (access?.oauthConnectionId && Date.parse(access.expiresAt ?? "") <= Date.now()) await ctx.db.delete(access._id);
    }
    if (args.refreshId) {
      const refresh = await ctx.db.get(args.refreshId);
      const grant = refresh ? await ctx.db.get(refresh.connectionId) : null;
      // Spent hashes stay for the entire live family, so even an old replay
      // can close it. Removing them never makes credentials acceptable.
      if (refresh && (!grant || grant.revokedAt || Date.parse(grant.expiresAt ?? "") <= Date.now())) await ctx.db.delete(refresh._id);
    }
  },
});

export const refresh = internalMutation({
  args: { tokenHash: hash, clientId: v.string(), resource: v.string(), accessHash: hash, refreshHash: hash, requestedScopes: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("oauthRefresh").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash)).unique();
    if (!row || row.clientId !== args.clientId || row.resource !== args.resource) return invalid();
    const connection = await ctx.db.get(row.connectionId);
    if (row.usedAt !== undefined) {
      // Return an error rather than throwing: the replay-triggered family
      // revocation must commit even though no replacement token is issued.
      if (connection && !connection.revokedAt) await ctx.db.patch(connection._id, { revokedAt: new Date().toISOString() });
      return invalid();
    }
    if (row.expiresAt <= Date.now() || !connectionIsUsable(connection) || !await registrationLive(ctx, connection) || connection.authorizationVersion !== 2 || connection.kind !== "oauth" || connection.oauthConnectionId) return invalid();
    if (args.requestedScopes) {
      const approved = new Set(row.scopes), requested = new Set(args.requestedScopes);
      if (requested.size !== args.requestedScopes.length || requested.size !== approved.size || args.requestedScopes.some((scope) => !approved.has(scope))) return { error: "invalid_scope" as const };
    }
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    await ctx.db.patch(connection._id, { lastUsedAt: new Date().toISOString() });
    return issueOAuth(ctx, connection, args.accessHash, args.refreshHash, row.scopes);
  },
});

/**
 * One-tap approval (Planban 2.0): a signed-in person allows or denies a
 * waiting agent's request from any device. Nothing existed before this
 * decision; it is recorded once per device code, and an approval counts
 * against the person's own hourly limit.
 */
export const decideDevice = internalMutation({
  args: {
    connectionId: v.id("connections"), deviceHash: hash, allow: v.boolean(),
    clientId: v.string(), clientName: v.string(), resource: v.string(), scopes: v.array(v.string()), level: agentLevel,
    purpose: v.union(v.literal("oauth"), v.literal("machine")), expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const approver = await liveConnection(ctx, args.connectionId);
    if (!approver.canAdminister) fail("forbidden", "Approve sign-ins from your own sign-in.");
    if (!/^[a-f0-9]{64}$/.test(args.deviceHash) || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + REQUEST_MS) fail("unauthorized", "This request has ended. Ask for a new code.");
    if (args.purpose !== "machine" || args.clientId !== MACHINE_CLIENT_ID || args.scopes.length !== 1 || args.scopes[0] !== "planban:machine" || args.level !== "complete") fail("validation", "Invalid sign-in request.");
    if (await ctx.db.query("oauthRequests").withIndex("by_deviceHash", (q) => q.eq("deviceHash", args.deviceHash)).first()) fail("unauthorized", "This request was already answered.");
    const base = {
      requestHash: args.deviceHash, deviceHash: args.deviceHash, clientId: args.clientId, clientName: args.clientName, redirectUri: "", resource: args.resource,
      scopes: args.scopes, level: args.level, challenge: "", state: "", purpose: args.purpose, userId: approver.userId, approverConnectionId: approver._id, expiresAt: args.expiresAt,
    };
    if (!args.allow) {
      await ctx.db.insert("oauthRequests", { ...base, status: "denied" });
      await scheduleCleanup(ctx, Math.max(0, args.expiresAt - Date.now()) + CODE_MS);
      return { allowed: false };
    }
    await refuseDeletedAccount(ctx, approver.userId);
    await chargeApproval(ctx, approver.userId);
    const now = new Date().toISOString();
    // Like any approval: a pending connection with no credential until the agent collects it.
    const connectionId = await ctx.db.insert("connections", {
      userId: approver.userId, kind: args.purpose, name: args.clientName, clientName: args.clientName, boards: "all", level: "complete",
      canAdminister: true, createdAt: now, lastUsedAt: now, oauthClientId: args.clientId, oauthResource: args.resource, authorizationVersion: 2, oauthPending: true,
    });
    await ctx.db.insert("oauthRequests", { ...base, status: "approved", connectionId, codeExpiresAt: args.expiresAt });
    await scheduleCleanup(ctx, Math.max(0, args.expiresAt - Date.now()) + CODE_MS);
    return { allowed: true };
  },
});

/** Whether a waiting agent's request has been answered yet. A read only. */
export const deviceAnswered = internalQuery({
  args: { deviceHash: hash },
  handler: async (ctx, { deviceHash }) => !!await ctx.db.query("oauthRequests").withIndex("by_deviceHash", (q) => q.eq("deviceHash", deviceHash)).first(),
});

/**
 * The waiting agent collects its sign-in with its device code. Until someone
 * answers, nothing is read but the index and nothing is written.
 */
export const redeemDevice = internalMutation({
  args: { deviceHash: hash, clientId: v.string(), resource: v.string(), accessHash: hash },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("oauthRequests").withIndex("by_deviceHash", (q) => q.eq("deviceHash", args.deviceHash)).first();
    if (!row) return { error: "authorization_pending" as const };
    if (row.clientId !== args.clientId || row.resource !== args.resource) return { error: "invalid_grant" as const };
    if (row.status === "denied") return { error: "access_denied" as const };
    if (row.status !== "approved" || !row.connectionId || (row.codeExpiresAt ?? 0) <= Date.now()) return { error: "expired_token" as const };
    const connection = await ctx.db.get(row.connectionId);
    if (!connection || connection.revokedAt || !connection.oauthPending) return { error: "invalid_grant" as const };
    if (!row.approverConnectionId || !connectionIsUsable(await ctx.db.get(row.approverConnectionId))) return { error: "invalid_grant" as const };
    await ctx.db.patch(row._id, { status: "consumed" });
    await ctx.db.patch(connection._id, { oauthPending: false, tokenHash: args.accessHash });
    await ctx.scheduler.runAfter(0, internal.people.refresh, { userId: connection.userId });
    return { machine: true as const, userId: connection.userId, scope: "planban:machine", expiresIn: REFRESH_IDLE_MS / 1000, refresh: false };
  },
});
