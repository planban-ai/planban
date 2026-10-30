import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as storage from "../src/core/storage";
import * as domain from "../src/core/boardOperations";
import { historyDocPath, historyIndexPath, historyRoadmapPath, manifestPath } from "../src/core/paths";
import { manifestSchema } from "../src/core/schema";
import { listBoards, registerBoardFromCwd, duplicateBoard } from "../src/core/registry";
import { credentialsRoot, onlineStatus, readCredentials, saveCredentials, serviceUrl } from "../src/core/online/credentials";
import { onlineRequest, OnlineAuthenticationError, PlanbanForbiddenError } from "../src/core/online/client";
import { revokeToken as revokeServiceToken } from "../online/service/convex/oauth";
import { onlineLogin } from "../src/core/online/login";
import { attachOnline, buildLocalBundle, exportOnline, keepLocalCopy, keepSeparateBoard, PlanbanConfirmationNeeded, PlanbanNotReadyForOnline, PlanbanTakeOnlineStopped, restoreBackup, stopTakeOnline, takeLocal, takeOnline, type BoardBundle } from "../src/core/online/transfers";
import { onlineCacheRoot } from "../src/core/online/adapter";
import { PlanbanStaleCopyError, resetCopyChecks, STALE_MARKER } from "../src/core/online/copyCheck";
import { backupRoot, refreshBackup } from "../src/core/online/backup";
import { onlineLogout } from "../src/core/online/connections";
import { moveFilesOut } from "../src/core/moveFilesOut";
import { startServer } from "../src/server/server";
import { planbanCommand } from "../src/core/command";
import { listHistory } from "../src/core/history";
import { checkIndexCard, checkIndexDocument, checkIndexValue } from "../src/core/contentRules";
import type { PlanbanDocPayload, PlanbanRoadmap } from "../src/core/types";
const CMD = planbanCommand().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const execFileAsync = promisify(execFile);
const originalHome = process.env.PLANBAN_HOME;
let root: string;
let cwd: string;
let fake: Awaited<ReturnType<typeof fakeService>>;

async function readBytes(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text;
}

