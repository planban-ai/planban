// Authenticates a web page request by its browser-session cookie, and the
// two routes that start and end a browser session. See webSession.ts.
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { authenticate, publicOrigin, randomSecret, requestOrigin, sha256Hex, type Authenticated } from "./auth";
import { clerkSessionStatus, verifyHumanSession, type sessionClient } from "./humanSession";

type Clerk = Awaited<ReturnType<typeof sessionClient>>;

/**
 * A request with any Authorization header is judged by it alone, even when
 * malformed; only a request without one may use the browser-session cookie.
 */
export async function authenticateApiRequest(ctx: ActionCtx, request: Request, clerk?: Clerk): Promise<Authenticated | null> {
  return request.headers.has("Authorization") ? authenticate(ctx, request) : authenticateWeb(ctx, request, clerk);
}
import { apiParts, CLERK_RECHECK_MS, clearedWebCookie, webCookie, webCookieToken, webRequestTrusted, webRouteAllowed } from "./webSession";

/**
 * The browser session behind a cookie request, or null. Only at the public
 * address, only on the web page's routes, only with the page's own headers,
 * and only while Clerk still confirms the session within the last hour.
 */
export async function authenticateWeb(ctx: ActionCtx, request: Request, clerk?: Clerk): Promise<Authenticated | null> {
  const token = webCookieToken(request);
  if (!token) return null;
  const origin = await requestOrigin(request);
  if (!origin || origin !== publicOrigin()) return null;
  const parts = apiParts(request);
  if (!parts || !webRouteAllowed(request.method, parts) || !webRequestTrusted(request, origin)) return null;
  const session = await ctx.runQuery(internal.webSessions.resolve, { tokenHash: await sha256Hex(token) });
  if (!session || session.serviceOrigin !== origin) return null;
  if (Date.now() - Date.parse(session.clerkCheckedAt) >= CLERK_RECHECK_MS) {
    const status = await clerkSessionStatus(session.clerkSessionId, session.userId, clerk);
    if (status === "ended") await ctx.runMutation(internal.webSessions.endForClerk, { connectionId: session.connectionId });
    if (status !== "active") return null;
    await ctx.runMutation(internal.webSessions.confirm, { connectionId: session.connectionId });
  }
  if (Date.now() - Date.parse(session.lastUsedAt) >= 60 * 60 * 1000) await ctx.runMutation(internal.webSessions.touch, { connectionId: session.connectionId });
  return { connectionId: session.connectionId };
}

const noStore = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const reply = (body: unknown, status: number, cookie?: string) => {
  const headers = new Headers(noStore);
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
};

/**
 * POST /web/session: after Clerk sign-in, the page sends its Clerk session
 * token in the Authorization header (never a form field) and gets the browser
 * session cookie back. A new token every time.
 */
export async function webSessionResponse(ctx: ActionCtx, request: Request, clerk?: Clerk): Promise<Response> {
  if (!webRequestTrusted(request)) return reply({ error: { code: "forbidden", message: "Sign in from the Planban web page." } }, 403);
  const identity = await verifyHumanSession(request, clerk);
  if (!identity) return reply({ error: { code: "unauthorized", message: "Sign in to Planban, then try again." } }, 401);
  const token = randomSecret("pbw_");
  const previous = webCookieToken(request);
  try {
    const { expiresAt } = await ctx.runMutation(internal.webSessions.enroll, {
      userId: identity.userId,
      clerkSessionId: identity.sessionId,
      tokenHash: await sha256Hex(token),
      ...(identity.expiresAt ? { clerkExpiresAt: identity.expiresAt } : {}),
      ...(previous ? { previousTokenHash: await sha256Hex(previous) } : {}),
    });
    return reply({ signedIn: true, expiresAt }, 200, webCookie(token, (Date.parse(expiresAt) - Date.now()) / 1000));
  } catch {
    return reply({ error: { code: "unauthorized", message: "This sign-in has ended. Sign in again." } }, 401, clearedWebCookie());
  }
}

/** POST /web/signout: ends this browser's session here and at Clerk, and clears the cookie. */
export async function webSignOutResponse(ctx: ActionCtx, request: Request): Promise<Response> {
  if (!webRequestTrusted(request)) return reply({ error: { code: "forbidden", message: "Sign out from the Planban web page." } }, 403);
  const token = webCookieToken(request);
  if (token) {
    const { clerkSessionId } = await ctx.runMutation(internal.webSessions.endByToken, { tokenHash: await sha256Hex(token) });
    if (clerkSessionId) await ctx.runAction(internal.webSessions.revokeClerkSession, { clerkSessionId });
  }
  return reply({ signedOut: true }, 200, clearedWebCookie());
}
