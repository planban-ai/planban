import { PEOPLE_ONLY } from "../core/goals";
import express from "express";
import { spawn } from "node:child_process";
import { urlOpener } from "../core/openUrl";
import { randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import chokidar, { type ChokidarOptions, type FSWatcher } from "chokidar";
import type { ViteDevServer } from "vite";
import { defaultPlanbanRoot, PlanbanPathError } from "../core/paths";
import { ensureDemoBoard } from "../core/demo";
import {
  idempotencyFingerprint,
  LOCK_DIR,
  QUEUE_DIR,
  PlanbanIdempotencyConflictError,
  runIdempotentBoardMutation,
} from "../core/persistence";
import {
  archiveBoard,
  deleteBoard,
  duplicateBoard,
  listAllBoards,
  listBoards,
  registerBoardFromCwd,
  registerBoardFromState,
  resolveBoardCwd,
  restoreBoard,
  touchBoard,
} from "../core/registry";
import {
  getStatus,
  initializeProject,
  loadState,
  readManifest,
  moveCard,
  PlanbanConflictError,
  PlanbanNotFoundError,
  PlanbanValidationError,
  readDoc,
  readHistoryDoc,
  reorderCards,
  restoreBoardVersion,
  restoreCardVersion,
  restoreDocVersion,
  saveRoadmap,
  setCardStatus,
  setCardParent,
  updateCard,
  cardAncestry,
  writeDoc,
  createCard,
  createCards,
  createGroup,
  deleteArchivedCard,
  historyPayload,
  readGoals,
  editGoals,
  decideGoalSuggestion,
  loadHistoryState,
  exportFlatVersion1,
  reconstructHierarchy,
} from "../core/storage";
import { boardPath, OnlineAuthenticationError, onlineRequest } from "../core/online/client";
import { planbanCommand } from "../core/command";
import type { LiveWatch } from "../core/online/live";
import { registerOnlineRoutes } from "./onlineRoutes";
import { PLANBAN_STATUSES, type PlanbanHistoryActor, type PlanbanRoadmapItem, type PlanbanStatus } from "../core/types";
import { PlanbanQueryValidationError, queryWorkItems, workItemQueryFromSearchParams } from "../core/workItemQuery";
import {
  compareVersions,
  currentVersionInfo,
  PLANBAN_UPDATE_MANIFEST_URL,
  type PlanbanUpdateManifest,
} from "../core/version";
import { updatePreflight } from "../core/updatePreflight";
import { runPlanbanUpdate, type UpdateRunSnapshot } from "../core/updateRunner";
import { PlanbanActivityStore } from "../core/activity";
import { collectStaleness } from "../core/stalenessSources";
import { keptProgress } from "../core/boardOperations";
import { PlanbanEditConflictError } from "../core/conflicts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_ROOT = resolve(PACKAGE_ROOT, "src/web");
const DIST_WEB_ROOT = resolve(PACKAGE_ROOT, "dist/web");
const DIST_WEB_INDEX = resolve(DIST_WEB_ROOT, "index.html");
const UPDATE_CHECK_TIMEOUT_MS = 3500;
const CODEX_SESSION_FILE_LIMIT = 250;
const CODEX_SESSION_SCAN_BYTES = 2 * 1024 * 1024;
const CODEX_THREAD_LOOKUP_CACHE_TTL_MS = 10000;
const PLANBAN_WATCH_POLL_INTERVAL_MS = 1000;
const updateJobs = new Map<string, UpdateRunSnapshot>();
const codexThreadLookupCache = new Map<string, {
  expiresAt: number;
  result: { threadId: string; threadUrl: string; sessionPath: string } | null;
}>();

export interface ServeOptions {
  cwd: string;
  port: number;
  useVite: boolean;
  watcherFactory?: (paths: string[], options: ChokidarOptions) => FSWatcher;
}

export function isIgnoredPlanbanWatchPath(path: string): boolean {
  const root = defaultPlanbanRoot();
  const relativePath = relative(root, resolve(path));
  if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === "..") return false;
  const segments = relativePath.split(sep);
  // Reads take the board write lock too, so its folder comes and goes on every
  // board read; watching it would make each read tell the page to reload.
  if (segments.includes(LOCK_DIR) || segments.includes(QUEUE_DIR)) return true;
  return segments[0] === "repos" && segments[2] === "history";
}

export function planbanWatchPaths(): string[] {
  const root = defaultPlanbanRoot();
  return [join(root, "index.json"), join(root, "repos")];
}

export function planbanWatcherOptions(): ChokidarOptions {
  const usePolling = process.platform === "win32" || process.env.CHOKIDAR_USEPOLLING === "1";
  return {
    ignored: isIgnoredPlanbanWatchPath,
    ignoreInitial: true,
    persistent: false,
    ...(usePolling ? { usePolling: true, interval: PLANBAN_WATCH_POLL_INTERVAL_MS } : {}),
  };
}

function isStatus(value: string): value is PlanbanStatus {
  return PLANBAN_STATUSES.includes(value as PlanbanStatus);
}

function mutationOriginError(req: express.Request): string | null {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method.toUpperCase())) return null;

  const secFetchSite = req.header("Sec-Fetch-Site")?.trim().toLowerCase();
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return "Mutating Planban API requests must come from the local Planban origin.";
  }

  const origin = req.header("Origin")?.trim();
  if (!origin) return null;

  try {
    const parsedOrigin = new URL(origin);
    const requestHost = req.header("Host")?.trim().toLowerCase();
    if (!requestHost || parsedOrigin.host.toLowerCase() !== requestHost) {
      return "Mutating Planban API requests must come from the local Planban origin.";
    }
    if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") {
      return "Mutating Planban API requests must use an HTTP origin.";
    }
  } catch {
    return "Mutating Planban API requests must include a valid Origin header.";
  }

  return null;
}

function parseActor(value: unknown): PlanbanHistoryActor {
  return value === "agent" || value === "import" || value === "system" ? value : "user";
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return undefined;
  return value;
}

function optionalMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function optionalCreatePosition(value: unknown) {
  return value === "top" || value === "bottom" ? value : undefined;
}

function optionalBaseRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new PlanbanValidationError("baseRevision must be a non-negative integer.");
  }
  return value as number;
}

function parseCardUpdate(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlanbanValidationError("Card update body must be an object.");
  }
  const body = value as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const nullableText = (key: string) => {
    const field = body[key];
    if (field !== null && typeof field !== "string") {
      throw new PlanbanValidationError(`${key} must be a string or null.`);
    }
    return field as string | null;
  };
  if (!["title", "summary", "nextAction", "tags", "blockedBy", "metadata"].some(has)) {
    throw new PlanbanValidationError("Provide title, summary, nextAction, tags, blockedBy, or metadata.");
  }
  if (has("title") && (typeof body.title !== "string" || !body.title.trim())) {
    throw new PlanbanValidationError("title must be a non-empty string.");
  }
  if (has("tags") && (!Array.isArray(body.tags) || body.tags.some((entry) => typeof entry !== "string"))) {
    throw new PlanbanValidationError("tags must be an array of strings.");
  }
  if (has("metadata") && body.metadata !== null && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
    throw new PlanbanValidationError("metadata must be an object or null.");
  }
  return {
    title: has("title") ? (body.title as string) : undefined,
    summary: has("summary") ? nullableText("summary") : undefined,
    nextAction: has("nextAction") ? nullableText("nextAction") : undefined,
    tags: has("tags") ? body.tags as string[] : undefined,
    blockedBy: has("blockedBy") ? nullableText("blockedBy") : undefined,
    metadata: has("metadata") ? body.metadata as Record<string, unknown> | null : undefined,
    baseRevision: optionalBaseRevision(body.baseRevision),
  };
}

