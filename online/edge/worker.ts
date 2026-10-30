// The public front of Planban Online at app.planban.ai: a Cloudflare Worker
// that forwards Planban's own routes to the Convex backend's native address.
//
// The backend trusts a request as having come through the public address only
// when it carries the shared edge proof (see online/service/convex/model/auth.ts).
// This Worker is the only holder of that proof. It overwrites any proof a
// caller sends, forwards to one fixed upstream, never follows redirects,
// never caches and never retries, so a credential can't leak to another host.

export interface Env {
  /** The backend's native HTTP actions address, e.g. https://example-123.eu-west-1.convex.site. */
  UPSTREAM: string;
  /** The only host this Worker answers for, e.g. app.planban.ai. */
  PUBLIC_HOST: string;
  /** Shared secret; the backend holds only its SHA-256 as PLANBAN_EDGE_PROOF_SHA256. */
  EDGE_PROOF: string;
  /** Per-caller limit on sign-in starts and authorize requests. */
  SIGNIN_LIMITER?: Limiter;
  /** Per-caller limit on claude.ai registrations, which arrive from Anthropic's shared addresses. */
  REGISTER_LIMITER?: Limiter;
  /** The web page's files (Workers static assets), answering every address that isn't the service's. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
}
type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

// The backend's sign-in quotas are shared by every caller and it can't see a
// trustworthy caller address; Cloudflare sets CF-Connecting-IP itself. These
// limits slow any one address. They don't stop many addresses together from
// reaching the backend's shared quota, which stays as the outer cost bound.
const LIMITED: Record<string, keyof Pick<Env, "SIGNIN_LIMITER" | "REGISTER_LIMITER">> = {
  "POST /oauth/machine/start": "SIGNIN_LIMITER",
  "GET /oauth/authorize": "SIGNIN_LIMITER",
  "POST /oauth/register": "REGISTER_LIMITER",
  "POST /web/session": "SIGNIN_LIMITER",
  "POST /web/invite": "SIGNIN_LIMITER",
  "POST /oauth/device": "SIGNIN_LIMITER",
  // New boards on the web: account quotas bound success; this stops refused requests reaching the service.
  "POST /api/v1/boards": "SIGNIN_LIMITER",
};

export const EDGE_PROOF_HEADER = "Planban-Edge-Proof";
/** Larger than any accepted Spec or Plan write, below the backend's own request limit. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

type Route = { path: string; prefix?: boolean; methods: readonly string[] };
// The backend's route inventory, less the local-only development sign-in.
const ROUTES: readonly Route[] = [
  { path: "/api/v1/", prefix: true, methods: ["GET", "POST", "PUT"] },
  { path: "/mcp", methods: ["GET", "POST", "DELETE"] },
  { path: "/oauth/token", methods: ["POST"] },
  { path: "/oauth/revoke", methods: ["POST"] },
  { path: "/oauth/register", methods: ["POST"] },
  { path: "/oauth/authorize", methods: ["GET"] },
  { path: "/oauth/consent", methods: ["GET"] },
  { path: "/oauth/machine/start", methods: ["POST"] },
  { path: "/oauth/machine/launch", methods: ["GET"] },
  { path: "/oauth/machine/cancel", methods: ["POST"] },
  { path: "/oauth/validity", methods: ["POST"] },
  { path: "/oauth/approve", methods: ["POST"] },
  { path: "/web/session", methods: ["POST"] },
  { path: "/web/signout", methods: ["POST"] },
  { path: "/web/invite", methods: ["POST"] },
  { path: "/web/config", methods: ["GET"] },
  { path: "/oauth/device", methods: ["POST"] },
  { path: "/.well-known/planban.json", methods: ["GET"] },
  { path: "/.well-known/oauth-authorization-server", methods: ["GET"] },
  { path: "/.well-known/oauth-protected-resource", methods: ["GET"] },
  { path: "/.well-known/oauth-protected-resource/mcp", methods: ["GET"] },
  { path: "/.well-known/jwks.json", methods: ["GET"] },
  { path: "/favicon.svg", methods: ["GET"] },
  { path: "/favicon.ico", methods: ["GET"] },
  { path: "/brand/icon-light.png", methods: ["GET"] },
  { path: "/brand/icon-dark.png", methods: ["GET"] },
];

/**
 * The addresses the Worker answers itself (wrangler.jsonc assets.run_worker_first
 * must list exactly these): the service's. Everything else is the web page,
 * served from static assets with its own address handling (/boards/...,
 * /invite/..., /sign-in, /approve), so page requests never count as Worker
 * requests. "*" covers the rest of the path.
 */
export const WORKER_FIRST = ["/api/*", "/oauth/*", "/mcp", "/.well-known/*", "/web/*", "/favicon.svg", "/favicon.ico", "/brand/*"] as const;

export function isServicePath(pathname: string): boolean {
  return WORKER_FIRST.some((pattern) => pattern.endsWith("/*") ? pathname.startsWith(pattern.slice(0, -1)) || pathname === pattern.slice(0, -2) : pathname === pattern);
}

/** The only redirect the backend issues: authorization and machine launch hand over to consent. */
const CONSENT_PATH = "/oauth/consent";

function refuse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

function routed(pathname: string, method: string): "ok" | "method" | "none" {
  // Only plain, already-normalised paths: no encoded separators or dot segments.
  if (/%2f|%5c|%2e|\/\.\.?(\/|$)|\/\//i.test(pathname)) return "none";
  const route = ROUTES.find((entry) => entry.prefix ? pathname.startsWith(entry.path) && pathname.length > entry.path.length : pathname === entry.path);
  if (!route) return "none";
  return route.methods.includes(method) ? "ok" : "method";
}

function configured(env: Env): { upstream: URL; host: string } | null {
  try {
    // Exactly a Convex HTTP actions origin: nothing that could carry the proof elsewhere.
    if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)?\.convex\.site$/.test(env.UPSTREAM ?? "")) return null;
    const upstream = new URL(env.UPSTREAM);
    if (upstream.origin !== env.UPSTREAM || upstream.port || upstream.username || upstream.password || upstream.hash || upstream.search) return null;
    if (!/^[a-z0-9.-]+$/.test(env.PUBLIC_HOST ?? "") || upstream.host === env.PUBLIC_HOST) return null;
    if (typeof env.EDGE_PROOF !== "string" || env.EDGE_PROOF.length < 32) return null;
    return { upstream, host: env.PUBLIC_HOST };
  } catch { return null; }
}

