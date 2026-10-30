// Browser sessions for the web page at the public address. A person signs in
// with Clerk once; the page then exchanges that session for an opaque cookie
// (owner decision, 14 October 2026: a browser stays signed in for 7 days).
// The cookie works only for the board page's own routes, only with the
// page's own headers, and never as a bearer credential anywhere.
import { publicOrigin } from "./auth";

/** A browser stays signed in for at most this long, and never longer than its Clerk session. */
export const WEB_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
/** After this long, Clerk must confirm the session again before the cookie works. */
export const CLERK_RECHECK_MS = 60 * 60 * 1000;
export const WEB_TOKEN_PREFIX = "pbw_";
export const WEB_CLIENT_HEADER = "X-Planban-Client";
const WEB_TOKEN = /^pbw_[A-Za-z0-9_-]{43}$/;

/** The cookie name: host-only and Secure on https; a plain name for a local http backend. */
export function webCookieName(origin = publicOrigin()): string {
  return origin.startsWith("https://") ? "__Host-planban_web" : "planban_web";
}

/**
 * The browser's web session token, or null. A request carrying the cookie more
 * than once is refused rather than guessed at.
 */
export function webCookieToken(request: Request): string | null {
  const name = webCookieName();
  const values = (request.headers.get("Cookie") ?? "").split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length !== 1 || !WEB_TOKEN.test(values[0]!)) return null;
  return values[0]!;
}

export function webCookie(token: string, maxAgeSeconds: number): string {
  const secure = webCookieName().startsWith("__Host-") ? "; Secure" : "";
  return `${webCookieName()}=${token}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearedWebCookie(): string {
  return webCookie("", 0);
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Cross-site request forgery checks for cookie requests. Every one must carry
 * the page's own header, which a form or a plain link can't add; writes must
 * also come from the public address itself.
 */
export function webRequestTrusted(request: Request, origin = publicOrigin()): boolean {
  if (request.headers.get(WEB_CLIENT_HEADER) !== "web") return false;
  if (SAFE_METHODS.has(request.method)) return true;
  return !!origin && request.headers.get("Origin") === origin && request.headers.get("Sec-Fetch-Site") === "same-origin";
}

/**
 * The only /api/v1 routes a browser session may reach: the board page's own
 * reads and edits, history and restores, people, invitations and members,
 * deleting a board's read-only online copy, connections, invitation acceptance, live updates, new boards and access
 * keys. Everything else, including transfers, import, export, take-local,
 * copy checks and every future route, needs a bearer credential. "*" matches
 * exactly one path segment.
 */
const WEB_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["GET", "me"],
  ["GET", "boards"],
  ["GET", "connections"],
  ["GET", "boards/*"],
  ["GET", "boards/*/changes"],
  ["GET", "boards/*/history"],
  ["GET", "boards/*/history/*"],
  ["GET", "boards/*/history/*/cards/*/docs/*"],
  ["GET", "boards/*/docs/*/*"],
  ["GET", "boards/*/invites"],
  ["GET", "boards/*/people"],
  ["GET", "boards/*/members"],
  ["GET", "boards/*/goals"],
  ["POST", "live-token"],
  ["POST", "boards"],
  ["POST", "boards/*/ops/*"],
  ["POST", "boards/*/invites"],
  ["POST", "boards/*/invites/*/revoke"],
  ["POST", "boards/*/members"],
  ["POST", "boards/*/members/*/role"],
  ["POST", "boards/*/members/*/remove"],
  ["POST", "boards/*/people/me/agents"],
  ["POST", "boards/*/delete-copy"],
  ["POST", "connections/revoke-others"],
  ["POST", "connections/*/revoke"],
  ["POST", "connections/*/access"],
  ["POST", "invites/accept"],
  ["POST", "invites/membership"],
  ["GET", "invites"],
  ["POST", "invites/*/accept"],
  ["POST", "device/preview"],
  ["POST", "device/decide"],
  ["POST", "keys"],
];

/** Whether a browser session may use this method and /api/v1 path (segments already split and decoded). */
export function webRouteAllowed(method: string, parts: readonly string[]): boolean {
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("/") || part.includes("\\"))) return false;
  return WEB_ROUTES.some(([routeMethod, pattern]) => {
    if (routeMethod !== method) return false;
    const segments = pattern.split("/");
    return segments.length === parts.length && segments.every((segment, index) => segment === "*" || segment === parts[index]);
  });
}

/** The /api/v1 path segments of a request, split and decoded as the API router does, or null if malformed. */
export function apiParts(request: Request): string[] | null {
  try {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/v1/") && url.pathname !== "/api/v1") return null;
    // Exact paths only for cookies: an empty segment (a doubled or trailing slash) is refused.
    const segments = url.pathname.replace(/^\/api\/v1\//, "").split("/");
    if (segments.some((segment) => segment === "")) return null;
    return segments.map(decodeURIComponent);
  } catch { return null; }
}
