// One-tap approval (Planban 2.0, owner decision 14 October 2026), for agents
// that can't receive a browser callback. The agent asks for a code; nothing is
// stored. It opens the approval link in the default browser when it runs on
// the person's own computer, and otherwise prints the link (a QR code is an
// extra). A signed-in person allows or denies from any device, desktop or
// phone; only that decision is recorded. The agent then collects its sign-in
// with its device code.
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { MACHINE_CLIENT_ID, REQUEST_MS } from "../oauth";
import { publicOrigin, randomSecret, sha256Hex } from "./auth";
import { readOAuthForm } from "./oauthHttp";
import { noteKey, openNote, randomNonce, sealNote, userCodeFor } from "./signInNote";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache" } });
export const DEVICE_POLL_SECONDS = 5;
const PERMISSION = "Sign in a computer with your full access.";

/**
 * POST /oauth/device (RFC 8628 device authorization, for the Planban command
 * line). Stores nothing: the approval link carries a signed note, after "#"
 * so it never reaches a server log.
 */
export async function deviceAuthorizationResponse(_ctx: ActionCtx, request: Request): Promise<Response> {
  const origin = publicOrigin();
  if (!origin || !noteKey()) return json({ error: "temporarily_unavailable" }, 503);
  const input = await readOAuthForm(request);
  if (!input || input.get("client_id") !== MACHINE_CLIENT_ID || input.get("scope") !== "planban:machine" || input.get("resource") !== origin) return json({ error: "invalid_request" }, 400);
  const deviceCode = randomSecret("pbv_");
  const deviceHash = await sha256Hex(deviceCode);
  const userCode = userCodeFor(deviceHash);
  const note = await sealNote({
    v: 1, kind: "device", purpose: "machine", clientId: MACHINE_CLIENT_ID, clientName: "Planban CLI", redirectUri: "", resource: origin,
    scopes: ["planban:machine"], level: "complete", challenge: "", state: "", expiresAt: Date.now() + REQUEST_MS, deviceHash, userCode, nonce: randomNonce(),
  });
  return json({
    device_code: deviceCode, user_code: userCode,
    verification_uri: `${origin}/approve`, verification_uri_complete: `${origin}/approve#request=${note}`,
    expires_in: REQUEST_MS / 1000, interval: DEVICE_POLL_SECONDS,
  });
}

/** What the approval page shows for a link: who is asking, with what access, and the code to compare. Reads only. */
export async function devicePreview(ctx: ActionCtx, text: string) {
  const note = await openNote(text, "device");
  if (!note || await ctx.runQuery(internal.oauth.deviceAnswered, { deviceHash: note.deviceHash! })) return { state: "ended" as const };
  return { state: "waiting" as const, clientName: note.clientName, permission: PERMISSION, userCode: note.userCode!, expiresAt: note.expiresAt };
}

/** The signed-in person's answer. Allowing counts against their own hourly limit. */
export async function deviceDecision(ctx: ActionCtx, connectionId: Id<"connections">, text: string, allow: boolean) {
  const note = await openNote(text, "device");
  if (!note) return { state: "ended" as const };
  await ctx.runMutation(internal.oauth.decideDevice, {
    connectionId, deviceHash: note.deviceHash!, allow, clientId: note.clientId, clientName: note.clientName, resource: note.resource,
    scopes: note.scopes, level: note.level, purpose: note.purpose, expiresAt: note.expiresAt,
  });
  return { state: allow ? "allowed" as const : "denied" as const };
}
