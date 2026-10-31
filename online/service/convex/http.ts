import { renderInviteEmail } from "./model/inviteEmail";
import { BRAND_FILES, brandResponse, FAVICON_DATA_URI, WORDMARK_BLACK_DATA_URI } from "./model/brandAssets";
// HTTP entry points: the REST API that local Planban installs use for an
// Online Board, and development sign-in on local backends.
import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { atServiceAddress, authenticate, devAuthEnabled, publicOrigin, randomSecret, sha256Hex, type Authenticated } from "./model/auth";
import type { ServiceErrorData } from "./model/errors";
import { liveTokensConfigured, publicJwks, signLiveToken } from "./model/liveToken";
import { handleMcp, McpService } from "./model/mcp";
import { INDEX_NOT_STORAGE } from "../../../src/core/contentRules";
import { packJson, unpacked } from "./model/codec";
import { requestedMemberRole } from "../../../src/core/memberRoles";
import { PLANBAN_VERSION_HEADER, refusedForVersion, UPDATE_REQUIRED_CODE, UPDATE_REQUIRED_STATUS } from "../../../src/core/clientVersion";
import { tokenResponse, revocationResponse } from "./model/oauthHttp";
import { webConfigResponse, authorizationResponse, registrationResponse, consentResponse, approvalResponse, machineStartResponse, machineLaunchResponse, machineCancelResponse, consentValidityResponse, enrollmentConfigured, CLI_REDIRECT_PORTS, PLANBAN_SCOPES } from "./model/oauthConsent";
import { MACHINE_CLIENT_ID } from "./oauth";
import { authenticateApiRequest, webSessionResponse, webSignOutResponse } from "./model/webAuth";
import { deviceAuthorizationResponse, deviceDecision, devicePreview } from "./model/deviceFlow";
import { clerkWebhookResponse } from "./model/signInEmail";
import { GITHUB_HOOK_PREFIX, githubWebhookResponse } from "./model/githubWebhook";

const STATUS_FOR: Record<ServiceErrorData["code"], number> = {
  rate_limited: 429,
  conflict: 409,
  validation: 400,
  not_found: 404,
  forbidden: 403,
  unauthorized: 401,
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ConvexError) {
    const data = error.data as ServiceErrorData;
    return json({ error: data }, STATUS_FOR[data.code] ?? 400);
  }
  console.error("Unexpected service error", error instanceof Error ? error.name : typeof error);
  return json({ error: { code: "internal", message: "The Online Board service failed. Try again." } }, 500);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const unauthorized = () => json(
  { error: { code: "unauthorized", message: "Sign in to Planban Online first." } },
  401,
  { "WWW-Authenticate": 'Bearer realm="planban"' },
);

/**
 * A computer's Planban too old for this request (owner decision, 16 October 2026): a
 * plain message pointing at Update, never a raw error. The web page is served with the
 * service, so it is always current.
 */
function tooOldFor(request: Request, op?: string): Response | null {
  if (request.headers.get("X-Planban-Client") === "web") return null;
  const refused = refusedForVersion(request.headers.get(PLANBAN_VERSION_HEADER), op);
  return refused ? json({ error: { code: UPDATE_REQUIRED_CODE, message: refused } }, UPDATE_REQUIRED_STATUS) : null;
}

