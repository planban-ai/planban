import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { EDGE_PROOF_HEADER, MAX_BODY_BYTES, type Env } from "../online/edge/worker";

const env: Env = { UPSTREAM: "https://native-123.eu-west-1.convex.site", PUBLIC_HOST: "app.planban.example", EDGE_PROOF: "p".repeat(48) };
const PUBLIC = "https://app.planban.example";

type Seen = { url: string; init: RequestInit & { headers: Headers } };
async function through(request: Request, reply: () => Response = () => new Response("{}", { status: 200 }), config: Env = env) {
  const seen: Seen[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => { seen.push({ url, init }); return reply(); }) as typeof fetch;
  try { return { response: await worker.fetch(request, config), seen }; } finally { globalThis.fetch = real; }
}

test("forwards known routes to the fixed upstream with a fresh proof, never the caller's", async () => {
  const { response, seen } = await through(new Request(`${PUBLIC}/mcp?x=1`, { method: "POST", headers: { [EDGE_PROOF_HEADER]: "forged", Authorization: "Bearer pba_x", "Content-Type": "application/json" }, body: "{}" }));
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://native-123.eu-west-1.convex.site/mcp?x=1");
  assert.equal(seen[0]!.init.headers.get(EDGE_PROOF_HEADER), env.EDGE_PROOF);
  assert.equal(seen[0]!.init.headers.get("Authorization"), "Bearer pba_x");
  assert.equal(seen[0]!.init.redirect, "manual");
  assert.equal(seen[0]!.init.cache, "no-store");
});

test("forwards the brand files AI apps and browsers fetch, and nothing else under /brand/", async () => {
  for (const path of ["/favicon.svg", "/favicon.ico", "/brand/icon-light.png", "/brand/icon-dark.png"]) {
    const { response, seen } = await through(new Request(`${PUBLIC}${path}`));
    assert.equal(response.status, 200, path);
    assert.equal(seen[0]!.url, `${env.UPSTREAM}${path}`);
  }
});

test("refuses other hosts, unknown routes, wrong methods, odd paths and oversized bodies without forwarding", async () => {
  const cases: Array<[Request, number]> = [
    [new Request("https://native-123.eu-west-1.convex.site/mcp", { method: "POST" }), 421],
    [new Request("http://app.planban.example/mcp", { method: "POST" }), 421],
    [new Request(`${PUBLIC}/`), 404],
    [new Request(`${PUBLIC}/dev/token`, { method: "POST" }), 404],
    [new Request(`${PUBLIC}/api/v1/`), 404],
    [new Request(`${PUBLIC}/api/v1/%2e%2e/dev/token`), 404],
    [new Request(`${PUBLIC}/invite/a%2Fb`), 404],
    [new Request(`${PUBLIC}/oauth/token`), 405],
    [new Request(`${PUBLIC}/mcp`, { method: "PUT" }), 405],
    [new Request(`${PUBLIC}/favicon.svg`, { method: "POST" }), 405],
    [new Request(`${PUBLIC}/brand/other.png`), 404],
    [new Request(`${PUBLIC}/brand/`), 404],
    [new Request(`${PUBLIC}/mcp`, { method: "POST", headers: { "Content-Length": String(MAX_BODY_BYTES + 1) }, body: "x" }), 413],
  ];
  for (const [request, status] of cases) {
    const { response, seen } = await through(request);
    assert.equal(response.status, status, `${request.method} ${request.url}`);
    assert.equal(seen.length, 0, `${request.method} ${request.url} must not be forwarded`);
  }
});

test("fails closed until configured with a real https upstream and a strong proof", async () => {
  for (const broken of [{ ...env, UPSTREAM: "unset" }, { ...env, UPSTREAM: "https://wrong-target.example/#name.convex.site" }, { ...env, UPSTREAM: "https://evil.example" }, { ...env, UPSTREAM: "https://native-123.convex.site.evil.example" }, { ...env, UPSTREAM: "https://native-123.convex.site:8443" }, { ...env, UPSTREAM: "https://native-123.convex.site/" }, { ...env, UPSTREAM: "https://user@native-123.convex.site" }, { ...env, UPSTREAM: "http://native-123.eu-west-1.convex.site" }, { ...env, UPSTREAM: "https://native-123.eu-west-1.convex.site/base" }, { ...env, EDGE_PROOF: "short" }, { ...env, UPSTREAM: PUBLIC }]) {
    const { response, seen } = await through(new Request(`${PUBLIC}/mcp`, { method: "POST" }), undefined, broken);
    assert.equal(response.status, 503);
    assert.equal(seen.length, 0);
  }
});

