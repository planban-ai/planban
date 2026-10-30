import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import * as oauth from "../online/service/convex/oauth";
import { authenticate } from "../online/service/convex/model/auth";
import { connectionIsUsable, resolvedConnection } from "../online/service/convex/model/access";
import { forOAuthClient, revoke, setAccess, list } from "../online/service/convex/connections";
import { machineSignIn } from "../online/service/convex/http";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const handler = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

function fixture() {
  const rows: any[] = [];
  const jobs: Array<{ at: number; fn: unknown; args: unknown }> = [];
  let sequence = 0;
  const db: any = {
    get: async (id: string) => rows.find((row) => row._id === id) ?? null,
    normalizeId: (_table: string, id: string) => id,
    insert: async (table: string, value: any) => { const id = `${table}-${++sequence}`; rows.push({ ...value, _id: id, _creationTime: Date.now(), table }); return id; },
    patch: async (id: string, fields: any) => Object.assign(rows.find((row) => row._id === id), fields),
    delete: async (id: string) => { const index = rows.findIndex((row) => row._id === id); if (index >= 0) rows.splice(index, 1); },
    query(table: string) {
      const filters: Array<(row: any) => boolean> = [];
      let sort: "asc" | "desc" | null = null;
      const matches = () => {
        const found = rows.filter((row) => row.table === table && filters.every((filter) => filter(row)));
        const key = table === "oauthUsage" ? "bucket" : "expiresAt";
        return sort ? found.sort((a, b) => (a[key] - b[key]) * (sort === "asc" ? 1 : -1)) : found;
      };
      const query: any = { withIndex(_index: string, build: any) { const index: any = {
        eq(key: string, value: unknown) { filters.push((row) => row[key] === value); return index; },
        gt(key: string, value: any) { filters.push((row) => row[key] !== undefined && row[key] > value); return index; },
        lt(key: string, value: any) { filters.push((row) => row[key] < value); return index; },
        lte(key: string, value: any) { filters.push((row) => row[key] <= value); return index; },
      }; build?.(index); return query; }, unique: async () => matches()[0] ?? null, collect: async () => matches(), take: async (count: number) => matches().slice(0, count), order(direction: "asc" | "desc") { sort = direction; return query; }, first: async () => matches()[0] ?? null };
      return query;
    },
  };
  const ctx: any = { db, scheduler: { runAfter: async (delay: number, fn: unknown, args: unknown) => { jobs.push({ at: Date.now() + delay, fn, args }); } } };
  const addMachine = (userId = "person", canAdminister = true) => db.insert("connections", { userId, kind: "machine", canAdminister, name: "Machine", clientName: "Machine", boards: "all", level: "complete", lastUsedAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  async function request(label: string, purpose = "oauth", callback: { clientId?: string; redirectUri?: string } = {}, userId = "person") {
    const args = { userId, expiresAt: Date.now() + (purpose === "machine" ? oauth.MACHINE_REQUEST_MS : oauth.REQUEST_MS), requestHash: digest(`request-${label}`), browserHash: digest(`browser-${label}`), csrfHash: digest(`csrf-${label}`), clientId: "https://client.example/client.json", clientName: "Fixture app", redirectUri: "http://127.0.0.1:4444/callback", resource: "https://planban.example/mcp", scopes: ["planban:plan", "offline_access"], level: "plan", challenge: "a".repeat(43), state: `state-${label}`, purpose };
    if (purpose === "machine") { args.clientId = oauth.MACHINE_CLIENT_ID; args.scopes = ["planban:machine"]; args.level = "complete"; }
    Object.assign(args, callback);
    await handler(oauth.createRequest, ctx, args);
    return { ...args, codeHash: digest(`code-${label}`), accessHash: digest(`access-${label}`), refreshHash: digest(`refresh-${label}`) };
  }
  async function approve(args: any, approverConnectionId: string, userId = "person") {
    await handler(oauth.bindIdentity, ctx, { ...args, userId });
    await handler(oauth.approve, ctx, { ...args, userId, approverConnectionId, deny: false });
    return rows.find((row) => row.table === "oauthRequests" && row.requestHash === args.requestHash).connectionId;
  }
  const redeem = (args: any) => handler(oauth.redeem, ctx, args);
  const accessId = (tokenHash: string) => rows.find((row) => row.table === "connections" && row.tokenHash === tokenHash)._id;
  async function runDueCleanup() {
    for (let rounds = 0; rounds < 100; rounds++) {
      const index = jobs.findIndex((job) => job.at <= Date.now() && getFunctionName(job.fn as any) === "oauth:cleanupRequests");
      if (index < 0) return;
      const [job] = jobs.splice(index, 1);
      await handler(oauth.cleanupRequests, ctx, job!.args);
    }
    throw new Error("Cleanup did not settle in bounded batches");
  }
  const cleanupNow = () => handler(oauth.cleanupRequests, ctx, { ticket: rows.find((row) => row.table === "oauthCleanup")?.ticket });
  return { ctx, rows, db, jobs, runDueCleanup, cleanupNow, addMachine, request, approve, redeem, accessId };
}

test("machine lease starts before browser claim, cannot be replayed or extended by approval, and refuses exact expiry", async () => {
  const original = Date.now; let now = 100000; Date.now = () => now;
  try {
    const f = fixture();
    const start = { launchHash: digest("launch"), requestHash: digest("unclaimed"), redirectUri: "http://127.0.0.1:53682/callback", resource: "https://planban.example", challenge: "a".repeat(43), state: "opaque" };
    const lease = await handler(oauth.startMachine, f.ctx, start);
    assert.equal(lease.expiresAt, now + 300000);
    const row = f.rows.find(r => r.table === "oauthRequests");
    assert.equal(row.browserHash, undefined);
    assert.equal(row.status, "awaiting_browser");
    const claim = { launchHash: start.launchHash, requestHash: digest("claimed"), browserHash: digest("browser"), csrfHash: digest("csrf") };
    now += 120000;
    assert.equal(await handler(oauth.claimMachine, f.ctx, claim), true);
    assert.equal(await handler(oauth.claimMachine, f.ctx, { ...claim, browserHash: digest("other") }), false);
    assert.equal(row.browserHash, claim.browserHash);
    assert.equal(row.expiresAt, lease.expiresAt);
    assert.equal(f.rows.find(r => r.table === "oauthUsage").requests, 1, "claim neither meters nor allocates again");
    const admin = await f.addMachine();
    now = lease.expiresAt - 1;
    await handler(oauth.bindIdentity, f.ctx, { ...claim, userId: "person" });
    await handler(oauth.approve, f.ctx, { ...claim, userId: "person", approverConnectionId: admin, codeHash: digest("code"), deny: false });
    assert.equal(row.expiresAt, lease.expiresAt);
    assert.equal(row.codeExpiresAt, lease.expiresAt, "near-end code must not extend the lease");
    now = lease.expiresAt;
    assert.equal(await handler(oauth.redemptionContext, f.ctx, { codeHash: row.codeHash }), null);
    assert.equal((await handler(oauth.redeem, f.ctx, { ...start, codeHash: row.codeHash, clientId: "planban-cli", accessHash: digest("access"), refreshHash: digest("refresh") })).error, "invalid_grant");
    assert.equal(await handler(oauth.inspect, f.ctx, claim), null);
    assert.equal((await f.db.get(row.connectionId)).oauthPending, true);
  } finally { Date.now = original; }
});

test("PKCE-owned cancellation wins before claim or redemption and leaves consumed independent machines unchanged", async () => {
  const f = fixture();
  const start = { launchHash: digest("cancel-launch"), requestHash: digest("unclaimed"), redirectUri: "http://127.0.0.1:53682/callback", resource: "https://planban.example", challenge: "a".repeat(43), state: "opaque" };
  await handler(oauth.startMachine, f.ctx, start);
  const row = f.rows.find(r => r.table === "oauthRequests");
  await handler(oauth.cancelMachine, f.ctx, { launchHash: start.launchHash, challenge: "wrong" });
  assert.equal(row.status, "awaiting_browser");
  const claim = { launchHash: start.launchHash, requestHash: digest("claimed"), browserHash: digest("browser"), csrfHash: digest("csrf") };
  assert.equal(await handler(oauth.claimMachine, f.ctx, claim), true);
  const admin = await f.addMachine();
  await handler(oauth.bindIdentity, f.ctx, { ...claim, userId: "person" });
  await handler(oauth.approve, f.ctx, { ...claim, userId: "person", approverConnectionId: admin, codeHash: digest("code"), deny: false });
  await handler(oauth.cancelMachine, f.ctx, start);
  assert.equal(row.status, "denied");
  assert.ok((await f.db.get(row.connectionId)).revokedAt);
  assert.equal((await f.db.get(admin)).revokedAt, undefined);
  const tombstone = (await f.db.get(row.connectionId)).revokedAt;
  await handler(oauth.cancelMachine, f.ctx, start);
  assert.equal((await f.db.get(row.connectionId)).revokedAt, tombstone);
  await handler(oauth.startMachine, f.ctx, { ...start, launchHash: digest("second-launch"), requestHash: digest("second") });
  const second = f.rows.find(r => r.launchHash === digest("second-launch"));
  await handler(oauth.cancelMachine, f.ctx, { launchHash: second.launchHash, challenge: start.challenge });
  assert.equal(await handler(oauth.claimMachine, f.ctx, { ...claim, launchHash: second.launchHash }), false);
  row.status = "consumed"; (await f.db.get(row.connectionId)).oauthPending = false;
  await handler(oauth.cancelMachine, f.ctx, start);
  assert.equal(row.status, "consumed", "consumed row cannot be rewritten by cancellation");
  assert.equal((await f.db.get(row.connectionId)).revokedAt, tombstone, "cancellation cannot revive or replace tombstones");
});

test("known redeemed machine token revocation closes only its exact machine and preserves prior tombstones", async () => {
  const f = fixture(), tokenHash = digest("machine-token");
  const machine = await f.db.insert("connections", { kind: "machine", tokenHash, authorizationVersion: 2, oauthClientId: "planban-cli", oauthPending: false });
  const other = await f.addMachine();
  await handler(oauth.revokeToken, f.ctx, { clientId: "other-client", tokenHash });
  assert.equal((await f.db.get(machine)).revokedAt, undefined);
  await handler(oauth.revokeToken, f.ctx, { clientId: "planban-cli", tokenHash });
  const tombstone = (await f.db.get(machine)).revokedAt;
  assert.ok(tombstone);
  assert.equal((await f.db.get(other)).revokedAt, undefined);
  await handler(oauth.revokeToken, f.ctx, { clientId: "planban-cli", tokenHash });
  assert.equal((await f.db.get(machine)).revokedAt, tombstone);
});

test("explicit approval creates an independently revocable pending grant and one code redemption activates it", async () => {
  const f = fixture(), machine = await f.addMachine(), args = await f.request("first");
  const grant = await f.approve(args, machine);
  assert.equal(connectionIsUsable(await f.db.get(grant)), false);
  assert.equal(f.rows.filter((row) => row.tokenHash).length, 0);
  assert.equal((await f.redeem(args)).error, undefined);
  assert.equal((await resolvedConnection(f.ctx, f.accessId(args.accessHash)))?._id, grant);
  assert.equal((await f.redeem(args)).error, "invalid_grant");
  assert.equal(f.rows.filter((row) => row.table === "connections" && row.oauthConnectionId === grant).length, 1);
});

test("code redemption is bound to PKCE, client, redirect and resource without consuming a valid pending code on mismatch", async () => {
  const f = fixture(), machine = await f.addMachine(), args = await f.request("binding");
  const grant = await f.approve(args, machine);
  for (const field of ["challenge", "clientId", "redirectUri", "resource"]) assert.equal((await f.redeem({ ...args, [field]: "wrong" })).error, "invalid_grant");
  assert.equal((await f.db.get(grant)).oauthPending, true);
  assert.equal((await f.redeem(args)).error, undefined);
});

test("Claude native port flexibility ends at authorization; code redemption requires the exact frozen localhost URI", async () => {
  const f = fixture(), machine = await f.addMachine();
  const args = await f.request("code-localhost", "oauth", { clientId: "https://claude.ai/oauth/claude-code-client-metadata", redirectUri: "http://localhost:54114/callback" });
  const grant = await f.approve(args, machine);
  for (const redirectUri of ["http://localhost:54115/callback", "http://localhost/callback", "http://127.0.0.1:54114/callback", "http://localhost:54114/other"]) assert.equal((await f.redeem({ ...args, redirectUri })).error, "invalid_grant");
  for (const mismatch of [{ challenge: "b".repeat(43) }, { resource: "https://attacker.example/mcp" }]) assert.equal((await f.redeem({ ...args, ...mismatch })).error, "invalid_grant");
  assert.equal((await f.db.get(grant)).oauthPending, true);
  assert.equal((await f.redeem(args)).error, undefined);
  assert.equal((await f.redeem(args)).error, "invalid_grant");
});

test("revoked grants remain denied after fresh approval, including refresh-derived access and legacy lookups", async () => {
  const f = fixture(), machine = await f.addMachine(), old = await f.request("old");
  const oldGrant = await f.approve(old, machine); await f.redeem(old);
  const refreshed = { tokenHash: old.refreshHash, clientId: old.clientId, resource: old.resource, accessHash: digest("old-descendant"), refreshHash: digest("old-refresh-descendant") };
  assert.equal((await handler(oauth.refresh, f.ctx, refreshed)).error, undefined);
  await f.db.patch(oldGrant, { revokedAt: new Date().toISOString() });
  const fresh = await f.request("fresh"), newGrant = await f.approve(fresh, machine); await f.redeem(fresh);
  for (const tokenHash of [old.accessHash, refreshed.accessHash]) assert.equal(await resolvedConnection(f.ctx, f.accessId(tokenHash)), null);
  assert.equal((await handler(oauth.refresh, f.ctx, { ...refreshed, tokenHash: refreshed.refreshHash })).error, "invalid_grant");
  assert.equal((await resolvedConnection(f.ctx, f.accessId(fresh.accessHash)))?._id, newGrant);
  assert.equal(await handler(forOAuthClient, f.ctx, { userId: "person", clientId: fresh.clientId, clientName: "Fixture app" }), null);
  assert.ok((await f.db.get(oldGrant)).revokedAt);
});

test("spent refresh replay closes only its family and preserves independent connections and machines", async () => {
  const f = fixture(), firstMachine = await f.addMachine(), secondMachine = await f.addMachine();
  const first = await f.request("family-a"), second = await f.request("family-b");
  await f.approve(first, firstMachine); await f.redeem(first);
  const secondGrant = await f.approve(second, secondMachine); await f.redeem(second);
  const refreshArgs = { tokenHash: first.refreshHash, clientId: first.clientId, resource: first.resource, accessHash: digest("rotated-access"), refreshHash: digest("rotated-refresh") };
  assert.equal((await handler(oauth.refresh, f.ctx, refreshArgs)).error, undefined);
  assert.ok(await resolvedConnection(f.ctx, f.accessId(refreshArgs.accessHash)));
  assert.equal((await handler(oauth.refresh, f.ctx, refreshArgs)).error, "invalid_grant");
  for (const tokenHash of [first.accessHash, refreshArgs.accessHash]) assert.equal(await resolvedConnection(f.ctx, f.accessId(tokenHash)), null);
  assert.equal((await resolvedConnection(f.ctx, f.accessId(second.accessHash)))?._id, secondGrant);
  assert.ok(await resolvedConnection(f.ctx, firstMachine));
  assert.ok(await resolvedConnection(f.ctx, secondMachine));
});

test("refresh accepts an explicit approved scope set and refuses changes without consuming credentials", async () => {
  const f = fixture(), machine = await f.addMachine(), args = await f.request("explicit-scope");
  const grant = await f.approve(args, machine); await f.redeem(args);
  const next = { tokenHash: args.refreshHash, clientId: args.clientId, resource: args.resource, accessHash: digest("explicit-access"), refreshHash: digest("explicit-next") };
  for (const requestedScopes of [["planban:complete", "offline_access"], ["planban:plan"], ["offline_access"], [], ["planban:plan", "planban:plan", "offline_access"]]) {
    assert.equal((await handler(oauth.refresh, f.ctx, { ...next, requestedScopes })).error, "invalid_scope");
    assert.equal(f.rows.find((row) => row.table === "oauthRefresh" && row.tokenHash === args.refreshHash).usedAt, undefined);
    assert.equal((await f.db.get(grant)).revokedAt, undefined);
  }
  assert.equal((await handler(oauth.refresh, f.ctx, { ...next, requestedScopes: ["offline_access", "planban:plan"] })).scope, "planban:plan offline_access");
  assert.equal((await handler(oauth.refresh, f.ctx, { ...next, requestedScopes: ["planban:complete"] })).error, "invalid_grant", "spent replay closes its family even with a changed scope");
  assert.ok((await f.db.get(grant)).revokedAt);
});

test("grant changes and refresh cannot expand an access credential beyond its approved scope", async () => {
  const f = fixture(), machine = await f.addMachine(), args = await f.request("scope-ceiling");
  const grant = await f.approve(args, machine); await f.redeem(args);
  await f.db.patch(grant, { level: "complete" });
  assert.equal((await resolvedConnection(f.ctx, f.accessId(args.accessHash)))?.level, "plan");
  const next = { tokenHash: args.refreshHash, clientId: args.clientId, resource: args.resource, accessHash: digest("scoped-refresh"), refreshHash: digest("scoped-refresh-next") };
  assert.equal((await handler(oauth.refresh, f.ctx, next)).scope, "planban:plan offline_access");
  assert.equal((await resolvedConnection(f.ctx, f.accessId(next.accessHash)))?.level, "plan");
  assert.equal((await handler(oauth.refresh, f.ctx, { ...next, tokenHash: next.refreshHash, resource: "https://other.example/mcp" })).error, "invalid_grant");
});

test("metadata budget is atomic, bounds failed fetch attempts and respects creation quota and rollover", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T00:00:00Z") });
  const f = fixture(), clientId = "https://chatgpt.com/oauth/codex/client.json";
  assert.equal(await handler(oauth.reserveMetadataFetch, f.ctx, { clientId: "https://attacker.example/client.json" }), false);
  assert.equal(f.rows.length, 0);
  for (let attempt = 0; attempt < 100; attempt++) assert.equal(await handler(oauth.reserveMetadataFetch, f.ctx, { clientId }), true);
  assert.equal(await handler(oauth.reserveMetadataFetch, f.ctx, { clientId }), false);
  const usage = f.rows.find((row) => row.table === "oauthUsage");
  assert.equal(usage.requests, 0, "network failures still consume their separate budget");
  assert.equal(usage.fetches, 100);
  assert.equal(f.rows.filter((row) => row.table === "oauthRequests").length, 0);
  assert.equal(f.jobs.filter((job) => getFunctionName(job.fn as any) === "oauth:cleanupRequests").length, 1);
  t.mock.timers.tick(oauth.REQUEST_MS);
  assert.equal(await handler(oauth.reserveMetadataFetch, f.ctx, { clientId }), true);
  const current = f.rows.find((row) => row.table === "oauthUsage" && row.bucket !== usage.bucket);
  await f.db.patch(current._id, { requests: oauth.AUTHORIZE_REQUESTS_PER_WINDOW });
  assert.equal(await handler(oauth.reserveMetadataFetch, f.ctx, { clientId }), false, "exhausted creation quota also prevents outbound work");
  t.mock.timers.tick(oauth.REQUEST_MS + oauth.CODE_MS);
  await f.runDueCleanup();
  assert.equal(f.rows.filter((row) => row.table === "oauthUsage").length, 0);
  assert.equal(f.jobs.filter((job) => getFunctionName(job.fn as any) === "oauth:cleanupRequests").length, 0);
});

test("browser-bound cancellation consumes a pending request without identity or a grant", async () => {
  const f = fixture(), args = await f.request("cancel-without-identity");
  for (const field of ["browserHash", "csrfHash"]) await assert.rejects(handler(oauth.denyRequest, f.ctx, { ...args, [field]: digest("wrong") }), /fresh authorization/);
  const result = await handler(oauth.denyRequest, f.ctx, args);
  assert.equal(result.redirectUri, args.redirectUri);
  assert.equal(result.state, args.state);
  assert.equal(f.rows.find((row) => row.table === "oauthRequests").status, "denied");
  assert.equal(f.rows.filter((row) => row.table === "connections").length, 0);
  await assert.rejects(handler(oauth.bindIdentity, f.ctx, { ...args, userId: "person", sessionId: "sess_fixture" }), /fresh authorization/);
  await assert.rejects(handler(oauth.denyRequest, f.ctx, args), /fresh authorization/);
});

test("cross-user approval, agent approval and mismatched browser/CSRF are denied", async () => {
  const f = fixture(), machine = await f.addMachine(), other = await f.addMachine("other"), agent = await f.addMachine("person", false), args = await f.request("consent");
  for (const field of ["browserHash", "csrfHash"]) await assert.rejects(handler(oauth.bindIdentity, f.ctx, { ...args, userId: "person", [field]: digest("wrong") }), /fresh authorization/);
  await handler(oauth.bindIdentity, f.ctx, { ...args, userId: "person" });
  await assert.rejects(handler(oauth.approve, f.ctx, { ...args, userId: "other", approverConnectionId: other, deny: false }), /fresh authorization/);
  await assert.rejects(handler(oauth.approve, f.ctx, { ...args, userId: "person", approverConnectionId: agent, deny: false }), /own sign-in/);
  await handler(oauth.approve, f.ctx, { ...args, userId: "person", approverConnectionId: machine, deny: true });
  assert.equal((await f.redeem(args)).error, "invalid_grant");
});

test("revoking approval authority or pending connection wins before code redemption", async () => {
  const f = fixture(), machine = await f.addMachine(), args = await f.request("revoked-approver");
  await f.approve(args, machine); await f.db.patch(machine, { revokedAt: new Date().toISOString() });
  assert.equal((await f.redeem(args)).error, "invalid_grant");
  const independent = await f.addMachine(), next = await f.request("revoked-pending");
  const grant = await f.approve(next, independent); await f.db.patch(grant, { revokedAt: new Date().toISOString() });
  assert.equal((await f.redeem(next)).error, "invalid_grant");
  assert.ok(await resolvedConnection(f.ctx, independent));
});

test("request, code and access expiry refuse exactly at their boundary; refreshed grant respects current level", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T00:00:00Z") });
  const f = fixture(), machine = await f.addMachine(), request = await f.request("expiry");
  t.mock.timers.tick(oauth.REQUEST_MS);
  await assert.rejects(f.approve(request, machine), /fresh authorization/);
  const code = await f.request("code-expiry"); await f.approve(code, machine);
  t.mock.timers.tick(oauth.CODE_MS);
  assert.equal((await f.redeem(code)).error, "invalid_grant");
  const active = await f.request("access-expiry"), grant = await f.approve(active, machine); await f.redeem(active);
  await f.db.patch(grant, { level: "read" });
  assert.equal((await resolvedConnection(f.ctx, f.accessId(active.accessHash)))?.level, "read");
  t.mock.timers.tick(oauth.ACCESS_MS);
  assert.equal(await resolvedConnection(f.ctx, f.accessId(active.accessHash)), null);
  assert.equal((await handler(oauth.refresh, f.ctx, { tokenHash: active.refreshHash, clientId: active.clientId, resource: active.resource, accessHash: digest("after-expiry"), refreshHash: digest("after-expiry-refresh") })).error, undefined);
  assert.equal((await resolvedConnection(f.ctx, f.accessId(digest("after-expiry"))))?.level, "read");
});