export async function handleApi(ctx: ActionCtx, request: Request, auth: Authenticated): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const method = request.method;
  const { connectionId } = auth;
  const outdated = tooOldFor(request, parts[0] === "boards" && parts[2] === "ops" ? parts[3] : undefined);
  if (outdated) return outdated;

  if (parts[0] === "me" && parts.length === 1 && method === "GET") return json(await ctx.runQuery(internal.boards.me, { connectionId }));
  if (parts[0] === "live-token" && parts.length === 1 && method === "POST") {
    if (!liveTokensConfigured()) return json({ error: { code: "not_found", message: "Live updates are not configured." } }, 404);
    await ctx.runQuery(internal.boards.me, { connectionId });
    return json({ ...(await signLiveToken(connectionId)), convexUrl: process.env.CONVEX_CLOUD_URL });
  }
  if (parts[0] === "transfers" && method === "POST") {
    // Take Online in parts: begin (with the roadmap), parts, commit; or abort.
    const input = await body(request);
    // The board's content travels to the mutation as packed bytes: a card's fields can be
    // shaped in ways Convex values don't allow (over 1,024 metadata keys in Revival's history).
    if (parts.length === 1) {
      return json(await ctx.runMutation(internal.transfers.begin, {
        connectionId, transferId: String(input.transferId ?? ""),
        payload: packJson({
          roadmap: input.roadmap,
          ...(typeof input.uid === "string" ? { uid: input.uid } : {}),
          ...(input.retention === undefined ? {} : { retention: input.retention }),
          ...(Array.isArray(input.retiredIds) ? { retiredIds: input.retiredIds.map(String) } : {}),
          ...(input.goals === undefined ? {} : { goals: input.goals }),
        }),
      }));
    }
    const transferId = parts[1]!;
    if (parts[2] === "parts" && parts.length === 3) {
      return json(await ctx.runMutation(internal.transfers.part, {
        connectionId, transferId, seq: Number(input.seq),
        payload: packJson({
          ...(input.docs === undefined ? {} : { docs: input.docs }),
          ...(input.history === undefined ? {} : { history: input.history }),
          ...(input.historyDocs === undefined ? {} : { historyDocs: input.historyDocs }),
        }),
      }));
    }
    if (parts[2] === "commit" && parts.length === 3) return json(unpacked(await ctx.runMutation(internal.transfers.commit, { connectionId, transferId, partCount: Number(input.partCount) })));
    if (parts[2] === "abort" && parts.length === 3) return json(await ctx.runMutation(internal.transfers.abort, { connectionId, transferId }));
  }
  if (parts[0] === "copy-check" && parts.length === 1 && method === "POST") {
    const input = await body(request);
    const fingerprints = Array.isArray(input.fingerprints) ? input.fingerprints
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({ version: Number(item.version), createdAt: String(item.createdAt ?? ""), operation: String(item.operation ?? "") }))
      .filter((item) => Number.isInteger(item.version)) : [];
    return json(await ctx.runQuery(internal.copies.check, { connectionId, fingerprints, ...(typeof input.uid === "string" ? { uid: input.uid } : {}) }));
  }
  if (parts[0] === "connections" && parts.length === 1 && method === "GET") return json(await ctx.runQuery(internal.connections.list, { connectionId }));
  if (parts[0] === "connections" && parts.length === 2 && parts[1] === "revoke-others" && method === "POST") {
    return json(await ctx.runMutation(internal.connections.revokeAllOthers, { connectionId }));
  }
  if (parts[0] === "connections" && parts.length === 3 && parts[2] === "revoke" && method === "POST") {
    return json(await ctx.runMutation(internal.connections.revoke, { connectionId, targetId: parts[1]! }));
  }
  if (parts[0] === "connections" && parts.length === 3 && parts[2] === "access" && method === "POST") {
    const input = await body(request);
    const level = input.level === "read" || input.level === "plan" || input.level === "complete" ? input.level : undefined;
    const boards = input.boards === "all" ? "all" as const : Array.isArray(input.boards) ? input.boards.map(String) : undefined;
    return json(await ctx.runMutation(internal.connections.setAccess, { connectionId, targetId: parts[1]!, ...(level ? { level } : {}), ...(boards !== undefined ? { boards } : {}) }));
  }
  if (parts[0] === "connections" && parts.length === 3 && parts[2] === "restore" && method === "POST") {
    return json(await ctx.runMutation(internal.connections.restore, { connectionId, targetId: parts[1]! }));
  }
  if (parts[0] === "keys" && parts.length === 1 && method === "POST") {
    const input = await body(request);
    const level = input.level === "read" || input.level === "plan" || input.level === "complete" ? input.level : null;
    if (!level) return json({ error: { code: "validation", message: "level must be read, plan or complete." } }, 400);
    const days = input.expiresInDays === undefined ? undefined : Number(input.expiresInDays);
    if (days !== undefined && !(Number.isInteger(days) && days > 0 && days <= 3650)) return json({ error: { code: "validation", message: "expiresInDays must be a whole number of days." } }, 400);
    const token = randomSecret("pbk_");
    const created = await ctx.runMutation(internal.connections.createKey, {
      connectionId, tokenHash: await sha256Hex(token), name: String(input.name ?? ""), boardId: String(input.boardId ?? ""), level,
      ...(days === undefined ? {} : { expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() }),
    });
    // The key is shown once; only its hash is stored.
    return json({ ...created, key: token }, 201);
  }
  if (parts[0] === "device" && parts.length === 2 && method === "POST" && (parts[1] === "preview" || parts[1] === "decide")) {
    // One-tap approval of a waiting agent, from the person's own sign-in on any device.
    const me = await ctx.runQuery(internal.boards.me, { connectionId });
    if (!me.canAdminister) return json({ error: { code: "forbidden", message: "Approve sign-ins from your own sign-in." } }, 403);
    const input = await body(request);
    const note = String(input.request ?? "");
    if (parts[1] === "preview") return json(await devicePreview(ctx, note));
    if (input.decision !== "allow" && input.decision !== "deny") return json({ error: { code: "validation", message: "decision must be allow or deny." } }, 400);
    return json(await deviceDecision(ctx, connectionId, note, input.decision === "allow"));
  }
  if (parts[0] === "invites" && parts.length === 1 && method === "GET") {
    // Email invitations waiting for this person's verified addresses (the dashboard's banner).
    const verifiedEmails = await verifiedEmailsOf((await ctx.runQuery(internal.boards.me, { connectionId })).userId);
    return json(await ctx.runQuery(internal.invites.waitingFor, { connectionId, verifiedEmails }));
  }
  if (parts[0] === "invites" && parts.length === 3 && parts[2] === "accept" && method === "POST") {
    const verifiedEmails = await verifiedEmailsOf((await ctx.runQuery(internal.boards.me, { connectionId })).userId);
    return json(await ctx.runMutation(internal.invites.acceptById, { connectionId, inviteId: parts[1]!, verifiedEmails }));
  }
  if (parts[0] === "invites" && parts[1] === "membership" && parts.length === 2 && method === "POST") {
    const input = await body(request);
    return json(await ctx.runQuery(internal.invites.membership, { connectionId, tokenHash: await sha256Hex(inviteToken(String(input.token ?? ""))) }));
  }
  if (parts[0] === "invites" && parts[1] === "accept" && parts.length === 2 && method === "POST") {
    const input = await body(request);
    const tokenHash = await sha256Hex(inviteToken(String(input.token ?? "")));
    const forEmail = await ctx.runQuery(internal.invites.emailOf, { tokenHash });
    const verifiedEmails = forEmail ? await verifiedEmailsOf((await ctx.runQuery(internal.boards.me, { connectionId })).userId) : undefined;
    return json(await ctx.runMutation(internal.invites.accept, { connectionId, tokenHash, ...(verifiedEmails ? { verifiedEmails } : {}) }));
  }
  if (parts[0] !== "boards") return json({ error: { code: "not_found", message: "Unknown endpoint." } }, 404);
  if (parts.length === 1 && method === "GET") return json({ boards: await ctx.runQuery(internal.boards.listBoards, { connectionId }) });
  if (parts.length === 1 && method === "POST") {
    const input = await body(request);
    return json(await ctx.runMutation(internal.transfers.createBoard, { connectionId, title: String(input.title ?? "") }), 201);
  }
  if (parts[1] === "import" && parts.length === 2 && method === "POST") {
    return json(unpacked(await ctx.runMutation(internal.transfers.importBundle, { connectionId, transferId: crypto.randomUUID(), payload: packJson(await body(request)) })), 201);
  }

  const boardId = parts[1]!;
  const rest = parts.slice(2);
  if (rest.length === 0 && method === "GET") {
    const since = url.searchParams.get("since");
    return json(unpacked(await ctx.runQuery(internal.boards.getBoard, { connectionId, boardId, ...(since === null ? {} : { since: Number(since) }) })));
  }
  if (rest[0] === "export" && rest.length === 1 && method === "GET") return json(unpacked(await ctx.runQuery(internal.boards.exportBoard, { connectionId, boardId })));
  const transfer = url.searchParams.get("transferId");
  const bound = transfer === null ? {} : { transferId: transfer };
  if (rest[0] === "export" && rest[1] === "meta" && method === "GET") return json(unpacked(await ctx.runQuery(internal.boards.exportMeta, { connectionId, boardId, ...bound })));
  if (rest[0] === "export" && rest[1] === "docs" && method === "GET") {
    const atRevision = url.searchParams.get("revision");
    return json(unpacked(await ctx.runQuery(internal.boards.exportDocs, {
      connectionId, boardId, offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 100), ...bound,
      ...(atRevision === null ? {} : { revision: Number(atRevision) }),
    })));
  }
  if (rest[0] === "export" && rest[1] === "history" && method === "GET") {
    const docsOf = url.searchParams.get("docsOf");
    const docsCursor = url.searchParams.get("docsCursor");
    return json(unpacked(await ctx.runQuery(internal.boards.exportHistory, {
      connectionId, boardId, after: Number(url.searchParams.get("after") ?? 0), limit: Number(url.searchParams.get("limit") ?? 8), ...bound,
      ...(docsOf === null ? {} : { docsOf: Number(docsOf) }), ...(docsCursor === null ? {} : { docsCursor }),
    })));
  }
  if (rest[0] === "history" && rest.length === 2 && method === "GET") {
    return json(unpacked(await ctx.runQuery(internal.boards.historyVersion, { connectionId, boardId, version: Number(rest[1]) })));
  }
  if (rest[0] === "history" && rest.length === 6 && rest[2] === "cards" && rest[4] === "docs" && method === "GET") {
    const kind = rest[5] === "spec" || rest[5] === "plan" ? rest[5] : null;
    if (!kind) return json({ error: { code: "validation", message: "kind must be spec or plan." } }, 400);
    return json(await ctx.runQuery(internal.boards.historyDoc, { connectionId, boardId, version: Number(rest[1]), cardId: rest[3]!, kind }));
  }
  if (rest[0] === "history" && method === "GET") {
    const after = url.searchParams.get("after");
    return json(await ctx.runQuery(internal.boards.history, { connectionId, boardId, ...(after === null ? {} : { after: Number(after) }) }));
  }
  if (rest[0] === "changes" && method === "GET") {
    // Live updates use Convex subscriptions; this one-shot check remains for
    // clients that cannot subscribe.
    const { revision } = await ctx.runQuery(internal.boards.revision, { connectionId, boardId });
    return json({ revision });
  }
  if (rest[0] === "invites" && rest.length === 1 && method === "GET") return json(await ctx.runQuery(internal.invites.list, { connectionId, boardId }));
  if (rest[0] === "invites" && rest.length === 1 && method === "POST") {
    const input = await body(request);
    const role = requestedMemberRole(input.role, "viewer");
    if (!role) return json({ error: { code: "validation", message: "role must be viewer or editor." } }, 400);
    const token = randomSecret("pbi_");
    const created = await ctx.runMutation(internal.invites.create, {
      connectionId, boardId, tokenHash: await sha256Hex(token), role, ...(typeof input.email === "string" && input.email.trim() ? { email: input.email } : {}),
    });
    const link = `${publicOrigin()}/invite/${token}`;
    const emailSent = created.email ? await sendInviteEmail(created.email, role, link, created.id) : false;
    // The link is shown once; only its hash is stored.
    return json({ invite: created, link, emailSent }, 201);
  }
  if (rest[0] === "invites" && rest.length === 3 && rest[2] === "revoke" && method === "POST") return json(await ctx.runMutation(internal.invites.revoke, { connectionId, boardId, inviteId: rest[1]! }));
  if (rest[0] === "members" && rest.length === 3 && method === "POST" && (rest[2] === "role" || rest[2] === "remove")) {
    const input = await body(request);
    const role = requestedMemberRole(input.role);
    if (rest[2] === "role" && !role) return json({ error: { code: "validation", message: "role must be viewer or editor." } }, 400);
    return json({ members: await ctx.runMutation(internal.members.update, { connectionId, boardId, userId: decodeURIComponent(rest[1]!), ...(rest[2] === "remove" ? { remove: true } : role ? { role } : {}) }) });
  }
  if (rest[0] === "people" && rest.length === 1 && method === "GET") return json(unpacked(await ctx.runQuery(internal.people.forBoard, { connectionId, boardId })));
  if (rest[0] === "people" && rest[1] === "me" && rest[2] === "agents" && method === "POST") {
    const input = await body(request);
    const level = input.level === "read" || input.level === "plan" || input.level === "complete" ? input.level : null;
    if (!level) return json({ error: { code: "validation", message: "level must be read, plan or complete." } }, 400);
    return json(await ctx.runMutation(internal.people.setAgentLevel, { connectionId, boardId, level }));
  }
  if (rest[0] === "members" && method === "GET") return json({ members: await ctx.runQuery(internal.members.list, { connectionId, boardId }) });
  if (rest[0] === "members" && method === "POST") {
    const input = await body(request);
    const role = requestedMemberRole(input.role, "editor");
    if (!role) return json({ error: { code: "validation", message: "role must be viewer or editor." } }, 400);
    return json({ members: await ctx.runMutation(internal.members.add, { connectionId, boardId, userId: String(input.userId ?? ""), role }) });
  }
  if (rest[0] === "delete-copy" && rest.length === 1 && method === "POST") {
    const input = await body(request);
    return json(await ctx.runMutation(internal.erasure.deleteBoardCopy, { connectionId, boardId, confirmTitle: String(input.confirmTitle ?? "") }));
  }
  if (rest[0] === "take-local" && rest[1] === "fence" && method === "POST") {
    const input = await body(request);
    return json(await ctx.runMutation(internal.boards.fence, {
      connectionId, boardId, transferId: String(input.transferId ?? ""),
      ...(typeof input.expectedGeneration === "number" ? { expectedGeneration: input.expectedGeneration } : {}),
      ...(Array.isArray(input.acknowledgedOthers) ? { acknowledgedOthers: input.acknowledgedOthers.map(String) } : {}),
    }));
  }
  if (rest[0] === "take-local" && rest[1] === "finish" && method === "POST") {
    const input = await body(request);
    return json(await ctx.runMutation(internal.boards.finishTakeLocal, { connectionId, boardId, transferId: String(input.transferId ?? "") }));
  }
  if (rest[0] === "ops" && rest.length === 2 && method === "POST") {
    // A retried edit carries the same Idempotency-Key and byte-identical body.
    const raw = await request.text();
    let input: unknown = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      return json({ error: { code: "validation", message: "The request body must be JSON." } }, 400);
    }
    const idempotencyKey = request.headers.get("Idempotency-Key");
    // Completing a card states that a person confirmed it, in the body as on MCP.
    const completionConfirmed: boolean = typeof input === "object" && input !== null && (input as { completionConfirmed?: unknown }).completionConfirmed === true;
    const ran = unpacked<{ refused?: ServiceErrorData } & Record<string, unknown>>(await ctx.runMutation(internal.boards.run, {
      connectionId, boardId, op: rest[1]!, payload: packJson(input), ...(completionConfirmed ? { completionConfirmed } : {}),
      ...(idempotencyKey ? { idempotencyKey, requestHash: await sha256Hex(`${boardId}\n${rest[1]}\n${raw}`) } : {}),
    }));
    // A refused agent edit, kept as an unresolved change: a conflict, like any other.
    if ("refused" in ran && ran.refused) return json({ error: ran.refused }, 409);
    return json(ran);
  }
  if (rest[0] === "presence" && rest.length === 1 && method === "POST") {
    const input = await body(request);
    return json(await ctx.runMutation(internal.boards.notePresence, { connectionId, boardId, cardId: String(input.cardId ?? ""), ...(typeof input.agentName === "string" ? { agentName: input.agentName } : {}) }));
  }
  if (rest[0] === "presence" && rest.length === 1 && method === "GET") {
    const cardId = url.searchParams.get("card") ?? undefined;
    const agentName = url.searchParams.get("agent") ?? undefined;
    return json(await ctx.runQuery(internal.boards.working, { connectionId, boardId, ...(cardId ? { cardId } : {}), ...(agentName ? { agentName } : {}) }));
  }
  if (rest[0] === "github" && rest.length === 1 && method === "GET") return json(await ctx.runQuery(internal.github.links, { connectionId, boardId }));
  if (rest[0] === "github" && rest[1] === "links" && rest.length === 2 && method === "POST") {
    // The link's secret is made here and returned this once, to the owner's own sign-in, for
    // their computer to hand to GitHub. It is never shown again.
    // Linking again after a failure picks up the unfinished link, with a new secret, at the same address.
    const input = await body(request);
    const secret = randomSecret("");
    const created = await ctx.runMutation(internal.github.createLink, { connectionId, boardId, repo: String(input.repo ?? ""), linkId: randomSecret("ghl_"), secret });
    return json({ ...created, webhookUrl: `${publicOrigin()}${GITHUB_HOOK_PREFIX}${created.linkId}`, secret }, created.resumed ? 200 : 201);
  }
  if (rest[0] === "github" && rest[1] === "links" && rest[3] === "hook" && rest.length === 4 && method === "POST") {
    const input = await body(request);
    return json(await ctx.runMutation(internal.github.setHook, { connectionId, boardId, linkId: rest[2]!, hookId: Number(input.hookId) }));
  }
  if (rest[0] === "github" && rest[1] === "unlink" && rest.length === 2 && method === "POST") {
    const input = await body(request);
    return json(await ctx.runMutation(internal.github.removeLink, { connectionId, boardId, repo: String(input.repo ?? "") }));
  }
  if (rest[0] === "github" && rest[1] === "unlink" && rest[2] === "done" && rest.length === 3 && method === "POST") {
    const input = await body(request);
    return json(await ctx.runMutation(internal.github.forgetLink, { connectionId, boardId, repo: String(input.repo ?? "") }));
  }
  if (rest[0] === "goals" && rest.length === 1 && method === "GET") return json(unpacked(await ctx.runQuery(internal.boards.goals, { connectionId, boardId })));
  if (rest[0] === "unresolved" && rest.length === 1 && method === "GET") {
    const cardId = url.searchParams.get("card") ?? undefined;
    return json(unpacked(await ctx.runQuery(internal.boards.unresolved, { connectionId, boardId, ...(cardId ? { cardId } : {}) })));
  }
  // Owner decision 18: Planban is an index, not storage. Online boards hold
  // text only; files stay where they live and cards refer to them.
  if (rest[0] === "attachments") return json({ error: { code: "not_found", message: INDEX_NOT_STORAGE } }, 404);
  if (rest[0] === "docs" && rest.length === 3 && method === "GET") {
    const kind = rest[2] === "plan" ? "plan" : rest[2] === "spec" ? "spec" : null;
    if (!kind) return json({ error: { code: "validation", message: "kind must be spec or plan." } }, 400);
    return json(await ctx.runQuery(internal.boards.readDoc, { connectionId, boardId, cardId: rest[1]!, kind }));
  }
  return json({ error: { code: "not_found", message: "Unknown endpoint." } }, 404);
}

