import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { publicOrigin, randomSecret, sha256Hex } from "./auth";
import { activeSessionIdentity, type HumanIdentity } from "./humanSession";
import { MACHINE_CLIENT_ID } from "../oauth";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const MAX_FORM_BYTES = 8192;
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache" },
});
const error = (code: string, status = 400) => reply({ error: code }, status);

export async function readOAuthForm(request: Request, allowAuthorization = false): Promise<URLSearchParams | null> {
  if (request.method !== "POST" || (!allowAuthorization && request.headers.has("Authorization")) || !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FORM_BYTES) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const params = new URLSearchParams();
    const decode = (value: string) => decodeURIComponent(value.replace(/\+/g, " "));
    for (const pair of text.split("&")) {
      if (!pair) continue;
      const equals = pair.indexOf("=");
      params.append(decode(equals < 0 ? pair : pair.slice(0, equals)), decode(equals < 0 ? "" : pair.slice(equals + 1)));
    }
    if ([...params].length > 12 || [...params.keys()].some((key) => params.getAll(key).length !== 1)) return null;
    return params;
  } catch { return null; }
  finally { await reader.cancel().catch(() => {}); }
}

async function challenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type SessionCheck = (sessionId: string, userId: string) => Promise<HumanIdentity | null>;

/** Opaque codes and refresh credentials never substitute for human consent. */
export async function tokenResponse(ctx: ActionCtx, request: Request, checkSession: SessionCheck = activeSessionIdentity): Promise<Response> {
  const input = await readOAuthForm(request);
  if (!input) return error("invalid_request");
  const clientId = input.get("client_id") ?? "";
  const resource = input.get("resource") ?? "";
  if (!clientId || clientId.length > 2048) return error("invalid_client");
  const origin = publicOrigin();
  if (!origin || ![origin, `${origin}/mcp`].includes(resource) || (clientId === MACHINE_CLIENT_ID && resource !== origin)) return error("invalid_target");
  const grantType = input.get("grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token" && grantType !== DEVICE_GRANT) return error("unsupported_grant_type");
  // Explicit refresh scope may restate the approved set. The mutation checks
  // it atomically against the stored credential before issuing replacements.
  const scope = input.get("scope");
  const requestedScopes = scope === null ? undefined : scope.split(" ");
  if (requestedScopes && (grantType !== "refresh_token" || !/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(scope!) || requestedScopes.length > 4 || new Set(requestedScopes).size !== requestedScopes.length)) return error("invalid_scope");
  const accessToken = randomSecret(clientId === MACHINE_CLIENT_ID ? "pbm_" : "pba_");
  const refreshToken = randomSecret("pbr_");
  const hashes = { accessHash: await sha256Hex(accessToken), refreshHash: await sha256Hex(refreshToken) };
  try {
    let result;
    if (grantType === DEVICE_GRANT) {
      // One-tap approval: the waiting command line collects its sign-in. Until someone answers, nothing is written.
      const deviceCode = input.get("device_code") ?? "";
      if (clientId !== MACHINE_CLIENT_ID || !/^pbv_[A-Za-z0-9_-]{43}$/.test(deviceCode)) return error("invalid_grant");
      result = await ctx.runMutation(internal.oauth.redeemDevice, { deviceHash: await sha256Hex(deviceCode), clientId, resource, accessHash: hashes.accessHash });
    } else if (grantType === "authorization_code") {
      const code = input.get("code") ?? "", verifier = input.get("code_verifier") ?? "", redirectUri = input.get("redirect_uri") ?? "";
      if (!/^pbc_[A-Za-z0-9_-]{43}$/.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !redirectUri || redirectUri.length > 2048) return error("invalid_request");
      const codeHash = await sha256Hex(code);
      const context = await ctx.runQuery(internal.oauth.redemptionContext, { codeHash });
      if (!context) return error("invalid_grant");
      const identity = context.sessionId && context.userId ? await checkSession(context.sessionId, context.userId) : null;
      if (context.sessionId && (!identity || identity.sessionId !== context.sessionId || identity.userId !== context.userId)) return error("invalid_grant");
      result = await ctx.runMutation(internal.oauth.redeem, {
        codeHash, clientId, resource, redirectUri, challenge: await challenge(verifier), ...hashes,
        ...(identity ? { sessionId: identity.sessionId, sessionUserId: identity.userId } : {}),
      });
    } else {
      const token = input.get("refresh_token") ?? "";
      if (!/^pbr_[A-Za-z0-9_-]{43}$/.test(token) || clientId === MACHINE_CLIENT_ID) return error("invalid_grant");
      result = await ctx.runMutation(internal.oauth.refresh, { tokenHash: await sha256Hex(token), clientId, resource, ...hashes, ...(requestedScopes ? { requestedScopes } : {}) });
    }
    if ("error" in result) return error(result.error);
    // Raw credentials are returned once; only their independent hashes reach
    // database mutations. Refresh replay errors must remain committed errors.
    return reply({ access_token: accessToken, token_type: "Bearer", expires_in: result.expiresIn, scope: result.scope,
      ...(result.refresh ? { refresh_token: refreshToken } : {}), ...(result.machine && "userId" in result ? { user_id: result.userId } : {}),
    });
  } catch { return error("server_error", 503); }
}

/** RFC 7009: unknown tokens have the same successful response as known ones. */
export async function revocationResponse(ctx: ActionCtx, request: Request): Promise<Response> {
  const input = await readOAuthForm(request);
  if (!input) return error("invalid_request");
  const clientId = input.get("client_id") ?? "", token = input.get("token") ?? "";
  if (!clientId || clientId.length > 2048 || !token || token.length > 2048) return error("invalid_request");
  try {
    await ctx.runMutation(internal.oauth.revokeToken, { clientId, tokenHash: await sha256Hex(token) });
    return reply({});
  } catch { return error("server_error", 503); }
}