test("legacy provider tokens cannot become resources or new machines, while explicit machine approval issues a separate connection", async () => {
  const f = fixture();
  const forbiddenCtx: any = { runQuery: () => { throw new Error("Legacy credential must never resolve"); }, runMutation: () => { throw new Error("Legacy exchange must never create a machine"); } };
  assert.equal(await authenticate(forbiddenCtx, new Request("https://planban.example/mcp", { headers: { Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.legacy.signature" } })), null);
  const response = await (machineSignIn as any)._handler(forbiddenCtx, new Request("https://planban.example/api/v1/auth/machine", { method: "POST", headers: { Authorization: "Bearer old-or-refresh-derived" } }));
  assert.equal(response.status, 401);
  const prior = await f.addMachine(), args = await f.request("machine", "machine");
  const grant = await f.approve(args, prior), result = await f.redeem(args);
  assert.equal(result.machine, true); assert.equal(result.refresh, false);
  assert.equal((await resolvedConnection(f.ctx, grant))?.canAdminister, true);
  assert.ok(await resolvedConnection(f.ctx, prior));
});

test("session-approved codes require a fresh server-verified session identity at redemption", async () => {
  const f = fixture(), args = await f.request("session", "machine"), sessionId = "verified-session";
  await handler(oauth.bindIdentity, f.ctx, { ...args, userId: "person", sessionId });
  await handler(oauth.approve, f.ctx, { ...args, userId: "person", sessionId, deny: false });
  assert.equal((await f.redeem(args)).error, "invalid_grant");
  assert.equal((await f.redeem({ ...args, sessionId, sessionUserId: "other" })).error, "invalid_grant");
  assert.equal((await f.redeem({ ...args, sessionId: "other-session", sessionUserId: "person" })).error, "invalid_grant");
  assert.equal((await f.redeem({ ...args, sessionId, sessionUserId: "person" })).machine, true);
});

test("machine approval cannot bypass an existing session binding", async () => {
  const f = fixture(), machine = await f.addMachine(), args = await f.request("bound-session");
  await handler(oauth.bindIdentity, f.ctx, { ...args, userId: "person", sessionId: "session-a" });
  for (const sessionId of [undefined, "session-b"]) {
    await assert.rejects(handler(oauth.approve, f.ctx, { ...args, userId: "person", approverConnectionId: machine, sessionId, deny: false }), /signed-in session changed/);
  }
  assert.equal(f.rows.filter((row) => row.oauthPending).length, 0);
  await handler(oauth.approve, f.ctx, { ...args, userId: "person", approverConnectionId: machine, sessionId: "session-a", deny: false });
  assert.equal((await f.redeem(args)).error, undefined);
});

test("cleanup respects a late-approved code's deadline beyond the original request deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T00:00:00Z") });
  const f = fixture(), machine = await f.addMachine(), args = await f.request("late-approval");
  t.mock.timers.tick(oauth.REQUEST_MS - 1);
  const grant = await f.approve(args, machine);
  t.mock.timers.tick(2);
  await f.cleanupNow();
  assert.equal((await f.db.get(grant)).revokedAt, undefined);
  assert.equal(f.rows.find((row) => row.table === "oauthRequests").codeExpiresAt - Date.now(), oauth.CODE_MS - 2);
  assert.equal((await f.redeem(args)).error, undefined);
});

test("scheduled cleanup follows later bucket requests and late-approved deadlines without a new request", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T00:00:00Z") });
  const f = fixture(), machine = await f.addMachine();
  await f.request("bucket-first");
  t.mock.timers.tick(2 * 60_000);
  const second = await f.request("bucket-second");
  t.mock.timers.tick(8 * 60_000 + 30_000);
  const grant = await f.approve(second, machine);
  t.mock.timers.tick(30_000);
  await f.runDueCleanup();
  assert.equal((await f.db.get(grant)).revokedAt, undefined, "the code is still valid at the first scheduled job");
  assert.ok(f.jobs.some((job) => job.at > Date.now() && getFunctionName(job.fn as any) === "oauth:cleanupRequests"));
  // An approved request is kept until its sign-in note would have expired, so the note can't be approved twice.
  t.mock.timers.tick(60_000 + oauth.CODE_MS);
  await f.runDueCleanup();
  assert.equal(f.rows.filter((row) => row.table === "oauthRequests").length, 0);
  assert.ok((await f.db.get(grant)).revokedAt);
  assert.equal(f.jobs.filter((job) => getFunctionName(job.fn as any) === "oauth:cleanupRequests").length, 0, "cleanup stops once its outstanding requests are gone");
});

