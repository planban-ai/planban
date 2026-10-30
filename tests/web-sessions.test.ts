// Browser sessions for the web page (Planban 2.0, phase 1): the cookie, its
// enrollment from Clerk, where it works, cross-site request forgery checks,
// revocation barriers, the hourly Clerk recheck, expiry and account switching.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { authenticate, EDGE_PROOF_HEADER, planbanTokenVerifier } from "../online/service/convex/model/auth";
import { atServiceOnly } from "../online/service/convex/http";
import { apiParts, CLERK_RECHECK_MS, webCookie, webCookieName, webCookieToken, webRequestTrusted, webRouteAllowed, WEB_SESSION_MS } from "../online/service/convex/model/webSession";
import { authenticateApiRequest, authenticateWeb, webSessionResponse, webSignOutResponse } from "../online/service/convex/model/webAuth";
import * as webSessions from "../online/service/convex/webSessions";
import { createKey, resolveToken, revoke, revokeAllOthers } from "../online/service/convex/connections";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const PUBLIC = "https://app.planban.example";
const NATIVE = "https://native-315.convex.example";
const PROOF = "synthetic-edge-proof-only";
const TOKEN = `pbw_${"A".repeat(43)}`;
const OTHER = `pbw_${"B".repeat(43)}`;
const START = Date.parse("2030-01-01T00:00:00.000Z");

function withEnv<T>(run: () => Promise<T>): Promise<T> {
  const values: Record<string, string> = { PLANBAN_PUBLIC_URL: PUBLIC, CONVEX_SITE_URL: NATIVE, PLANBAN_EDGE_PROOF_SHA256: digest(PROOF) };
  const prior = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return run().finally(() => {
    for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  });
}

async function withClock<T>(start: number, run: (clock: { now: number }) => Promise<T>): Promise<T> {
  const RealDate = Date;
  const clock = { now: start };
  class FakeDate extends RealDate {
    constructor(...args: any[]) { super(...(args.length ? args : [clock.now]) as []); }
    static now() { return clock.now; }
  }
  (globalThis as any).Date = FakeDate;
  try { return await run(clock); } finally { (globalThis as any).Date = RealDate; }
}

function store() {
  const rows: any[] = [];
  const jobs: any[] = [];
  let sequence = 0;
  const db: any = {
    get: async (id: string) => rows.find((row) => row._id === id) ?? null,
    insert: async (table: string, value: any) => { const id = `${table}-${++sequence}`; rows.push({ ...value, _id: id, _table: table }); return id; },
    patch: async (id: string, patch: any) => Object.assign(rows.find((row) => row._id === id), patch),
    delete: async (id: string) => { rows.splice(rows.findIndex((row) => row._id === id), 1); },
    normalizeId: (table: string, id: string) => rows.some((row) => row._id === id && row._table === table) ? id : null,
    query: (table: string) => {
      let match = (row: any) => row._table === table;
      const query: any = {
        withIndex: (_name: string, range?: (q: any) => any) => {
          const q: any = {
            eq: (field: string, value: unknown) => { const prior = match; match = (row) => prior(row) && row[field] === value; return q; },
            lt: (field: string, value: any) => { const prior = match; match = (row) => prior(row) && row[field] < value; return q; },
          };
          range?.(q);
          return query;
        },
        filter: () => query,
        order: () => query,
        unique: async () => rows.find(match) ?? null,
        first: async () => rows.find(match) ?? null,
        collect: async () => rows.filter(match),
        take: async (count: number) => rows.filter(match).slice(0, count),
      };
      return query;
    },
  };
  const scheduler = { runAfter: async (_delay: number, ref: any, args: any) => { jobs.push({ name: getFunctionName(ref), args }); } };
  const ctx: any = { db, scheduler };
  // Actions call into the same in-memory database.
  const byName: Record<string, any> = Object.fromEntries(Object.entries(webSessions).map(([key, fn]) => [`webSessions:${key}`, fn]));
  const call = async (ref: any, args: any) => {
    const fn = byName[getFunctionName(ref)];
    if (!fn) throw new Error(`no fake for ${getFunctionName(ref)}`);
    return fn._handler(ctx, args);
  };
  const actionCtx: any = { runQuery: call, runMutation: call, runAction: async (ref: any, args: any) => { jobs.push({ name: getFunctionName(ref), args, ran: true }); } };
  return { ctx, actionCtx, rows, jobs };
}