/** Every /api/v1 request: a bearer credential or the browser's session, then the route. */
export async function apiResponse(ctx: ActionCtx, request: Request): Promise<Response> {
  try {
    // GitHub's deliveries carry no Planban credential: each is checked against its link's own secret.
    if (new URL(request.url).pathname.startsWith(GITHUB_HOOK_PREFIX)) return await githubWebhookResponse(ctx, request);
    const auth = await authenticateApiRequest(ctx, request);
    if (!auth) return unauthorized();
    return await handleApi(ctx, request, auth);
  } catch (error) {
    return errorResponse(error);
  }
}

const api = httpAction(apiResponse);

/** Development sign-in for local backends only: returns a bearer token for a named test person. */
export const devTokenResponse: RouteHandler = async (ctx, request) => {
  if (!devAuthEnabled()) return json({ error: { code: "not_found", message: "Unknown endpoint." } }, 404);
  const input = await body(request);
  const userId = typeof input.userId === "string" && /^[a-z0-9-]{1,40}$/.test(input.userId) ? input.userId : null;
  if (!userId) return json({ error: { code: "validation", message: "userId must be a short lowercase id." } }, 400);
  const boards = Array.isArray(input.boards) && input.boards.every((board) => typeof board === "string") ? input.boards as string[] : "all";
  const level = input.level === "read" || input.level === "plan" || input.level === "complete" ? input.level : boards === "all" ? "complete" : "plan";
  const token = randomSecret("pbd_");
  const { connectionId } = await ctx.runMutation(internal.connections.createDevConnection, {
    tokenHash: await sha256Hex(token),
    userId,
    clientName: typeof input.clientName === "string" ? input.clientName.slice(0, 80) : "Planban development sign-in",
    boards,
    level,
  });
  return json({ token, connectionId, userId }, 201);
};