test("continuous traffic uses one cleanup driver across client buckets and terminates after traffic stops", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T00:00:00Z") });
  const f = fixture();
  const queued = () => f.jobs.filter((job) => getFunctionName(job.fn as any) === "oauth:cleanupRequests");
  for (let minute = 0; minute < 240; minute++) {
    // Each approval counts against its own person's hourly limit.
    await f.request(`continuous-${minute}`, "oauth", {}, `person-${minute}`);
    await f.runDueCleanup();
    assert.equal(queued().length, 1, `one driver after minute ${minute}`);
    assert.ok(f.rows.filter((row) => row.table === "oauthRequests").length <= 12, "expired requests remain bounded");
    t.mock.timers.tick(60_000);
  }
  t.mock.timers.tick(oauth.REQUEST_MS + oauth.CODE_MS + 1);
  await f.runDueCleanup();
  assert.equal(queued().length, 0);
  assert.equal(f.rows.filter((row) => row.table === "oauthRequests" || row.table === "oauthUsage").length, 0);
  const state = f.rows.find((row) => row.table === "oauthCleanup");
  const ticket = state.ticket;
  await handler(oauth.cleanupRequests, f.ctx, { ticket: ticket - 1 });
  assert.equal(queued().length, 0, "a stale ticket cannot restart a cleanup chain");
  await f.request("after-idle");
  assert.equal(queued().length, 1);
  assert.ok(state.ticket > ticket, "a new idle-to-active transition owns a fresh ticket");
});