const clerk = (status: "active" | "ended" | "unknown", expireAt = START + 30 * 24 * 60 * 60 * 1000) => ({
  sessions: {
    getSession: async (id: string) => {
      if (status === "unknown") throw Object.assign(new Error("network"), { status: 503 });
      return { id, userId: "user_alice", status: status === "active" ? "active" : "ended", expireAt };
    },
    revokeSession: async () => ({}),
  },
  authenticateRequest: async () => ({
    isAuthenticated: true,
    toAuth: () => ({ tokenType: "session_token", userId: "user_alice", sessionId: "sess_one", sessionClaims: { iss: "https://clerk.example", azp: PUBLIC } }),
  }),
}) as any;

function apiRequest(path: string, init: { method?: string; cookie?: string | null; headers?: Record<string, string>; proof?: boolean; client?: boolean; origin?: string | null; site?: string } = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.proof !== false) headers.set(EDGE_PROOF_HEADER, PROOF);
  if (init.cookie !== null) headers.set("Cookie", init.cookie ?? `${webCookieName(PUBLIC)}=${TOKEN}`);
  if (init.client !== false) headers.set("X-Planban-Client", "web");
  const method = init.method ?? "GET";
  if (method !== "GET") {
    if (init.origin !== null) headers.set("Origin", init.origin ?? PUBLIC);
    headers.set("Sec-Fetch-Site", init.site ?? "same-origin");
  }
  return new Request(`${NATIVE}${path}`, { method, headers });
}

async function enrolled(ctx: any, overrides: Record<string, unknown> = {}) {
  return webSessions.enroll._handler(ctx, { userId: "user_alice", clerkSessionId: "sess_one", tokenHash: digest(TOKEN), ...overrides } as any);
}

test("the cookie is host-only, Secure, HttpOnly and Lax on https, and one copy only", async () => {
  await withEnv(async () => {
    assert.equal(webCookieName(), "__Host-planban_web");
    assert.equal(webCookie(TOKEN, 60), `__Host-planban_web=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60`);
    const one = new Request(PUBLIC, { headers: { Cookie: `a=b; __Host-planban_web=${TOKEN}` } });
    assert.equal(webCookieToken(one), TOKEN);
    assert.equal(webCookieToken(new Request(PUBLIC, { headers: { Cookie: `__Host-planban_web=${TOKEN}; __Host-planban_web=${OTHER}` } })), null, "two copies are refused");
    assert.equal(webCookieToken(new Request(PUBLIC, { headers: { Cookie: "__Host-planban_web=pbm_" + "a".repeat(43) } })), null, "only a pbw_ token");
    assert.equal(webCookieToken(new Request(PUBLIC, { headers: { Cookie: "__Host-planban_web=pbw_short" } })), null);
  });
});