function openExternalUrl(url: string) {
  return new Promise<void>((resolveOpen, reject) => {
    const { command, args } = urlOpener(url);
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.unref();
    resolveOpen();
  });
}

function codexSessionsRoot() {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
}

function codexThreadUrl(threadId: string) {
  return `codex://threads/${threadId}`;
}

function readCodexThreadMeta(item: PlanbanRoadmapItem) {
  const metadata = item.metadata;
  const value = metadata && typeof metadata === "object" ? metadata.codexThread : null;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function updateItemCodexThreadMeta(
  item: PlanbanRoadmapItem,
  codexThread: Record<string, unknown>,
): PlanbanRoadmapItem {
  return {
    ...item,
    metadata: {
      ...(item.metadata ?? {}),
      codexThread: {
        ...readCodexThreadMeta(item),
        ...codexThread,
      },
    },
    updatedAt: new Date().toISOString(),
    ...keptProgress(item),
  };
}

function isUpdateManifest(value: unknown): value is PlanbanUpdateManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const postUpdateRoute = candidate.postUpdateRoute;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.version === "string" &&
    typeof candidate.pluginVersion === "string" &&
    typeof candidate.mcpVersion === "string" &&
    typeof candidate.storageSchemaVersion === "number" &&
    typeof candidate.minimumStorageSchemaVersion === "number" &&
    typeof candidate.publishedAt === "string" &&
    typeof candidate.sourceUrl === "string" &&
    typeof candidate.releaseNotesUrl === "string" &&
    (candidate.targetRef === undefined || typeof candidate.targetRef === "string") &&
    (candidate.targetCommit === undefined || typeof candidate.targetCommit === "string") &&
    typeof candidate.summary === "string" &&
    typeof candidate.updatePrompt === "string" &&
    (postUpdateRoute === undefined || postUpdateRoute === "tutorial" || postUpdateRoute === "board" || postUpdateRoute === "board-with-changelog") &&
    (candidate.tutorialVersion === undefined || typeof candidate.tutorialVersion === "number") &&
    (candidate.showTutorialWhenUpdatingFromBefore === undefined || typeof candidate.showTutorialWhenUpdatingFromBefore === "string") &&
    (candidate.changelogTitle === undefined || typeof candidate.changelogTitle === "string") &&
    (candidate.changelogSummary === undefined || typeof candidate.changelogSummary === "string")
  );
}

async function fetchLatestUpdateManifest(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const requestUrl = new URL(url);
    requestUrl.searchParams.set("_", Date.now().toString());
    const response = await fetch(requestUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "planban-update-check",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Update metadata returned HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    if (!isUpdateManifest(payload)) throw new Error("Update metadata did not match the Planban manifest schema");
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function updateStatus() {
  const current = currentVersionInfo();
  const metadataUrl = process.env.PLANBAN_UPDATE_MANIFEST_URL || PLANBAN_UPDATE_MANIFEST_URL;
  const checkedAt = new Date().toISOString();
  try {
    const latest = await fetchLatestUpdateManifest(metadataUrl);
    const updateAvailable = compareVersions(latest.version, current.version) > 0;
    const compatible = latest.minimumStorageSchemaVersion <= current.storageSchemaVersion;
    return {
      checkedAt,
      metadataUrl,
      current,
      latest,
      updateAvailable,
      compatible,
      checkError: null,
    };
  } catch (error) {
    return {
      checkedAt,
      metadataUrl,
      current,
      latest: null,
      updateAvailable: false,
      compatible: true,
      checkError: error instanceof Error ? error.message : "Update check failed",
    };
  }
}

async function recentCodexSessionFiles(root = codexSessionsRoot()) {
  const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
  const cutoffMs = Date.now() - 1000 * 60 * 60 * 24 * 14;

  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs < cutoffMs) return;
      files.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    }));
  }

  await visit(root);
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, CODEX_SESSION_FILE_LIMIT);
}

function threadIdFromSessionPath(path: string) {
  return path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? null;
}

function cacheCodexThreadLookup(
  key: string,
  result: { threadId: string; threadUrl: string; sessionPath: string } | null,
) {
  codexThreadLookupCache.set(key, {
    expiresAt: Date.now() + CODEX_THREAD_LOOKUP_CACHE_TTL_MS,
    result,
  });
  if (codexThreadLookupCache.size > 100) {
    const oldestKey = codexThreadLookupCache.keys().next().value;
    if (oldestKey) codexThreadLookupCache.delete(oldestKey);
  }
}