test("cleanup preserves a current rate counter until bucket rollover and removes it without more traffic", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T00:00:00Z") });
  const f = fixture();
  // Planban 1.x command lines still start a stored lease, metered against the shared budget.
  await handler(oauth.startMachine, f.ctx, { launchHash: digest("legacy-launch"), requestHash: digest("legacy-request"), challenge: "a".repeat(43), state: "legacy", redirectUri: "http://127.0.0.1:53682/callback", resource: "https://planban.example" });
  t.mock.timers.tick(oauth.MACHINE_REQUEST_MS + oauth.CODE_MS);
  await f.runDueCleanup();
  assert.equal(f.rows.filter((row) => row.table === "oauthRequests").length, 0);
  assert.equal(f.rows.filter((row) => row.table === "oauthUsage").length, 1, "the current quota cannot reset early");
  t.mock.timers.tick(oauth.REQUEST_MS);
  await f.runDueCleanup();
  assert.equal(f.rows.filter((row) => row.table === "oauthUsage").length, 0);
  assert.equal(f.jobs.filter((job) => getFunctionName(job.fn as any) === "oauth:cleanupRequests").length, 0);
});

test("token revocation is idempotent and closes its exact family without revoking another app installation", async () => {
  const f = fixture(), machine = await f.addMachine(), first = await f.request("revoke-a"), second = await f.request("revoke-b");
  await f.approve(first, machine); await f.redeem(first); await f.approve(second, machine); await f.redeem(second);
  const args = { tokenHash: first.refreshHash, clientId: first.clientId };
  for (const tokenHash of ["unknown", args.tokenHash, args.tokenHash]) assert.deepEqual(await handler(oauth.revokeToken, f.ctx, { ...args, tokenHash }), { revoked: true });
  assert.equal(await resolvedConnection(f.ctx, f.accessId(first.accessHash)), null);
  assert.ok(await resolvedConnection(f.ctx, f.accessId(second.accessHash)));
  assert.ok(await resolvedConnection(f.ctx, machine));
});

