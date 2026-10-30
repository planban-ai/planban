// GitHub's webhook for a repository linked to an Online Board (see github.ts).
// GitHub posts each delivery to /api/v1/github/hooks/<linkId>, signed with the
// link's secret (X-Hub-Signature-256: HMAC-SHA256 of the raw body). Only a
// merged pull request (pull_request, action closed, merged true) and GitHub's
// ping do anything; everything else is acknowledged and ignored without a write.
//
// An unknown link, a wrong or missing signature and a delivery from another
// repository get the same answer, so a caller learns nothing about which
// boards or repositories are linked. The body is size-limited before it is
// read in full, and the signature is checked before it is parsed.
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { ServiceErrorData } from "./errors";

export const GITHUB_HOOK_PREFIX = "/api/v1/github/hooks/";
/** GitHub caps payloads at 25 MB; a pull request event, description included, is far below this. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
const LINK_ID = /^[A-Za-z0-9_-]{16,80}$/u;
const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/u;
/** Checked against when the link is unknown, so an unknown link takes as long to refuse as a wrong signature. */
const STAND_IN_SECRET = "planban-unknown-link-stand-in-secret";

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
/** The one refusal for an unknown link, a bad signature or the wrong repository. */
const refused = () => answer(401, { error: "unauthorized" });

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings in time that depends only on their length (GitHub's signatures are all one length). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/** GitHub's X-Hub-Signature-256 for this body and secret: "sha256=" and the hex HMAC-SHA256. */
export async function githubSignature(secret: string, body: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, body))}`;
}

/** Whether the header is GitHub's signature of this body with this secret. A missing or malformed header is not. */
export async function verifyGitHubSignature(secret: string, body: Uint8Array<ArrayBuffer>, header: string | null): Promise<boolean> {
  const expected = await githubSignature(secret, body);
  if (!header || !/^sha256=[0-9a-f]{64}$/u.test(header)) return false;
  return constantTimeEqual(header, expected);
}

async function boundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export interface MergedPullRequest {
  repo: string;
  number: number;
  title: string;
  mergedAt: string;
  url: string;
}

/** The merged pull request a pull_request delivery reports, or null for any other action. */
export function mergedPullRequest(payload: unknown, repo: string): MergedPullRequest | null {
  const event = payload as { action?: unknown; pull_request?: Record<string, unknown> };
  const pr = event?.pull_request;
  if (event?.action !== "closed" || !pr || pr.merged !== true) return null;
  const number = pr.number;
  const mergedAt = typeof pr.merged_at === "string" && Number.isFinite(Date.parse(pr.merged_at)) ? new Date(pr.merged_at).toISOString() : null;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || !mergedAt) return null;
  // The address is GitHub's own for this repository and number; anything else is rebuilt.
  const url = `https://github.com/${repo}/pull/${number}`;
  return { repo, number, title: typeof pr.title === "string" ? pr.title.slice(0, 1000) : "", mergedAt, url };
}

/** One delivery from GitHub to a linked repository's address. */
export async function githubWebhookResponse(ctx: ActionCtx, request: Request): Promise<Response> {
  if (request.method !== "POST") return answer(405, { error: "method_not_allowed" });
  const linkId = new URL(request.url).pathname.slice(GITHUB_HOOK_PREFIX.length);
  const declared = request.headers.get("content-length");
  if (declared !== null && !(/^\d+$/u.test(declared) && Number(declared) <= MAX_WEBHOOK_BYTES)) return answer(413, { error: "payload_too_large" });
  const body = await boundedBody(request, MAX_WEBHOOK_BYTES);
  if (body === null) return answer(413, { error: "payload_too_large" });
  const link = LINK_ID.test(linkId) ? await ctx.runQuery(internal.github.hookSecret, { linkId }) : null;
  const signed = await verifyGitHubSignature(link?.secret ?? STAND_IN_SECRET, body, request.headers.get("x-hub-signature-256"));
  if (!link || !signed) return refused();
  let payload: { repository?: { full_name?: unknown } };
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return answer(400, { error: "invalid_body" });
  }
  // Signed with this link's secret, but for another repository: refused the same way.
  const fullName = payload?.repository?.full_name;
  if (typeof fullName !== "string" || fullName.toLowerCase() !== link.repo.toLowerCase()) return refused();
  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  if (!DELIVERY_ID.test(deliveryId)) return answer(400, { error: "missing_delivery_id" });
  const event = request.headers.get("x-github-event") ?? "";
  if (event !== "ping" && event !== "pull_request") return answer(202, { ignored: "Only merged pull requests are recorded." });
  const merge = event === "pull_request" ? mergedPullRequest(payload, link.repo) : null;
  if (event === "pull_request" && !merge) return answer(202, { ignored: "Only merged pull requests are recorded." });
  try {
    const result = await ctx.runMutation(internal.github.receive, { linkId, deliveryId, ...(merge ? { merge } : {}) });
    return answer(result.status, result.body);
  } catch (error) {
    // A board over its limits, or busy: GitHub shows the answer, and the delivery can be sent again.
    const data = error instanceof ConvexError ? error.data as ServiceErrorData : null;
    const outcome = data ? `Not recorded: ${data.message}` : "Not recorded: the service failed. Redeliver it from GitHub.";
    await ctx.runMutation(internal.github.noteDelivery, { linkId, event, outcome }).catch(() => undefined);
    return answer(data?.code === "rate_limited" ? 429 : 503, { error: outcome });
  }
}