/**
 * Remote MCP over Streamable HTTP. An unauthenticated request gets the
 * standard challenge pointing at the protected resource metadata, which
 * names the sign-in server MCP clients use for OAuth.
 */
function mcpUnauthorized() {
  return json({ error: { code: "unauthorized", message: "Sign in to Planban Online first." } }, 401, {
    // Resource scopes describe Planban permissions, not provider identity.
    "WWW-Authenticate": `Bearer realm="planban", resource_metadata="${publicOrigin()}/.well-known/oauth-protected-resource/mcp", scope="${PLANBAN_SCOPES.join(" ")}"`,
  });
}

export const mcp = httpAction(async (ctx, request) => {
  try {
    const auth = await authenticate(ctx, request);
    if (!auth) return mcpUnauthorized();
    return await handleMcp(request, new McpService(ctx, auth.connectionId), publicOrigin());
  } catch (error) {
    // A credential can be revoked between authentication and the protected query.
    if (error instanceof ConvexError && (error.data as ServiceErrorData).code === "unauthorized") return mcpUnauthorized();
    return errorResponse(error);
  }
});

/** RFC 9728: only our explicit service enrollment can issue resource tokens. */
function protectedResourceFor(path: string) {
  return httpAction(async () => json({
    resource: `${publicOrigin()}${path}`,
    authorization_servers: enrollmentConfigured() ? [publicOrigin()] : [],
    bearer_methods_supported: ["header"],
    scopes_supported: PLANBAN_SCOPES,
    resource_name: "Planban Online",
  }, 200, { "Cache-Control": "public, max-age=300" }));
}