test("passes only the consent hand-over redirect and keeps each cookie separate", async () => {
  const consent = () => {
    const headers = new Headers({ Location: `${PUBLIC}/oauth/consent?request=pbe_x` });
    headers.append("Set-Cookie", "__Host-a=1; Path=/; Secure; HttpOnly");
    headers.append("Set-Cookie", "__Host-b=2; Path=/; Secure; HttpOnly");
    return new Response(null, { status: 303, headers });
  };
  const ok = await through(new Request(`${PUBLIC}/oauth/machine/launch?launch=x`), consent);
  assert.equal(ok.response.status, 303);
  assert.equal(ok.response.headers.get("Location"), `${PUBLIC}/oauth/consent?request=pbe_x`);
  assert.deepEqual(ok.response.headers.getSetCookie(), ["__Host-a=1; Path=/; Secure; HttpOnly", "__Host-b=2; Path=/; Secure; HttpOnly"]);
  assert.equal((await through(new Request(`${PUBLIC}/oauth/machine/launch`), () => new Response(null, { status: 303, headers: { Location: "/oauth/consent?request=pbe_y" } }))).response.status, 303);

  for (const location of ["https://native-123.eu-west-1.convex.site/oauth/consent?request=x", "https://evil.example/oauth/consent", `${PUBLIC}/oauth/token`, "//evil.example/oauth/consent", "/elsewhere"]) {
    const refused = await through(new Request(`${PUBLIC}/oauth/machine/launch`), () => new Response(null, { status: 302, headers: { Location: location } }));
    assert.equal(refused.response.status, 502, location);
    assert.equal(refused.response.headers.get("Location"), null);
  }
});

test("never echoes the proof back and reports an unreachable upstream plainly", async () => {
  const echoed = await through(new Request(`${PUBLIC}/.well-known/planban.json`), () => new Response("{}", { headers: { [EDGE_PROOF_HEADER]: env.EDGE_PROOF } }));
  assert.equal(echoed.response.headers.get(EDGE_PROOF_HEADER), null);
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
  try { assert.equal((await worker.fetch(new Request(`${PUBLIC}/mcp`, { method: "POST" }), env)).status, 502); } finally { globalThis.fetch = real; }
});

test("limits sign-in starts per caller address before forwarding, and refuses them without a limiter", async () => {
  const keys: string[] = [];
  let allow = true;
  const limited: Env = { ...env, SIGNIN_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: allow }; } } };
  const start = () => new Request(`${PUBLIC}/oauth/machine/start`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9", "X-Forwarded-For": "198.51.100.1" }, body: "x" });
  assert.equal((await through(start(), undefined, limited)).response.status, 200);
  assert.deepEqual(keys, ["203.0.113.9"]);
  allow = false;
  const refused = await through(start(), undefined, limited);
  assert.equal(refused.response.status, 429);
  assert.equal(refused.seen.length, 0);
  // Other routes aren't limited here.
  assert.equal((await through(new Request(`${PUBLIC}/mcp`, { method: "POST" }), undefined, limited)).response.status, 200);
  const unlimited = await through(start());
  assert.equal(unlimited.response.status, 503);
  assert.equal(unlimited.seen.length, 0);
});