test("cookie requests need the page's header; writes also need this origin and same-site fetch metadata", async () => {
  await withEnv(async () => {
    const make = (method: string, headers: Record<string, string>) => new Request(`${PUBLIC}/api/v1/boards`, { method, headers });
    assert.equal(webRequestTrusted(make("GET", {})), false, "no X-Planban-Client");
    assert.equal(webRequestTrusted(make("GET", { "X-Planban-Client": "web" })), true);
    const write = { "X-Planban-Client": "web", Origin: PUBLIC, "Sec-Fetch-Site": "same-origin" };
    assert.equal(webRequestTrusted(make("POST", write)), true);
    assert.equal(webRequestTrusted(make("POST", { ...write, Origin: "https://evil.example" })), false, "cross-site");
    assert.equal(webRequestTrusted(make("POST", { ...write, Origin: "https://www.planban.example" })), false, "sibling subdomain");
    assert.equal(webRequestTrusted(make("POST", { ...write, "Sec-Fetch-Site": "same-site" })), false, "same-site is not same-origin");
    assert.equal(webRequestTrusted(make("POST", { "X-Planban-Client": "web", "Sec-Fetch-Site": "same-origin" })), false, "missing Origin");
    assert.equal(webRequestTrusted(make("POST", { ...write, Origin: "null" })), false, "null Origin");
    // A forged HTML form can't set the header, so it fails before anything else.
    assert.equal(webRequestTrusted(make("POST", { Origin: PUBLIC, "Sec-Fetch-Site": "same-origin" })), false, "form post");
  });
});

test("a browser session reaches only the web page's routes", () => {
  const allowed: Array<[string, string]> = [
    ["GET", "/api/v1/me"], ["GET", "/api/v1/boards"], ["POST", "/api/v1/boards"], ["GET", "/api/v1/boards/b1"],
    ["POST", "/api/v1/boards/b1/ops/updateCard"], ["GET", "/api/v1/boards/b1/history"], ["GET", "/api/v1/boards/b1/history/3"],
    ["GET", "/api/v1/boards/b1/history/3/cards/c1/docs/spec"], ["GET", "/api/v1/boards/b1/docs/c1/plan"], ["GET", "/api/v1/boards/b1/changes"],
    ["GET", "/api/v1/boards/b1/people"], ["POST", "/api/v1/boards/b1/invites"], ["POST", "/api/v1/boards/b1/members/u2/role"],
    ["GET", "/api/v1/connections"], ["POST", "/api/v1/connections/revoke-others"], ["POST", "/api/v1/connections/c9/revoke"],
    ["POST", "/api/v1/invites/accept"], ["POST", "/api/v1/live-token"], ["POST", "/api/v1/keys"],
  ];
  const refused: Array<[string, string]> = [
    ["POST", "/api/v1/transfers"], ["POST", "/api/v1/transfers/t1/commit"], ["POST", "/api/v1/boards/import"],
    ["GET", "/api/v1/boards/b1/export"], ["GET", "/api/v1/boards/b1/export/docs"], ["POST", "/api/v1/boards/b1/take-local/fence"],
    ["POST", "/api/v1/copy-check"], ["POST", "/api/v1/connections/c9/restore"], ["PUT", "/api/v1/boards/b1"],
    ["GET", "/api/v1/boards/b1/history/3/extra"], ["GET", "/api/v1/future-route"], ["DELETE", "/api/v1/boards/b1"],
    ["GET", "/api/v1/boards/b1/docs/c1%2Fx/spec"], ["GET", "/api/v1/boards/%2E%2E/docs/c1/spec"],
  ];
  for (const [method, path] of allowed) assert.equal(webRouteAllowed(method, apiParts(new Request(PUBLIC + path))!), true, `${method} ${path}`);
  for (const [method, path] of refused) assert.equal(webRouteAllowed(method, apiParts(new Request(PUBLIC + path))!), false, `${method} ${path}`);
});

test("enrolling sets an absolute expiry of seven days or the Clerk session's end, whichever is first", async () => {
  await withEnv(() => withClock(START, async () => {
    const { ctx, jobs } = store();
    const long = await enrolled(ctx, { clerkExpiresAt: START + 30 * 24 * 60 * 60 * 1000 });
    assert.equal(long.expiresAt, new Date(START + WEB_SESSION_MS).toISOString());
    assert.equal(jobs.some((job) => job.name === "people:refresh"), true);
    const short = await enrolled(store().ctx, { clerkExpiresAt: START + 60_000 });
    assert.equal(short.expiresAt, new Date(START + 60_000).toISOString());
    await assert.rejects(enrolled(store().ctx, { clerkExpiresAt: START - 1 }), /ended/);
  }));
});