async function fakeService() {
  let url = "";
  let accessToken = "access-0";
  let refreshToken = "refresh-0";
  let refreshes = 0;
  let beforeDocRead: (() => Promise<void>) | null = null;
  let auth: URL | undefined;
  let registration: any;
  let bundle: BoardBundle | undefined;
  let authority = "online";
  let rejectRefresh = false;
  let rejectAccess = false;
  let failExport = false;
  let metadataOrigin: string | undefined;
  let loginTokenOverride: Record<string, unknown> | undefined;
  let leaseMs = 300000;
  const issuedMachines: any[] = [{ _id: "unrelated", kind: "machine", tokenHash: "unrelated" }];
  let beforeFence: (() => void) | undefined;
  const docs = new Map<string, PlanbanDocPayload>();
  const transfers = new Map<string, { begin: any; parts: Map<number, any>; state: "open" | "committed" | "aborted" }>();
  const replies = new Map<string, unknown>();
  let dropNextReply = false;
  let failLiveToken = false;
  const revoked: string[] = [];
  let failCopyCheck = false;
  let localTransfer: string | undefined;
  const revokedTokens = new Set<string>();
  let failExportDocs = false;
  let boardUid: string | undefined;
  const attachments = new Map<string, any>();
  const blobs = new Map<string, Buffer>();
  const members = [{ userId: "dev-owner", role: "owner" }];
  let failParts = false;
  let failAbort = false;
  let slowPartsMs = 0;
  let failNextBoardRead = false;
  let dropFenceReply = false;
  let limitNextOp = false;
  let onMe: (() => Promise<void> | void) | undefined;
  const uploads = new Map<string, Buffer>();
  const sessions = new Map<string, any>();
  const requests: { method: string; path: string; body: any }[] = [];
  const errors: Error[] = [];
  const server = createServer(async (req, res) => {
    try {
      const request = new URL(req.url!, url);
      const path = request.pathname;
      const rawBytes = await readBytes(req);
      const raw = rawBytes.toString("utf8");
      const body = raw && req.method !== "PUT" ? (req.headers["content-type"]?.includes("application/json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : undefined;
      requests.push({ method: req.method!, path, body });
      const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      // The fake implements Planban's explicit service-owned enrollment.
      if (path === "/.well-known/planban.json") return json(200, { signIn: { issuer: url, cliClientId: "planban-cli", redirectPorts: [53682, 53683, 53684, 53685, 53686], scope: "planban:machine" } });
      if (path === "/.well-known/oauth-authorization-server") return json(200, {
        issuer: url, token_endpoint: `${metadataOrigin ?? url}/oauth/token`, authorization_endpoint: `${metadataOrigin ?? url}/authorize`,
        revocation_endpoint: `${metadataOrigin ?? url}/oauth/revoke`, code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        planban_machine_start_endpoint: `${metadataOrigin ?? url}/oauth/machine/start`, planban_machine_cancel_endpoint: `${metadataOrigin ?? url}/oauth/machine/cancel`,
      });
      if (path === "/oauth/machine/start") {
        auth = new URL(url + "/authorize?" + new URLSearchParams(body));
        const launch = "pbl_" + "l".repeat(43);
        // One clock reading, so the lease is exactly leaseMs long (two readings could make it a millisecond too long).
        const serverNow = Date.now();
        return json(200, { launch, launchUrl: url + "/oauth/machine/launch?launch=" + launch, serverNow, expiresAt: serverNow + leaseMs });
      }
      if (path === "/oauth/machine/cancel") return json(200, { ended: true });
      if (path === "/oauth/machine/launch" && req.method === "GET") {
        // A browser that is already signed in: straight back to the callback.
        assert.ok(auth);
        assert.equal(auth.searchParams.get("client_id"), "planban-cli");
        assert.equal(auth.searchParams.get("resource"), url);
        assert.equal(auth.searchParams.get("scope"), "planban:machine");
        assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
        assert.match(auth.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:5368[2-6]\/callback$/);
        const callback = new URL(auth.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ code: "test-code", state: auth.searchParams.get("state")!, iss: url }).toString();
        res.writeHead(302, { Location: callback.href });
        return res.end();
      }
      if (path === "/oauth/token") {
        assert.equal(body.client_id, "planban-cli");
        if (body.grant_type === "refresh_token") {
          assert.equal(body.resource, url);
          refreshes++;
          if (rejectRefresh || body.refresh_token !== refreshToken) return json(400, { error: "invalid_grant" });
        } else {
          assert.equal(body.code, "test-code");
          assert.equal(body.redirect_uri, auth!.searchParams.get("redirect_uri"));
          assert.equal(body.resource, url);
          assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), auth!.searchParams.get("code_challenge"));
          accessToken = "pbm_" + "m".repeat(43);
          issuedMachines.push({ _id: "issued", kind: "machine", tokenHash: createHash("sha256").update(accessToken).digest("hex"), authorizationVersion: 2, oauthClientId: "planban-cli", oauthPending: false });
          return json(200, loginTokenOverride ?? { access_token: accessToken, token_type: "Bearer", scope: "planban:machine", user_id: "dev-owner", expires_in: 90 * 86400 });
        }
        accessToken = `access-${requests.length}`;
        refreshToken = `refresh-${requests.length}`;
        return json(200, { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 });
      }
      if (path === "/oauth/revoke") {
        revoked.push(body.token);
        const db: any = { patch: async (id: string, fields: any) => Object.assign(issuedMachines.find(r => r._id === id), fields), get: async (id: string) => issuedMachines.find(r => r._id === id), query: (table: string) => {
          let tokenHash: string; const query: any = { withIndex: (_name: string, build: any) => { build({ eq: (_key: string, value: string) => { tokenHash = value; } }); return query; }, unique: async () => table === "connections" ? issuedMachines.find(r => r.tokenHash === tokenHash) ?? null : null }; return query;
        } };
        await (revokeServiceToken as any)._handler({ db }, { tokenHash: createHash("sha256").update(body.token).digest("hex"), clientId: body.client_id });
        return json(200, {});
      }
      if (path === "/api/v1/auth/machine") {
        return json(401, { error: { code: "unauthorized", message: "Bearer exchange is retired." } });
      }
      // A second account, which sees none of the first one's uploads.
      if (req.headers.authorization === "Bearer pbm_other-account") {
        if (path === "/api/v1/me") return json(200, { userId: "someone-else" });
        return json(404, { error: { code: "not_found", message: "Upload not found." } });
      }
      if (rejectAccess || req.headers.authorization !== `Bearer ${accessToken}`) {
        res.setHeader("WWW-Authenticate", 'Bearer resource_metadata="' + url + '/.well-known/oauth-protected-resource"');
        return json(401, { error: "unauthorized" });
      }
      if (path === "/api/v1/me") {
        await onMe?.();
        return json(200, { userId: "dev-owner", scope: "all" });
      }
      if (path === "/api/v1/connections/self/revoke") {
        revokedTokens.add(String(req.headers.authorization));
        return json(200, { revoked: true });
      }
      if (path === "/api/v1/copy-check") {
        if (failCopyCheck) return json(503, { error: { code: "unavailable", message: "Down for maintenance." } });
        if (!bundle || authority !== "online") return json(200, { matches: [] });
        const matchedVersions = body.fingerprints
          .filter((print: any) => bundle!.history.some(({ entry }) => entry.version === print.version && entry.createdAt === print.createdAt && entry.operation === print.operation))
          .map((print: any) => print.version);
        // Like the service: the same identity, or at least two shared entries.
        const identified = !!body.uid && body.uid === boardUid;
        const found = identified || matchedVersions.length >= Math.min(2, body.fingerprints.length);
        return json(200, { matches: found ? [{ boardId: "demo", title: bundle.roadmap.project.title, onlineSince: "2026-10-11T12:00:00.000Z", matchedVersions }] : [] });
      }
      if (path === "/api/v1/live-token" && failLiveToken) return json(503, { error: { code: "unavailable", message: "Live updates are down." } });
      if (path.startsWith("/error/")) return json(Number(path.split("/")[2]), { error: { code: "fixture", message: "Fixture refusal", currentRevision: 19 } });
      const importBundle = (input: BoardBundle) => {
        assert.equal(input.roadmap.project.id, "demo");
        bundle = structuredClone(input);
        authority = "online";
        bundle!.roadmap = domain.committedRoadmap(domain.normalizeRoadmap(bundle!.roadmap), new Date().toISOString());
        const version = Math.max(0, ...bundle!.history.map(({ entry }) => entry.version)) + 1;
        bundle!.history.push({ entry: { version, roadmapRevision: bundle!.roadmap.revision, createdAt: new Date().toISOString(), actor: "import", operation: "board.import", summary: "Imported board", affectedCards: [], affectedDocs: [] }, roadmap: structuredClone(bundle!.roadmap) });
        docs.clear();
        for (const doc of bundle!.docs) docs.set(`${doc.cardId}/${doc.kind}`, { ...doc, exists: true, path: `items/${doc.cardId}/${doc.kind}.md`, mtimeMs: 1 });
        return { boardId: "demo", roadmap: bundle!.roadmap };
      };
      if (path === "/api/v1/boards/import") {
        if (bundle && authority !== "returned-local") return json(409, { error: { code: "conflict", message: "Board exists" } });
        return json(201, importBundle(body));
      }
      if (path === "/api/v1/transfers") {
        const existing = transfers.get(body.transferId);
        if (existing) return json(200, { state: existing.state, receivedParts: [...existing.parts.keys()] });
        if (bundle && authority !== "returned-local") return json(409, { error: { code: "conflict", message: "Board exists" } });
        transfers.set(body.transferId, { begin: body, parts: new Map(), state: "open" });
        if (body.uid) boardUid = body.uid;
        return json(200, { state: "open", receivedParts: [] });
      }
      if (path.startsWith("/api/v1/transfers/")) {
        const [, , , , transferId, step] = path.split("/");
        const transfer = transfers.get(decodeURIComponent(transferId!));
        if (!transfer) return json(404, { error: { code: "not_found", message: "Upload not found." } });
        if (step === "parts") {
          if (failParts) return json(503, { error: { code: "unavailable", message: "The service is busy." } });
          if (slowPartsMs) await new Promise((resolve) => setTimeout(resolve, slowPartsMs));
          if (transfer.state === "open") transfer.parts.set(body.seq, body);
          return json(200, { duplicate: false });
        }
        if (step === "abort") {
          if (failAbort) return json(503, { error: { code: "unavailable", message: "The service is busy." } });
          if (transfer.state === "committed") return json(409, { error: { code: "conflict", message: "This upload already finished." } });
          transfer.state = "aborted";
          return json(200, { state: "aborted" });
        }
        if (step === "commit") {
          if (transfer.state === "committed") return json(200, { boardId: "demo", roadmap: bundle!.roadmap });
          if (transfer.parts.size !== body.partCount) return json(400, { error: { code: "validation", message: "The upload is incomplete." } });
          const parts = [...transfer.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
          const result = importBundle({
            format: "planban-board-bundle", version: 1, roadmap: transfer.begin.roadmap, retiredIds: transfer.begin.retiredIds,
            ...(transfer.begin.retention ? { retention: transfer.begin.retention } : {}),
            docs: parts.flatMap((part) => part.docs ?? []), history: parts.flatMap((part) => part.history ?? []), historyDocs: parts.flatMap((part) => part.historyDocs ?? []),
          } as BoardBundle);
          transfer.state = "committed";
          return json(200, result);
        }
      }
      if (!bundle || !path.startsWith("/api/v1/boards/demo")) return json(404, { error: { code: "not_found", message: "Board not found" } });
      const roadmap = () => domain.normalizeRoadmap(bundle!.roadmap);
      const suffix = path.slice("/api/v1/boards/demo".length);
      if (!suffix && failNextBoardRead) {
        failNextBoardRead = false;
        return json(503, { error: { code: "unavailable", message: "The service is busy." } });
      }
      if (!suffix) {
        // Like the service: a reader that already has this revision is told so.
        const since = request.searchParams.get("since");
        if (since !== null && Number(since) === roadmap().revision) return json(200, { unchanged: true, revision: roadmap().revision, authority });
        return json(200, { roadmap: roadmap(), authority });
      }
      if (suffix === "/changes") return json(200, { revision: roadmap().revision });
      if (suffix === "/export/meta") {
        if (failExport) return json(500, { error: { message: "Export interrupted" } });
        return json(200, { format: "planban-board-bundle", version: 1, roadmap: bundle.roadmap, retiredIds: bundle.retiredIds ?? [], historyVersions: bundle.history.map(({ entry }) => entry.version), ...(bundle.retention ? { retention: bundle.retention } : {}) });
      }
      if (suffix === "/export/docs") {
        if (failExportDocs) return json(500, { error: { message: "Export interrupted" } });
        const all = [...docs.values()].map(({ cardId, kind, markdown }) => ({ cardId, kind, markdown }));
        const offset = Number(request.searchParams.get("offset") ?? 0);
        return json(200, offset === 0 ? { docs: all, nextOffset: null } : { docs: [], nextOffset: null });
      }
      if (suffix === "/export/history") {
        const after = Number(request.searchParams.get("after") ?? 0);
        const limit = Number(request.searchParams.get("limit") ?? 8);
        const page = bundle.history.filter(({ entry }) => entry.version > after).sort((a, b) => a.entry.version - b.entry.version).slice(0, limit);
        const versions = new Set(page.map(({ entry }) => entry.version));
        return json(200, { history: page, historyDocs: (bundle.historyDocs ?? []).filter((doc) => versions.has(doc.version)) });
      }
      if (suffix === "/members" && req.method === "GET") return json(200, { members });
      if (suffix === "/take-local/fence") {
        if (localTransfer === body.transferId) return json(200, { generation: 1 });
        if (authority !== "online") return json(409, { error: { code: "conflict", message: "Already being taken local." } });
        beforeFence?.();
        const others = members.filter((member) => member.userId !== "dev-owner").map((member) => member.userId);
        const acknowledged: string[] = body.acknowledgedOthers ?? [];
        if (others.length !== acknowledged.length || others.some((id) => !acknowledged.includes(id))) {
          return json(409, { error: { code: "conflict", message: "The people on this board changed since you confirmed. Confirm again who loses access." } });
        }
        authority = "returned-local";
        localTransfer = body.transferId;
        bundle.roadmap = domain.committedRoadmap(roadmap(), new Date().toISOString());
        members.splice(1);
        if (dropFenceReply) {
          // The freeze happened, but its answer is lost on the network.
          dropFenceReply = false;
          req.socket.destroy();
          return;
        }
        return json(200, { generation: 1 });
      }
      if (suffix === "/take-local/finish") {
        if (localTransfer === body.transferId) localTransfer = undefined;
        return json(200, { finished: true });
      }
      if (suffix === "/history") return json(200, { currentVersion: Math.max(...bundle.history.map(({ entry }) => entry.version)), retention: { boardVersions: 100, cardVersions: 25, documentVersions: 25, hourlyDays: 2, maxAgeDays: 90 }, entries: bundle.history.map(({ entry }) => entry).filter((entry) => entry.version > Number(request.searchParams.get("after") ?? 0)).reverse() });
      if (suffix === "/attachments" && req.method === "GET") return json(200, { attachments: [...attachments.values()] });
      if (suffix === "/attachments/begin" || suffix === "/attachments/finish") {
        if (suffix === "/attachments/begin" && !blobs.has(body.sha256)) {
          const uploadId = `upload-${sessions.size + 1}`;
          sessions.set(uploadId, { ...body, parts: new Map<number, Buffer>() });
          return json(200, { done: false, uploadId, partBytes: 4, partCount: Math.max(1, Math.ceil(body.size / 4)) });
        }
        let file = body;
        if (suffix === "/attachments/finish") {
          file = sessions.get(body.uploadId);
          const uploaded = file && Buffer.concat([...file.parts.entries()].sort(([a]: [number], [b]: [number]) => a - b).map(([, part]: [number, Buffer]) => part));
          if (!file || !uploaded || createHash("sha256").update(uploaded).digest("hex") !== file.sha256) return json(400, { error: { code: "validation", message: "Upload mismatch." } });
          blobs.set(file.sha256, uploaded);
        }
        const id = `att-${file.cardId}-${file.path}`;
        const record = { id, cardId: file.cardId, path: file.path, sha256: file.sha256, size: file.size, contentType: file.contentType, uploadedBy: "dev-owner", uploadedAt: new Date().toISOString() };
        attachments.set(id, record);
        return json(200, { done: true, attachment: record });
      }
      if (suffix.startsWith("/attachments/uploads/") && req.method === "PUT") {
        const [, , , uploadId, , index] = suffix.split("/");
        sessions.get(uploadId!)?.parts.set(Number(index), Buffer.from(rawBytes));
        return json(200, { stored: true });
      }
      if (suffix.startsWith("/attachments/") && req.method === "GET") {
        const record = attachments.get(decodeURIComponent(suffix.split("/")[2]!));
        if (!record) return json(404, { error: { code: "not_found", message: "Attachment not found." } });
        res.writeHead(200, { "Content-Type": record.contentType });
        res.end(blobs.get(record.sha256));
        return;
      }
      if (suffix.startsWith("/docs/")) {
        const [, , cardId, kind] = suffix.split("/").map(decodeURIComponent);
        // A test can change the board while a document is being read.
        if (beforeDocRead) { const run = beforeDocRead; beforeDocRead = null; await run(); }
        return json(200, docs.get(`${cardId}/${kind}`) ?? { cardId, kind, exists: false, path: null, markdown: "", mtimeMs: null });
      }
      if (suffix.startsWith("/ops/")) {
        assert.equal("cwd" in body, false);
        if (authority !== "online") return json(409, { error: { code: "conflict", message: "Board has returned to local authority" } });
        const op = suffix.split("/").at(-1)!;
        const key = req.headers["idempotency-key"] as string | undefined;
        if (key && replies.has(key)) return json(200, replies.get(key));
        // Like the hosted service: every edit states its base version.
        if (op === "writeDoc" ? body.expectedMtimeMs === undefined : typeof body.baseRevision !== "number") {
          return json(400, { error: { code: "validation", message: "Online Board edits must state the version they were based on (baseRevision).", currentRevision: roadmap().revision } });
        }
        if (body.baseRevision !== undefined) domain.assertBaseRevision(roadmap(), body.baseRevision);
        const context = { now: new Date().toISOString() };
        let result: Record<string, unknown> = {};
        let change: domain.PlannedChange;
        if (op === "writeDoc") {
          const planned = domain.planWriteDoc(roadmap(), body, context);
          const existing = docs.get(`${body.cardId}/${body.kind}`);
          if (body.expectedMtimeMs !== undefined && body.expectedMtimeMs !== (existing?.mtimeMs ?? null)) throw new domain.PlanbanConflictError("Document changed online.");
          const doc = { cardId: body.cardId, kind: body.kind, path: planned.path, markdown: body.markdown, exists: true, mtimeMs: (existing?.mtimeMs ?? 0) + 1 };
          docs.set(`${body.cardId}/${body.kind}`, doc);
          result = { doc };
          change = { roadmap: planned.roadmap ?? roadmap(), history: planned.history, docWrites: [] };
        } else {
          const planners: Record<string, Function> = { createCard: domain.planCreateCard, createGroup: domain.planCreateGroup, createCards: domain.planCreateCards, moveCard: domain.planMoveCard, updateCard: domain.planUpdateCard, deleteArchivedCard: domain.planDeleteArchivedCard, reorderCards: domain.planReorderCards };
          change = planners[op]!(roadmap(), body, context);
          if (op === "createCard") result = { createdCard: change.roadmap.roadmapItems.find((item) => item.id === (change as any).cardId) };
          if (op === "createGroup") result = { createdGroup: change.roadmap.roadmapItems.find((item) => item.id === (change as any).groupId) };
          if (op === "createCards") result = { createdCards: change.roadmap.roadmapItems.filter((item) => (change as any).cardIds.includes(item.id)) };
          for (const doc of change.docWrites) docs.set(`${doc.cardId}/${doc.kind}`, { ...doc, exists: true, mtimeMs: 1 });
          if (op === "deleteArchivedCard") for (const key of docs.keys()) if (key.startsWith(`${body.cardId}/`)) docs.delete(key);
        }
        bundle.roadmap = domain.committedRoadmap(change.roadmap, context.now);
        const version = Math.max(...bundle.history.map(({ entry }) => entry.version)) + 1;
        bundle.history.push({ entry: { ...change.history, affectedDocs: change.history.affectedDocs ?? [], version, roadmapRevision: bundle.roadmap.revision, createdAt: context.now }, roadmap: structuredClone(bundle.roadmap) });
        if (key) replies.set(key, { roadmap: bundle.roadmap, result });
        if (limitNextOp) {
          limitNextOp = false;
          return json(429, { error: { code: "rate_limited", message: "This account has reached today's limit of 5,000 changes or 64 MB of written text on Planban Online. It resets at midnight UTC." } });
        }
        if (dropNextReply) {
          // Simulates a response lost on the network after the edit committed.
          dropNextReply = false;
          req.socket.destroy();
          return;
        }
        return json(200, { roadmap: bundle.roadmap, result });
      }
      json(404, { error: { code: "not_found", message: "Unknown endpoint" } });
    } catch (error) {
      const status = error instanceof domain.PlanbanConflictError ? 409 : error instanceof domain.PlanbanValidationError ? 400 : error instanceof domain.PlanbanNotFoundError ? 404 : 500;
      if (status === 500) errors.push(error as Error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: status === 409 ? "conflict" : "validation", message: (error as Error).message } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    url, requests, errors, issuedMachines, get refreshes() { return refreshes; }, set beforeDocRead(run: (() => Promise<void>) | null) { beforeDocRead = run; }, get bundle() { return bundle!; }, get authority() { return authority; },
    setMachineLease(ms: number) { leaseMs = ms; },
    setLoginTokenResponse(value: Record<string, unknown>) { loginTokenOverride = value; },
    expireAccess() { accessToken = "expired"; }, rejectRefresh() { rejectRefresh = true; }, rejectAccess() { rejectAccess = true; },
    failExport(value: boolean) { failExport = value; }, setMetadataOrigin(value: string) { metadataOrigin = value; },
    beforeFence(fn: () => void) { beforeFence = fn; }, dropNextReply() { dropNextReply = true; }, failLiveToken() { failLiveToken = true; }, revoked, members, failParts(value: boolean) { failParts = value; }, failAbort(value: boolean) { failAbort = value; }, slowParts(ms: number) { slowPartsMs = ms; }, failNextBoardRead() { failNextBoardRead = true; }, dropFenceReply() { dropFenceReply = true; }, limitNextOp() { limitNextOp = true; }, onMe(fn: (() => Promise<void> | void) | undefined) { onMe = fn; }, failCopyCheck(value: boolean) { failCopyCheck = value; }, transfers, revokedTokens, attachments, blobs, failExportDocs(value: boolean) { failExportDocs = value; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-online-"));
  process.env.PLANBAN_HOME = join(root, "home");
  process.env.PLANBAN_ONLINE_TEST_PASSWORD = "test-password";
  cwd = join(root, "repo");
  fake = await fakeService();
  await storage.initializeProject({ cwd, repoId: "demo", title: "Demo board", updateAgents: false });
  await storage.createCard({ cwd, title: "Alpha", specMarkdown: "# Original spec", planMarkdown: "# Original plan" });
  await saveCredentials(fake.url, { clientId: "cli", accessToken: "access-0", refreshToken: "refresh-0", expiresAt: new Date(Date.now() + 3600_000).toISOString(), person: "dev-owner" });
});

test.afterEach(async () => {
  await fake.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.env.PLANBAN_HOME = originalHome;
  delete process.env.PLANBAN_ONLINE_TEST_PASSWORD;
  assert.deepEqual(fake.errors, []);
});

test("online manifest accepts origins without secrets and rejects unsafe origins", () => {
  for (const url of ["https://example.com", "http://localhost:8787", fake.url]) {
    assert.equal(manifestSchema.parse({ version: 1, enabled: true, repoId: "demo", storage: { kind: "online", url, boardId: "demo" } }).storage?.kind, "online");
  }
  for (const url of ["http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com?token=secret"]) {
    assert.throws(() => serviceUrl(url));
    assert.equal(manifestSchema.safeParse({ version: 1, enabled: true, repoId: "demo", storage: { kind: "online", url, boardId: "demo" } }).success, false);
  }
});

test("browser sign-in uses the service's sign-in server with PKCE, then keeps only this machine's own sign-in", async () => {
  await saveCredentials(fake.url, null);
  const result = await onlineLogin(fake.url, { openBrowser: async (authorizeUrl) => {
    const toCallback = (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!;
    const forged = new URL(toCallback);
    forged.searchParams.set("state", "wrong");
    assert.equal((await fetch(forged)).status, 400, "a callback with another state is refused");
    assert.equal((await fetch(toCallback)).status, 200);
  } });
  assert.equal(result.signedIn, true);
  const credentials = (await readCredentials()).services[fake.url]!;
  assert.equal(credentials.accessToken, "pbm_" + "m".repeat(43));
  assert.equal(credentials.refreshToken, "");
  assert.deepEqual(fake.revoked, [], "no provider access or refresh token participates");
  assert.equal(fake.requests.some(({ path }) => path === "/api/v1/auth/machine"), false, "retired exchange is never called");
  // Windows has no owner-only file modes.
  if (process.platform !== "win32") assert.equal((await stat(join(credentialsRoot(), "credentials.json"))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(await onlineStatus()).includes("machine-token"), false);
});





test("machine wait closes a hanging opener and sends PKCE-owned cancellation without saving credentials", async () => {
  await saveCredentials(fake.url, null);
  fake.setMachineLease(80);
  const started = performance.now();
  await assert.rejects(onlineLogin(fake.url, { openBrowser: async () => new Promise<void>(() => {}) }), /timed out/);
  assert.ok(performance.now() - started < 2000);
  const start = fake.requests.find(r => r.path === "/oauth/machine/start")!;
  const cancel = fake.requests.find(r => r.path === "/oauth/machine/cancel")!;
  assert.equal(createHash("sha256").update(cancel.body.code_verifier).digest("base64url"), start.body.code_challenge);
  assert.equal((await readCredentials()).services[fake.url], undefined);
  assert.equal(fake.requests.some(r => r.path === "/oauth/revoke"), false);
});

test("failed credential save invokes real machine revocation and preserves existing file and independent machine", async () => {
  const file = join(credentialsRoot(), "credentials.json"), original = "malformed existing private fixture file";
  await writeFile(file, original);
  await assert.rejects(onlineLogin(fake.url, { switchAccount: true, openBrowser: async (url) => { await fetch((await fetch(url, { redirect: "manual" })).headers.get("location")!); } }));
  assert.equal(await readFile(file, "utf8"), original);
  assert.ok(fake.issuedMachines.find(r => r._id === "issued").revokedAt);
  assert.equal(fake.issuedMachines.find(r => r._id === "unrelated").revokedAt, undefined);
});

test("actual hung browser-opening child does not keep the CLI process alive after its lease ends", async () => {
  fake.setMachineLease(150);
  const pidFile = join(root, "owned-opener.pid");
  const script = `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {writeFileSync} from 'node:fs';
    const actualSpawn=cp.spawn; cp.spawn=()=>{ const child=actualSpawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync(process.env.OPENER_PID_FILE,String(child.pid)); return child; }; syncBuiltinESMExports();
    const {onlineLogin}=await import('./src/core/online/login.ts'); try { await onlineLogin(process.env.FIXTURE_URL, { switchAccount: true }); process.exitCode=3; } catch(error) { if(!String(error).includes('timed out')) throw error; }`;
  try {
    await execFileAsync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], { env: { ...process.env, FIXTURE_URL: fake.url, OPENER_PID_FILE: pidFile }, timeout: 4000 });
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), "owned opening child must be terminated");
  } finally {
    const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if(pid) try { process.kill(pid, "SIGKILL"); } catch {}
  }
});

test("malformed machine lease fails before browser opening and leaves existing credentials untouched", async () => {
  const before = await readCredentials(); fake.setMachineLease(300001);
  await assert.rejects(onlineLogin(fake.url, { switchAccount: true, openBrowser: async () => assert.fail("invalid lease opened browser") }), /valid bounded/);
  assert.deepEqual(await readCredentials(), before);
});

test("board-limited access is refused for browser sign-in, which always gives the machine full access", async () => {
  await assert.rejects(() => onlineLogin("http://127.0.0.1:1", { access: "board", boards: "demo" }), /only to development sign-in/);
  await assert.rejects(() => onlineLogin("http://127.0.0.1:1", { boards: "demo" }), /only to development sign-in/);
});

test("CLI refuses provider, wrong-purpose or refreshing tokens before saving credentials", async () => {
  for (const tokens of [
    { access_token: "old.clerk.jwt", token_type: "Bearer", scope: "planban:machine" },
    { access_token: "pba_" + "a".repeat(43), token_type: "Bearer", scope: "planban:machine" },
    { access_token: "pbm_" + "a".repeat(43), token_type: "Bearer", scope: "planban:read" },
    { access_token: "pbm_" + "a".repeat(43), token_type: "Bearer", scope: "planban:machine", refresh_token: "pbr_" + "r".repeat(43) },
  ]) {
    await saveCredentials(fake.url, null);
    fake.setLoginTokenResponse(tokens);
    await assert.rejects(onlineLogin(fake.url, { openBrowser: async (authorizeUrl) => { await fetch((await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!); } }), /machine's own Planban sign-in/);
    assert.equal((await readCredentials()).services[fake.url], undefined);
  }
  assert.equal(fake.requests.some(({ path }) => path === "/api/v1/auth/machine"), false);
});

test("the sign-in server's endpoints must belong to it", async () => {
  fake.setMetadataOrigin("https://other.example");
  await assert.rejects(onlineLogin(fake.url, { switchAccount: true, openBrowser: async () => assert.fail("no browser should open") }), /must belong to it/);
  assert.equal(fake.requests.some((req) => req.path === "/oauth/token"), false);
});

test("dispatch preserves state and result shapes for all card operations", async () => {
  await takeOnline(fake.url, cwd);
  const initial = await storage.loadState(cwd);
  assert.equal(initial.manifest.storage?.kind, "online");
  assert.equal(initial.roadmapPath.endsWith("snapshot.json"), true);
  assert.equal(await storage.pathExists(join(initial.planningRoot, "roadmap.json")), false);
  const moved = await storage.moveCard({ cwd, cardId: "alpha", status: "up-next", baseRevision: initial.roadmap.revision });
  assert.equal(moved.roadmap.roadmapItems[0]?.status, "up-next");
  const updated = await storage.updateCard({ cwd, cardId: "alpha", summary: "Shared summary", metadata: { source: "test" }, baseRevision: moved.roadmap.revision });
  assert.equal(updated.roadmap.roadmapItems[0]?.summary, "Shared summary");
  const rev = async () => (await storage.loadState(cwd)).roadmap.revision;
  const created = await storage.createCard({ cwd, title: "Beta", status: "pending", baseRevision: await rev() });
  assert.equal(created.createdCard.id, "beta");
  const group = await storage.createGroup({ cwd, title: "Group", summary: "Shared objective", baseRevision: await rev() });
  assert.equal(group.createdGroup.isGroup, true);
  const children = await storage.createCards({ cwd, titles: ["Child one", "Child two"], parentId: group.createdGroup.id, baseRevision: await rev() });
  assert.equal(children.createdCards.length, 2);
  const parented = await storage.setCardParent({ cwd, cardId: "beta", parentId: group.createdGroup.id, baseRevision: await rev() });
  assert.equal(parented.roadmap.roadmapItems.find((item) => item.id === "beta")?.parentId, group.createdGroup.id);
  await storage.setCardParent({ cwd, cardId: "beta", parentId: null, baseRevision: await rev() });
  await storage.reorderCards({ cwd, items: (await storage.loadState(cwd)).roadmap.roadmapItems.map(({ id, status }) => ({ id, status })).reverse(), baseRevision: await rev() });
  await storage.setCardStatus(cwd, "beta", "archived", await rev());
  const deleted = await storage.deleteArchivedCard({ cwd, cardId: "beta", baseRevision: await rev() });
  assert.equal(deleted.roadmap.roadmapItems.some((item) => item.id === "beta"), false);
  assert.ok((await storage.historyPayload(cwd)).entries.length > 2);
});

test("documents preserve online stamps and stale roadmap or document edits conflict", async () => {
  await takeOnline(fake.url, cwd);
  const doc = await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" });
  assert.equal(doc.markdown, "# Original spec");
  const saved = await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Shared spec", expectedMtimeMs: doc.mtimeMs });
  assert.equal(saved.mtimeMs, 2);
  assert.equal((await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown, "# Shared spec");
  await assert.rejects(storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "stale", expectedMtimeMs: doc.mtimeMs }), storage.PlanbanConflictError);
  await assert.rejects(storage.moveCard({ cwd, cardId: "alpha", status: "up-next", baseRevision: 0 }), storage.PlanbanConflictError);
});

test("hosted errors retain domain classes, access status and revision details", async () => {
  for (const [status, type] of [[400, storage.PlanbanValidationError], [404, storage.PlanbanNotFoundError], [409, storage.PlanbanConflictError], [403, PlanbanForbiddenError]] as const) {
    await assert.rejects(onlineRequest(fake.url, `/error/${status}`), (error: any) => error instanceof type && (status !== 409 || error.currentRevision === 19));
  }
});

test("take-online sends every retained roadmap and current and historical document body", async () => {
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Second spec" });
  const before = await storage.loadState(cwd);
  const expected = await buildLocalBundle(cwd);
  const result = await takeOnline(fake.url, cwd);
  // Reassemble what was uploaded in parts.
  const begin = fake.requests.find((req) => req.path === "/api/v1/transfers")!.body;
  const parts = fake.requests.filter((req) => req.path.endsWith("/parts")).map((req) => req.body).sort((a, b) => a.seq - b.seq);
  const imported = {
    format: expected.format, version: expected.version, roadmap: begin.roadmap,
    docs: parts.flatMap((part) => part.docs ?? []), history: parts.flatMap((part) => part.history ?? []),
    historyDocs: parts.flatMap((part) => part.historyDocs ?? []), retention: begin.retention,
  };
  const byVersion = <T extends { version: number; cardId: string; kind: string }>(docs: T[]) => [...docs].sort((a, b) => a.version - b.version || a.cardId.localeCompare(b.cardId) || a.kind.localeCompare(b.kind));
  assert.deepEqual({ ...imported, historyDocs: byVersion(imported.historyDocs) }, {
    ...expected, history: [...expected.history].sort((a, b) => a.entry.version - b.entry.version), historyDocs: byVersion(expected.historyDocs ?? []),
  });
  assert.equal(imported.roadmap.project.id, "demo");
  assert.equal(expected.docs.length, 2);
  assert.ok(expected.historyDocs!.some((doc) => doc.markdown === "# Original spec"));
  assert.ok(expected.historyDocs!.some((doc) => doc.markdown === "# Second spec"));
  for (const version of expected.history) assert.deepEqual(version.roadmap, JSON.parse(await readFile(historyRoadmapPath(before.planningRoot, version.entry.version), "utf8")));
  assert.deepEqual(JSON.parse(await readFile(result.localSnapshot, "utf8")), before.roadmap);
  // The live board is set aside; what is left there stops older Planban versions using it.
  assert.equal(await readFile(before.roadmapPath, "utf8"), storage.RETIRED_ROADMAP);
  assert.equal((await storage.loadState(cwd)).roadmap.revision, before.roadmap.revision + 1);
});

test("take-local fences before export, preserves history docs and can re-take online", async () => {
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Later spec" });
  const bundleBefore = await buildLocalBundle(cwd);
  await takeOnline(fake.url, cwd);
  fake.beforeFence(() => { fake.bundle.roadmap.roadmapItems[0]!.summary = "Last remote edit"; });
  const start = fake.requests.length;
  const returned = await takeLocal(cwd);
  const calls = fake.requests.slice(start).filter((req) => req.path.endsWith("/fence") || req.path.includes("/export/"));
  assert.deepEqual(calls.slice(0, 2).map((req) => req.path.split("/").at(-1)), ["fence", "meta"]);
  assert.equal(fake.authority, "returned-local");
  const local = await storage.loadState(cwd);
  assert.equal(local.manifest.storage?.kind, "local");
  assert.equal(local.roadmap.roadmapItems[0]!.summary, "Last remote edit");
  assert.equal((await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown, "# Later spec");
  for (const doc of bundleBefore.historyDocs!) assert.equal(await readFile(historyDocPath(returned.planningRoot, doc.version, doc.cardId, doc.kind), "utf8"), doc.markdown);
  const oldVersion = bundleBefore.historyDocs!.find((doc) => doc.markdown === "# Original spec")!.version;
  assert.equal((await storage.readHistoryDoc({ cwd, version: oldVersion, cardId: "alpha", kind: "spec" })).markdown, "# Original spec");
  await storage.updateCard({ cwd, cardId: "alpha", summary: "Local edit" });
  const revision = (await storage.loadState(cwd)).roadmap.revision;
  await takeOnline(fake.url, cwd);
  assert.equal(fake.authority, "online");
  assert.equal((await storage.loadState(cwd)).roadmap.revision, revision + 1);
});

test("an interrupted take-local keeps the online manifest and can be retried", async () => {
  await takeOnline(fake.url, cwd);
  fake.failExport(true);
  await assert.rejects(takeLocal(cwd), /Export interrupted/);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  assert.equal(fake.authority, "returned-local");
  fake.failExport(false);
  await takeLocal(cwd);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "local");
});

test("attach and registry discovery use remote authority and export writes a bundle", async () => {
  await takeOnline(fake.url, cwd);
  const second = join(root, "second-machine");
  await attachOnline(fake.url, "demo", second);
  assert.equal((await registerBoardFromCwd(second))?.repoId, "demo");
  assert.equal((await listBoards()).find((board) => board.repoId === "demo")?.cwd, second);
  await storage.updateCard({ cwd: second, cardId: "alpha", summary: "Second machine", baseRevision: (await storage.loadState(second)).roadmap.revision });
  assert.equal((await storage.loadState(cwd)).roadmap.roadmapItems[0]!.summary, "Second machine");
  const out = join(root, "bundle.json");
  await execFileAsync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", "online", "export", "--cwd", second, "--out", out], { env: process.env });
  assert.equal(JSON.parse(await readFile(out, "utf8")).format, "planban-board-bundle");
  await assert.rejects(attachOnline(fake.url, "other", second), /already has a different board/);
});

test("tidying an Online Board refuses normal and dry runs before network or file changes", async () => {
  await takeOnline(fake.url, cwd);
  const state = await storage.loadState(cwd);
  const folder = join(state.planningRoot, "items", "alpha");
  await mkdir(folder, { recursive: true });
  const cacheFile = join(folder, "kept.txt");
  await writeFile(cacheFile, "kept in cache");
  const destination = join(root, "moved-out");
  const fetchBefore = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("unexpected network call while tidying"); };
  try {
    for (const dryRun of [false, true]) {
      await assert.rejects(moveFilesOut({ cwd, cardId: "alpha", to: destination, dryRun }),
        (error: unknown) => error instanceof storage.PlanbanValidationError && /not yet available for Online Boards/.test(error.message));
    }
  } finally {
    globalThis.fetch = fetchBefore;
  }
  assert.equal(calls, 0);
  assert.equal(await readFile(cacheFile, "utf8"), "kept in cache");
  assert.equal(await storage.pathExists(destination), false);
});

test("unsupported online file operations refuse rather than using local snapshots", async () => {
  await takeOnline(fake.url, cwd);
  const state = await storage.loadState(cwd);
  for (const run of [
    () => storage.saveRoadmap(state, state.roadmap),
    () => storage.exportFlatVersion1({ cwd, exportId: "backup" }),
    () => storage.reconstructHierarchy({ cwd, groups: [], baseRevision: state.roadmap.revision }),
    () => storage.initializeProject({ cwd }),
    () => duplicateBoard({ sourceRepoId: "demo" }),
  ]) await assert.rejects(run(), (error: any) => error instanceof storage.PlanbanValidationError && /not yet available for Online Boards/.test(error.message));
  fake.rejectAccess();
  await assert.rejects(storage.loadState(cwd), OnlineAuthenticationError);
});

test("Board HTTP API reads and edits online state and signals changes from another machine", async () => {
  await takeOnline(fake.url, cwd);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const state = await (await fetch(`${server.url}/api/boards/demo/state`)).json();
    assert.equal(state.roadmap.roadmapItems[0].id, "alpha");
    const response = await fetch(`${server.url}/api/boards/demo/cards/alpha`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary: "UI edit", baseRevision: state.roadmap.revision }) });
    assert.equal(response.status, 200);
    // Watching only another board must not reach the hosted service.
    await fetch(`${server.url}/api/live?repoId=some-local-board`);
    const before = fake.requests.filter((req) => req.path.endsWith("/changes")).length;
    await new Promise((resolve) => setTimeout(resolve, 3300));
    assert.equal(fake.requests.filter((req) => req.path.endsWith("/changes")).length, before);
    const live = await (await fetch(`${server.url}/api/live?repoId=demo`)).json();
    await storage.updateCard({ cwd, cardId: "alpha", summary: "Other machine edit", baseRevision: (await storage.loadState(cwd)).roadmap.revision });
    await new Promise((resolve) => setTimeout(resolve, 3300));
    const changed = await (await fetch(`${server.url}/api/live?repoId=demo`)).json();
    assert.ok(changed.stateVersion > live.stateVersion);
    assert.ok(fake.requests.some((req) => req.path.endsWith("/changes")));
    const stale = await fetch(`${server.url}/api/boards/demo/cards/alpha`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary: "stale", baseRevision: 0 }) });
    assert.equal(stale.status, 409);
    const draft = await fetch(`${server.url}/api/boards/demo/cards/alpha/codex-thread/draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "codex://threads/new", launchToken: "demo" }) });
    assert.equal(draft.status, 422);
    assert.match((await draft.json()).error, /not yet available for Online Boards/);
  } finally { await server.close(); }
});

test("an Online Board without a sign-in tells the page which service to sign in to, signed out or expired", async () => {
  await takeOnline(fake.url, cwd);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const state = () => fetch(`${server.url}/api/boards/demo/state`);
    // The sign-in has ended: the service refuses this computer's credentials.
    fake.rejectAccess();
    const expired = await state();
    assert.equal(expired.status, 401);
    const expiredBody = await expired.json();
    assert.deepEqual([expiredBody.signInNeeded, expiredBody.signedOut], [serviceUrl(fake.url), "expired"]);
    // Signed out: no credentials on this computer at all.
    await onlineLogout(fake.url);
    const missing = await state();
    assert.equal(missing.status, 401);
    const missingBody = await missing.json();
    assert.deepEqual([missingBody.signInNeeded, missingBody.signedOut], [serviceUrl(fake.url), "missing"]);
    // Agents and terminals still get the command in the message.
    // The board names the account it uses (here one whose email this test sign-in never learned).
    assert.match(missingBody.error, /online sign-in/);
    assert.equal(missingBody.signInCommand, `${planbanCommand()} online sign-in ${serviceUrl(fake.url)}`);
    // The page can only start sign-in for a service this computer already trusts, never one a board's files name.
    const untrusted = await fetch(`${server.url}/api/online/sign-in`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://planban-login.example" }) });
    assert.equal(untrusted.status, 422);
    assert.match((await untrusted.json()).error, /planban-login\.example, which this computer hasn't signed in to before/);
  } finally { await server.close(); }
});

test("local stdio MCP dispatches online reads and mutations", async () => {
  await takeOnline(fake.url, cwd);
  const child = spawn(process.execPath, ["plugins/planban/scripts/start-planban-mcp.mjs"], {
    env: { ...process.env, PLANBAN_REPO_ROOT: resolve("."), PLANBAN_ACTIVITY_URL: fake.url }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP timeout")); }, 10_000);
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr)); });
  });
  child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "planban_update_card", arguments: { cwd, cardId: "alpha", summary: "MCP edit", baseRevision: (await storage.loadState(cwd)).roadmap.revision } } }) + "\n");
  await exit;
  const result = JSON.parse(output.trim()).result;
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal((await storage.loadState(cwd)).roadmap.roadmapItems[0]!.summary, "MCP edit");
});

test("logout removes only the chosen service and missing login never uses local files", async () => {
  await takeOnline(fake.url, cwd);
  await saveCredentials("https://another.example", { clientId: "other", accessToken: "other-token", refreshToken: "other-refresh", expiresAt: new Date().toISOString() });
  await execFileAsync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", "online", "logout", fake.url], { env: process.env });
  assert.equal((await readCredentials()).services[fake.url], undefined);
  assert.ok((await readCredentials()).services["https://another.example"]);
  await assert.rejects(storage.loadState(cwd), OnlineAuthenticationError);
});

test("stale local checkouts cannot edit or reinitialize a transferred planning root", async () => {
  const other = join(root, "stale-checkout");
  await mkdir(join(other, ".planban"), { recursive: true });
  await writeFile(manifestPath(other), await readFile(manifestPath(cwd)));
  await takeOnline(fake.url, cwd);
  await assert.rejects(storage.updateCard({ cwd: other, cardId: "alpha", summary: "stale local edit" }), /roadmap is missing/);
  await assert.rejects(storage.initializeProject({ cwd: other, repoId: "demo", updateAgents: false }), /recovery snapshot/);
  assert.notEqual(fake.bundle.roadmap.roadmapItems[0]!.summary, "stale local edit");
});

test("invalid export paths leave the hosted fence and online manifest intact", async () => {
  await takeOnline(fake.url, cwd);
  fake.bundle.roadmap.roadmapItems[0]!.specDoc = "../../escaped-spec.md";
  await assert.rejects(takeLocal(cwd), /must stay inside/);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  assert.equal(fake.authority, "returned-local");
  assert.equal(await storage.pathExists(join(process.env.PLANBAN_HOME!, "escaped-spec.md")), false);
});

test("export documents cannot replace the local roadmap, history index or lock", async () => {
  await takeOnline(fake.url, cwd);
  for (const path of ["roadmap.json", "history/index.json", ".planban-write.lock/owner.json"]) {
    fake.bundle.roadmap.roadmapItems[0]!.specDoc = path;
    await assert.rejects(takeLocal(cwd), (error: any) => error instanceof storage.PlanbanValidationError && /conflicting document path/.test(error.message));
    assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  }
});

async function killedAt(point: string, args: string[]) {
  const failure = await execFileAsync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", ...args], {
    env: { ...process.env, PLANBAN_TEST_CRASH_AT: point },
  }).then(() => null, (error) => error);
  // Windows has no kill signals; the crash hook exits with code 137 there instead.
  const killed = failure?.signal === "SIGKILL" || (process.platform === "win32" && failure?.code === 137);
  assert.ok(killed, `expected the process to be killed at ${point}: ${failure?.stderr ?? "it finished"}`);
}

test("take-online killed mid-upload leaves the board local, and running it again finishes once", async () => {
  const before = await storage.loadState(cwd);
  await killedAt("take-online:after-part", ["online", "take-online", fake.url, "--cwd", cwd]);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
  assert.equal(await storage.pathExists(before.roadmapPath), true);
  assert.equal([...fake.transfers.values()].some((transfer) => transfer.state === "committed"), false);
  const result = await takeOnline(fake.url, cwd);
  assert.equal(result.boardId, "demo");
  assert.equal([...fake.transfers.values()].filter((transfer) => transfer.state === "committed").length, 1);
  assert.equal(fake.transfers.size, 1, "the resumed upload reuses the same transfer");
  assert.equal((await storage.loadState(cwd)).manifest.storage?.kind, "online");
  assert.equal(await storage.pathExists(join(before.planningRoot, "online-transfer.json")), false);
});

test("take-online killed right after the commit leaves this machine's board shut to every writer; the retry finishes and nothing is lost", async () => {
  const before = await storage.loadState(cwd);
  await killedAt("take-online:after-commit", ["online", "take-online", fake.url, "--cwd", cwd]);
  assert.equal(fake.authority, "online");
  assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
  // The board is online but this project has not switched yet: a local edit now would be lost, so it is refused.
  await assert.rejects(storage.createCard({ cwd, title: "Made after the upload" }), /moving online/);
  // Planban 1.x, which reads roadmap.json itself, cannot use it either.
  assert.throws(() => JSON.parse(readFileSync(before.roadmapPath, "utf8")), /Restart: Planban 2\.0/);
  const result = await takeOnline(fake.url, cwd);
  assert.equal([...fake.transfers.values()].filter((transfer) => transfer.state === "committed").length, 1);
  assert.equal(result.unsyncedLocalChanges, undefined);
  assert.deepEqual(JSON.parse(await readFile(result.localSnapshot, "utf8")), before.roadmap);
  assert.equal((await storage.loadState(cwd)).manifest.storage?.kind, "online");
  // The live board is set aside; what is left there stops older Planban versions using it.
  assert.equal(await readFile(before.roadmapPath, "utf8"), storage.RETIRED_ROADMAP);
});

test("a roadmap that appears while a committed move is unfinished is set aside and reported, never taken for the board", async () => {
  const before = await storage.loadState(cwd);
  await killedAt("take-online:after-commit", ["online", "take-online", fake.url, "--cwd", cwd]);
  // Something put a board back where the marker was (Planban 1.x init after the file was removed, say).
  const stray = JSON.stringify({ version: 2, writerVersion: 6, revision: 0, roadmapItems: [] });
  await writeFile(before.roadmapPath, stray);
  const result: any = await takeOnline(fake.url, cwd);
  assert.deepEqual(JSON.parse(await readFile(result.localSnapshot, "utf8")), before.roadmap, "the snapshot is the board as it was");
  assert.equal(await readFile(result.strayRoadmap, "utf8"), stray, "the stray roadmap is kept, aside, and named");
  assert.equal(await readFile(before.roadmapPath, "utf8"), storage.RETIRED_ROADMAP);
  assert.equal((await storage.loadState(cwd)).manifest.storage?.kind, "online");
});

test("take-local killed mid-download keeps the online board intact, and running it again finishes", async () => {
  await takeOnline(fake.url, cwd);
  const online = await storage.loadState(cwd);
  await killedAt("take-local:mid-download", ["online", "take-local", "--cwd", cwd]);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  assert.equal(fake.authority, "returned-local");
  await assert.rejects(storage.updateCard({ cwd, cardId: "alpha", summary: "late", baseRevision: (await storage.loadState(cwd)).roadmap.revision }), storage.PlanbanConflictError);
  const returned = await takeLocal(cwd);
  const local = await storage.loadState(cwd);
  assert.equal(local.manifest.storage?.kind, "local");
  assert.equal(local.planningRoot, returned.planningRoot);
  assert.deepEqual(local.roadmap.roadmapItems.map((item) => item.id), online.roadmap.roadmapItems.map((item) => item.id));
  assert.equal((await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown, "# Original spec");
  assert.equal(await storage.pathExists(join(onlineCacheRoot({ kind: "online", url: fake.url, boardId: "demo" }), "online-transfer.json")), false);
});

test("a shut board whose marker was deleted gets it back on resume, and the move finishes from the snapshot", async () => {
  const before = await storage.loadState(cwd);
  await killedAt("take-online:after-seal", ["online", "take-online", fake.url, "--cwd", cwd]);
  await rm(before.roadmapPath);
  const result = await takeOnline(fake.url, cwd);
  assert.deepEqual(JSON.parse(await readFile(result.localSnapshot, "utf8")), before.roadmap);
  assert.equal(await readFile(before.roadmapPath, "utf8"), storage.RETIRED_ROADMAP);
  assert.deepEqual(fake.bundle.roadmap.roadmapItems.map((item) => item.id), before.roadmap.roadmapItems.map((item) => item.id));
});

test("take-online killed after copying the snapshot, before shutting the local board, finishes on retry with one snapshot", async () => {
  const before = await storage.loadState(cwd);
  await killedAt("take-online:after-snapshot", ["online", "take-online", fake.url, "--cwd", cwd]);
  assert.deepEqual(JSON.parse(await readFile(before.roadmapPath, "utf8")), before.roadmap, "never a moment without a roadmap file");
  assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
  const result = await takeOnline(fake.url, cwd);
  assert.equal((await storage.loadState(cwd)).manifest.storage?.kind, "online");
  assert.deepEqual(JSON.parse(await readFile(result.localSnapshot, "utf8")), before.roadmap);
  assert.equal((await readdir(before.planningRoot)).filter((name) => name.startsWith("roadmap.local-before-online-")).length, 1);
  assert.equal([...fake.transfers.values()].filter((transfer) => transfer.state === "committed").length, 1);
});

test("take-online killed after shutting the local board, before the commit, keeps it shut and finishes on retry", async () => {
  const before = await storage.loadState(cwd);
  await killedAt("take-online:after-seal", ["online", "take-online", fake.url, "--cwd", cwd]);
  assert.equal(await readFile(before.roadmapPath, "utf8"), storage.RETIRED_ROADMAP);
  await assert.rejects(storage.createCard({ cwd, title: "Lost?" }), /moving online/);
  const result = await takeOnline(fake.url, cwd);
  // The retry never takes the marker for the board: the snapshot still holds the board as it was.
  assert.deepEqual(JSON.parse(await readFile(result.localSnapshot, "utf8")), before.roadmap);
  assert.equal((await readdir(before.planningRoot)).filter((name) => name.startsWith("roadmap.local-before-online-")).length, 1);
  assert.equal((await storage.loadState(cwd)).manifest.storage?.kind, "online");
});

test("take-local killed after writing the local copy resumes into the same folder", async () => {
  await takeOnline(fake.url, cwd);
  await killedAt("take-local:after-stage", ["online", "take-local", "--cwd", cwd]);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  const journal = JSON.parse(await readFile(join(onlineCacheRoot({ kind: "online", url: fake.url, boardId: "demo" }), "online-transfer.json"), "utf8"));
  const returned = await takeLocal(cwd);
  assert.equal(returned.planningRoot, journal.root);
  assert.equal((await storage.loadState(cwd)).manifest.storage?.kind, "local");
});

test("an edit whose response is lost is retried with its idempotency key and applied once", async () => {
  await takeOnline(fake.url, cwd);
  const state = await storage.loadState(cwd);
  const versions = fake.bundle.history.length;
  fake.dropNextReply();
  const updated = await storage.updateCard({ cwd, cardId: "alpha", summary: "Exactly once", baseRevision: state.roadmap.revision });
  assert.equal(updated.roadmap.roadmapItems[0]!.summary, "Exactly once");
  assert.equal(fake.bundle.history.length, versions + 1);
  const keys = fake.requests.filter((req) => req.path.endsWith("/ops/updateCard"));
  assert.equal(keys.length, 2, "the edit was sent twice");
});

test("online edits must state the version they were based on", async () => {
  await takeOnline(fake.url, cwd);
  await assert.rejects(storage.updateCard({ cwd, cardId: "alpha", summary: "No base" }), (error: any) => error instanceof storage.PlanbanValidationError && /baseRevision/.test(error.message));
});

test("when live updates fail, the board server checks for changes instead", async () => {
  await takeOnline(fake.url, cwd);
  fake.failLiveToken();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const live = await (await fetch(`${server.url}/api/live?repoId=demo`)).json();
    await storage.updateCard({ cwd, cardId: "alpha", summary: "Changed elsewhere", baseRevision: (await storage.loadState(cwd)).roadmap.revision });
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const changed = await (await fetch(`${server.url}/api/live?repoId=demo`)).json();
    assert.ok(fake.requests.some((req) => req.path === "/api/v1/live-token"));
    assert.ok(fake.requests.some((req) => req.path.endsWith("/changes")), "fell back to checking for changes");
    assert.ok(changed.stateVersion > live.stateVersion);
  } finally { await server.close(); }
});

/** Another machine's local copy of the demo board: a copy of its planning root, used from a second project. */
async function secondMachineCopy() {
  const source = (await storage.loadState(cwd)).planningRoot;
  const copyRoot = join(root, "second-machine-planning");
  await cp(source, copyRoot, { recursive: true });
  const second = join(root, "second-machine-project");
  await mkdir(join(second, ".planban"), { recursive: true });
  await writeFile(manifestPath(second), JSON.stringify({ version: 1, repoId: "demo", enabled: true, storage: { kind: "local", root: copyRoot } }));
  resetCopyChecks();
  return { second, copyRoot };
}

const revisionOf = async (project: string) => (await storage.loadState(project)).roadmap.revision;

test("a local copy of a board taken online elsewhere refuses writes and says how to continue", async () => {
  const { second, copyRoot } = await secondMachineCopy();
  await storage.updateCard({ cwd: second, cardId: "alpha", summary: "Before it went online", baseRevision: await revisionOf(second) });
  await takeOnline(fake.url, cwd);
  resetCopyChecks();
  await assert.rejects(storage.updateCard({ cwd: second, cardId: "alpha", summary: "Too late", baseRevision: await revisionOf(second) }),
    (error: any) => error instanceof PlanbanStaleCopyError && /Not saved.*now lives online/.test(error.message) && /do not choose for the owner/.test(error.message) && /--replace-stale-copy/.test(error.message) && /keep-local-copy --cwd .* --title/.test(error.message));
  assert.equal((await storage.loadState(second)).roadmap.roadmapItems[0]!.summary, "Before it went online", "reads still work");
  assert.ok(await storage.pathExists(join(copyRoot, STALE_MARKER)));
  // The refusal survives the service being unreachable.
  fake.failCopyCheck(true);
  resetCopyChecks();
  await assert.rejects(storage.writeDoc({ cwd: second, cardId: "alpha", kind: "spec", markdown: "x" }), PlanbanStaleCopyError);
});

test("a stale copy with unsynced edits reports them and keeps them when attaching to the online board", async () => {
  const { second, copyRoot } = await secondMachineCopy();
  // Edited on the second machine, never synced, while the first machine takes the board online.
  await storage.createCard({ cwd: second, title: "Only on the second machine", baseRevision: await revisionOf(second) });
  await takeOnline(fake.url, cwd);
  resetCopyChecks();
  const refusal = await storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }).then(() => null, (error) => error);
  assert.ok(refusal instanceof PlanbanStaleCopyError);
  assert.deepEqual(refusal.stale.unsyncedChanges.map((change: { summary: string }) => change.summary), ["Created Only on the second machine"]);
  assert.match(refusal.message, /1 change\(s\) on this machine never reached the online board/);
  await assert.rejects(attachOnline(fake.url, "demo", second), /already has a different board/);
  const attached = await attachOnline(fake.url, "demo", second, { replaceStaleCopy: true });
  assert.equal((await storage.loadState(second)).manifest.storage?.kind, "online");
  assert.deepEqual(attached.staleCopy?.unsyncedChanges.map((change) => change.summary), ["Created Only on the second machine"]);
  assert.match(await readFile(attached.staleCopy!.report, "utf8"), /Only on the second machine/);
  assert.ok(JSON.parse(await readFile(attached.staleCopy!.snapshot, "utf8")).roadmapItems.some((item: { title: string }) => item.title === "Only on the second machine"));
  assert.equal(await storage.pathExists(join(copyRoot, "roadmap.json")), false);
});

test("when the service cannot be reached, a local write goes ahead and is reported later if the copy turns out stale", async () => {
  const { second } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  fake.failCopyCheck(true);
  resetCopyChecks();
  await storage.createCard({ cwd: second, title: "Written offline", baseRevision: await revisionOf(second) });
  fake.failCopyCheck(false);
  resetCopyChecks();
  const refusal = await storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }).then(() => null, (error) => error);
  assert.ok(refusal instanceof PlanbanStaleCopyError);
  assert.deepEqual(refusal.stale.unsyncedChanges.map((change: { summary: string }) => change.summary), ["Created Written offline"]);
});

test("a board with the same id but unrelated history is not treated as a stale copy", async () => {
  await takeOnline(fake.url, cwd);
  const other = join(root, "unrelated");
  await storage.initializeProject({ cwd: other, repoId: "unrelated-board", title: "Unrelated", updateAgents: false });
  const otherRoot = (await storage.loadState(other)).planningRoot;
  await writeFile(manifestPath(other), JSON.stringify({ version: 1, repoId: "demo", enabled: true, storage: { kind: "local", root: otherRoot } }));
  resetCopyChecks();
  await storage.createCard({ cwd: other, title: "Fine", baseRevision: await revisionOf(other) });
  assert.ok(fake.requests.some((req) => req.path === "/api/v1/copy-check"));
});

test("keeping a stale copy as a separate local board renames it and stops the checks for it", async () => {
  const { second, copyRoot } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  resetCopyChecks();
  await assert.rejects(storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }), PlanbanStaleCopyError);
  const kept = await keepLocalCopy(second, "demo-local");
  assert.equal(kept.repoId, "demo-local");
  resetCopyChecks();
  const state = await storage.loadState(second);
  assert.equal(state.manifest.repoId, "demo-local");
  assert.match(state.roadmap.project.title, /local copy/);
  await storage.updateCard({ cwd: second, cardId: "alpha", summary: "Mine now", baseRevision: state.roadmap.revision });
  assert.equal(await storage.pathExists(join(copyRoot, STALE_MARKER)), false);
});

test("keeping an older copy as a separate board gives it its own folder and name, and the project follows the online board", async () => {
  const { second, copyRoot } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  resetCopyChecks();
  await assert.rejects(storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }), PlanbanStaleCopyError);
  const kept = await keepSeparateBoard(second, { title: "Demo (mine)" });
  // The project now uses the online board, so its agents follow it.
  assert.equal((await storage.readManifest(second))?.storage?.kind, "online");
  assert.equal(await storage.pathExists(join(copyRoot, "ONLINE-BOARD.txt")), true, "the older copy is kept as recovery evidence");
  // The separate board is its own board, editable, never flagged again.
  resetCopyChecks();
  const separate = await storage.loadState(kept.separateBoard.cwd);
  assert.notEqual(separate.manifest.repoId, "demo");
  assert.equal(separate.roadmap.project.title, "Demo (mine)");
  assert.ok(separate.roadmap.roadmapItems.some((item) => item.id === "alpha"));
  await storage.updateCard({ cwd: kept.separateBoard.cwd, cardId: "alpha", summary: "Mine now", baseRevision: separate.roadmap.revision });
  assert.equal(await storage.pathExists(join(separate.planningRoot, STALE_MARKER)), false);
  assert.equal(await storage.pathExists(join(separate.planningRoot, "INDEPENDENT-COPY.json")), true);
});

test("the board page shows an older copy and switches it to the online board when asked", async () => {
  const { second } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  resetCopyChecks();
  await assert.rejects(storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }), PlanbanStaleCopyError);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd: second, port, useVite: false });
  try {
    const status = await (await fetch(`${server.url}/api/boards/demo/online`)).json();
    assert.equal(status.location, "local");
    assert.equal(status.stale.boardId, "demo");
    const used = await fetch(`${server.url}/api/boards/demo/online/use-online`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(used.status, 200, await used.clone().text());
    assert.equal((await storage.readManifest(second))?.storage?.kind, "online");
    assert.equal((await (await fetch(`${server.url}/api/boards/demo/online`)).json()).location, "online");
  } finally {
    await server.close();
  }
});

test("keeping a separate board refuses a bad id before copying, and a retry finishes the same board", async () => {
  const { second } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  resetCopyChecks();
  await assert.rejects(storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }), PlanbanStaleCopyError);
  await assert.rejects(keepSeparateBoard(second, { newId: "../unexpected" }), /Choose a new board id/);
  assert.equal(await storage.pathExists(join(root, "home", "unexpected")), false);
  // The service is unreachable while switching: the separate board exists, and running it again finishes without another copy.
  fake.failNextBoardRead();
  await assert.rejects(keepSeparateBoard(second, { title: "Mine" }), /will not make another copy/);
  const finished = await keepSeparateBoard(second);
  assert.equal(finished.separateBoard.title, "Mine");
  const boards = (await readdir(join(root, "home", "repos"))).filter((name) => name.startsWith("demo-copy"));
  assert.equal(boards.length, 1, `one separate board, not ${boards.join(", ")}`);
  assert.equal((await storage.readManifest(second))?.storage?.kind, "online");
});

test("Take Online leaves a note in the project folder; a machine with the note keeps its old copy read-only without going online", async () => {
  const { second, copyRoot } = await secondMachineCopy();
  await execFileAsync("git", ["init", "-q", cwd]);
  const result: any = await takeOnline(fake.url, cwd);
  const notePath = join(cwd, ".planban", "online-board.json");
  assert.equal(result.onlineNote.path, notePath);
  assert.match(result.onlineNote.commit, /git -C .* add ".planban\/online-board.json" && git -C .* commit/);
  const note = JSON.parse(await readFile(notePath, "utf8"));
  assert.equal(note.boardId, "demo");
  assert.match(note.note, new RegExp(`lives online at .*${CMD} online login`));

  // The second machine gets the note (as if pulled with the project) and has never signed in.
  await cp(notePath, join(second, ".planban", "online-board.json"));
  await saveCredentials(fake.url, null);
  resetCopyChecks();
  const start = fake.requests.length;
  const refusal: any = await storage.updateCard({ cwd: second, cardId: "alpha", summary: "offline", baseRevision: await revisionOf(second) }).then(() => null, (error) => error);
  assert.ok(refusal instanceof PlanbanStaleCopyError, String(refusal));
  assert.match(refusal.message, new RegExp(`now lives online.*not signed in to it yet.*${CMD} online login`, "s"));
  assert.match(refusal.message, /Agents: do not retry/);
  assert.equal(fake.requests.length, start, "no network call");
  assert.equal(await storage.pathExists(join(copyRoot, STALE_MARKER)), true);
});

test("a take-online killed before writing its note writes it when run again; a damaged note says how to fix it", async () => {
  const { second } = await secondMachineCopy();
  await killedAt("take-online:after-seal", ["online", "take-online", fake.url, "--cwd", cwd]);
  const notePath = join(cwd, ".planban", "online-board.json");
  assert.equal(await storage.pathExists(notePath), false);
  await killedAt("take-online:after-note", ["online", "take-online", fake.url, "--cwd", cwd]);
  assert.equal(await storage.pathExists(notePath), true);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local", "killed after the note, before switching");
  await takeOnline(fake.url, cwd);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  assert.equal(JSON.parse(await readFile(notePath, "utf8")).boardId, "demo");

  await writeFile(join(second, ".planban", "online-board.json"), JSON.stringify({ url: fake.url, boardId: "demo" }));
  resetCopyChecks();
  await assert.rejects(storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }), /note .* is damaged or incomplete\. Restore it from version control, or remove it/);
});

test("Take Local removes the project's online note", async () => {
  await execFileAsync("git", ["init", "-q", cwd]);
  await takeOnline(fake.url, cwd);
  const result: any = await takeLocal(cwd);
  assert.equal(await storage.pathExists(join(cwd, ".planban", "online-board.json")), false);
  assert.match(result.onlineNote.commit, /commit -am/);
});

test("a machine that never signed in makes no network calls for local boards", async () => {
  await saveCredentials(fake.url, null);
  resetCopyChecks();
  const start = fake.requests.length;
  await storage.updateCard({ cwd, cardId: "alpha", summary: "Offline machine", baseRevision: await revisionOf(cwd) });
  await storage.loadState(cwd);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.requests.length, start);
});

test("signing in checks the machine's local boards for stale copies", async () => {
  const { second } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  // On the second machine, its own registry lists its local copy.
  await registerBoardFromCwd(second);
  resetCopyChecks();
  const result: any = await onlineLogin(fake.url, { switchAccount: true, openBrowser: async (authorizeUrl) => {
    await fetch((await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!);
  } });
  assert.ok(result.staleLocalCopies?.some((copy: { repoId: string; onlineBoard: string }) => copy.repoId === "demo" && copy.onlineBoard === "demo"));
});

test("every machine keeps a local backup of an Online Board it uses, and it restores into a new local board", async () => {
  await takeOnline(fake.url, cwd);
  const backup = join(backupRoot(fake.url, "demo"), "latest");
  assert.equal(JSON.parse(await readFile(join(backup, "roadmap.json"), "utf8")).roadmapItems[0].id, "alpha");
  assert.equal(await readFile(join(backup, "docs", "alpha.spec.md"), "utf8"), "# Original spec");
  const second = join(root, "second-machine");
  await attachOnline(fake.url, "demo", second);
  const doc = await storage.readDoc({ cwd: second, cardId: "alpha", kind: "spec" });
  await storage.writeDoc({ cwd: second, cardId: "alpha", kind: "spec", markdown: "# Changed online", expectedMtimeMs: doc.mtimeMs });
  await storage.updateCard({ cwd: second, cardId: "alpha", summary: "Backed up", baseRevision: await revisionOf(second) });
  const before = fake.requests.length;
  await refreshBackup(fake.url, "demo", { force: true });
  const fetched = fake.requests.slice(before).filter((req) => req.path.includes("/docs/")).map((req) => req.path);
  assert.deepEqual(fetched, ["/api/v1/boards/demo/docs/alpha/spec"], "only the changed document is downloaded");
  assert.equal(await readFile(join(backup, "docs", "alpha.spec.md"), "utf8"), "# Changed online");
  assert.equal(JSON.parse(await readFile(join(backup, "roadmap.json"), "utf8")).roadmapItems[0].summary, "Backed up");

  // Someone saves while the backup is reading the changed document: the
  // backup never pairs a newer body with an older roadmap.
  const latest = await storage.readDoc({ cwd: second, cardId: "alpha", kind: "spec" });
  await storage.writeDoc({ cwd: second, cardId: "alpha", kind: "spec", markdown: "# Before the race", expectedMtimeMs: latest.mtimeMs });
  fake.beforeDocRead = async () => {
    const current = await storage.readDoc({ cwd: second, cardId: "alpha", kind: "spec" });
    await storage.writeDoc({ cwd: second, cardId: "alpha", kind: "spec", markdown: "# Saved during the backup", expectedMtimeMs: current.mtimeMs });
  };
  await refreshBackup(fake.url, "demo", { force: true });
  const savedMeta = JSON.parse(await readFile(join(backup, "backup.json"), "utf8"));
  const savedBody = await readFile(join(backup, "docs", "alpha.spec.md"), "utf8");
  assert.equal(savedBody, "# Saved during the backup");
  assert.equal(savedMeta.revision, await revisionOf(second), "the saved roadmap is the one that body belongs to");
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(await storage.pathExists(join(backupRoot(fake.url, "demo"), "daily", today, "roadmap.json")));

  const restoredCwd = join(root, "restored");
  const restored = await restoreBackup(backup, restoredCwd, "demo-restored");
  assert.equal(restored.cards, 1);
  const state = await storage.loadState(restoredCwd);
  assert.equal(state.manifest.storage?.kind, "local");
  assert.equal(state.roadmap.roadmapItems[0]!.summary, "Backed up");
  assert.equal((await storage.readDoc({ cwd: restoredCwd, cardId: "alpha", kind: "spec" })).markdown, "# Saved during the backup");
});

test("signing out revokes this machine's connection on the service, then forgets it locally", async () => {
  const result = await onlineLogout(fake.url);
  assert.equal(result.revoked, true);
  assert.ok(fake.revokedTokens.has("Bearer access-0"));
  assert.equal((await readCredentials()).services[fake.url], undefined);
});

test("signing out while the service is unreachable still forgets the sign-in and says the connection remains", async () => {
  const unreachable = "http://127.0.0.1:9";
  await saveCredentials(unreachable, { clientId: "cli", accessToken: "access-x", refreshToken: "", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  const result = await onlineLogout(unreachable);
  assert.equal(result.revoked, false);
  assert.match(result.note ?? "", /stays active until you revoke it/);
  assert.equal((await readCredentials()).services[unreachable], undefined);
});

test("a backup refresh that fails keeps the last good backup", async () => {
  await takeOnline(fake.url, cwd);
  const latest = join(backupRoot(fake.url, "demo"), "latest");
  await rm(join(latest, "backup.json"));
  fake.failExportDocs(true);
  assert.equal(await refreshBackup(fake.url, "demo", { force: true }), null);
  assert.equal(JSON.parse(await readFile(join(latest, "roadmap.json"), "utf8")).roadmapItems[0].id, "alpha");
  assert.equal(await readFile(join(latest, "docs", "alpha.spec.md"), "utf8"), "# Original spec");
});

test("take-local killed right after switching the project tells the service before the board is taken online again", async () => {
  await takeOnline(fake.url, cwd);
  await killedAt("take-local:after-publish", ["online", "take-local", "--cwd", cwd]);
  const local = await storage.loadState(cwd);
  assert.equal(local.manifest.storage?.kind, "local");
  assert.ok(await storage.pathExists(join(local.planningRoot, "online-transfer.json")));
  const start = fake.requests.length;
  await takeOnline(fake.url, cwd);
  const steps = fake.requests.slice(start).map((req) => req.path);
  assert.ok(steps.indexOf("/api/v1/boards/demo/take-local/finish") >= 0);
  assert.ok(steps.indexOf("/api/v1/boards/demo/take-local/finish") < steps.indexOf("/api/v1/transfers"));
});

test("a stale copy is recognised by the board's identity however many edits it has made since", async () => {
  const { second } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  fake.failCopyCheck(true);
  resetCopyChecks();
  for (let index = 0; index < 60; index += 1) await storage.createCard({ cwd: second, title: `Offline ${index}`, baseRevision: await revisionOf(second) });
  fake.failCopyCheck(false);
  resetCopyChecks();
  const refusal = await storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }).then(() => null, (error) => error);
  assert.ok(refusal instanceof PlanbanStaleCopyError);
});

test("a copy of a board made before identities existed is still recognised by its oldest shared history", async () => {
  await rm(join((await storage.loadState(cwd)).planningRoot, "board-identity.json"));
  const { second, copyRoot } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  await rm(join(copyRoot, "board-identity.json"), { force: true });
  fake.failCopyCheck(true);
  resetCopyChecks();
  for (let index = 0; index < 60; index += 1) await storage.createCard({ cwd: second, title: `Offline ${index}`, baseRevision: await revisionOf(second) });
  fake.failCopyCheck(false);
  resetCopyChecks();
  const refusal = await storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }).then(() => null, (error) => error);
  assert.ok(refusal instanceof PlanbanStaleCopyError);
  assert.equal(refusal.stale.unsyncedChanges.length, 60);
});

test("a board goes online only when it is clean: files and local pictures in the way are listed with how to tidy them", async () => {
  const before = await storage.loadState(cwd);
  const folder = join(before.planningRoot, "items", "alpha");
  await mkdir(join(folder, "renders"), { recursive: true });
  await writeFile(join(folder, "renders", "front.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const current = await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" });
  const spec = "# Alpha\n\n![Front view](renders/front.png)\n\n![Logo](data:image/png;base64,iVBORw0KGgo=)\n\n![Diagram](https://example.com/diagram.png)\n";
  await assert.rejects(storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: spec, expectedMtimeMs: current.exists ? current.mtimeMs : null }), /Planban boards hold text only/);
  // Simulate content left by an older install; strict Local Mode cannot create it now.
  await writeFile(join(folder, "spec.md"), spec);
  const written = await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" });

  const refusal: any = await takeOnline(fake.url, cwd).then(() => null, (error) => error);
  assert.ok(refusal instanceof PlanbanNotReadyForOnline, String(refusal));
  assert.match(refusal.message, /cannot go online yet; nothing has moved\. 1 file\(s\) and 2 picture\(s\) are in the way/);
  assert.match(refusal.message, /file renders\/front\.png; picture in the Spec \(Front view\), .*items[\\/]alpha[\\/]renders[\\/]front\.png; picture in the Spec \(Logo\), stored in the document/);
  assert.match(refusal.message, /Move each file in its folder to where it belongs.*labelled with its machine/s);
  assert.equal(fake.transfers.size, 0, "nothing moved");
  assert.equal(await readFile(join(folder, "spec.md"), "utf8"), spec, "nothing on this machine changed");

  // Tidied: the file lives elsewhere and the Spec refers to it; pictures on the web are fine.
  await rm(join(folder, "renders"), { recursive: true });
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Alpha\n\nFront view: Mac mini: ~/Projects/demo/renders/front.png\n\n![Diagram](https://example.com/diagram.png)\n", expectedMtimeMs: written.mtimeMs });
  await takeOnline(fake.url, cwd);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
});

test("old versions in history that hold embedded files go online with notes in their place; the copy here keeps them", async () => {
  const before = await storage.loadState(cwd);
  const history = await listHistory(before);
  let oldest = history.entries.at(-1)!;
  let roadmap: any = null;
  for (const entry of [...history.entries].reverse()) {
    roadmap = JSON.parse(await readFile(historyRoadmapPath(before.planningRoot, entry.version), "utf8"));
    oldest = entry;
    if (roadmap.roadmapItems.length) break;
  }
  const path = historyRoadmapPath(before.planningRoot, oldest.version);
  roadmap.roadmapItems[0] = { ...roadmap.roadmapItems[0], metadata: { logo: Array.from({ length: 3000 }, (_, i) => i % 256), [`data:text/plain;base64,${"QUJD".repeat(100)}`]: 1 }, summary: `![x](data:image/gif;base64,R0lGODlhAQABAAAAACw=)` };
  await writeFile(path, JSON.stringify(roadmap));
  await takeOnline(fake.url, cwd);
  const sent = [...fake.transfers.values()].at(-1)!.parts;
  const versions = [...sent.values()].flatMap((part: any) => part.history ?? []);
  const old = versions.find((version: any) => version.entry.version === oldest.version);
  const card = old.roadmap.roadmapItems[0];
  assert.doesNotThrow(() => checkIndexCard(card));
  assert.match(JSON.stringify(card), /file kept in the copy of this board on/);
  assert.equal(await readFile(path, "utf8"), JSON.stringify(roadmap), "the copy here is unchanged");
});

test("old history that would still break the rules after cleaning goes online as notes, so a tidy board is never held back", async () => {
  const before = await storage.loadState(cwd);
  const history = await listHistory(before);
  const version = history.entries[0]!;
  const path = historyRoadmapPath(before.planningRoot, version.version);
  const roadmap = JSON.parse(await readFile(path, "utf8"));
  roadmap.project.description = "word ".repeat(15 * 1024);
  await writeFile(path, JSON.stringify(roadmap));
  const index = JSON.parse(await readFile(historyIndexPath(before.planningRoot), "utf8"));
  index.entries[0].summary = "word ".repeat(15 * 1024);
  await writeFile(historyIndexPath(before.planningRoot), JSON.stringify(index));
  const doc = version.affectedDocs[0] ?? { cardId: "alpha", kind: "spec" };
  await mkdir(dirname(historyDocPath(before.planningRoot, version.version, doc.cardId, doc.kind)), { recursive: true });
  await writeFile(historyDocPath(before.planningRoot, version.version, doc.cardId, doc.kind), `${"word ".repeat(250 * 1024)}\n![s](data:image/svg+xml;base64,PHN2Zy8+)`);
  await takeOnline(fake.url, cwd);
  const sent = [...[...fake.transfers.values()].at(-1)!.parts.values()];
  for (const part of sent as any[]) {
    for (const old of part.history ?? []) {
      assert.doesNotThrow(() => checkIndexValue(old.entry, "entry", 64 * 1024));
      const { roadmapItems, ...details } = old.roadmap;
      assert.doesNotThrow(() => checkIndexValue(details, "details", 64 * 1024));
      for (const card of roadmapItems) assert.doesNotThrow(() => checkIndexCard(card));
    }
    for (const old of part.historyDocs ?? []) assert.doesNotThrow(() => checkIndexDocument(old.markdown, old.cardId, old.kind));
  }
});

test("a resumed take-online is checked again, so files added meanwhile stop it until tidied", async () => {
  const before = await storage.loadState(cwd);
  await killedAt("take-online:after-part", ["online", "take-online", fake.url, "--cwd", cwd]);
  await mkdir(join(before.planningRoot, "items", "alpha"), { recursive: true });
  await writeFile(join(before.planningRoot, "items", "alpha", "notes.txt"), "added meanwhile");
  await assert.rejects(takeOnline(fake.url, cwd), (error: unknown) => error instanceof PlanbanNotReadyForOnline && /notes\.txt/.test((error as Error).message));
  assert.deepEqual([...fake.transfers.values()].map((transfer) => transfer.state), ["open"], "the interrupted upload is left to resume");
  await rm(join(before.planningRoot, "items", "alpha", "notes.txt"));
  await takeOnline(fake.url, cwd);
  assert.deepEqual([...fake.transfers.values()].map((transfer) => transfer.state), ["committed"]);
});

test("a take-online that fails removes the partly copied online board and leaves this machine's board unchanged", async () => {
  const before = await storage.loadState(cwd);
  fake.failParts(true);
  await assert.rejects(takeOnline(fake.url, cwd), /still on this machine, unchanged, and the partly copied online version was removed/);
  assert.deepEqual([...fake.transfers.values()].map((transfer) => transfer.state), ["aborted"]);
  assert.equal(await storage.pathExists(join(before.planningRoot, "online-transfer.json")), false);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
  assert.equal((await storage.loadState(cwd)).roadmap.revision, before.roadmap.revision);
  fake.failParts(false);
  await takeOnline(fake.url, cwd);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
});

test("stop-take-online cancels an interrupted move; one that already reached the service is finished instead", async () => {
  const before = await storage.loadState(cwd);
  await killedAt("take-online:after-part", ["online", "take-online", fake.url, "--cwd", cwd]);
  const stopped = await stopTakeOnline(cwd);
  assert.equal(stopped.stopped, true);
  assert.deepEqual([...fake.transfers.values()].map((transfer) => transfer.state), ["aborted"]);
  assert.equal(await storage.pathExists(join(before.planningRoot, "online-transfer.json")), false);
  assert.equal((await stopTakeOnline(cwd)).stopped, false);
  await killedAt("take-online:after-commit", ["online", "take-online", fake.url, "--cwd", cwd]);
  await assert.rejects(stopTakeOnline(cwd), /already reached the online service/);
  await takeOnline(fake.url, cwd);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
});

test("a stopped take-online removes the partly copied online board and leaves this machine's board unchanged", async () => {
  const before = await storage.loadState(cwd);
  await assert.rejects(takeOnline(fake.url, cwd, { signal: AbortSignal.abort() }), (error: unknown) => error instanceof PlanbanTakeOnlineStopped);
  assert.deepEqual([...fake.transfers.values()].map((transfer) => transfer.state), ["aborted"]);
  assert.equal(await storage.pathExists(join(before.planningRoot, "online-transfer.json")), false);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
});

test("someone joining between the question and the freeze is asked about, and nothing is frozen", async () => {
  await takeOnline(fake.url, cwd);
  fake.beforeFence(() => {
    if (!fake.members.some((member) => member.userId === "late")) fake.members.push({ userId: "late", role: "viewer" });
  });
  const refusal: any = await takeLocal(cwd).then(() => null, (error) => error);
  assert.ok(refusal instanceof PlanbanConfirmationNeeded, String(refusal));
  assert.match(refusal.message, /late \(viewer\)/);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  assert.equal(await storage.pathExists(join(storage.resolvePlanningRoot((await storage.readManifest(cwd))!), "online-transfer.json")), false);
  fake.beforeFence(() => undefined);
  await takeLocal(cwd, { removeOthers: true });
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "local");
});

test("a take-local resumed before its freeze asks again about people who joined meanwhile", async () => {
  await takeOnline(fake.url, cwd);
  await killedAt("take-local:before-fence", ["online", "take-local", "--cwd", cwd]);
  fake.members.push({ userId: "maya", role: "editor" });
  await assert.rejects(takeLocal(cwd), (error: unknown) => error instanceof PlanbanConfirmationNeeded && /maya/.test((error as Error).message));
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  await takeLocal(cwd, { removeOthers: true });
  assert.deepEqual(fake.members.map((member) => member.userId), ["dev-owner"]);
});

test("an earlier upload is replaced only once the service confirms it is gone", async () => {
  const before = await storage.loadState(cwd);
  const journalPath = join(before.planningRoot, "online-transfer.json");
  await killedAt("take-online:after-part", ["online", "take-online", fake.url, "--cwd", cwd]);
  const recorded = JSON.parse(await readFile(journalPath, "utf8"));
  await storage.updateCard({ cwd, cardId: "alpha", summary: "edited after the upload", baseRevision: (await storage.loadState(cwd)).roadmap.revision });
  fake.failAbort(true);
  await assert.rejects(takeOnline(fake.url, cwd));
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).transferId, recorded.transferId, "the record of the earlier upload is kept");
  fake.failAbort(false);
  await takeOnline(fake.url, cwd);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  assert.equal(fake.bundle.roadmap.roadmapItems.find((item) => item.id === "alpha")?.summary, "edited after the upload", "the current board went online");
});

test("an upload started by another account is never cancelled or forgotten by this one", async () => {
  const before = await storage.loadState(cwd);
  const journalPath = join(before.planningRoot, "online-transfer.json");
  await killedAt("take-online:after-part", ["online", "take-online", fake.url, "--cwd", cwd]);
  const recorded = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(recorded.userId, "dev-owner");
  await writeFile(journalPath, JSON.stringify({ ...recorded, userId: "someone-else" }));
  await storage.updateCard({ cwd, cardId: "alpha", summary: "edited", baseRevision: (await storage.loadState(cwd)).roadmap.revision });
  await assert.rejects(takeOnline(fake.url, cwd), /another account \(someone-else\)/);
  await assert.rejects(stopTakeOnline(cwd), /another account \(someone-else\)/);
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).transferId, recorded.transferId);
  assert.deepEqual([...fake.transfers.values()].map((transfer) => transfer.state), ["open"]);
});

test("a daily limit reaches the board page and agents as a limit, with its message, not as a failure", async () => {
  await takeOnline(fake.url, cwd);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const state = await (await fetch(`${server.url}/api/boards/demo/state`)).json();
    fake.limitNextOp();
    const response = await fetch(`${server.url}/api/boards/demo/cards/alpha`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary: "One more", baseRevision: state.roadmap.revision }) });
    assert.equal(response.status, 429);
    assert.match((await response.json()).error, /today's limit .* resets at midnight UTC/);
  } finally {
    await server.close();
  }
});

test("the board page moves a board online and back, and names who would lose access before cutting them off", async () => {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const finished = async (id: string) => {
    for (;;) {
      const job = await (await fetch(`${server.url}/api/boards/demo/online/job/${id}`)).json();
      if (job.status !== "running") return job;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    const requestsBefore = fake.requests.length;
    const local = await (await fetch(`${server.url}/api/boards/demo/online`)).json();
    assert.equal(local.location, "local");
    assert.equal(fake.requests.length, requestsBefore, "a local board's status never contacts the online service");

    fake.failParts(true);
    const failing = await (await post("/api/boards/demo/online/take-online", { url: fake.url })).json();
    const failed = await finished(failing.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /unchanged, and the partly copied online version was removed/);
    assert.equal((await (await fetch(`${server.url}/api/boards/demo/online`)).json()).location, "local");
    fake.failParts(false);

    const started = await post("/api/boards/demo/online/take-online", { url: fake.url });
    assert.equal(started.status, 202);
    assert.equal((await finished((await started.json()).id)).status, "succeeded");
    const online = await (await fetch(`${server.url}/api/boards/demo/online`)).json();
    assert.equal(online.location, "online");
    assert.deepEqual(online.people, [{ userId: "dev-owner", role: "owner", you: true }]);

    fake.members.push({ userId: "maya", role: "editor" });
    const unconfirmed = await post("/api/boards/demo/online/take-local", { removeOthers: true, expectedOthers: [] });
    assert.equal(unconfirmed.status, 409, "the confirmation must cover exactly the people on the board now");
    assert.deepEqual((await unconfirmed.json()).confirmationNeeded.removes, [{ userId: "maya", role: "editor" }]);
    assert.equal(fake.requests.some((req) => req.path.endsWith("/take-local/fence")), false);
    const confirmed = await post("/api/boards/demo/online/take-local", { removeOthers: true, expectedOthers: ["maya"] });
    assert.equal(confirmed.status, 202);
    assert.equal((await finished((await confirmed.json()).id)).status, "succeeded");
    assert.equal((await (await fetch(`${server.url}/api/boards/demo/online`)).json()).location, "local");
    assert.deepEqual(fake.members.map((member) => member.userId), ["dev-owner"]);
  } finally {
    await server.close();
  }
});

test("cancelling an upload asks and cancels as one account, even if another signs in between", async () => {
  const before = await storage.loadState(cwd);
  await killedAt("take-online:after-part", ["online", "take-online", fake.url, "--cwd", cwd]);
  const saved = (await readCredentials()).services[serviceUrl(fake.url)]!;
  // Someone signs in as another account right after the identity check.
  fake.onMe(async () => {
    fake.onMe(undefined);
    await saveCredentials(fake.url, { ...saved, accessToken: "pbm_other-account" });
  });
  await stopTakeOnline(cwd);
  assert.deepEqual([...fake.transfers.values()].map((transfer) => transfer.state), ["aborted"], "the upload was cancelled by the account that started it");
  assert.equal(await storage.pathExists(join(before.planningRoot, "online-transfer.json")), false);
  await saveCredentials(fake.url, saved);
});

test("the board page starts one move at a time, explains a failed move from where the board stands, and stops a move when it closes", async () => {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  let server = await startServer({ cwd, port, useVite: false });
  const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const finished = async (id: string) => {
    for (;;) {
      const job = await (await fetch(`${server.url}/api/boards/demo/online/job/${id}`)).json();
      if (job.status !== "running") return job;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    // Two tabs at once: only one move starts.
    fake.slowParts(200);
    const [first, second] = await Promise.all([post("/api/boards/demo/online/take-online", { url: fake.url }), post("/api/boards/demo/online/take-online", { url: fake.url })]);
    assert.deepEqual([first.status, second.status].sort(), [202, 409]);
    const started = await (first.status === 202 ? first : second).json();
    const stopped = await post("/api/boards/demo/online/stop", {});
    assert.equal((await stopped.json()).id, started.id, "Stop reaches the move that is running");
    assert.equal((await finished(started.id)).status, "stopped");
    fake.slowParts(0);

    // A failure whose clean-up cannot be confirmed says so, rather than promising nothing changed.
    fake.failParts(true);
    fake.failAbort(true);
    const uncertain = await finished((await (await post("/api/boards/demo/online/take-online", { url: fake.url })).json()).id);
    assert.equal(uncertain.status, "failed");
    assert.equal(uncertain.outcome.unchanged, false);
    assert.equal(uncertain.outcome.location, "local");
    assert.match(uncertain.outcome.message, /could not be removed yet/);
    assert.equal(uncertain.outcome.retry, "Continue");
    fake.failParts(false);
    fake.failAbort(false);
    assert.equal((await finished((await (await post("/api/boards/demo/online/take-online", { url: fake.url })).json()).id)).status, "succeeded");

    // A freeze whose answer was lost is confirmed with the service, not assumed not to have happened.
    fake.dropFenceReply();
    const lost = await finished((await (await post("/api/boards/demo/online/take-local", { removeOthers: true, expectedOthers: [] })).json()).id);
    assert.equal(lost.status, "failed");
    assert.equal(lost.outcome.unchanged, false);
    assert.match(lost.outcome.message, /read-only/);
    assert.equal((await finished((await (await post("/api/boards/demo/online/take-local", { removeOthers: true, expectedOthers: [] })).json()).id)).status, "succeeded");
    assert.equal((await finished((await (await post("/api/boards/demo/online/take-online", { url: fake.url })).json()).id)).status, "succeeded");

    // Take Local failing after the freeze says the board is frozen.
    fake.failExportDocs(true);
    const frozen = await finished((await (await post("/api/boards/demo/online/take-local", { removeOthers: true, expectedOthers: [] })).json()).id);
    assert.equal(frozen.status, "failed");
    assert.equal(frozen.outcome.location, "online");
    assert.match(frozen.outcome.message, /read-only/);
    assert.equal(frozen.outcome.retry, "Finish taking it local");
    fake.failExportDocs(false);
    assert.equal((await finished((await (await post("/api/boards/demo/online/take-local", { removeOthers: true, expectedOthers: [] })).json()).id)).status, "succeeded");

    // Closing the server stops a Take Online still copying, and removes its partial copy.
    const currentRoot = (await storage.loadState(cwd)).planningRoot;
    fake.slowParts(300);
    const copying = await (await post("/api/boards/demo/online/take-online", { url: fake.url })).json();
    assert.equal(copying.status, "running");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await server.close();
    fake.slowParts(0);
    assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
    assert.equal([...fake.transfers.values()].at(-1)!.state, "aborted");
    assert.equal(await storage.pathExists(join(currentRoot, "online-transfer.json")), false);
    server = await startServer({ cwd, port, useVite: false });
  } finally {
    fake.slowParts(0);
    await server.close();
  }
});

test("taking a shared board local says who loses access, and only goes ahead when confirmed", async () => {
  await takeOnline(fake.url, cwd);
  fake.members.push({ userId: "maya", role: "editor" });
  const refusal: any = await takeLocal(cwd).then(() => null, (error) => error);
  assert.ok(refusal instanceof PlanbanConfirmationNeeded, String(refusal));
  assert.match(refusal.message, /removes access for 1 other person\(s\), and their agents: maya \(editor\).*kept, read-only/s);
  assert.equal(fake.requests.some((req) => req.path.endsWith("/take-local/fence")), false, "nothing is frozen before confirming");
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  await takeLocal(cwd, { removeOthers: true });
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "local");
  assert.deepEqual(fake.members.map((member) => member.userId), ["dev-owner"]);
});

test("a sign-in the service no longer accepts asks the person to sign in again", async () => {
  fake.rejectAccess();
  await assert.rejects(onlineRequest(fake.url, "/api/v1/me"), (error: any) => error instanceof OnlineAuthenticationError && error.message.includes("online sign-in"));
  assert.equal(fake.requests.filter((req) => req.path === "/api/v1/me").length, 1, "no retry loop");
});
