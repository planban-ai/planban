// The stateless sign-in start (owner decision, 14 October 2026; Planban 2.0
// plan, phase 1): starts write nothing and spend no shared budget; notes are
// signed, browser-bound, expiring and single-use; approvals count per person.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import * as oauth from "../online/service/convex/oauth";
import { approvalResponse, authorizationResponse, consentValidityResponse, machineLaunchResponse, machineStartResponse } from "../online/service/convex/model/oauthConsent";
import { openNote, sealNote, type SignInNote } from "../online/service/convex/model/signInNote";

const origin = "https://planban.example", clientId = "https://chatgpt.com/oauth/codex/client.json";
const client = { clientId, name: "Codex", native: true, redirectUris: ["http://127.0.0.1/callback"] };
const fields = { client_id: clientId, redirect_uri: "http://127.0.0.1:54321/callback", response_type: "code", resource: origin + "/mcp", code_challenge: "a".repeat(43), code_challenge_method: "S256", scope: "planban:plan offline_access", state: "client-state" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const browser = "pbb_" + "b".repeat(43), csrf = "pbs_" + "c".repeat(43);
const cookie = `__Host-planban_browser=${browser}; __Host-planban_csrf=${csrf}`;

async function configured(run: () => Promise<void>) {
  const values = { PLANBAN_PUBLIC_URL: origin, CLERK_ISSUER: "https://fixture.clerk.example", CLERK_PUBLISHABLE_KEY: "pk_test_" + btoa("fixture.clerk.example$"), CLERK_SECRET_KEY: "synthetic-fixture-only", PLANBAN_SIGNIN_NOTE_KEY: "synthetic-sign-in-note-key-for-tests-only" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try { Object.assign(process.env, values); await run(); }
  finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

/** An in-memory service: the real sign-in mutations and queries against a fake database. */
function service() {
  const rows: any[] = [];
  let sequence = 0;
  const db: any = {
    get: async (id: string) => rows.find((row) => row._id === id) ?? null,
    insert: async (table: string, value: any) => { const id = `${table}-${++sequence}`; rows.push({ ...value, _id: id, _table: table }); return id; },
    patch: async (id: string, patch: any) => Object.assign(rows.find((row) => row._id === id), patch),
    delete: async (id: string) => { rows.splice(rows.findIndex((row) => row._id === id), 1); },
    normalizeId: (_table: string, id: string) => id,
    query: (table: string) => {
      let match = (row: any) => row._table === table;
      const query: any = {
        withIndex: (_name: string, range?: (q: any) => any) => {
          const q: any = {};
          const add = (test: (a: any, b: any) => boolean) => (field: string, value: any) => { const prior = match; match = (row) => prior(row) && test(row[field], value); return q; };
          q.eq = add((a, b) => a === b); q.lt = add((a, b) => a < b); q.lte = add((a, b) => a <= b); q.gt = add((a, b) => a > b);
          range?.(q);
          return query;
        },
        order: () => query,
        unique: async () => rows.find(match) ?? null,
        first: async () => rows.find(match) ?? null,
        collect: async () => rows.filter(match),
        take: async (count: number) => rows.filter(match).slice(0, count),
      };
      return query;
    },
  };
  const ctx: any = { db, scheduler: { runAfter: async () => {} } };
  const writes: string[] = [];
  const call = async (ref: any, args: any) => {
    const name = getFunctionName(ref).replace(/^oauth:/, "");
    const fn = (oauth as any)[name];
    if (!fn) throw new Error(`no fake for ${getFunctionName(ref)}`);
    return fn._handler(ctx, args);
  };
  const actionCtx: any = {
    runQuery: call,
    runMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === "oauth:reserveMetadataFetch") return true;
      if (name === "oauth:cacheMetadataClient") return;
      writes.push(name);
      return call(ref, args);
    },
  };
  return { rows, ctx, actionCtx, writes };
}

const approveRequest = (note: string, decision = "allow") => new Request(origin + "/oauth/approve", {
  method: "POST", headers: { Origin: origin, Cookie: cookie }, body: new URLSearchParams({ request: note, csrf, decision }),
});
const person = (userId = "user_alice") => async () => ({ userId, sessionId: "sess_alice" });
const consentNote = (overrides: Partial<SignInNote> = {}) => sealNote({
  v: 1, kind: "consent", purpose: "oauth", clientId, clientName: "Codex", redirectUri: fields.redirect_uri, resource: fields.resource,
  scopes: ["planban:plan", "offline_access"], level: "plan", challenge: fields.code_challenge, state: "client-state",
  expiresAt: Date.now() + oauth.REQUEST_MS, browserHash: hash(browser), nonce: Math.random().toString(36), ...overrides,
});

test("starting a sign-in, from an app or a computer, writes nothing and spends no shared budget", async () => configured(async () => {
  const { actionCtx, writes, rows } = service();
  for (let i = 0; i < 50; i++) {
    const response = await authorizationResponse(actionCtx, new Request(origin + "/oauth/authorize?" + new URLSearchParams(fields), { headers: { Cookie: cookie } }), async () => client);
    assert.equal(response.status, 303);
  }
  const start = await machineStartResponse(actionCtx, new Request(origin + "/oauth/machine/start", { method: "POST", body: new URLSearchParams({
    client_id: "planban-cli", scope: "planban:machine", redirect_uri: "http://127.0.0.1:53682/callback", resource: origin, code_challenge: "a".repeat(43), code_challenge_method: "S256", state: "cli-state", stateless: "1",
  }) }));
  const lease = await start.json();
  assert.match(lease.launch, /^pbn_/);
  assert.equal(lease.launchUrl, `${origin}/oauth/machine/launch?launch=${lease.launch}`);
  assert.ok(lease.expiresAt - lease.serverNow > 0 && lease.expiresAt - lease.serverNow <= 300_000);
  const launched = await machineLaunchResponse(actionCtx, new Request(lease.launchUrl, { headers: { Cookie: cookie } }));
  assert.equal(launched.status, 303);
  assert.deepEqual(writes, [], "no start, launch or consent step writes anything");
  assert.equal(rows.length, 0);
}));

test("an altered, foreign, expired or wrong-kind note is refused", async () => configured(async () => {
  const note = await consentNote();
  assert.ok(await openNote(note, "consent"));
  const [payload, signature] = note.split(".");
  const flipped = payload!.slice(0, -2) + (payload!.at(-2) === "A" ? "B" : "A") + payload!.at(-1);
  assert.equal(await openNote(`${flipped}.${signature}`, "consent"), null, "altered payload");
  assert.equal(await openNote(`${payload}.${"A".repeat(43)}`, "consent"), null, "altered signature");
  assert.equal(await openNote(await sealNote(JSON.parse(atob(payload!.slice(4).replace(/-/g, "+").replace(/_/g, "/"))), "another-key-of-thirty-two-characters!!"), "consent"), null, "signed elsewhere");
  assert.equal(await openNote(await consentNote({ expiresAt: Date.now() - 1 }), "consent"), null, "expired");
  assert.equal(await openNote(note, "launch"), null, "wrong kind");
}));

test("a note works only in its own browser, and is approved once: a replay is refused", async () => configured(async () => {
  const { actionCtx, rows } = service();
  const note = await consentNote();
  const other = new Request(origin + "/oauth/approve", { method: "POST", headers: { Origin: origin, Cookie: `__Host-planban_browser=pbb_${"x".repeat(43)}; __Host-planban_csrf=${csrf}` }, body: new URLSearchParams({ request: note, csrf, decision: "allow" }) });
  assert.equal((await approvalResponse(actionCtx, other, person())).status, 403, "another browser");
  const first = await approvalResponse(actionCtx, approveRequest(note), person());
  assert.match(new URL((await first.json()).redirect).searchParams.get("code")!, /^pbc_/);
  assert.equal(rows.filter((row) => row._table === "oauthRequests").length, 1, "the record is created only at approval");
  assert.equal((await approvalResponse(actionCtx, approveRequest(note), person())).status, 403, "replayed note");
  const validity = await consentValidityResponse(actionCtx, new Request(origin + "/oauth/validity", { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: new URLSearchParams({ request: note, csrf }) }));
  assert.deepEqual(await validity.json(), { valid: false });
}));

test("denying writes nothing and needs no sign-in", async () => configured(async () => {
  const { actionCtx, writes } = service();
  const denied = await approvalResponse(actionCtx, approveRequest(await consentNote(), "deny"), async () => { throw new Error("denial needs no identity"); });
  assert.equal(new URL((await denied.json()).redirect).searchParams.get("error"), "access_denied");
  assert.deepEqual(writes, []);
}));

test("approvals count per person: one person's limit never refuses another", async () => configured(async () => {
  const { actionCtx } = service();
  for (let i = 0; i < oauth.APPROVALS_PER_HOUR; i++) assert.equal((await approvalResponse(actionCtx, approveRequest(await consentNote()), person())).status, 200);
  assert.equal((await approvalResponse(actionCtx, approveRequest(await consentNote()), person())).status, 429, "Alice's own limit");
  assert.equal((await approvalResponse(actionCtx, approveRequest(await consentNote()), person("user_bob"))).status, 200, "Bob is unaffected");
}));

test("a computer's stateless sign-in: launch, consent and approval give the command line its code, and the launch works once", async () => configured(async () => {
  const { actionCtx, rows } = service();
  const start = await machineStartResponse(actionCtx, new Request(origin + "/oauth/machine/start", { method: "POST", body: new URLSearchParams({
    client_id: "planban-cli", scope: "planban:machine", redirect_uri: "http://127.0.0.1:53682/callback", resource: origin, code_challenge: "a".repeat(43), code_challenge_method: "S256", state: "cli-state", stateless: "1",
  }) }));
  const { launchUrl } = await start.json();
  const consentFor = async (browserCookie: string) => {
    const launched = await machineLaunchResponse(actionCtx, new Request(launchUrl, { headers: { Cookie: browserCookie } }));
    return new URL(launched.headers.get("Location")!).searchParams.get("request")!;
  };
  const note = await consentFor(cookie);
  const approved = await approvalResponse(actionCtx, approveRequest(note), person());
  const redirect = new URL((await approved.json()).redirect);
  assert.equal(redirect.origin + redirect.pathname, "http://127.0.0.1:53682/callback");
  assert.equal(redirect.searchParams.get("state"), "cli-state");
  assert.equal(rows.find((row) => row._table === "oauthRequests").purpose, "machine");
  // The same launch link opened again, even in this browser, can't be approved a second time.
  const again = await consentFor(cookie);
  assert.equal((await approvalResponse(actionCtx, approveRequest(again), person())).status, 403);
}));

test("the record itself refuses a second note with the same hash or the same computer launch, even if two approvals race", async () => configured(async () => {
  const { ctx } = service();
  const base = {
    requestHash: hash("note-1"), browserHash: hash(browser), csrfHash: hash(csrf), clientId: "planban-cli", clientName: "Planban CLI",
    redirectUri: "http://127.0.0.1:53682/callback", resource: origin, scopes: ["planban:machine"], level: "complete", challenge: "a".repeat(43),
    state: "s", purpose: "machine", userId: "user_alice", sessionId: "sess_alice", expiresAt: Date.now() + oauth.MACHINE_REQUEST_MS, launchHash: hash("launch-1"),
  };
  await oauth.createRequest._handler(ctx, base as any);
  await assert.rejects(oauth.createRequest._handler(ctx, base as any), /fresh authorization/, "same note");
  await assert.rejects(oauth.createRequest._handler(ctx, { ...base, requestHash: hash("note-2") } as any), /fresh authorization/, "same launch");
  await assert.rejects(oauth.createRequest._handler(ctx, { ...base, requestHash: hash("note-3"), launchHash: hash("launch-3"), expiresAt: Date.now() - 1 } as any), /fresh authorization/, "expired");
}));

test("a note has exactly one spelling: the other encodings of its last character are refused, so single use holds", async () => configured(async () => {
  const note = await consentNote();
  const last = note.at(-1)!;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const index = alphabet.indexOf(last);
  // The last of 43 characters carries 4 meaningful bits; the 2 low bits are padding.
  const aliases = [0, 1, 2, 3].map((low) => alphabet[(index & ~3) | low]!).filter((char) => char !== last).map((char) => note.slice(0, -1) + char);
  assert.equal(aliases.length, 3);
  for (const alias of aliases) assert.equal(await openNote(alias, "consent"), null);
  assert.ok(await openNote(note, "consent"));
  const { actionCtx } = service();
  for (const alias of aliases) assert.equal((await approvalResponse(actionCtx, approveRequest(alias), person())).status, 403);
}));

test("clean-up keeps an approved note's record until the note expires, so it can't be approved again", async (t) => configured(async () => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T00:00:00Z") });
  const { ctx, actionCtx } = service();
  const note = await consentNote();
  assert.equal((await approvalResponse(actionCtx, approveRequest(note), person())).status, 200);
  t.mock.timers.tick(2 * 60_000);
  const state = ctx.db.query("oauthCleanup").withIndex("by_name", (q: any) => q.eq("name", "requests"));
  await oauth.cleanupRequests._handler(ctx, { ticket: (await state.unique())?.ticket } as any);
  assert.equal((await approvalResponse(actionCtx, approveRequest(note), person())).status, 403, "still refused while the note is valid");
  t.mock.timers.tick(oauth.REQUEST_MS);
  await oauth.cleanupRequests._handler(ctx, { ticket: (await state.unique())?.ticket } as any);
  assert.equal((await approvalResponse(actionCtx, approveRequest(note), person())).status, 403, "and the expired note itself is refused");
}));