test("cleanup removes expired requests and access aliases without reopening tombstones or losing live-family replay hashes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T00:00:00Z") });
  const f = fixture(), machine = await f.addMachine(), active = await f.request("cleanup-active"), abandoned = await f.request("cleanup-pending");
  const activeGrant = await f.approve(active, machine); await f.redeem(active);
  const abandonedGrant = await f.approve(abandoned, machine);
  const accessId = f.accessId(active.accessHash), refreshId = f.rows.find((row) => row.table === "oauthRefresh")._id;
  t.mock.timers.tick(oauth.REQUEST_MS + oauth.CODE_MS);
  await f.cleanupNow();
  assert.equal(f.rows.filter((row) => row.table === "oauthRequests").length, 0);
  assert.ok((await f.db.get(abandonedGrant)).revokedAt);
  assert.equal((await f.db.get(activeGrant)).revokedAt, undefined);
  await handler(oauth.cleanupCredential, f.ctx, { accessId, refreshId });
  assert.equal(await f.db.get(accessId), null);
  assert.ok(await f.db.get(refreshId), "refresh hashes stay while their family is live");
  assert.ok(await f.db.get(activeGrant), "grant records are never deleted by credential cleanup");
  await f.db.patch(activeGrant, { revokedAt: new Date().toISOString() });
  await handler(oauth.cleanupCredential, f.ctx, { refreshId });
  assert.equal(await f.db.get(refreshId), null);
  assert.ok((await f.db.get(activeGrant)).revokedAt);
});