test("signing in again gives the same browser session a new token and keeps its expiry; another account's cookie ends", async () => {
  await withEnv(() => withClock(START, async (clock) => {
    const { ctx, rows } = store();
    const first = await enrolled(ctx);
    clock.now += 60_000;
    const again = await enrolled(ctx, { tokenHash: digest(OTHER) });
    assert.equal(again.connectionId, first.connectionId);
    assert.equal(again.expiresAt, first.expiresAt);
    assert.equal(rows.find((row) => row._id === first.connectionId).tokenHash, digest(OTHER), "the old token no longer matches");
    assert.equal(await webSessions.resolve._handler(ctx, { tokenHash: digest(TOKEN) } as any), null);

    // Switching account: the earlier cookie's session (another Clerk session) is ended.
    const bob = await enrolled(ctx, { userId: "user_bob", clerkSessionId: "sess_two", tokenHash: digest(TOKEN), previousTokenHash: digest(OTHER) });
    assert.notEqual(bob.connectionId, first.connectionId);
    assert.ok(rows.find((row) => row._id === first.connectionId).revokedAt);
  }));
});

test("a browser token never works as a bearer credential", async () => {
  await withEnv(async () => {
    const { ctx } = store();
    let asked = false;
    const actionCtx: any = { runQuery: async () => { asked = true; return { connectionId: "x", lastUsedAt: new Date().toISOString(), serviceOrigin: PUBLIC }; } };
    assert.equal(await planbanTokenVerifier.authenticate(actionCtx, TOKEN, PUBLIC), null);
    assert.equal(asked, false, "refused before any lookup");
    await enrolled(ctx);
    assert.equal(await resolveToken._handler(ctx, { tokenHash: digest(TOKEN) } as any), null, "the bearer lookup refuses web rows");
  });
});

test("a cookie authenticates only through the edge, on allowed routes, with the page's headers", async () => {
  await withEnv(() => withClock(START, async () => {
    const { ctx, actionCtx } = store();
    const { connectionId } = await enrolled(ctx);
    const ok = async (request: Request) => (await authenticateWeb(actionCtx, request, clerk("active")))?.connectionId ?? null;
    assert.equal(await ok(apiRequest("/api/v1/boards")), connectionId);
    assert.equal(await ok(apiRequest("/api/v1/boards/b1/ops/updateCard", { method: "POST" })), connectionId);
    assert.equal(await ok(apiRequest("/api/v1/boards", { proof: false })), null, "no edge proof");
    assert.equal(await ok(apiRequest("/api/v1/boards", { client: false })), null, "no X-Planban-Client");
    assert.equal(await ok(apiRequest("/api/v1/boards/b1/ops/updateCard", { method: "POST", origin: "https://evil.example", site: "cross-site" })), null, "cross-site write");
    assert.equal(await ok(apiRequest("/api/v1/boards/b1/ops/updateCard", { method: "POST", origin: null })), null, "write without Origin");
    assert.equal(await ok(apiRequest("/api/v1/transfers", { method: "POST" })), null, "refused route");
    assert.equal(await ok(apiRequest("/api/v1/boards/b1/export")), null, "refused route");
    assert.equal(await ok(apiRequest("/api/v1/boards", { cookie: `${webCookieName(PUBLIC)}=${OTHER}` })), null, "unknown token");
  }));
});

test("any Authorization header, even a malformed one, is judged alone and never falls back to the cookie", async () => {
  await withEnv(() => withClock(START, async () => {
    const { ctx, actionCtx } = store();
    await enrolled(ctx);
    for (const value of ["Basic abc", "Bearer", "Bearer pbw_" + "A".repeat(43), "bearer   "]) {
      assert.equal(await authenticateApiRequest(actionCtx, apiRequest("/api/v1/boards", { headers: { Authorization: value } }), clerk("active")), null, value);
    }
  }));
});

