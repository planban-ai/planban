// The Worker serving the web page (Planban 2.0 plan, phase 5): page addresses
// serve the page's files, service addresses keep their allowlist, and the
// page's security headers are exact.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import worker, { isServicePath, WORKER_FIRST, type Env } from "../online/edge/worker";
import { createHash } from "node:crypto";
import { contentSecurityPolicy, headersFile, inlineScriptsOf } from "../online/edge/webHeaders";

const PUBLIC = "https://app.planban.example";
const UPSTREAM = "https://native-123.eu-west-1.convex.site";

function edge() {
  const assetRequests: string[] = [];
  const env: Env = {
    UPSTREAM, PUBLIC_HOST: "app.planban.example", EDGE_PROOF: "p".repeat(48),
    ASSETS: { fetch: async (request: Request) => { assetRequests.push(new URL(request.url).pathname); return new Response("<!doctype html><title>Planban</title>", { headers: { "Content-Type": "text/html" } }); } },
  };
  return { env, assetRequests };
}

async function through(request: Request, env: Env) {
  const forwarded: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { forwarded.push(url); return new Response("{}", { status: 200 }); }) as typeof fetch;
  try { return { response: await worker.fetch(request, env), forwarded }; } finally { globalThis.fetch = real; }
}

test("wrangler serves the page from the build and runs the Worker first for exactly the service's addresses", async () => {
  const text = await readFile(new URL("../online/edge/wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gmu, "").replace(/,(\s*[}\]])/gu, "$1")) as { assets?: Record<string, unknown> };
  assert.deepEqual(config.assets, {
    directory: "../../dist/web", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: [...WORKER_FIRST],
  });
});

test("page addresses serve the page; the Worker never forwards them", async () => {
  const { env, assetRequests } = edge();
  for (const path of ["/", "/boards/northfold", "/invite/pbi_token", "/sign-in", "/approve", "/assets/index.js", "/index.html"]) {
    const { response, forwarded } = await through(new Request(`${PUBLIC}${path}`), env);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /Planban/u);
    assert.deepEqual(forwarded, [], `${path} never reaches the service`);
  }
  assert.deepEqual(assetRequests, ["/", "/boards/northfold", "/invite/pbi_token", "/sign-in", "/approve", "/assets/index.js", "/index.html"]);
  const posted = await through(new Request(`${PUBLIC}/boards/northfold`, { method: "POST", body: "{}" }), env);
  assert.equal(posted.response.status, 405, "the page's files are only read");
});

test("service addresses keep their allowlist, assets or not", async () => {
  const { env, assetRequests } = edge();
  const cases: Array<[string, string, number, boolean]> = [
    ["GET", "/api/v1/boards", 200, true],
    ["POST", "/mcp", 200, true],
    ["GET", "/.well-known/oauth-authorization-server", 200, true],
    ["POST", "/web/signout", 200, true],
    ["GET", "/web/config", 200, true],
    ["GET", "/favicon.svg", 200, true],
    ["GET", "/api/nothing-here", 404, false],
    ["GET", "/web/unknown", 404, false],
    ["POST", "/web/config", 405, false],
    ["GET", "/oauth/token", 405, false],
    ["GET", "/brand/other.png", 404, false],
    ["GET", "/.well-known/other", 404, false],
  ];
  for (const [method, path, status, forwards] of cases) {
    const { response, forwarded } = await through(new Request(`${PUBLIC}${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) }), env);
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(forwarded.length, forwards ? 1 : 0, `${method} ${path}`);
  }
  assert.deepEqual(assetRequests, [], "no service address falls through to the page");
  // Invitation links are the page's now; the service's old invitation page isn't reachable through the front door.
  assert.equal(isServicePath("/invite/pbi_token"), false);
  const invite = await through(new Request(`${PUBLIC}/invite/pbi_token`), { ...env, ASSETS: undefined });
  assert.deepEqual(invite.forwarded, []);
});

test("every route the Worker forwards is one it runs for", async () => {
  const source = await readFile(new URL("../online/edge/worker.ts", import.meta.url), "utf8");
  const paths = [...source.matchAll(/\{ path: "([^"]+)"/gu)].map((match) => match[1]!);
  assert.ok(paths.length > 10);
  for (const path of paths) assert.equal(isServicePath(path.endsWith("/") ? `${path}x` : path), true, path);
});

test("the page's Content Security Policy is exact, from the deployed Clerk and Convex addresses", () => {
  const settings = { clerkFrontendApi: "https://clerk.planban.example", convexCloudUrl: "https://name-123.eu-west-1.convex.cloud" };
  assert.equal(contentSecurityPolicy(settings), [
    "default-src 'none'",
    "script-src 'self' https://clerk.planban.example https://challenges.cloudflare.com https://*.protect.clerk.com",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https://clerk.planban.example https://*.protect.clerk.com:* https://name-123.eu-west-1.convex.cloud wss://name-123.eu-west-1.convex.cloud",
    "img-src 'self' https://clerk.planban.example https://img.clerk.com data:",
    "font-src 'self'",
    "frame-src https://clerk.planban.example https://challenges.cloudflare.com https://*.protect.clerk.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "));
  assert.equal(headersFile(settings), [
    "/*",
    `  Content-Security-Policy: ${contentSecurityPolicy(settings)}`,
    "  Referrer-Policy: no-referrer",
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
    "",
  ].join("\n"));
  for (const bad of [
    { ...settings, clerkFrontendApi: "http://clerk.planban.example" },
    { ...settings, clerkFrontendApi: "https://clerk.planban.example/path" },
    { ...settings, clerkFrontendApi: "https://clerk.planban.example; script-src *" },
    { ...settings, convexCloudUrl: "https://evil.example" },
    { ...settings, convexCloudUrl: "https://name.convex.cloud.evil.example" },
  ]) assert.throws(() => contentSecurityPolicy(bad), /https origin/u, JSON.stringify(bad));
});

test("the policy allows the page's own files and, by exact hash, only its one inline script", async () => {
  const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
  const scripts = inlineScriptsOf(html);
  assert.equal(scripts.length, 1, "the address bootstrap");
  assert.doesNotMatch(html, /\bon[a-z]+=/u, "no inline event handlers");
  assert.doesNotMatch(html, /https?:\/\//u, "nothing loaded from elsewhere");
  const policy = contentSecurityPolicy({ clerkFrontendApi: "https://clerk.planban.example", convexCloudUrl: "https://name-123.eu-west-1.convex.cloud", inlineScripts: scripts });
  const hash = createHash("sha256").update(scripts[0]!, "utf8").digest("base64");
  assert.ok(policy.includes(`script-src 'self' 'sha256-${hash}' https://clerk.planban.example `), policy);
  assert.doesNotMatch(policy, /unsafe-inline'[^;]*;[^;]*script|script-src[^;]*unsafe-inline/u, "scripts are never allowed wholesale");
});

test("the deploy step hashes the built page's inline script, which the build keeps as written", async () => {
  const source = await readFile(new URL("../online/edge/write-headers.ts", import.meta.url), "utf8");
  assert.match(source, /inlineScripts: inlineScriptsOf\(page\)/u);
  const built = await readFile(new URL("../dist/web/index.html", import.meta.url), "utf8").catch(() => null);
  // The tracked build is refreshed at integration; when it has the bootstrap, it must be byte-identical to the source's.
  if (built && inlineScriptsOf(built).length) {
    const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
    assert.deepEqual(inlineScriptsOf(built), inlineScriptsOf(html));
  }
});
