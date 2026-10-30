// The authentication boundary. A verifier turns a request's credential into a
// Planban connection id, or null. Planban-issued secrets (machine sign-ins,
// personal access keys, development tokens, OAuth access credentials) resolve
// by hash. Clerk proves human identity only at explicit enrollment.
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

export interface Authenticated {
  connectionId: Id<"connections">;
}

export interface AuthVerifier {
  /** `origin` is the service address the request arrived through, from requestOrigin. */
  authenticate(ctx: ActionCtx, bearer: string, origin: string): Promise<Authenticated | null>;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return prefix + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const planbanTokenVerifier: AuthVerifier = {
  async authenticate(ctx, bearer, origin) {
    if (!/^pb[a-z]_[A-Za-z0-9_-]{20,}$/.test(bearer)) return null;
    // Browser session tokens only ever work as the web page's cookie.
    if (bearer.startsWith("pbw_")) return null;
    const resolved = await ctx.runQuery(internal.connections.resolveToken, { tokenHash: await sha256Hex(bearer) });
    if (!resolved) return null;
    // A credential works only through the address it was issued for.
    if (resolved.oauthResource !== undefined) {
      if (![origin, `${origin}/mcp`].includes(resolved.oauthResource)) return null;
    } else if ((resolved.serviceOrigin ?? legacyOrigin()) !== origin) return null;
    if (Date.now() - Date.parse(resolved.lastUsedAt) >= 60 * 60 * 1000) {
      await ctx.runMutation(internal.connections.touch, { connectionId: resolved.connectionId });
    }
    return { connectionId: resolved.connectionId };
  },
};

/** The service's public address, which Clerk tokens may name as their audience. */
export function publicOrigin() {
  return (process.env.PLANBAN_PUBLIC_URL ?? process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "");
}

/** The hosting provider's own address for this backend. */
function nativeOrigin() {
  return (process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "");
}

/**
 * Credentials issued before addresses were recorded belong to the native
 * address, which was the only address then. They stop working through any
 * other address instead of being silently rewritten.
 */
export function legacyOrigin() {
  return nativeOrigin() || publicOrigin();
}

export const EDGE_PROOF_HEADER = "Planban-Edge-Proof";

/**
 * The service address a request arrived through, or null when it must be
 * refused. With PLANBAN_EDGE_PROOF_SHA256 set, the public address sits in front
 * of the native one and adds a shared proof to every request it forwards; a
 * request without that proof came straight to the native address, which then
 * accepts no credentials at all. Host, forwarded headers and Origin are never
 * evidence either way.
 */
export async function requestOrigin(request: Request): Promise<string | null> {
  const proofHash = process.env.PLANBAN_EDGE_PROOF_SHA256;
  const service = publicOrigin(), native = nativeOrigin();
  if (proofHash === undefined) {
    // One address: a separate public address without the proof fails closed.
    return service && (!native || native === service) ? service : null;
  }
  if (!/^[a-f0-9]{64}$/.test(proofHash) || !service || !native || service === native) return null;
  const proof = request.headers.get(EDGE_PROOF_HEADER);
  return proof && await sha256Hex(proof) === proofHash ? service : null;
}

/** Sign-in, consent, token and invitation routes serve only the trusted service address. */
export async function atServiceAddress(request: Request): Promise<boolean> {
  const origin = await requestOrigin(request);
  return origin !== null && origin === publicOrigin();
}

/** The address a connection's credentials belong to; personal keys inherit it from their creator. */
export function connectionOrigin(connection: { oauthResource?: string; serviceOrigin?: string }): string {
  if (connection.oauthResource) return new URL(connection.oauthResource).origin;
  return connection.serviceOrigin ?? legacyOrigin();
}

// Direct Clerk OAuth credentials cannot identify a grant incarnation. They
// remain denied even after a new service-owned connection is authorized.
const verifiers: AuthVerifier[] = [planbanTokenVerifier];

export async function authenticate(ctx: ActionCtx, request: Request): Promise<Authenticated | null> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const origin = await requestOrigin(request);
  if (!origin) return null;
  for (const verifier of verifiers) {
    const result = await verifier.authenticate(ctx, match[1]!, origin);
    if (result) return result;
  }
  return null;
}

/**
 * Development sign-in is only offered by a local backend with
 * PLANBAN_DEV_AUTH=1. A deployed service never has a loopback site URL.
 */
export function devAuthEnabled(): boolean {
  const site = process.env.CONVEX_SITE_URL ?? "";
  return process.env.PLANBAN_DEV_AUTH === "1" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(site);
}