test("after an hour Clerk must confirm the session; an ended session ends here too, an unreachable Clerk only refuses", async () => {
  await withEnv(() => withClock(START, async (clock) => {
    const { ctx, actionCtx, rows } = store();
    const { connectionId } = await enrolled(ctx);
    clock.now = START + CLERK_RECHECK_MS;
    assert.equal(await authenticateWeb(actionCtx, apiRequest("/api/v1/boards"), clerk("unknown")), null, "fails closed");
    assert.equal(rows.find((row) => row._id === connectionId).revokedAt, undefined, "but isn't ended");
    assert.equal((await authenticateWeb(actionCtx, apiRequest("/api/v1/boards"), clerk("active")))?.connectionId, connectionId);
    assert.equal(rows.find((row) => row._id === connectionId).clerkCheckedAt, new Date(clock.now).toISOString());
    clock.now += CLERK_RECHECK_MS;
    assert.equal(await authenticateWeb(actionCtx, apiRequest("/api/v1/boards"), clerk("ended")), null);
    assert.ok(rows.find((row) => row._id === connectionId).revokedAt, "ended for good");
    assert.ok(rows.some((row) => row._table === "webSessionBarriers" && row.clerkSessionId === "sess_one"));
  }));
});

test("a browser session stops at its expiry", async () => {
  await withEnv(() => withClock(START, async (clock) => {
    const { ctx, actionCtx } = store();
    await enrolled(ctx, { clerkExpiresAt: START + 10 * 60 * 1000 });
    clock.now = START + 10 * 60 * 1000;
    assert.equal(await authenticateWeb(actionCtx, apiRequest("/api/v1/boards"), clerk("active")), null);
  }));
});

test("revoking a browser session ends it at Clerk, and that Clerk session can't enroll again", async () => {
  await withEnv(() => withClock(START, async () => {
    const { ctx, actionCtx, jobs } = store();
    const web = await enrolled(ctx);
    const machine = await ctx.db.insert("connections", { userId: "user_alice", kind: "machine", name: "Mac", clientName: "Planban CLI", boards: "all", level: "complete", canAdminister: true, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), tokenHash: "machine" });
    await revoke._handler(ctx, { connectionId: machine, targetId: web.connectionId } as any);
    assert.ok(jobs.some((job) => job.name === "webSessions:revokeClerkSession" && job.args.clerkSessionId === "sess_one"));
    assert.equal(await authenticateWeb(actionCtx, apiRequest("/api/v1/live-token", { method: "POST" }), clerk("active")), null, "live updates refused after revocation");
    await assert.rejects(enrolled(ctx, { tokenHash: digest(OTHER) }), /ended/, "re-enrolling silently is refused");
    // A fresh sign-in is a new Clerk session, which works.
    assert.ok((await enrolled(ctx, { clerkSessionId: "sess_fresh", tokenHash: digest(OTHER) })).connectionId);
  }));
});

test("signing out other devices ends other browser sessions with barriers too", async () => {
  await withEnv(() => withClock(START, async () => {
    const { ctx, rows } = store();
    const mine = await enrolled(ctx);
    const other = await enrolled(ctx, { clerkSessionId: "sess_phone", tokenHash: digest(OTHER) });
    await revokeAllOthers._handler(ctx, { connectionId: mine.connectionId } as any);
    assert.ok(rows.find((row) => row._id === other.connectionId).revokedAt);
    assert.equal(rows.find((row) => row._id === mine.connectionId).revokedAt, undefined);
    assert.ok(rows.some((row) => row._table === "webSessionBarriers" && row.clerkSessionId === "sess_phone"));
  }));
});

