// Clerk establishes human identity for explicit enrollment only. OAuth
// access credentials, machine credentials and caller-supplied identities
// cannot substitute for an active browser session.
import type { createClerkClient } from "@clerk/backend";
import { publicOrigin } from "./auth";

type SessionClient = ReturnType<typeof createClerkClient>;
/** expiresAt: when Clerk will end the session, in milliseconds, when Clerk says. */
export interface HumanIdentity { userId: string; sessionId: string; expiresAt?: number }

export async function sessionClient(): Promise<SessionClient | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey || !process.env.CLERK_ISSUER || !publicOrigin()) return null;
  try {
    const { createClerkClient } = await import("@clerk/backend");
    return createClerkClient({ secretKey, publishableKey });
  } catch { return null; }
}

/** Rechecked at code redemption; the app never receives the session token. */
export async function activeSessionIdentity(sessionId: string, userId: string, client?: SessionClient | null): Promise<HumanIdentity | null> {
  if (!/^sess_[A-Za-z0-9]+$/.test(sessionId) || !/^user_[A-Za-z0-9]+$/.test(userId)) return null;
  try {
    const verifier = client === undefined ? await sessionClient() : client;
    if (!verifier) return null;
    const session = await verifier.sessions.getSession(sessionId);
    if (session.id !== sessionId || session.userId !== userId || session.status !== "active") return null;
    return { sessionId, userId, ...(Number.isFinite(session.expireAt) ? { expiresAt: session.expireAt } : {}) };
  } catch { return null; }
}

/**
 * Whether Clerk still holds a session active for this person: "ended" when
 * Clerk says it isn't (or doesn't know it), "unknown" when Clerk can't be
 * asked. Callers refuse in both cases and end their own records only on "ended".
 */
export async function clerkSessionStatus(sessionId: string, userId: string, client?: SessionClient | null): Promise<"active" | "ended" | "unknown"> {
  if (!/^sess_[A-Za-z0-9]+$/.test(sessionId) || !/^user_[A-Za-z0-9]+$/.test(userId)) return "ended";
  let verifier: SessionClient | null;
  try { verifier = client === undefined ? await sessionClient() : client; } catch { return "unknown"; }
  if (!verifier) return "unknown";
  try {
    const session = await verifier.sessions.getSession(sessionId);
    return session.id === sessionId && session.userId === userId && session.status === "active" ? "active" : "ended";
  } catch (error) {
    const status = (error as { status?: number }).status;
    return status === 404 || status === 410 ? "ended" : "unknown";
  }
}

export async function verifyHumanSession(request: Request, client?: SessionClient | null): Promise<HumanIdentity | null> {
  const issuer = process.env.CLERK_ISSUER;
  const origin = publicOrigin();
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  if (!issuer || !origin || !bearer) return null;
  try {
    const verifier = client === undefined ? await sessionClient() : client;
    if (!verifier) return null;
    // Clerk parses a literal "Bearer " prefix. Preserve HTTP scheme case
    // insensitivity without transferring or consuming the handler's body.
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${bearer[1]}`);
    const proof = new Request(request.url, { method: request.method, headers });
    const state = await verifier.authenticateRequest(proof, { acceptsToken: "session_token", authorizedParties: [origin] });
    if (!state.isAuthenticated) return null;
    const auth = state.toAuth();
    if (auth.tokenType !== "session_token" || !auth.userId || !auth.sessionId || auth.sessionClaims?.iss !== issuer || auth.sessionClaims?.azp !== origin) return null;
    return activeSessionIdentity(auth.sessionId, auth.userId, verifier);
  } catch { return null; }
}
