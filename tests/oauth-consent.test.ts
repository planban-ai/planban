import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { authorizationResponse, approvalResponse, consentResponse, machineStartResponse, machineLaunchResponse, machineCancelResponse, consentValidityResponse } from "../online/service/convex/model/oauthConsent";
import { serviceDiscovery, authorizationServerDiscovery } from "../online/service/convex/http";
import { CLAUDE_CODE_CLIENT_ID, parseClientMetadata } from "../online/service/convex/model/oauthClient";
import { openNote } from "../online/service/convex/model/signInNote";

const origin = "https://planban.example", clientId = "https://chatgpt.com/oauth/codex/client.json";
const client = { clientId, name: "Codex", native: true, redirectUris: ["http://127.0.0.1/callback"] };
const fields = { client_id: clientId, redirect_uri: "http://127.0.0.1:54321/callback", response_type: "code", resource: origin + "/mcp", code_challenge: "a".repeat(43), code_challenge_method: "S256", scope: "planban:plan offline_access", state: "client-state" };
const authorize = (values = fields, headers: Record<string, string> = {}) => new Request(origin + "/oauth/authorize?" + new URLSearchParams(values), { headers });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** The signed note a sign-in start hands the browser, read back as the service would. */
const noteOf = (response: Response) => openNote(new URL(response.headers.get("Location")!).searchParams.get("request")!, "consent");
async function configured(run: () => Promise<void>) {
  const values = { PLANBAN_PUBLIC_URL: origin, CLERK_ISSUER: "https://fixture.clerk.example", CLERK_PUBLISHABLE_KEY: "pk_test_" + btoa("fixture.clerk.example$"), CLERK_SECRET_KEY: "synthetic-fixture-only", PLANBAN_SIGNIN_NOTE_KEY: "synthetic-sign-in-note-key-for-tests-only" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try { Object.assign(process.env, values); await run(); }
  finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

test("discovery names only the service issuer and explicit machine flow, and fails closed when unavailable", async () => configured(async () => {
  const invoke = (fn: any) => fn._handler({}, new Request(origin + "/.well-known/planban.json"));
  const service = await (await invoke(serviceDiscovery)).json();
  assert.equal(service.signIn.issuer, origin);
  assert.equal(service.signIn.cliClientId, "planban-cli");
  assert.equal(service.signIn.scope, "planban:machine");
  const metadata = await (await invoke(authorizationServerDiscovery)).json();
  assert.equal(metadata.issuer, origin);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
  for (const field of ["authorization_endpoint", "token_endpoint", "revocation_endpoint"]) assert.equal(new URL(metadata[field]).origin, origin);
  assert.ok(!JSON.stringify(metadata).includes("fixture.clerk.example"));
  assert.ok(!metadata.scopes_supported.includes("openid"));
  delete process.env.CLERK_PUBLISHABLE_KEY;
  assert.equal((await (await invoke(serviceDiscovery)).json()).signIn, undefined);
  assert.equal((await invoke(authorizationServerDiscovery)).status, 503);
}));

test("authorization freezes validated metadata and bindings, with independent host cookies and no unsafe redirect", async () => configured(async () => {
  const writes: string[] = [];
  const ctx: any = { runMutation: async (fn: any) => {
    if (getFunctionName(fn) === "oauth:reserveMetadataFetch") return true;
    // Caching a fetched client document is bounded by the separate fetch budget; it isn't a sign-in record.
    if (getFunctionName(fn) === "oauth:cacheMetadataClient") return;
    writes.push(getFunctionName(fn));
  } };
  const response = await authorizationResponse(ctx, authorize(), async () => client);
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("Location")!);
  assert.equal(location.origin, origin);
  assert.equal(location.pathname, "/oauth/consent");
  // The start stores nothing: the frozen request travels in a signed note.
  assert.deepEqual(writes, []);
  const note = (await noteOf(response))!;
  assert.equal(note.clientId, clientId);
  assert.equal(note.redirectUri, fields.redirect_uri);
  assert.equal(note.challenge, fields.code_challenge);
  assert.deepEqual(note.scopes, ["planban:plan", "offline_access"]);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const cookie of cookies) assert.match(cookie, /^__Host-planban_\w+=pb[bs]_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  const browserCookie = cookies.find((cookie) => cookie.startsWith("__Host-planban_browser="))!.split(";")[0]!.split("=")[1]!;
  assert.equal(note.browserHash, hash(browserCookie), "tied to this browser's cookie");
  const invalid = await authorizationResponse(ctx, authorize({ ...fields, redirect_uri: "https://attacker.example/callback" }), async () => client);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("Location"), null);
  let invalidFetches = 0;
  for (const override of [{ resource: "https://attacker.example" }, { scope: "planban:owner" }, { code_challenge_method: "plain" }, { code_challenge: "short" }, { response_type: "token" }, { state: "x".repeat(2049) }]) {
    const failed = await authorizationResponse(ctx, authorize({ ...fields, ...override }), async () => { invalidFetches++; return client; });
    assert.equal(failed.status, 400);
    assert.equal(failed.headers.get("Location"), null, "unvalidated callbacks receive no error redirect");
    assert.ok((await failed.json()).error);
  }
  assert.equal(invalidFetches, 0, "independent malformed fields never fetch publisher metadata");
  assert.deepEqual(writes, [], "nothing is ever written at the start");
}));