test("POST /web/session takes the Clerk token only from Authorization, from this page, and sets the cookie", async () => {
  await withEnv(() => withClock(START, async () => {
    const { actionCtx, rows } = store();
    const sessionRequest = (headers: Record<string, string>) => new Request(`${NATIVE}/web/session`, {
      method: "POST", headers: { [EDGE_PROOF_HEADER]: PROOF, "X-Planban-Client": "web", Origin: PUBLIC, "Sec-Fetch-Site": "same-origin", ...headers },
    });
    process.env.CLERK_ISSUER = "https://clerk.example";
    try {
      const response = await webSessionResponse(actionCtx, sessionRequest({ Authorization: "Bearer clerk-session-jwt" }), clerk("active"));
      assert.equal(response.status, 200);
      const cookie = response.headers.get("Set-Cookie") ?? "";
      assert.match(cookie, /^__Host-planban_web=pbw_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null, "no CORS headers");
      assert.equal(rows.filter((row) => row._table === "connections" && row.kind === "web").length, 1);

      const forged = await webSessionResponse(actionCtx, sessionRequest({ Authorization: "Bearer clerk-session-jwt", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }), clerk("active"));
      assert.equal(forged.status, 403);
      const noHeader = await webSessionResponse(actionCtx, sessionRequest({}), clerk("active"));
      assert.equal(noHeader.status, 401, "no token in the body or a form field is ever read");
    } finally { delete process.env.CLERK_ISSUER; }
  }));
});