async function fileContainsLaunchToken(file: { path: string; size: number }, token: string) {
  if (file.size > CODEX_SESSION_SCAN_BYTES) {
    const handle = await open(file.path, "r").catch(() => null);
    if (!handle) return false;
    try {
      const bytesToRead = Math.min(file.size, CODEX_SESSION_SCAN_BYTES);
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, Math.max(0, file.size - bytesToRead));
      return buffer.toString("utf8").includes(token);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  let scannedBytes = 0;
  let tail = "";
  const stream = createReadStream(file.path, { encoding: "utf8" });
  for await (const chunk of stream) {
    scannedBytes += Buffer.byteLength(chunk);
    if (`${tail}${chunk}`.includes(token)) return true;
    tail = chunk.slice(Math.max(0, chunk.length - token.length + 1));
    if (scannedBytes > CODEX_SESSION_SCAN_BYTES) {
      stream.destroy();
      return false;
    }
  }
  return false;
}

async function findCodexThreadByLaunchToken(token: string) {
  const launchToken = token.trim();
  if (!launchToken) return null;
  const cacheKey = `${codexSessionsRoot()}:${launchToken}`;
  const cached = codexThreadLookupCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const files = await recentCodexSessionFiles();
  for (const file of files) {
    const threadId = threadIdFromSessionPath(file.path);
    if (!threadId) continue;
    if (await fileContainsLaunchToken(file, launchToken)) {
      const result = {
        threadId,
        threadUrl: codexThreadUrl(threadId),
        sessionPath: file.path,
      };
      cacheCodexThreadLookup(cacheKey, result);
      return result;
    }
  }
  cacheCodexThreadLookup(cacheKey, null);
  return null;
}

export async function startServer(options: ServeOptions) {
  const cwd = resolve(options.cwd);
  const app = express();
  const server = createHttpServer(app);
  let vite: ViteDevServer | null = null;
  let watcher: FSWatcher | null = null;
  let activitySweep: NodeJS.Timeout | null = null;
  let onlineRefresh: NodeJS.Timeout | null = null;
  let onlineRefreshRunning = false;
  let closeOnlineWatches = () => {};
  const onlineRevisions = new Map<string, number>();
  const onlineAbort = new AbortController();
  let onlineMoves: ReturnType<typeof registerOnlineRoutes> | null = null;
  // An Online Board is only polled while a browser is watching that board (it
  // polls /api/live?repoId=...), so an idle server, or one showing only local
  // boards, makes no hosted requests.
  const lastLiveRequestAt = new Map<string, number>();
  const activityStore = new PlanbanActivityStore();
  let liveVersion = 0;
  let stateVersion = 0;
  let boardsVersion = 0;
  let activityVersion = 0;
  const currentBoard = await registerBoardFromCwd(cwd).catch(() => null);

  // Binding the socket to loopback does not protect against DNS rebinding:
  // an arbitrary web hostname can resolve to this socket. Trust the actual
  // request authority before parsing bodies or serving any API or page.
  app.use((req, res, next) => {
    const host = req.header("Host") ?? "";
    const authority = /^(127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host);
    const port = authority?.[2] === undefined ? 80 : Number(authority[2]);
    if (!authority || port !== req.socket.localPort) {
      res.status(403).json({ error: "Planban requests must use this server's loopback address and port." });
      return;
    }
    next();
  });

  app.use(express.json({ limit: "4mb" }));

  app.use("/api", (req, res, next) => {
    const error = mutationOriginError(req);
    if (error) {
      res.status(403).json({ error });
      return;
    }
    next();
  });

  function sendEvent(event: string, _data: unknown) {
    liveVersion += 1;
    if (event === "state") stateVersion += 1;
    if (event === "boards") boardsVersion += 1;
    if (event === "activity") activityVersion += 1;
  }

  function activitySnapshot() {
    return { activities: activityStore.snapshot() };
  }

  function sendActivitySnapshot() {
    sendEvent("activity", activitySnapshot());
  }

  async function closeServer() {
    await onlineMoves?.dispose();
    onlineAbort.abort();
    if (onlineRefresh) {
      clearInterval(onlineRefresh);
      onlineRefresh = null;
    }
    closeOnlineWatches();
    if (activitySweep) {
      clearInterval(activitySweep);
      activitySweep = null;
    }
    await Promise.race([
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      }),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1000)),
    ]);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    if (watcher) {
      const closeWatcher = watcher.close();
      await Promise.race([
        closeWatcher,
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1000)),
      ]);
    }
    await vite?.close();
  }

  function scheduleRestartHandoff() {
    if (process.env.PLANBAN_DISABLE_AUTO_RESTART === "1") return;
    const scriptPath = resolve(PACKAGE_ROOT, "scripts/restart-planban-after-update.mjs");
    const restartLogFile = resolve(PACKAGE_ROOT, ".planban-restart.log");
    mkdirSync(dirname(restartLogFile), { recursive: true });
    const restartLogFd = openSync(restartLogFile, "a");
    const args = [
      scriptPath,
      "--parent-pid",
      String(process.pid),
      "--runtime-root",
      PACKAGE_ROOT,
      "--cwd",
      cwd,
      "--port",
      String(options.port),
    ];
    if (!options.useVite || existsSync(DIST_WEB_INDEX)) args.push("--no-vite");

    const child = spawn(process.execPath, args, {
      cwd: PACKAGE_ROOT,
      detached: true,
      stdio: ["ignore", restartLogFd, restartLogFd],
      env: {
        ...process.env,
        PLANBAN_RESTART_LOG_FILE: restartLogFile,
      },
    });
    child.unref();
    closeSync(restartLogFd);

    setTimeout(() => {
      const closeGracefully = closeServer();
      const forceExit = new Promise<void>((resolveForce) => {
        setTimeout(resolveForce, 2500);
      });
      void Promise.race([closeGracefully, forceExit]).finally(() => {
        process.exit(0);
      });
    }, 250);
  }

  function idempotencyKey(req: express.Request) {
    const header = req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
    if (header?.trim()) return header.trim();
    return typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : undefined;
  }

  async function runApiMutation<T>(
    req: express.Request,
    cwdForMutation: string,
    run: () => Promise<T>,
  ): Promise<{ replayed: boolean; value: T }> {
    const status = await getStatus(cwdForMutation);
    if (!status.initialized || !status.planningRoot) {
      return { replayed: false, value: await run() };
    }
    return runIdempotentBoardMutation({
      planningRoot: status.planningRoot,
      idempotencyKey: idempotencyKey(req),
      scope: `${req.method} ${req.route?.path ?? req.path}`,
      fingerprint: idempotencyFingerprint({
        params: req.params,
        body: req.body ?? null,
      }),
      run,
    });
  }

  app.get("/api/live", (req, res) => {
    if (typeof req.query.repoId === "string" && req.query.repoId) lastLiveRequestAt.set(req.query.repoId, Date.now());
    res.set("Cache-Control", "no-store").json({
      liveVersion,
      stateVersion,
      boardsVersion,
      activityVersion,
      ...activitySnapshot(),
    });
  });

  app.get("/api/events", (_req, res) => {
    // EventSource reconnects can outlive an in-app browser tab and exhaust its
    // per-origin connection pool. A 204 tells legacy clients to stop reconnecting.
    res.status(204).set("Cache-Control", "no-store").end();
  });

  activitySweep = setInterval(() => {
    if (activityStore.prune()) sendActivitySnapshot();
  }, 100);
  activitySweep.unref?.();

  app.get("/api/status", async (_req, res, next) => {
    try {
      const status = await getStatus(cwd);
      res.json({ ...status, currentRepoId: currentBoard?.repoId ?? ("repoId" in status ? status.repoId : null) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/update-status", async (_req, res, next) => {
    try {
      res.json(await updateStatus());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/update-preflight", async (_req, res, next) => {
    try {
      res.json(await updatePreflight({ runtimeRoot: PACKAGE_ROOT }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/update-run", async (req, res, next) => {
    try {
      const status = await updateStatus();
      if (!status.latest || !status.updateAvailable) {
        res.status(409).json({ error: "No Planban update is currently available." });
        return;
      }
      if (!status.compatible) {
        res.status(409).json({ error: "This update needs an agent-guided storage migration." });
        return;
      }

      const currentBoardUrl = typeof req.body?.currentBoardUrl === "string" ? req.body.currentBoardUrl : null;
      const id = randomUUID();
      const startedAt = new Date().toISOString();
      const pending: UpdateRunSnapshot = {
        id,
        status: "pending",
        startedAt,
        completedAt: null,
        installShape: "unknown",
        targetVersion: status.latest.version,
        targetRef: status.latest.targetRef ?? null,
        targetCommit: status.latest.targetCommit ?? null,
        currentBoardUrl,
        restartRequired: true,
        message: "Preparing Planban update...",
        error: null,
        transcriptPath: null,
        steps: [],
      };
      updateJobs.set(id, pending);

      void runPlanbanUpdate({
        id,
        runtimeRoot: PACKAGE_ROOT,
        latest: status.latest,
        currentBoardUrl,
        onSnapshot(snapshot) {
          updateJobs.set(id, snapshot);
          sendEvent("update-job", snapshot);
        },
      }).then((snapshot) => {
        updateJobs.set(id, snapshot);
        sendEvent("update-job", snapshot);
        if (snapshot.status === "succeeded" && snapshot.restartRequired) {
          scheduleRestartHandoff();
        }
      }).catch((error: unknown) => {
        const failed: UpdateRunSnapshot = {
          ...pending,
          status: "failed",
          completedAt: new Date().toISOString(),
          message: "Planban update failed.",
          error: error instanceof Error ? error.message : "Planban update failed.",
        };
        updateJobs.set(id, failed);
        sendEvent("update-job", failed);
      });

      res.status(202).json(pending);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/update-run/:id", (req, res) => {
    const job = updateJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Update job not found." });
      return;
    }
    res.json(job);
  });

  app.get("/api/boards", async (req, res, next) => {
    try {
      const includeArchived = req.query.includeArchived === "true";
      res.json({
        currentRepoId: currentBoard?.repoId ?? null,
        boards: includeArchived ? await listAllBoards() : await listBoards(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/archive", async (req, res, next) => {
    try {
      const board = await archiveBoard(req.params.repoId);
      sendEvent("boards", { repoId: req.params.repoId, action: "archive" });
      res.json({ board });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/restore", async (req, res, next) => {
    try {
      const board = await restoreBoard(req.params.repoId);
      sendEvent("boards", { repoId: req.params.repoId, action: "restore" });
      res.json({ board });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/duplicate", async (req, res, next) => {
    try {
      const repoId = typeof req.body?.repoId === "string" ? req.body.repoId.trim() : undefined;
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : undefined;
      const result = await duplicateBoard({ sourceRepoId: req.params.repoId, repoId, title });
      sendEvent("boards", { repoId: result.board.repoId, sourceRepoId: req.params.repoId, action: "duplicate" });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/boards/:repoId", async (req, res, next) => {
    try {
      const confirmRepoId = typeof req.body?.confirmRepoId === "string" ? req.body.confirmRepoId.trim() : "";
      if (confirmRepoId !== req.params.repoId) {
        res.status(422).json({ error: "confirmRepoId must match the board repo id" });
        return;
      }
      const result = await deleteBoard(req.params.repoId);
      sendEvent("boards", { repoId: req.params.repoId, action: "delete" });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/demo", async (_req, res, next) => {
    try {
      const state = await ensureDemoBoard();
      await registerBoardFromState(state, { kind: "demo" });
      sendEvent("state", { repoId: state.manifest.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/open-codex-thread", async (req, res, next) => {
    try {
      const url = typeof req.body?.url === "string" ? req.body.url : "";
      const parsed = new URL(url);
      if (parsed.protocol !== "codex:") {
        res.status(422).json({ error: "Only codex:// URLs can be opened from this endpoint" });
        return;
      }
      await openExternalUrl(parsed.toString());
      res.json({ opened: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/cards/:id/codex-thread/draft", async (req, res, next) => {
    try {
      const url = typeof req.body?.url === "string" ? req.body.url : "";
      const launchToken = typeof req.body?.launchToken === "string" ? req.body.launchToken.trim() : "";
      if (!launchToken) {
        res.status(422).json({ error: "launchToken is required" });
        return;
      }
      const parsed = new URL(url);
      if (parsed.protocol !== "codex:" || parsed.hostname !== "threads" || parsed.pathname !== "/new") {
        res.status(422).json({ error: "Only codex://threads/new URLs can be opened from this endpoint" });
        return;
      }

      const repoId = req.params.repoId as string;
      const cwdForBoard = await boardCwd(repoId, false);
      const { replayed, value: nextState } = await runApiMutation(req, cwdForBoard, async () => {
        const state = await loadState(cwdForBoard);
        let found = false;
        const roadmapItems = state.roadmap.roadmapItems.map((item) => {
          if (item.id !== req.params.id) return item;
          found = true;
          return updateItemCodexThreadMeta(item, {
            status: "pending",
            launchToken,
            draftOpenedAt: new Date().toISOString(),
            threadId: null,
            threadUrl: null,
          });
        });
        if (!found) {
          throw Object.assign(new Error("Card not found"), { statusCode: 404 });
        }

        const roadmap = await saveRoadmap(state, {
          ...state.roadmap,
          roadmapItems,
        }, {
          actor: "user",
          operation: "codex_thread.draft",
          summary: "Opened Codex thread draft",
          affectedCards: [req.params.id],
        });
        return { ...state, roadmap };
      });
      if (!replayed) await openExternalUrl(parsed.toString());
      sendEvent("state", { repoId: req.params.repoId, revision: nextState.roadmap.revision });
      res.json({ opened: true, state: nextState });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/cards/:id/codex-thread/sync", async (req, res, next) => {
    try {
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value: result } = await runApiMutation(req, cwdForBoard, async () => {
        const state = await loadState(cwdForBoard);
        const item = state.roadmap.roadmapItems.find((entry) => entry.id === req.params.id);
        if (!item) throw Object.assign(new Error("Card not found"), { statusCode: 404 });
        const meta = readCodexThreadMeta(item);
        const existingThreadId = typeof meta.threadId === "string" ? meta.threadId.trim() : "";
        if (existingThreadId) {
          return { linked: true, threadId: existingThreadId, threadUrl: codexThreadUrl(existingThreadId), state };
        }
        const token = typeof meta.launchToken === "string" ? meta.launchToken.trim() : "";
        if (!token) {
          return { linked: false, state };
        }

        const match = await findCodexThreadByLaunchToken(token);
        if (!match) {
          return { linked: false, pending: true, state };
        }

        const roadmapItems = state.roadmap.roadmapItems.map((entry) =>
          entry.id === req.params.id
            ? updateItemCodexThreadMeta(entry, {
                status: "linked",
                threadId: match.threadId,
                threadUrl: match.threadUrl,
                sessionPath: match.sessionPath,
                linkedAt: new Date().toISOString(),
              })
            : entry,
        );
        const roadmap = await saveRoadmap(state, {
          ...state.roadmap,
          roadmapItems,
        }, {
          actor: "system",
          operation: "codex_thread.link",
          summary: "Linked Codex thread to roadmap card",
          affectedCards: [req.params.id],
        });
        const nextState = { ...state, roadmap };
        return { linked: true, threadId: match.threadId, threadUrl: match.threadUrl, state: nextState };
      });
      if (result.linked && "state" in result) {
        sendEvent("state", { repoId: req.params.repoId, revision: result.state.roadmap.revision });
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/init", async (req, res, next) => {
    try {
      const state = await initializeProject({
        cwd,
        title: typeof req.body?.title === "string" ? req.body.title : undefined,
      });
      await registerBoardFromState(state);
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Reading a board records it as recently opened. Changing one does not:
   * a card write must take the board before writing anything, so it can give
   * up cleanly if another process is stuck holding it.
   */
  async function boardCwd(repoId: string, recordOpened = true) {
    const board = await resolveBoardCwd(repoId);
    if (recordOpened) await touchBoard(repoId);
    return board;
  }

  function activityString(value: unknown, name: string) {
    if (typeof value !== "string" || !value.trim()) throw new PlanbanValidationError(`${name} is required.`);
    return value.trim();
  }

  async function validateActivityTarget(repoId: string, cardId: string) {
    const cwdForBoard = await resolveBoardCwd(repoId);
    const state = await loadState(cwdForBoard);
    if (!state.roadmap.roadmapItems.some((item) => item.id === cardId)) {
      throw new PlanbanNotFoundError(`Planban card ${cardId} was not found.`);
    }
  }

  onlineMoves = registerOnlineRoutes(app, {
    resolveBoardCwd,
    changed(repoId) {
      sendEvent("boards", { repoId, action: "online" });
      sendEvent("state", { repoId });
    },
  });

  app.get("/api/boards/:repoId/activity", async (req, res, next) => {
    try {
      await resolveBoardCwd(req.params.repoId);
      res.json({ activities: activityStore.snapshot().filter((activity) => activity.repoId === req.params.repoId) });
    } catch (error) { next(error); }
  });

  app.post("/api/boards/:repoId/activity/start", async (req, res, next) => {
    try {
      const cardId = activityString(req.body?.cardId, "cardId");
      const leaseId = activityString(req.body?.leaseId, "leaseId");
      await validateActivityTarget(req.params.repoId, cardId);
      activityStore.begin({ repoId: req.params.repoId, cardId, leaseId });
      sendActivitySnapshot();
      res.status(202).json({ ok: true });
    } catch (error) { next(error); }
  });

  app.post("/api/boards/:repoId/activity/end", async (req, res, next) => {
    try {
      const cardId = activityString(req.body?.cardId, "cardId");
      const leaseId = activityString(req.body?.leaseId, "leaseId");
      await resolveBoardCwd(req.params.repoId);
      activityStore.end({ repoId: req.params.repoId, cardId, leaseId });
      sendActivitySnapshot();
      res.status(202).json({ ok: true });
    } catch (error) { next(error); }
  });

  app.get("/api/boards/:repoId/state", async (req, res, next) => {
    try {
      const state = await loadState(await boardCwd(req.params.repoId));
      // Advisory stale signals for the board chip; the git merge log and history index are cached in core.
      const staleness = await collectStaleness({ cwd: state.cwd, planningRoot: state.planningRoot, items: state.roadmap.roadmapItems, storage: state.manifest.storage });
      res.json({ ...state, staleness: { cards: staleness.cards, ...(staleness.notes?.length ? { notes: staleness.notes } : {}) } });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/boards/:repoId/health", async (req, res, next) => {
    try {
      const state = await loadState(await boardCwd(req.params.repoId));
      res.json({
        ok: true,
        repoId: state.manifest.repoId,
        revision: state.roadmap.revision,
        writerVersion: state.roadmap.writerVersion,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/boards/:repoId/cards", async (req, res, next) => {
    try {
      const state = await loadState(await boardCwd(req.params.repoId));
      res.json(state.roadmap.roadmapItems);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/exports/flat-v1", async (req, res, next) => {
    try {
      const exportId = typeof req.body?.exportId === "string" ? req.body.exportId : "";
      if (!exportId) throw new PlanbanValidationError("exportId is required.");
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value: result } = await runApiMutation(req, cwdForBoard, () => exportFlatVersion1({ cwd: cwdForBoard, exportId }));
      res.json(result);
    } catch (error) { next(error); }
  });

  app.post("/api/boards/:repoId/hierarchy/reconstruct", async (req, res, next) => {
    try {
      const groups = req.body?.groups ?? req.body?.programmes;
      if (!Array.isArray(groups)) throw new PlanbanValidationError("groups must be an array.");
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => reconstructHierarchy({
        cwd: cwdForBoard,
        groups,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) { next(error); }
  });

  app.get("/api/boards/:repoId/cards/query", async (req, res, next) => {
    try {
      const state = await loadState(await boardCwd(req.params.repoId));
      const params = new URL(req.originalUrl, "http://planban.local").searchParams;
      res.json({
        revision: state.roadmap.revision,
        ...queryWorkItems(state.roadmap.roadmapItems, workItemQueryFromSearchParams(params)),
      });
    } catch (error) {
      if (error instanceof PlanbanQueryValidationError) {
        res.status(422).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.post("/api/boards/:repoId/cards", async (req, res, next) => {
    try {
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      if (!title) {
        res.status(422).json({ error: "title is required" });
        return;
      }
      const status = typeof req.body?.status === "string" && isStatus(req.body.status)
        ? req.body.status
        : undefined;
      if (req.body?.parentId !== undefined && req.body.parentId !== null && (typeof req.body.parentId !== "string" || !req.body.parentId.trim())) {
        res.status(422).json({ error: "parentId must be a non-empty card id or null" });
        return;
      }
      const repoId = req.params.repoId as string;
      const cwdForBoard = await boardCwd(repoId, false);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => createCard({
        cwd: cwdForBoard,
        title,
        status,
        summary: typeof req.body?.summary === "string" ? req.body.summary : undefined,
        nextAction: typeof req.body?.nextAction === "string" ? req.body.nextAction : undefined,
        tags: optionalStringArray(req.body?.tags),
        metadata: optionalMetadata(req.body?.metadata),
        specMarkdown: typeof req.body?.specMarkdown === "string" ? req.body.specMarkdown : undefined,
        planMarkdown: typeof req.body?.planMarkdown === "string" ? req.body.planMarkdown : undefined,
        position: optionalCreatePosition(req.body?.position),
        afterId: typeof req.body?.afterId === "string" ? req.body.afterId : undefined,
        parentId: typeof req.body?.parentId === "string" ? req.body.parentId : null,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post(["/api/boards/:repoId/groups", "/api/boards/:repoId/programmes"], async (req, res, next) => {
    try {
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      if (!title) { res.status(422).json({ error: "title is required" }); return; }
      const summary = typeof req.body?.summary === "string" ? req.body.summary.trim() : undefined;
      const itemIds = req.body?.itemIds ?? req.body?.deliverableIds;
      if (itemIds !== undefined && (!Array.isArray(itemIds) || itemIds.some((id: unknown) => typeof id !== "string" || !id.trim()))) {
        res.status(422).json({ error: "itemIds must contain card ids" }); return;
      }
      if (req.body?.status !== undefined && (typeof req.body.status !== "string" || !isStatus(req.body.status))) {
        res.status(422).json({ error: `Invalid status: ${String(req.body.status)}` }); return;
      }
      const repoId = req.params.repoId as string;
      const cwdForBoard = await boardCwd(repoId, false);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => createGroup({
        cwd: cwdForBoard,
        title,
        summary,
        nextAction: typeof req.body?.nextAction === "string" ? req.body.nextAction : undefined,
        status: typeof req.body?.status === "string" ? req.body.status : undefined,
        itemIds,
        anchorId: typeof req.body?.anchorId === "string" ? req.body.anchorId : undefined,
        specMarkdown: typeof req.body?.specMarkdown === "string" ? req.body.specMarkdown : undefined,
        planMarkdown: typeof req.body?.planMarkdown === "string" ? req.body.planMarkdown : undefined,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) { next(error); }
  });

  app.post("/api/boards/:repoId/cards/batch", async (req, res, next) => {
    try {
      if (!Array.isArray(req.body?.titles) || req.body.titles.length === 0 || req.body.titles.some((title: unknown) => typeof title !== "string" || !title.trim())) {
        res.status(422).json({ error: "titles must contain at least one non-empty title" }); return;
      }
      if (req.body?.status !== undefined && (typeof req.body.status !== "string" || !isStatus(req.body.status))) {
        res.status(422).json({ error: `Invalid status: ${String(req.body.status)}` }); return;
      }
      if (req.body?.parentId !== undefined && req.body.parentId !== null && (typeof req.body.parentId !== "string" || !req.body.parentId.trim())) {
        res.status(422).json({ error: "parentId must be a non-empty card id or null" }); return;
      }
      const status = typeof req.body?.status === "string" && isStatus(req.body.status) ? req.body.status : undefined;
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => createCards({
        cwd: cwdForBoard, titles: req.body.titles, status,
        parentId: typeof req.body?.parentId === "string" ? req.body.parentId : null,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) { next(error); }
  });

  app.get("/api/boards/:repoId/cards/:id", async (req, res, next) => {
    try {
      const state = await loadState(await boardCwd(req.params.repoId));
      const card = state.roadmap.roadmapItems.find((item) => item.id === req.params.id);
      if (!card) {
        res.status(404).json({ error: "Card not found" });
        return;
      }
      res.json({ ...card, ancestry: cardAncestry(state.roadmap, card.id) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/boards/:repoId/cards/:id", async (req, res, next) => {
    try {
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const update = parseCardUpdate(req.body);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => updateCard({
        cwd: cwdForBoard,
        cardId: req.params.id,
        ...update,
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  function parseReorderItems(rawItems: unknown) {
    const items = Array.isArray(rawItems) ? rawItems : [];
    const parsed = items.map((item: unknown) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as { id?: unknown; status?: unknown };
      if (typeof entry.id !== "string" || typeof entry.status !== "string" || !isStatus(entry.status)) {
        return null;
      }
      return { id: entry.id, status: entry.status };
    });
    return parsed;
  }

  app.post("/api/boards/:repoId/cards/reorder", async (req, res, next) => {
    try {
      const parsed = parseReorderItems(req.body?.items);
      if (parsed.some((item: unknown) => item === null)) {
        res.status(422).json({ error: "Reorder payload must include items with valid id and status" });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => reorderCards({
        cwd: cwdForBoard,
        items: parsed as Array<{ id: string; status: PlanbanStatus }>,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/cards/:id/move", async (req, res, next) => {
    try {
      if (req.body?.status !== undefined && (typeof req.body.status !== "string" || !isStatus(req.body.status))) {
        res.status(422).json({ error: `Invalid status: ${String(req.body.status)}` });
        return;
      }
      if (req.body?.parentId !== undefined && req.body.parentId !== null && (typeof req.body.parentId !== "string" || !req.body.parentId.trim())) {
        res.status(422).json({ error: "parentId must be a non-empty card id or null" });
        return;
      }
      if (req.body?.afterId !== undefined && req.body.afterId !== null && typeof req.body.afterId !== "string") {
        res.status(422).json({ error: "afterId must be a card id or null" });
        return;
      }
      if (req.body?.status === undefined && req.body?.parentId === undefined && req.body?.afterId === undefined) {
        res.status(422).json({ error: "A status, parentId, or afterId is required" });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => moveCard({
        cwd: cwdForBoard,
        cardId: req.params.id,
        status: typeof req.body?.status === "string" ? req.body.status : undefined,
        parentId: req.body?.parentId === undefined ? undefined : req.body.parentId,
        afterId: req.body?.afterId === undefined ? undefined : req.body.afterId,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/cards/:id/parent", async (req, res, next) => {
    try {
      if (req.body?.parentId !== null && (typeof req.body?.parentId !== "string" || !req.body.parentId.trim())) {
        res.status(422).json({ error: "parentId must be a non-empty card id or null" });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => setCardParent({
        cwd: cwdForBoard,
        cardId: req.params.id,
        parentId: req.body.parentId,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) { next(error); }
  });

  for (const [route, status] of [
    ["complete", "complete"],
    ["archive", "archived"],
    ["restore", "pending"],
  ] as const) {
    app.post(`/api/boards/:repoId/cards/:id/${route}`, async (req, res, next) => {
      try {
        const cwdForBoard = await boardCwd(req.params.repoId, false);
        const { value: state } = await runApiMutation(req, cwdForBoard, () =>
          setCardStatus(cwdForBoard, req.params.id, status),
        );
        sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
        res.json(state);
      } catch (error) {
        next(error);
      }
    });
  }

  app.delete("/api/boards/:repoId/cards/:id", async (req, res, next) => {
    try {
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => deleteArchivedCard({
        cwd: cwdForBoard,
        cardId: req.params.id,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/boards/:repoId/cards/:id/docs/:kind", async (req, res, next) => {
    try {
      const kind = req.params.kind;
      if (kind !== "spec" && kind !== "plan") {
        res.status(404).json({ error: "Unknown doc kind" });
        return;
      }
      res.json(await readDoc({ cwd: await boardCwd(req.params.repoId), cardId: req.params.id, kind }));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/boards/:repoId/cards/:id/docs/:kind", async (req, res, next) => {
    try {
      const kind = req.params.kind;
      if (kind !== "spec" && kind !== "plan") {
        res.status(404).json({ error: "Unknown doc kind" });
        return;
      }
      const markdown = typeof req.body?.markdown === "string" ? req.body.markdown : "";
      const expectedMtimeMs =
        typeof req.body?.expectedMtimeMs === "number" || req.body?.expectedMtimeMs === null
          ? req.body.expectedMtimeMs
          : undefined;
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value: payload } = await runApiMutation(req, cwdForBoard, () => writeDoc({
        cwd: cwdForBoard,
        cardId: req.params.id,
        kind,
        markdown,
        expectedMtimeMs,
      }));
      sendEvent("state", { repoId: req.params.repoId, doc: payload.path });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  // Goals (owner decisions, 16 October 2026): the page reads them; people change them here.
  // Only the board page in a browser may change them: it names itself, and the browser marks
  // its requests same-origin. Agents use the suggestion tool instead (PEOPLE_ONLY).
  const fromBoardPage = (req: express.Request) => req.header("X-Planban-Client") === "web"
    && req.header("Sec-Fetch-Site")?.trim().toLowerCase() === "same-origin" && req.body?.actor !== "agent";
  app.get("/api/boards/:repoId/goals", async (req, res, next) => {
    try {
      const { page, revision } = await readGoals({ cwd: await boardCwd(req.params.repoId) });
      res.json({ ...page, revision });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/goals", async (req, res, next) => {
    try {
      if (!fromBoardPage(req)) {
        res.status(403).json({ error: PEOPLE_ONLY });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value } = await runApiMutation(req, cwdForBoard, () => editGoals({
        cwd: cwdForBoard, edit: req.body?.edit, baseRevision: optionalBaseRevision(req.body?.baseRevision), actor: "user",
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: value.revision });
      res.json({ ...value.page, revision: value.revision });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/goals/suggestions/:id", async (req, res, next) => {
    try {
      if (!fromBoardPage(req)) {
        res.status(403).json({ error: PEOPLE_ONLY });
        return;
      }
      const decision = req.body?.decision;
      if (decision !== "accept" && decision !== "dismiss") {
        res.status(422).json({ error: "decision is accept or dismiss" });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value } = await runApiMutation(req, cwdForBoard, () => decideGoalSuggestion({
        cwd: cwdForBoard, suggestionId: req.params.id, decision, baseRevision: optionalBaseRevision(req.body?.baseRevision), actor: "user",
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: value.revision });
      res.json({ ...value.page, revision: value.revision });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/boards/:repoId/history", async (req, res, next) => {
    try {
      res.json(await historyPayload(await boardCwd(req.params.repoId)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/boards/:repoId/history/:version", async (req, res, next) => {
    try {
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) {
        res.status(422).json({ error: "Invalid history version" });
        return;
      }
      res.json(await loadHistoryState({ cwd: await boardCwd(req.params.repoId), version }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/history/:version/restore-board", async (req, res, next) => {
    try {
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) {
        res.status(422).json({ error: "Invalid history version" });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => restoreBoardVersion({
        cwd: cwdForBoard,
        version,
        actor: parseActor(req.body?.actor),
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/history/:version/cards/:id/restore", async (req, res, next) => {
    try {
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) {
        res.status(422).json({ error: "Invalid history version" });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => restoreCardVersion({
        cwd: cwdForBoard,
        version,
        cardId: req.params.id,
        actor: parseActor(req.body?.actor),
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/boards/:repoId/history/:version/cards/:id/docs/:kind", async (req, res, next) => {
    try {
      const version = Number(req.params.version);
      const kind = req.params.kind;
      if (!Number.isInteger(version) || version < 1 || (kind !== "spec" && kind !== "plan")) {
        res.status(422).json({ error: "Invalid history document request" });
        return;
      }
      res.json(await readHistoryDoc({ cwd: await boardCwd(req.params.repoId), version, cardId: req.params.id, kind }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/history/:version/cards/:id/docs/:kind/restore", async (req, res, next) => {
    try {
      const version = Number(req.params.version);
      const kind = req.params.kind;
      if (!Number.isInteger(version) || version < 1 || (kind !== "spec" && kind !== "plan")) {
        res.status(422).json({ error: "Invalid history document restore request" });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId, false);
      const { value: payload } = await runApiMutation(req, cwdForBoard, () => restoreDocVersion({
        cwd: cwdForBoard,
        version,
        cardId: req.params.id,
        kind,
        actor: parseActor(req.body?.actor),
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { repoId: req.params.repoId, doc: payload.path });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/state", async (_req, res, next) => {
    try {
      res.json(await loadState(cwd));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards", async (_req, res, next) => {
    try {
      const state = await loadState(cwd);
      res.json(state.roadmap.roadmapItems);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards", async (req, res, next) => {
    try {
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      if (!title) {
        res.status(422).json({ error: "title is required" });
        return;
      }
      const status = typeof req.body?.status === "string" && isStatus(req.body.status)
        ? req.body.status
        : undefined;
      if (req.body?.parentId !== undefined && req.body.parentId !== null && (typeof req.body.parentId !== "string" || !req.body.parentId.trim())) {
        res.status(422).json({ error: "parentId must be a non-empty card id or null" });
        return;
      }
      const { value: state } = await runApiMutation(req, cwd, () => createCard({
        cwd,
        title,
        status,
        summary: typeof req.body?.summary === "string" ? req.body.summary : undefined,
        nextAction: typeof req.body?.nextAction === "string" ? req.body.nextAction : undefined,
        tags: optionalStringArray(req.body?.tags),
        metadata: optionalMetadata(req.body?.metadata),
        specMarkdown: typeof req.body?.specMarkdown === "string" ? req.body.specMarkdown : undefined,
        planMarkdown: typeof req.body?.planMarkdown === "string" ? req.body.planMarkdown : undefined,
        position: optionalCreatePosition(req.body?.position),
        afterId: typeof req.body?.afterId === "string" ? req.body.afterId : undefined,
        parentId: typeof req.body?.parentId === "string" ? req.body.parentId : null,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post(["/api/groups", "/api/programmes"], async (req, res, next) => {
    try {
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      if (!title) { res.status(422).json({ error: "title is required" }); return; }
      const summary = typeof req.body?.summary === "string" ? req.body.summary.trim() : undefined;
      const itemIds = req.body?.itemIds ?? req.body?.deliverableIds;
      if (itemIds !== undefined && (!Array.isArray(itemIds) || itemIds.some((id: unknown) => typeof id !== "string" || !id.trim()))) {
        res.status(422).json({ error: "itemIds must contain card ids" }); return;
      }
      if (req.body?.status !== undefined && (typeof req.body.status !== "string" || !isStatus(req.body.status))) {
        res.status(422).json({ error: `Invalid status: ${String(req.body.status)}` }); return;
      }
      const { value: state } = await runApiMutation(req, cwd, () => createGroup({
        cwd,
        title,
        summary,
        nextAction: typeof req.body?.nextAction === "string" ? req.body.nextAction : undefined,
        status: typeof req.body?.status === "string" ? req.body.status : undefined,
        itemIds,
        anchorId: typeof req.body?.anchorId === "string" ? req.body.anchorId : undefined,
        specMarkdown: typeof req.body?.specMarkdown === "string" ? req.body.specMarkdown : undefined,
        planMarkdown: typeof req.body?.planMarkdown === "string" ? req.body.planMarkdown : undefined,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) { next(error); }
  });

  app.post("/api/cards/batch", async (req, res, next) => {
    try {
      if (!Array.isArray(req.body?.titles) || req.body.titles.length === 0 || req.body.titles.some((title: unknown) => typeof title !== "string" || !title.trim())) {
        res.status(422).json({ error: "titles must contain at least one non-empty title" }); return;
      }
      if (req.body?.status !== undefined && (typeof req.body.status !== "string" || !isStatus(req.body.status))) {
        res.status(422).json({ error: `Invalid status: ${String(req.body.status)}` }); return;
      }
      if (req.body?.parentId !== undefined && req.body.parentId !== null && (typeof req.body.parentId !== "string" || !req.body.parentId.trim())) {
        res.status(422).json({ error: "parentId must be a non-empty card id or null" }); return;
      }
      const status = typeof req.body?.status === "string" && isStatus(req.body.status) ? req.body.status : undefined;
      const { value: state } = await runApiMutation(req, cwd, () => createCards({
        cwd, titles: req.body.titles, status,
        parentId: typeof req.body?.parentId === "string" ? req.body.parentId : null,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { revision: state.roadmap.revision }); res.json(state);
    } catch (error) { next(error); }
  });

  app.get("/api/cards/:id", async (req, res, next) => {
    try {
      const state = await loadState(cwd);
      const card = state.roadmap.roadmapItems.find((item) => item.id === req.params.id);
      if (!card) {
        res.status(404).json({ error: "Card not found" });
        return;
      }
      res.json({ ...card, ancestry: cardAncestry(state.roadmap, card.id) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/cards/:id", async (req, res, next) => {
    try {
      const update = parseCardUpdate(req.body);
      const { value: state } = await runApiMutation(req, cwd, () => updateCard({
        cwd,
        cardId: req.params.id,
        ...update,
      }));
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/reorder", async (req, res, next) => {
    try {
      const parsed = parseReorderItems(req.body?.items);
      if (parsed.some((item: unknown) => item === null)) {
        res.status(422).json({ error: "Reorder payload must include items with valid id and status" });
        return;
      }
      const { value: state } = await runApiMutation(req, cwd, () => reorderCards({
        cwd,
        items: parsed as Array<{ id: string; status: PlanbanStatus }>,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/:id/move", async (req, res, next) => {
    try {
      if (req.body?.status !== undefined && (typeof req.body.status !== "string" || !isStatus(req.body.status))) {
        res.status(422).json({ error: `Invalid status: ${String(req.body.status)}` });
        return;
      }
      if (req.body?.parentId !== undefined && req.body.parentId !== null && (typeof req.body.parentId !== "string" || !req.body.parentId.trim())) {
        res.status(422).json({ error: "parentId must be a non-empty card id or null" });
        return;
      }
      if (req.body?.afterId !== undefined && req.body.afterId !== null && typeof req.body.afterId !== "string") {
        res.status(422).json({ error: "afterId must be a card id or null" });
        return;
      }
      if (req.body?.status === undefined && req.body?.parentId === undefined && req.body?.afterId === undefined) {
        res.status(422).json({ error: "A status, parentId, or afterId is required" });
        return;
      }
      const { value: state } = await runApiMutation(req, cwd, () => moveCard({
        cwd,
        cardId: req.params.id,
        status: typeof req.body?.status === "string" ? req.body.status : undefined,
        parentId: req.body?.parentId === undefined ? undefined : req.body.parentId,
        afterId: req.body?.afterId === undefined ? undefined : req.body.afterId,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/:id/parent", async (req, res, next) => {
    try {
      if (req.body?.parentId !== null && (typeof req.body?.parentId !== "string" || !req.body.parentId.trim())) {
        res.status(422).json({ error: "parentId must be a non-empty card id or null" });
        return;
      }
      const { value: state } = await runApiMutation(req, cwd, () => setCardParent({
        cwd,
        cardId: req.params.id,
        parentId: req.body.parentId,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) { next(error); }
  });

  for (const [route, status] of [
    ["complete", "complete"],
    ["archive", "archived"],
    ["restore", "pending"],
  ] as const) {
    app.post(`/api/cards/:id/${route}`, async (req, res, next) => {
      try {
        const { value: state } = await runApiMutation(req, cwd, () => setCardStatus(cwd, req.params.id, status));
        sendEvent("state", { revision: state.roadmap.revision });
        res.json(state);
      } catch (error) {
        next(error);
      }
    });
  }

  app.delete("/api/cards/:id", async (req, res, next) => {
    try {
      const { value: state } = await runApiMutation(req, cwd, () => deleteArchivedCard({
        cwd,
        cardId: req.params.id,
        baseRevision: optionalBaseRevision(req.body?.baseRevision),
      }));
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:id/docs/:kind", async (req, res, next) => {
    try {
      const kind = req.params.kind;
      if (kind !== "spec" && kind !== "plan") {
        res.status(404).json({ error: "Unknown doc kind" });
        return;
      }
      res.json(await readDoc({ cwd, cardId: req.params.id, kind }));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/cards/:id/docs/:kind", async (req, res, next) => {
    try {
      const kind = req.params.kind;
      if (kind !== "spec" && kind !== "plan") {
        res.status(404).json({ error: "Unknown doc kind" });
        return;
      }
      const markdown = typeof req.body?.markdown === "string" ? req.body.markdown : "";
      const expectedMtimeMs =
        typeof req.body?.expectedMtimeMs === "number" || req.body?.expectedMtimeMs === null
          ? req.body.expectedMtimeMs
          : undefined;
      const { value: payload } = await runApiMutation(req, cwd, () =>
        writeDoc({ cwd, cardId: req.params.id, kind, markdown, expectedMtimeMs }),
      );
      sendEvent("state", { doc: payload.path });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  if (options.useVite) {
    const viteModule = await import("vite");
    vite = await viteModule.createServer({
      server: { middlewareMode: true },
      appType: "spa",
      root: WEB_ROOT,
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(DIST_WEB_ROOT));
    app.get(/.*/, async (_req, res, next) => {
      try {
        res.type("html").send(await readFile(DIST_WEB_INDEX, "utf8"));
      } catch (error) {
        next(error);
      }
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    const statusCode = error && typeof error === "object" && "statusCode" in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : null;
    const responseStatus = Number.isInteger(statusCode)
      ? statusCode as number
      : error instanceof PlanbanNotFoundError
        ? 404
        : error instanceof PlanbanConflictError || error instanceof PlanbanIdempotencyConflictError
        ? 409
        : error instanceof PlanbanPathError || error instanceof PlanbanValidationError
          ? 422
          : 500;
    // A missing or ended Online Board sign-in: the board page offers Sign in for this service.
    const signIn = error instanceof OnlineAuthenticationError ? error.signIn : undefined;
    // A refused edit on an online board: what changed, by whom, and the current value, for the page.
    const conflict = error instanceof PlanbanEditConflictError ? error.conflict : undefined;
    res.status(responseStatus).json({ error: message, ...(signIn ? { signInNeeded: signIn.url, signedOut: signIn.reason, signInCommand: `${planbanCommand()} online sign-in ${signIn.url}`, ...(signIn.account !== undefined ? { signInAccount: signIn.account } : {}) } : {}), ...(conflict ? { conflict, currentRevision: conflict.currentRevision } : {}) });
  });

  try {
    const watcherFactory = options.watcherFactory ?? chokidar.watch;
    watcher = watcherFactory(planbanWatchPaths(), planbanWatcherOptions());
    const activeWatcher = watcher;
    activeWatcher.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Planban file watcher disabled after an error: ${message}\n`);
      if (watcher === activeWatcher) watcher = null;
      void activeWatcher.close().catch((closeError) => {
        const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
        process.stderr.write(`Planban file watcher cleanup failed: ${closeMessage}\n`);
      });
    });
    activeWatcher.on("all", (_event: string, path: string) => sendEvent("state", { path }));
  } catch {
    // Uninitialized projects can still be served so the UI can show onboarding.
  }

  // Online authority has no local file events. For each Online Board a browser
  // is watching, subscribe to its revision (Convex pushes changes) and raise
  // the same state signal the board page already polls. Services without live
  // updates are checked every few seconds instead, without overlapping checks.
  // A board whose subscription is unavailable or failed is checked every few
  // seconds instead, and the subscription is retried after a minute.
  const SUBSCRIBE_RETRY_MS = 60_000;
  type WatchState = { repoId: string; mode: "starting" } | { repoId: string; mode: "live"; watch: LiveWatch } | { repoId: string; mode: "poll"; retryAt: number };
  const onlineWatches = new Map<string, WatchState>();
  const signalRevision = (key: string, repoId: string, revision: number) => {
    if (onlineRevisions.get(key) !== revision && onlineRefresh) {
      onlineRevisions.set(key, revision);
      sendEvent("state", { repoId });
    }
  };
  const fallBackToPolling = (key: string, repoId: string, retryAt = Date.now() + SUBSCRIBE_RETRY_MS) => {
    const entry = onlineWatches.get(key);
    if (entry?.mode === "live") void entry.watch.close().catch(() => undefined);
    if (entry) onlineWatches.set(key, { repoId, mode: "poll", retryAt });
  };
  const dropWatch = (key: string) => {
    const entry = onlineWatches.get(key);
    onlineWatches.delete(key);
    if (entry?.mode === "live") void entry.watch.close().catch(() => undefined);
  };
  closeOnlineWatches = () => {
    for (const key of [...onlineWatches.keys()]) dropWatch(key);
  };
  onlineRefresh = setInterval(() => {
    if (onlineRefreshRunning) return;
    const now = Date.now();
    for (const [repoId, at] of lastLiveRequestAt) if (now - at > 15_000) lastLiveRequestAt.delete(repoId);
    for (const [key, entry] of onlineWatches) if (!lastLiveRequestAt.has(entry.repoId)) dropWatch(key);
    if (lastLiveRequestAt.size === 0) return;
    onlineRefreshRunning = true;
    void (async () => {
      const boards = (await listBoards()).filter((board) => lastLiveRequestAt.has(board.repoId));
      await Promise.all([...new Set(boards.map((board) => board.cwd))].map(async (boardCwd) => {
        if (!onlineRefresh) return;
        try {
          const manifest = await readManifest(boardCwd);
          if (!manifest?.enabled || manifest.storage?.kind !== "online" || !lastLiveRequestAt.has(manifest.repoId)) return;
          const storage = manifest.storage;
          const repoId = manifest.repoId;
          const key = `${storage.url}/${storage.boardId}`;
          let entry = onlineWatches.get(key);
          if (entry?.mode === "poll" && Date.now() >= entry.retryAt) {
            onlineWatches.delete(key);
            entry = undefined;
          }
          if (!entry) {
            onlineWatches.set(key, { repoId, mode: "starting" });
            try {
              const { watchRevision } = await import("../core/online/live");
              const watch = await watchRevision(storage.url, storage.boardId,
                (revision) => signalRevision(key, repoId, revision),
                () => fallBackToPolling(key, repoId));
              if (onlineWatches.get(key)?.mode !== "starting" || !onlineRefresh) {
                await watch?.close();
                return;
              }
              // A service without live updates is always checked instead.
              if (watch) onlineWatches.set(key, { repoId, mode: "live", watch });
              else onlineWatches.set(key, { repoId, mode: "poll", retryAt: Infinity });
            } catch {
              onlineWatches.set(key, { repoId, mode: "poll", retryAt: Date.now() + SUBSCRIBE_RETRY_MS });
            }
            entry = onlineWatches.get(key);
          }
          if (entry?.mode !== "poll") return;
          const remote = await onlineRequest<{ revision: number }>(storage.url, boardPath(storage.boardId, `/changes?since=${onlineRevisions.get(key) ?? 0}&waitMs=0`), undefined, { signal: onlineAbort.signal });
          signalRevision(key, repoId, remote.revision);
        } catch {
          // Foreground reads surface connectivity/authentication errors. Never
          // replace remote authority with an editable offline copy.
        }
      }));
    })().catch(() => undefined).finally(() => { onlineRefreshRunning = false; });
  }, 3000);
  onlineRefresh.unref();

  await new Promise<void>((resolveListen) => {
    server.listen(options.port, "127.0.0.1", resolveListen);
  });

  return {
    url: `http://127.0.0.1:${options.port}`,
    close: closeServer,
  };
}