test("account controls operate on grants, cannot edit access aliases, and self-revocation closes the family", async () => {
  const f = fixture(), machine = await f.addMachine(), args = await f.request("account-controls");
  const grant = await f.approve(args, machine); await f.redeem(args);
  const alias = f.accessId(args.accessHash);
  const entries = await handler(list, f.ctx, { connectionId: machine });
  assert.ok(entries.connections.some((entry: any) => entry.id === grant));
  assert.ok(!entries.connections.some((entry: any) => entry.id === alias));
  await assert.rejects(handler(setAccess, f.ctx, { connectionId: machine, targetId: alias, level: "complete" }), /not found/);
  await handler(revoke, f.ctx, { connectionId: alias, targetId: "self" });
  assert.ok((await f.db.get(grant)).revokedAt);
  assert.equal(await resolvedConnection(f.ctx, alias), null);
  assert.ok(await resolvedConnection(f.ctx, machine));
});

test("resource authentication refuses service credentials bound to another configured resource", async () => {
  const prior = process.env.PLANBAN_PUBLIC_URL;
  try {
    process.env.PLANBAN_PUBLIC_URL = "https://planban.example";
    const context: any = { runQuery: async () => ({ connectionId: "alias", lastUsedAt: new Date().toISOString(), oauthResource: "https://other.example/mcp" }) };
    const request = new Request("https://planban.example/mcp", { headers: { Authorization: `Bearer pba_${"a".repeat(32)}` } });
    assert.equal(await authenticate(context, request), null);
    context.runQuery = async () => ({ connectionId: "alias", lastUsedAt: new Date().toISOString(), oauthResource: "https://planban.example/mcp" });
    assert.deepEqual(await authenticate(context, request), { connectionId: "alias" });
  } finally {
    if (prior === undefined) delete process.env.PLANBAN_PUBLIC_URL; else process.env.PLANBAN_PUBLIC_URL = prior;
  }
});