test("browser sign-in is limited per address and sign-out passes; neither answers other methods", async () => {
  let allow = true;
  const limited: Env = { ...env, SIGNIN_LIMITER: { limit: async () => ({ success: allow }) } };
  const session = () => new Request(`${PUBLIC}/web/session`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" } });
  assert.equal((await through(session(), undefined, limited)).response.status, 200);
  allow = false;
  assert.equal((await through(session(), undefined, limited)).response.status, 429);
  const signOut = await through(new Request(`${PUBLIC}/web/signout`, { method: "POST" }), undefined, limited);
  assert.equal(signOut.response.status, 200);
  assert.equal(signOut.seen[0]!.url, `${env.UPSTREAM}/web/signout`);
  assert.equal((await through(new Request(`${PUBLIC}/web/session`), undefined, limited)).response.status, 405);
  assert.equal((await through(new Request(`${PUBLIC}/web/other`, { method: "POST" }), undefined, limited)).response.status, 404);
});

test("new boards are limited per address and refused without a limiter; other API routes aren't", async () => {
  let allow = false;
  const limited: Env = { ...env, SIGNIN_LIMITER: { limit: async () => ({ success: allow }) } };
  const create = () => new Request(`${PUBLIC}/api/v1/boards`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" }, body: "{}" });
  assert.equal((await through(create(), undefined, limited)).response.status, 429);
  allow = true;
  assert.equal((await through(create(), undefined, limited)).response.status, 200);
  assert.equal((await through(create())).response.status, 503, "fails closed without a limiter");
  assert.equal((await through(new Request(`${PUBLIC}/api/v1/boards`), undefined, limited)).response.status, 200, "listing boards isn't limited");
});

test("the front door never adds cross-site permissions, on success or on any refusal", async () => {
  const cases = [
    new Request(`${PUBLIC}/api/v1/boards`, { headers: { Origin: "https://evil.example" } }),
    new Request(`${PUBLIC}/nowhere`, { headers: { Origin: "https://evil.example" } }),
    new Request(`${PUBLIC}/web/session`, { headers: { Origin: "https://evil.example" } }),
    new Request(`${PUBLIC}/web/session`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } }),
  ];
  const upstreamTriesCors = () => new Response("{}", { status: 200, headers: { "Access-Control-Allow-Origin": "*" } });
  for (const request of cases) {
    const { response } = await through(request, upstreamTriesCors);
    for (const name of response.headers.keys()) assert.ok(!name.startsWith("access-control-"), `${request.method} ${request.url}: ${name}`);
  }
});

test("registrations use their own limiter, and a streamed body past the cap fails the upload", async () => {
  const used: string[] = [];
  const limiter = (name: string) => ({ limit: async () => { used.push(name); return { success: true }; } });
  const limited: Env = { ...env, SIGNIN_LIMITER: limiter("signin"), REGISTER_LIMITER: limiter("register") };
  await through(new Request(`${PUBLIC}/oauth/register`, { method: "POST", headers: { "CF-Connecting-IP": "160.79.104.1" }, body: "{}" }), undefined, limited);
  await through(new Request(`${PUBLIC}/oauth/authorize`, { headers: { "CF-Connecting-IP": "203.0.113.9" } }), undefined, limited);
  assert.deepEqual(used, ["register", "signin"]);

  const big = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_BODY_BYTES)); controller.enqueue(new Uint8Array(10)); controller.close(); } });
  const { seen } = await through(new Request(`${PUBLIC}/mcp`, { method: "POST", body: big, duplex: "half" } as any));
  await assert.rejects(new Response(seen[0]!.init.body as ReadableStream).arrayBuffer());
});

test("GitHub deliveries are limited per caller address and per link before forwarding, and refused without the limiters", async () => {
  const keys: string[] = [];
  let allowLink = true;
  const limited: Env = {
    ...env,
    GITHUB_HOOK_IP_LIMITER: { limit: async ({ key }) => { keys.push(`ip:${key}`); return { success: true }; } },
    GITHUB_HOOK_LIMITER: { limit: async ({ key }) => { keys.push(`link:${key}`); return { success: allowLink }; } },
  };
  const delivery = () => new Request(`${PUBLIC}/api/v1/github/hooks/ghl_abc123abc123abc123`, { method: "POST", headers: { "CF-Connecting-IP": "140.82.115.1" }, body: "{}" });
  assert.equal((await through(delivery(), undefined, limited)).response.status, 200);
  assert.deepEqual(keys, ["ip:140.82.115.1", "link:ghl_abc123abc123abc123"]);
  allowLink = false;
  const refused = await through(delivery(), undefined, limited);
  assert.equal(refused.response.status, 429);
  assert.equal(refused.seen.length, 0);
  const unlimited = await through(delivery());
  assert.equal(unlimited.response.status, 503, "fails closed without the limiters");
  assert.equal(unlimited.seen.length, 0);
});