// AI apps require the resource to equal the address they were given exactly,
// so the MCP endpoint has its own document naming /mcp.
const protectedResource = protectedResourceFor("");
const protectedMcpResource = protectedResourceFor("/mcp");


/** Retired unbound Clerk bearer exchange: refresh is not new machine consent. */
export const machineSignIn = httpAction(async () => json({
  error: { code: "unauthorized", message: "Start a new explicit Planban machine authorization. This bearer exchange is retired." },
}, 401));

/** An invite link's secret, from the link itself or just the secret. */
function inviteToken(input: string) {
  const match = /(pbi_[A-Za-z0-9_-]{20,})/.exec(input);
  return match ? match[1]! : "";
}

/**
 * Sends an email invite through Resend when the service is set up for it
 * (RESEND_API_KEY and PLANBAN_INVITE_FROM); otherwise the owner shares the link.
 */
export async function sendInviteEmail(to: string, role: string, link: string, inviteId?: string) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.PLANBAN_INVITE_FROM;
  if (!key || !from) return false;
  let message;
  if (role !== "viewer" && role !== "editor") return false;
  try { message = renderInviteEmail(role, link, publicOrigin()); }
  catch { return false; }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    // One logical invitation is sent at most once, even if this request is retried.
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(inviteId ? { "Idempotency-Key": `planban-invite-${inviteId}` } : {}) },
    body: JSON.stringify({
      from, to: [to], ...message,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  return !!response?.ok;
}

/** A person's verified email addresses, from Clerk now; none if Clerk cannot say (so an email invite is refused). */
async function verifiedEmailsOf(userId: string): Promise<string[]> {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret || !/^user_[A-Za-z0-9]+$/.test(userId)) return [];
  const response = await fetch(`https://api.clerk.com/v1/users/${userId}`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!response?.ok) return [];
  const user = await response.json() as { email_addresses?: Array<{ email_address: string; verification?: { status?: string } | null }> };
  return (user.email_addresses ?? []).filter((address) => address.verification?.status === "verified").map((address) => address.email_address);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/**
 * The web page's invitation preview. The token comes in the body, never the
 * address, so it stays out of logs; nothing is shown for an invitation that
 * can't be used beyond its state.
 */
export const invitePreviewResponse: RouteHandler = async (ctx, request) => {
  const input = await body(request).catch(() => ({} as Record<string, unknown>));
  const token = inviteToken(String(input.token ?? ""));
  const preview = token ? await ctx.runQuery(internal.invites.previewState, { tokenHash: await sha256Hex(token) }) : { state: "unknown" as const };
  return json(preview);
};

/** The page an invite link opens: what it is for, and how to join. */
const invitePageResponse: RouteHandler = async (ctx, request) => {
  const token = inviteToken(new URL(request.url).pathname);
  const invite = token ? await ctx.runQuery(internal.invites.preview, { tokenHash: await sha256Hex(token) }) : null;
  const page = (title: string, body: string) => new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><link rel="icon" href="${FAVICON_DATA_URI}">`
    + `<body style="font:15px/1.55 -apple-system,system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 20px;color:#111"><img src="${WORDMARK_BLACK_DATA_URI}" alt="Planban" height="24" style="display:block;height:24px;width:auto;margin-bottom:28px"><h1 style="font-size:22px">${escapeHtml(title)}</h1>${body}</body>`,
    { status: invite ? 200 : 404, headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex",
      // A static page: no scripts, no framing, nothing loaded from elsewhere.
      "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
    } },
  );
  if (!invite) return page("This invite has expired", "<p>Invite links work for 7 days. Ask the board owner for a new one.</p>");
  const link = `${publicOrigin()}/invite/${token}`;
  return page(`Join ${invite.boardTitle} on Planban`,
    `<p>${escapeHtml(invite.inviterName)} invited you as ${invite.role === "editor" ? "an editor: you can change cards, specs and plans, and mark work complete" : "a viewer: you can read the board and its history"}.${invite.forEmail ? " This invite is for one email address; sign in with it." : ""}</p>`
    + `<p>To join, run this in a terminal on your computer. Planban opens your browser to sign in with your own account:</p>`
    + `<pre style="background:#f4f4f5;padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-all">planban online join ${escapeHtml(link)}</pre>`
    + `<p style="color:#666">The link works until ${escapeHtml(new Date(invite.expiresAt).toUTCString())}.</p>`);
};

/** What a Planban install needs to know to sign in here. */
export const serviceDiscovery = httpAction(async () => json({
  service: "Planban Online",
  resource: publicOrigin(),
  ...(enrollmentConfigured() ? {
    signIn: {
      issuer: publicOrigin(),
      cliClientId: MACHINE_CLIENT_ID,
      redirectPorts: CLI_REDIRECT_PORTS,
      scope: "planban:machine",
    },
  } : {}),
  devSignIn: devAuthEnabled(),
}, 200, { "Cache-Control": "public, max-age=300" }));

export const authorizationServerDiscovery = httpAction(async () => enrollmentConfigured() ? json({
  issuer: publicOrigin(), authorization_endpoint: `${publicOrigin()}/oauth/authorize`,
  planban_machine_start_endpoint: `${publicOrigin()}/oauth/machine/start`,
  planban_machine_cancel_endpoint: `${publicOrigin()}/oauth/machine/cancel`,
  token_endpoint: `${publicOrigin()}/oauth/token`, revocation_endpoint: `${publicOrigin()}/oauth/revoke`,
  // One-tap approval for the Planban command line on machines without a browser callback.
  device_authorization_endpoint: `${publicOrigin()}/oauth/device`,
  // Self-registration is for claude.ai only (owner decision 22).
  registration_endpoint: `${publicOrigin()}/oauth/register`,
  response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
  code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"], scopes_supported: [...PLANBAN_SCOPES, "planban:machine"],
  authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true,
}, 200, { "Cache-Control": "public, max-age=300" }) : json({ error: "temporarily_unavailable" }, 503));

const http = httpRouter();
type RouteHandler = (ctx: ActionCtx, request: Request) => Promise<Response>;

/**
 * Routes that create, exchange or reveal credentials or capability links. A
 * request that didn't arrive through the service address gets a generic
 * refusal that echoes nothing back.
 */
export function atServiceOnly(handler: RouteHandler): RouteHandler {
  return async (ctx, request) => await atServiceAddress(request)
    ? await handler(ctx, request)
    : json({ error: "temporarily_unavailable" }, 503);
}

for (const method of ["GET", "POST", "PUT"] as const) http.route({ pathPrefix: "/api/v1/", method, handler: api });
http.route({ path: "/dev/token", method: "POST", handler: httpAction(atServiceOnly(devTokenResponse)) });
// The web page's browser session: started from a Clerk sign-in, ended by signing out.
http.route({ path: "/web/session", method: "POST", handler: httpAction(atServiceOnly((ctx, request) => webSessionResponse(ctx, request))) });
http.route({ path: "/web/signout", method: "POST", handler: httpAction(atServiceOnly(webSignOutResponse)) });
http.route({ path: "/web/config", method: "GET", handler: httpAction(atServiceOnly(async () => webConfigResponse())) });
http.route({ path: "/web/invite", method: "POST", handler: httpAction(atServiceOnly(invitePreviewResponse)) });
http.route({ path: "/oauth/device", method: "POST", handler: httpAction(atServiceOnly(deviceAuthorizationResponse)) });
for (const method of ["GET", "POST", "DELETE"] as const) http.route({ path: "/mcp", method, handler: mcp });
http.route({ path: "/api/v1/auth/machine", method: "POST", handler: machineSignIn });
http.route({ path: "/oauth/token", method: "POST", handler: httpAction(atServiceOnly(tokenResponse)) });
http.route({ path: "/oauth/revoke", method: "POST", handler: httpAction(atServiceOnly(revocationResponse)) });
http.route({ path: "/oauth/register", method: "POST", handler: httpAction(atServiceOnly(registrationResponse)) });
http.route({ path: "/oauth/authorize", method: "GET", handler: httpAction(atServiceOnly(authorizationResponse)) });
http.route({ path: "/oauth/consent", method: "GET", handler: httpAction(atServiceOnly(consentResponse)) });
http.route({ path: "/oauth/machine/start", method: "POST", handler: httpAction(atServiceOnly(machineStartResponse)) });
http.route({ path: "/oauth/machine/launch", method: "GET", handler: httpAction(atServiceOnly(machineLaunchResponse)) });
http.route({ path: "/oauth/machine/cancel", method: "POST", handler: httpAction(atServiceOnly(machineCancelResponse)) });
http.route({ path: "/oauth/validity", method: "POST", handler: httpAction(atServiceOnly(consentValidityResponse)) });
http.route({ path: "/oauth/approve", method: "POST", handler: httpAction(atServiceOnly(approvalResponse)) });
// Clerk's email.created webhook, straight to the service (signed through Svix): Planban's own sign-in emails.
http.route({ path: "/clerk/webhook", method: "POST", handler: httpAction(async (_ctx, request) => clerkWebhookResponse(request)) });
http.route({ path: "/.well-known/planban.json", method: "GET", handler: serviceDiscovery });
http.route({ path: "/.well-known/oauth-authorization-server", method: "GET", handler: authorizationServerDiscovery });
http.route({ pathPrefix: "/invite/", method: "GET", handler: httpAction(atServiceOnly(invitePageResponse)) });
http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: protectedResource });
http.route({ path: "/.well-known/oauth-protected-resource/mcp", method: "GET", handler: protectedMcpResource });
http.route({
  path: "/.well-known/jwks.json",
  method: "GET",
  handler: httpAction(async () => liveTokensConfigured() ? json(publicJwks(), 200, { "Cache-Control": "public, max-age=300" }) : json({ keys: [] })),
});
// Brand files: favicons for app.planban.ai, and filled icons that AI apps show beside the connector.
for (const file of BRAND_FILES) http.route({ path: file.path, method: "GET", handler: httpAction(async () => brandResponse(file)) });

export default http;