/** Passes a body through, failing the upload once it passes `limit` bytes, with or without Content-Length. */
function capped(body: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) controller.error(new Error("payload_too_large"));
      else controller.enqueue(chunk);
    },
  }));
}

/** A redirect may only go to the consent page on this public address. */
function allowedLocation(location: string, host: string): boolean {
  if (location.startsWith(`${CONSENT_PATH}?`)) return true;
  try {
    const url = new URL(location);
    return url.protocol === "https:" && url.host === host && url.pathname === CONSENT_PATH && !url.username && !url.password;
  } catch { return false; }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = configured(env);
    if (!config) return refuse(503, "temporarily_unavailable");
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.host !== config.host) return refuse(421, "misdirected_request");
    // The web page, if the Worker is asked for it at all (static assets normally answer first).
    if (!isServicePath(url.pathname) && env.ASSETS && !/%2f|%5c|\/\.\.?(\/|$)|\/\//i.test(url.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") return refuse(405, "method_not_allowed");
      return env.ASSETS.fetch(request);
    }
    const route = routed(url.pathname, request.method);
    if (route === "none") return refuse(404, "not_found");
    if (route === "method") return refuse(405, "method_not_allowed");
    const limiterName = LIMITED[`${request.method} ${url.pathname}`];
    if (limiterName) {
      const caller = request.headers.get("CF-Connecting-IP");
      const limiter = env[limiterName];
      if (!limiter || !caller) return refuse(503, "temporarily_unavailable");
      if (!(await limiter.limit({ key: caller })).success) return refuse(429, "rate_limited");
    }
    const length = request.headers.get("Content-Length");
    if (length !== null && !(/^\d+$/.test(length) && Number(length) <= MAX_BODY_BYTES)) return refuse(413, "payload_too_large");

    // Build the target from the fixed upstream; never resolve caller-supplied URLs.
    const target = new URL(config.upstream.href);
    target.pathname = url.pathname;
    target.search = url.search;

    const headers = new Headers(request.headers);
    headers.delete(EDGE_PROOF_HEADER);
    headers.delete("Host");
    headers.set(EDGE_PROOF_HEADER, env.EDGE_PROOF);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    let upstream: Response;
    try {
      upstream = await fetch(target.href, {
        method: request.method,
        headers,
        body: hasBody && request.body ? capped(request.body, MAX_BODY_BYTES) : undefined,
        redirect: "manual",
        cache: "no-store",
        signal: request.signal,
      });
    } catch {
      return refuse(502, "upstream_unavailable");
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("Location");
      if (!location || !allowedLocation(location, config.host)) return refuse(502, "upstream_redirect_refused");
    }
    // Headers pass through as separate fields, including each Set-Cookie.
    const out = new Headers(upstream.headers);
    out.delete(EDGE_PROOF_HEADER);
    // Never cross-site: no response through the front door grants another site access.
    for (const name of [...out.keys()]) if (name.startsWith("access-control-")) out.delete(name);
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  },
};