test("POST /web/signout ends the session, asks Clerk to end it, and clears the cookie", async () => {
  await withEnv(() => withClock(START, async () => {
    const { ctx, actionCtx, rows, jobs } = store();
    const { connectionId } = await enrolled(ctx);
    const forged = await webSignOutResponse(actionCtx, apiRequest("/web/signout", { method: "POST", origin: "https://evil.example", site: "cross-site" }));
    assert.equal(forged.status, 403);
    assert.equal(rows.find((row) => row._id === connectionId).revokedAt, undefined);
    const response = await webSignOutResponse(actionCtx, apiRequest("/web/signout", { method: "POST" }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Set-Cookie") ?? "", /^__Host-planban_web=; .*Max-Age=0$/);
    assert.ok(rows.find((row) => row._id === connectionId).revokedAt);
    assert.ok(jobs.some((job) => job.name === "webSessions:revokeClerkSession" && job.ran));
  }));
});

test("a browser session creates an access key for one board, which then works as a bearer through the public address", async () => {
  await withEnv(() => withClock(START, async () => {
    const { ctx } = store();
    const { connectionId } = await enrolled(ctx);
    await ctx.db.insert("boards", { boardId: "deadleg", title: "Deadleg", ownerId: "user_alice", authority: "online", revision: 1, generation: 1, historyVersion: 0 });
    await ctx.db.insert("members", { boardId: "deadleg", userId: "user_alice", role: "owner" });
    const key = `pbk_${"k".repeat(43)}`;
    const created = await createKey._handler(ctx, { connectionId, tokenHash: digest(key), name: "Cloud agent", boardId: "deadleg", level: "plan" } as any);
    assert.deepEqual(created.boardId, "deadleg");
    const resolved = await resolveToken._handler(ctx, { tokenHash: digest(key) } as any);
    assert.equal(resolved.serviceOrigin, PUBLIC);
  }));
});

test("after seven days the same Clerk sign-in can't enroll a browser again; a fresh sign-in can", async () => {
  await withEnv(() => withClock(START, async (clock) => {
    const { ctx } = store();
    await enrolled(ctx, { clerkExpiresAt: START + 30 * 24 * 60 * 60 * 1000 });
    clock.now = START + 3 * 24 * 60 * 60 * 1000;
    const again = await enrolled(ctx, { tokenHash: digest(OTHER), clerkExpiresAt: START + 30 * 24 * 60 * 60 * 1000 });
    assert.equal(again.expiresAt, new Date(START + WEB_SESSION_MS).toISOString(), "still ends seven days after the first sign-in");
    clock.now = START + WEB_SESSION_MS;
    await assert.rejects(enrolled(ctx, { clerkExpiresAt: START + 30 * 24 * 60 * 60 * 1000 }), /ended/);
    assert.ok((await enrolled(ctx, { clerkSessionId: "sess_new", clerkExpiresAt: START + 30 * 24 * 60 * 60 * 1000 })).connectionId);
  }));
});

test("a barrier outlasts its Clerk session, then is removed", async () => {
  await withEnv(() => withClock(START, async (clock) => {
    const { ctx, rows } = store();
    const longClerk = START + 200 * 24 * 60 * 60 * 1000;
    const { connectionId } = await enrolled(ctx, { clerkExpiresAt: longClerk });
    await webSessions.endByToken._handler(ctx, { tokenHash: digest(TOKEN) } as any);
    assert.ok(rows.find((row) => row._id === connectionId).revokedAt);
    clock.now = START + 100 * 24 * 60 * 60 * 1000;
    await webSessions.pruneBarriers._handler(ctx, {} as any);
    assert.ok(rows.some((row) => row._table === "webSessionBarriers"), "kept while the Clerk session could still be live");
    clock.now = longClerk + 1;
    await webSessions.pruneBarriers._handler(ctx, {} as any);
    assert.ok(!rows.some((row) => row._table === "webSessionBarriers"));
  }));
});

test("both browser routes refuse requests that didn't come through the front door", async () => {
  await withEnv(async () => {
    const { actionCtx } = store();
    for (const [path, handler] of [["/web/session", (ctx: any, r: Request) => webSessionResponse(ctx, r, clerk("active"))], ["/web/signout", webSignOutResponse]] as const) {
      const direct = apiRequest(path, { method: "POST", proof: false, headers: { Authorization: "Bearer clerk-session-jwt" } });
      const response = await atServiceOnly(handler as any)(actionCtx, direct);
      assert.equal(response.status, 503, path);
      assert.equal(response.headers.get("Set-Cookie"), null, `${path} sets no cookie`);
    }
  });
});

test("the cookie never reaches a refused route, method or disguised path, nor /mcp", async () => {
  await withEnv(() => withClock(START, async () => {
    const { ctx, actionCtx } = store();
    await enrolled(ctx);
    const refused: Array<[string, string]> = [
      ["POST", "/api/v1/transfers"], ["POST", "/api/v1/transfers/t1/parts"], ["POST", "/api/v1/boards/import"],
      ["GET", "/api/v1/boards/b1/export"], ["GET", "/api/v1/boards/b1/export/meta"], ["POST", "/api/v1/boards/b1/take-local/fence"],
      ["POST", "/api/v1/boards/b1/take-local/finish"], ["POST", "/api/v1/copy-check"], ["POST", "/api/v1/connections/c1/restore"],
      ["HEAD", "/api/v1/boards"], ["PUT", "/api/v1/boards/b1"], ["DELETE", "/api/v1/boards/b1"], ["OPTIONS", "/api/v1/boards"],
      ["GET", "/api/v1/boards/b1/docs/c1%2Fx/spec"], ["GET", "/api/v1/boards/%2E%2E/export"], ["GET", "/api/v1//boards"],
      ["GET", "/api/v1/boards/b1/./export"], ["GET", "/api/v1/unknown"], ["POST", "/api/v1/keys/extra"],
    ];
    for (const [method, path] of refused) {
      const request = apiRequest(path, { method: method === "HEAD" || method === "OPTIONS" ? "GET" : method });
      const forged = new Request(request.url, { method, headers: request.headers });
      assert.equal(await authenticateApiRequest(actionCtx, forged, clerk("active")), null, `${method} ${path}`);
    }
    // /mcp authenticates bearers only; the cookie is never consulted there.
    const mcp = new Request(`${NATIVE}/mcp`, { method: "POST", headers: { [EDGE_PROOF_HEADER]: PROOF, Cookie: `${webCookieName(PUBLIC)}=${TOKEN}`, "X-Planban-Client": "web", Origin: PUBLIC, "Sec-Fetch-Site": "same-origin" } });
    assert.equal(await authenticate(actionCtx, mcp), null);
  }));
});