test("exhausted metadata budget refuses valid requests before fetch, without permitting unknown clients", async () => configured(async () => {
  let fetches = 0, reservations = 0;
  const ctx: any = { runMutation: async (fn: any) => { assert.equal(getFunctionName(fn), "oauth:reserveMetadataFetch"); reservations++; return false; } };
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await authorizationResponse(ctx, authorize(), async () => { fetches++; return client; });
    assert.equal(response.status, 429);
  }
  assert.equal(reservations, 3);
  assert.equal(fetches, 0);
  const unknown = await authorizationResponse(ctx, authorize({ ...fields, client_id: "https://attacker.example/client.json" }), async () => { fetches++; return client; });
  assert.equal(unknown.status, 400);
  assert.equal(reservations, 3, "unknown URLs neither allocate budget rows nor fetch");
}));

test("Claude localhost port flexibility freezes the original callback and preserves independent request validation", async () => configured(async () => {
  const code = parseClientMetadata(CLAUDE_CODE_CLIENT_ID, { client_id: CLAUDE_CODE_CLIENT_ID, client_name: "Claude Code", redirect_uris: ["http://localhost/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] })!;
  const stored: any[] = [];
  const ctx: any = { runMutation: async (fn: any, args: any) => {
    if (getFunctionName(fn) === "oauth:reserveMetadataFetch") return true;
    if (getFunctionName(fn) === "oauth:cacheMetadataClient") return;
    stored.push(args);
  } };
  const values = { ...fields, client_id: CLAUDE_CODE_CLIENT_ID, redirect_uri: "http://localhost:54114/callback", scope: "planban:read planban:plan planban:complete offline_access" };
  const started = await authorizationResponse(ctx, authorize(values), async () => code);
  assert.equal(started.status, 303);
  const note = (await noteOf(started))!;
  assert.equal(note.redirectUri, values.redirect_uri);
  assert.equal(note.state, values.state);
  for (const override of [{ redirect_uri: "http://localhost:0/callback" }, { redirect_uri: "http://localhost:54114/a/../callback" }, { code_challenge_method: "plain" }, { code_challenge: "" }, { code_challenge: "short" }, { resource: "http://attacker.example/mcp" }]) {
    const response = await authorizationResponse(ctx, authorize({ ...values, ...override }), async () => code);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Location"), null);
  }
  const duplicate = new URL(authorize(values).url); duplicate.searchParams.append("redirect_uri", values.redirect_uri);
  assert.equal((await authorizationResponse(ctx, new Request(duplicate), async () => code)).status, 400);
  assert.equal(stored.length, 0, "no start writes an authorization row");
  const browser = "pbb_" + "b".repeat(43), csrf = "pbs_" + "c".repeat(43), ticket = "pbe_" + "d".repeat(43);
  const approvalCtx: any = { runMutation: async () => ({ redirectUri: values.redirect_uri, state: values.state }) };
  for (const decision of ["allow", "deny"]) {
    const response = await approvalResponse(approvalCtx, new Request(origin + "/oauth/approve", {
      method: "POST", headers: { Origin: origin, Cookie: `__Host-planban_browser=${browser}; __Host-planban_csrf=${csrf}` },
      body: new URLSearchParams({ request: ticket, csrf, decision }),
    }), async () => ({ userId: "fixture", sessionId: "session" }));
    const returned = new URL((await response.json()).redirect);
    assert.equal(returned.origin + returned.pathname, values.redirect_uri);
    assert.equal(returned.searchParams.get("state"), values.state);
    assert.equal(returned.searchParams.get("iss"), origin);
    if (decision === "deny") assert.equal(returned.searchParams.get("error"), "access_denied");
    else assert.match(returned.searchParams.get("code")!, /^pbc_[A-Za-z0-9_-]{43}$/);
  }
}));

test("consent escapes frozen metadata and approval requires origin, independent CSRF and verified identity", async () => configured(async () => {
  const browser = "pbb_" + "b".repeat(43), csrf = "pbs_" + "c".repeat(43), requestSecret = "pbe_" + "d".repeat(43);
  const cookie = `__Host-planban_browser=${browser}; __Host-planban_csrf=${csrf}`;
  const calls: any[] = [];
  const ctx: any = {
    runQuery: async (_fn: unknown, args: any) => { assert.equal(args.browserHash, hash(browser)); return { ...fields, clientName: '</h1><script>alert("metadata")</script>', clientId, scopes: ["planban:plan", "offline_access"], purpose: "oauth" }; },
    runMutation: async (fn: any, args: any) => { calls.push({ fn: getFunctionName(fn), args }); return { redirectUri: fields.redirect_uri, state: fields.state }; },
  };
  const page = await consentResponse(ctx, new Request(origin + "/oauth/consent?request=" + requestSecret, { headers: { Cookie: cookie } }));
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Security-Policy")!, /frame-ancestors 'none'/);
  assert.equal(page.headers.get("Referrer-Policy"), "no-referrer");
  const html = await page.text();
  assert.ok(!html.includes('</h1><script>alert("metadata")</script>'));
  assert.ok(html.includes("&lt;script&gt;"));
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)![1]!;
  new Script(script);
  const input = { request: requestSecret, csrf, decision: "allow", userId: "attacker", sessionId: "attacker" };
  const post = (values = input, headers: Record<string, string> = {}) => new Request(origin + "/oauth/approve", { method: "POST", body: new URLSearchParams(values), headers: { Origin: origin, Cookie: cookie, Authorization: "Bearer synthetic.session", ...headers } });
  let verified = 0;
  const verify = async () => { verified++; return { userId: "user_fixture", sessionId: "sess_fixture" }; };
  for (const invalid of [post(input, { Origin: "https://attacker.example" }), post({ ...input, csrf: "wrong" }), post(input, { Cookie: "" }), post(input, { Cookie: cookie + "; __Host-planban_csrf=" + csrf })]) assert.equal((await approvalResponse(ctx, invalid, verify)).status, 403);
  assert.equal(verified, 0);
  assert.equal(calls.length, 0);
  const approved = await approvalResponse(ctx, post(), verify);
  const result = await approved.json();
  const callback = new URL(result.redirect);
  assert.equal(callback.searchParams.get("iss"), origin);
  assert.equal(callback.searchParams.get("state"), fields.state);
  const code = callback.searchParams.get("code")!;
  assert.match(code, /^pbc_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(calls.map(({ fn }) => fn), ["oauth:bindIdentity", "oauth:approve"]);
  assert.equal(calls[1].args.userId, "user_fixture");
  assert.equal(calls[1].args.sessionId, "sess_fixture");
  assert.equal(calls[1].args.codeHash, hash(code));
  assert.ok(!JSON.stringify(calls).includes(code));
  calls.length = 0;
  const denied = await approvalResponse(ctx, post({ ...input, decision: "deny" }), async () => { throw new Error("denial needs no identity"); });
  assert.equal(new URL((await denied.json()).redirect).searchParams.get("error"), "access_denied");
  assert.deepEqual(calls.map(({ fn }) => fn), ["oauth:denyRequest"]);
}));


test("machine start freezes before browser claim and direct legacy authorization cannot bypass the lease", async () => configured(async () => {
  const calls: any[] = []; const ctx: any = { runMutation: async (fn: any, args: any) => { calls.push({ fn: getFunctionName(fn), args }); return { serverNow: 1000, expiresAt: 301000 }; } };
  const values = { ...fields, client_id: "planban-cli", scope: "planban:machine", redirect_uri: "http://127.0.0.1:53682/callback", resource: origin };
  const post = (fields: any) => new Request(origin + "/oauth/machine/start", { method: "POST", body: new URLSearchParams(fields) });
  assert.equal((await authorizationResponse(ctx, authorize(values))).status, 400);
  for(const bad of [{ ...values, redirect_uri: "http://localhost:53682/callback" },{ ...values, resource: origin + "/mcp" },{ ...values, code_challenge_method: "plain" }]) assert.equal((await machineStartResponse(ctx, post(bad))).status, 400);
  assert.equal(calls.length, 0);
  const response = await machineStartResponse(ctx, post(values));
  const lease = await response.json();
  assert.match(lease.launch, /^pbl_[A-Za-z0-9_-]{43}$/);
  assert.equal(calls[0].fn, "oauth:startMachine");
  assert.equal(calls[0].args.launchHash, hash(lease.launch));
  assert.ok(!JSON.stringify(calls).includes(lease.launch));
  assert.equal((await machineCancelResponse(ctx, new Request(origin + "/oauth/machine/cancel", { method: "POST", body: new URLSearchParams({ launch: lease.launch }) }))).status, 400);
  const verifier = "v".repeat(43);
  await machineCancelResponse(ctx, new Request(origin + "/oauth/machine/cancel", { method: "POST", body: new URLSearchParams({ launch: lease.launch, code_verifier: verifier }) }));
  assert.equal(calls[1].args.challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.ok(!JSON.stringify(calls).includes(verifier));
}));

test("validity is browser/CSRF/origin-bound, minimal, read-only and generic on invalid requests", async () => configured(async () => {
  const browser = "pbb_" + "b".repeat(43), csrf = "pbs_" + "c".repeat(43), secret = "pbe_" + "r".repeat(43);
  let reads = 0;
  const ctx: any = { runMutation: () => assert.fail("validity mutates"), runQuery: async () => { reads++; return { clientName: "Private", expiresAt: 301000, serverNow: 1000 }; } };
  const make = (originHeader = origin) => new Request(origin + "/oauth/validity", { method: "POST", headers: { Origin: originHeader, Cookie: `__Host-planban_browser=${browser}; __Host-planban_csrf=${csrf}` }, body: new URLSearchParams({ request: secret, csrf }) });
  assert.deepEqual(await (await consentValidityResponse(ctx, make("https://attacker.example"))).json(), { valid: false });
  assert.equal(reads, 0);
  assert.deepEqual(await (await consentValidityResponse(ctx, make())).json(), { valid: true, expiresAt: 301000, serverNow: 1000 });
  assert.equal(reads, 1);
  const ended = await consentResponse({ runQuery: async () => null } as any, new Request(origin + "/oauth/consent?request=" + secret));
  assert.equal(ended.status, 200);
  assert.match(await ended.text(), /Start a new sign-in/);
  assert.match(ended.headers.get("Content-Security-Policy")!, /frame-ancestors 'none'/);
}));
