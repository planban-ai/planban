import assert from "node:assert/strict";
import { openNote } from "../online/service/convex/model/signInNote";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { CLAUDE_WEB_CLIENT_ID, clientRedirectAllowed, loadOAuthClient, metadataClientAllowed, parseClientMetadata, REGISTERED_CLIENT_NAME } from "../online/service/convex/model/oauthClient";
import { authorizationResponse } from "../online/service/convex/model/oauthConsent";
import { tokenResponse } from "../online/service/convex/model/oauthHttp";
import { cacheMetadataClient, cachedMetadataClient, CLIENT_CACHE_MS } from "../online/service/convex/oauth";

// Exactly as claude.ai publishes it (fetched 14 October 2026).
const PUBLISHED = { client_id: CLAUDE_WEB_CLIENT_ID, client_name: "Claude", client_uri: "https://claude.ai", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"], response_types: ["code"], token_endpoint_auth_method: "none" };
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const origin = "https://planban.example";

async function configured(run: () => Promise<void>) {
  const values = { PLANBAN_PUBLIC_URL: origin, CLERK_ISSUER: "https://fixture.clerk.example", CLERK_PUBLISHABLE_KEY: "pk_test_" + btoa("fixture.clerk.example$"), CLERK_SECRET_KEY: "synthetic-fixture-only", PLANBAN_SIGNIN_NOTE_KEY: "synthetic-sign-in-note-key-for-tests-only" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try { Object.assign(process.env, values); await run(); }
  finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

test("claude.ai's published connector document is accepted and named as Claude (claude.ai)", () => {
  assert.equal(metadataClientAllowed(CLAUDE_WEB_CLIENT_ID), true);
  const client = parseClientMetadata(CLAUDE_WEB_CLIENT_ID, PUBLISHED)!;
  assert.ok(client, "the extra jwt-bearer grant is ignored, not refused");
  assert.equal(client.name, REGISTERED_CLIENT_NAME);
  assert.equal(client.native, false);
  assert.deepEqual(client.redirectUris, [CALLBACK]);
  assert.equal(clientRedirectAllowed(client, CALLBACK), true);
  for (const uri of [CALLBACK + "?x=1", CALLBACK + "/", "https://claude.ai/api/mcp/other", "https://attacker.example/api/mcp/auth_callback", "http://127.0.0.1/callback"]) assert.equal(clientRedirectAllowed(client, uri), false, uri);
});

test("the claude.ai document is refused if it strays from Claude's own callback or public sign-in", () => {
  for (const override of [
    { redirect_uris: [CALLBACK, "https://attacker.example/callback"] },
    { redirect_uris: ["https://claude.com/api/mcp/auth_callback"] },
    { application_type: "native", redirect_uris: [CALLBACK] },
    { token_endpoint_auth_method: "client_secret_basic" },
    { grant_types: ["urn:ietf:params:oauth:grant-type:jwt-bearer", "refresh_token"] },
    { response_types: ["token"] },
    { client_id: "https://claude.ai/oauth/claude-code-client-metadata" },
  ]) assert.equal(parseClientMetadata(CLAUDE_WEB_CLIENT_ID, { ...PUBLISHED, ...override }), null, JSON.stringify(override));
});

test("the loader reads the published document, and authorization reaches consent with Claude's exact callback", async () => configured(async () => {
  const fetcher: typeof fetch = async (input) => {
    assert.equal(String(input), CLAUDE_WEB_CLIENT_ID);
    return new Response(JSON.stringify(PUBLISHED), { headers: { "Content-Type": "application/json" } });
  };
  const stored: any[] = [];
  const ctx: any = { runMutation: async (fn: any, args: any) => {
    if (getFunctionName(fn) === "oauth:reserveMetadataFetch") return true;
    if (getFunctionName(fn) === "oauth:cacheMetadataClient") return;
    stored.push([getFunctionName(fn), args]);
  } };
  const fields = { client_id: CLAUDE_WEB_CLIENT_ID, redirect_uri: CALLBACK, response_type: "code", resource: origin + "/mcp", code_challenge: "a".repeat(43), code_challenge_method: "S256", scope: "planban:read offline_access", state: "claude-state" };
  const authorize = (values: Record<string, string>) => new Request(origin + "/oauth/authorize?" + new URLSearchParams(values));
  const response = await authorizationResponse(ctx, authorize(fields), (id) => loadOAuthClient(id, fetcher));
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("Location")!).pathname, "/oauth/consent");
  const note = (await openNote(new URL(response.headers.get("Location")!).searchParams.get("request")!, "consent"))!;
  assert.equal(note.clientId, CLAUDE_WEB_CLIENT_ID);
  assert.equal(note.clientName, "Claude (claude.ai)");
  assert.equal(note.redirectUri, CALLBACK);

  const refused = await authorizationResponse(ctx, authorize({ ...fields, redirect_uri: "https://attacker.example/callback" }), (id) => loadOAuthClient(id, fetcher));
  assert.equal(refused.status, 400);
  assert.equal(refused.headers.get("Location"), null);
  assert.equal(stored.length, 0, "nothing is stored at the start");
}));

test("the token endpoint never issues the jwt-bearer grant Claude's document lists", async () => configured(async () => {
  const touched: string[] = [];
  const ctx: any = { runMutation: async () => { touched.push("mutation"); }, runQuery: async () => { touched.push("query"); } };
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", client_id: CLAUDE_WEB_CLIENT_ID, resource: origin + "/mcp", assertion: "x.y.z" });
  const response = await tokenResponse(ctx, new Request(origin + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "unsupported_grant_type");
  assert.deepEqual(touched, []);
}));

test("a fetched client document is reused for an hour, so sign-in starts don't spend the fetch budget", async () => configured(async () => {
  const calls: string[] = [];
  let fetches = 0;
  let cache: any = null;
  const ctx: any = {
    runQuery: async (fn: any, args: any) => { calls.push(getFunctionName(fn)); return cache && args.clientId === CLAUDE_WEB_CLIENT_ID ? cache : null; },
    runMutation: async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      calls.push(name);
      if (name === "oauth:reserveMetadataFetch") return true;
      if (name === "oauth:cacheMetadataClient") cache = { clientId: args.clientId, name: args.name, redirectUris: args.redirectUris, native: args.native };
    },
  };
  const loader = async (id: string) => { fetches++; return parseClientMetadata(id, PUBLISHED); };
  const fields = { client_id: CLAUDE_WEB_CLIENT_ID, redirect_uri: CALLBACK, response_type: "code", resource: origin + "/mcp", code_challenge: "a".repeat(43), code_challenge_method: "S256", scope: "planban:read", state: "s" };
  const authorize = () => new Request(origin + "/oauth/authorize?" + new URLSearchParams(fields));

  assert.equal((await authorizationResponse(ctx, authorize(), loader)).status, 303);
  assert.equal(fetches, 1);
  assert.deepEqual(cache, { clientId: CLAUDE_WEB_CLIENT_ID, name: REGISTERED_CLIENT_NAME, redirectUris: [CALLBACK], native: false });
  calls.length = 0;
  for (let n = 0; n < 5; n++) assert.equal((await authorizationResponse(ctx, authorize(), loader)).status, 303);
  assert.equal(fetches, 1, "later sign-in starts reuse the cached document");
  assert.equal(calls.includes("oauth:reserveMetadataFetch"), false, "and spend no fetch budget");
  // A cached document still binds the callback.
  const wrong = new Request(origin + "/oauth/authorize?" + new URLSearchParams({ ...fields, redirect_uri: "https://attacker.example/cb" }));
  assert.equal((await authorizationResponse(ctx, wrong, loader)).status, 400);
}));

test("the client cache expires after an hour and holds only reviewed clients", async () => {
  const rows: any[] = [];
  const db: any = {
    query: () => ({ withIndex: (_n: string, range: (q: any) => any) => { let id: string | undefined; range({ eq: (_f: string, value: string) => { id = value; } }); return { unique: async () => rows.find((row) => row.clientId === id) ?? null }; } }),
    insert: async (_t: string, value: any) => { rows.push({ ...value, _id: `c${rows.length}` }); },
    patch: async (id: string, value: any) => Object.assign(rows.find((row) => row._id === id), value),
  };
  const run = (fn: any, args: any) => fn._handler({ db }, args);
  await run(cacheMetadataClient, { clientId: "https://attacker.example/client.json", name: "Claude (claude.ai)", redirectUris: [CALLBACK], native: false });
  assert.equal(rows.length, 0, "unreviewed clients are never cached");
  await run(cacheMetadataClient, { clientId: CLAUDE_WEB_CLIENT_ID, name: REGISTERED_CLIENT_NAME, redirectUris: [CALLBACK], native: false });
  assert.ok(await run(cachedMetadataClient, { clientId: CLAUDE_WEB_CLIENT_ID }));
  rows[0].fetchedAt -= CLIENT_CACHE_MS;
  assert.equal(await run(cachedMetadataClient, { clientId: CLAUDE_WEB_CLIENT_ID }), null, "an hour-old copy is fetched again");
  assert.equal(await run(cachedMetadataClient, { clientId: "https://attacker.example/client.json" }), null);
});
