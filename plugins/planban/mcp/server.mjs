import { spawn } from "node:child_process";
import readline from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePlanbanRuntime } from "../scripts/runtime-root.mjs";
import { planbanProjectDir } from "../scripts/project-dir.mjs";
import { planbanActivityBaseUrl, startPlanbanMcpActivity } from "./activity.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PLANBAN_RUNTIME_ROOT = resolvePlanbanRuntime(PLUGIN_ROOT);
const HAS_BUILT_WEB_BUNDLE = existsSync(resolve(PLANBAN_RUNTIME_ROOT, "dist/web/index.html"));
const storageModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/storage.ts")).href);
const registryModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/registry.ts")).href);
const typesModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/types.ts")).href);
const queryModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/workItemQuery.ts")).href);
const demoModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/demo.ts")).href);
const versionModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/version.ts")).href);
const stalenessModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/staleness.ts")).href);
const stalenessSourcesModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/stalenessSources.ts")).href);
const contentRulesModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/contentRules.ts")).href);
const moveFilesOutModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/moveFilesOut.ts")).href);
const errorReportModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/errorReport.ts")).href);
const accountsModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/online/accounts.ts")).href);
const goalsModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/goals.ts")).href);
const { inboxForAgents, landingNote, parseLandingRef } = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/landings.ts")).href);

const { cardAncestry, clearLanding, createCard, createCards, createGroup, dropChange, exportFlatVersion1, getStatus, historyPayload, loadState, moveCard, notePresence, readDoc, readDocSections, readGoals, readGoalsBlock, reconstructHierarchy, setCardParent, suggestGoalChange, unresolvedChanges, updateCard, workingOnCard, writeDoc, writeDocSection } = storageModule;
const { goalsPageText } = goalsModule;
const { UPDATE_HOW } = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/clientVersion.ts")).href);
const { archiveBoard, deleteBoard, duplicateBoard, listAllBoards, listBoards, resolveBoardCwd, restoreBoard } = registryModule;
const { PLANBAN_STATUSES } = typesModule;
const { queryWorkItems } = queryModule;
const { ensureDemoBoard } = demoModule;
const { PLANBAN_MCP_VERSION } = versionModule;
const { largeDocNote, stalenessAttention, stalenessLine } = stalenessModule;
const { collectStaleness, projectStaleness } = stalenessSourcesModule;
const { HOW_TO_REFER } = contentRulesModule;
const { moveFilesOut } = moveFilesOutModule;

// Planban is an index, not storage (owner decisions 18 and 20). Agents learn it from these words.
const INDEX_RULE = `Planban is an index, not file storage: a card holds only text (its fields, Spec, Plan and history), never files, and nothing is ever saved into a card's folder. ${HOW_TO_REFER}`;

const SERVER_NAME = "Planban MCP";
// The same filled icons as the hosted server: black on white for light interfaces, white on black for dark.
const SERVER_ICONS = [
  { src: "https://app.planban.ai/brand/icon-light.png", mimeType: "image/png", sizes: ["512x512"], theme: "light" },
  { src: "https://app.planban.ai/brand/icon-dark.png", mimeType: "image/png", sizes: ["512x512"], theme: "dark" },
];
const PLANBAN_MCP_INSTRUCTIONS = [
  "Prefer these tools for Planban reads and writes.",
  "Pass cwd (absolute repository path) or repoId.",
  "Before editing owner-facing content, read .planban/agent-context.md and follow the Planban protocol and Planban house style.",
  "Serialize writes, one at a time.",
  "Planban is an index, not file storage: link to files; planban_move_files_out tidies cards holding them.",
  "Complete is person-controlled: only when a person asks, confirms or waives review; set completionConfirmed true.",
  "Online Boards: card edits pass baseRevision, document writes their expectedMtimeMs; if refused as changed, reapply only what is still needed, tell the person if you drop it, never just resend; retry lost replies with the same idempotencyKey; never edit board files.",
  "Refusals say why; tell the person.",
  "move_card is the canonical placement operation.",
  "After an open or the complete logical mutation batch, include the clickable Board URL from userReply.markdown in the final reply.",
  "With an in-app browser, make at most one bounded attempt to show it; never reopen the board after every write.",
  "If boardUrlVerified is false, call planban_launch_board once before presenting it.",
  "A planban:<board>/<item> token is a Planban reference: resolve it with planban_get_card (repoId, cardId); trust the id over any quoted title.",
  "Admin, recovery and legacy tools need explicit profiles.",
].join(" ");
const SERVER_VERSION = PLANBAN_MCP_VERSION;
let clientAgentName = null;
const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export function planbanMcpServerVersion() {
  return SERVER_VERSION;
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function requireText(value, name) {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value;
}

function optionalString(value, name) {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
}

function optionalNullableString(value, name) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireString(value, name);
}

function optionalNumber(value, name) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  return value;
}

function optionalRevision(value, name) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function optionalBoolean(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function optionalStringArray(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} must be an array of strings.`);
  }
  return value;
}

function optionalMetadata(value, name) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object or null.`);
  }
  return value;
}

function requireDocKind(value) {
  const kind = requireString(value, "kind");
  if (kind !== "spec" && kind !== "plan") throw new Error("kind must be spec or plan.");
  return kind;
}

function requireStatus(value) {
  const status = requireString(value, "status");
  if (!PLANBAN_STATUSES.includes(status)) {
    throw new Error(`status must be one of: ${PLANBAN_STATUSES.join(", ")}.`);
  }
  return status;
}

function optionalStatus(value, name) {
  if (value === undefined || value === null) return undefined;
  return requireStatus(value, name);
}

function optionalCreatePosition(value, name) {
  if (value === undefined || value === null) return undefined;
  const position = requireString(value, name);
  if (position !== "top" && position !== "bottom") throw new Error(`${name} must be top or bottom.`);
  return position;
}

async function cwdFromArgs(args) {
  if (typeof args.cwd === "string" && args.cwd.trim()) return resolve(args.cwd);
  if (typeof args.repoId === "string" && args.repoId.trim()) return await resolveBoardCwd(args.repoId.trim());
  throw new Error("cwd or repoId is required.");
}

function summarizeBoard(state) {
  return {
    // Shared with the remote tools: boardId, title, revision, roadmapItems.
    boardId: state.manifest.repoId,
    title: state.roadmap.project.title,
    cwd: state.cwd,
    manifestPath: state.manifestPath,
    planningRoot: state.planningRoot,
    roadmapPath: state.roadmapPath,
    repoId: state.manifest.repoId,
    revision: state.roadmap.revision,
    project: state.roadmap.project,
    columns: state.roadmap.columns,
    roadmapItems: state.roadmap.roadmapItems,
  };
}

function compactBoardSummary(state) {
  const { roadmapItems, ...summary } = summarizeBoard(state);
  // A retried online edit says so, and which revision it first produced.
  return { ...summary, itemCount: roadmapItems.length, ...(state.onlineReplay ?? {}) };
}

const DEFAULT_BOARD_ORIGIN = "http://127.0.0.1:4317";
const BOARD_URL_PROBE_TIMEOUT_MS = 600;

function boardOrigin() {
  try {
    return planbanActivityBaseUrl(process.env);
  } catch {
    return DEFAULT_BOARD_ORIGIN;
  }
}

async function probeBoardHealth(origin, repoId, timeoutMs = BOARD_URL_PROBE_TIMEOUT_MS) {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${origin}/api/boards/${encodeURIComponent(repoId)}/health`, { signal: controller.signal });
    if (!response?.ok) {
      await response?.body?.cancel?.().catch(() => {});
      return false;
    }
    const payload = await response.json().catch(() => null);
    return payload?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Best-effort Board URL handoff for read and mutation results. Never starts the
// service and never throws; an unverified URL points agents at planban_launch_board.
async function boardHandoff(repoId) {
  const origin = boardOrigin();
  const url = `${origin}/boards/${encodeURIComponent(repoId)}`;
  const verified = await probeBoardHealth(origin, repoId).catch(() => false);
  return {
    boardUrl: url,
    boardUrlVerified: verified,
    userReply: verified
      ? { urlRequired: true, url, markdown: `[Open the verified board](${url})` }
      : { urlRequired: true, url, markdown: `[Open the board](${url})`, verifyWith: "planban_launch_board" },
  };
}

/** Who else is working on a card, for get_card; this agent is now working on it too. */
async function workingFor(cwd, cardId) {
  // Both at once, each with its own 5-second limit overall.
  const [, others] = await Promise.all([
    notePresence({ cwd, cardId, agentName: clientAgentName ?? undefined }),
    workingOnCard({ cwd, cardId, agentName: clientAgentName ?? undefined }).catch(() => []),
  ]);
  return others.length ? { workingOn: others } : {};
}

/** A card's unresolved changes, for get_card; nothing when there are none or the service can't be asked. */
async function unresolvedFor(cwd, cardId) {
  const result = await unresolvedChanges({ cwd, cardId }).catch(() => ({ changes: [] }));
  return result.changes.length ? { unresolvedChanges: result.changes } : {};
}

async function boardResult(text, repoId, structuredContent) {
  if (typeof repoId !== "string" || !repoId) return textResult(text, structuredContent);
  const handoff = await boardHandoff(repoId);
  const line = handoff.boardUrlVerified
    ? `Board URL: ${handoff.boardUrl}`
    : `Board URL: ${handoff.boardUrl} - verify with planban_launch_board before presenting.`;
  return textResult(`${text}\n${line}`, { ...structuredContent, ...handoff });
}

// Stale signals are advisory: they never block or fail a read.
async function boardStaleness(state) {
  return await collectStaleness({ cwd: state.cwd, planningRoot: state.planningRoot, items: state.roadmap.roadmapItems, storage: state.manifest.storage });
}

function withLine(text, line) {
  return line ? `${text}\n${line}` : text;
}

// A Spec or Plan over 100 KB is being appended to; say so whenever an agent reads or writes it.
function docSizeLine(payload) {
  if (typeof payload?.markdown !== "string" || (payload.kind !== "spec" && payload.kind !== "plan")) return null;
  const note = largeDocNote(payload.kind, Buffer.byteLength(payload.markdown, "utf8"));
  return note ? `${note}.` : null;
}

function signalsLine(signals) {
  const holding = signals?.find((signal) => signal.kind === "holds-files");
  const rest = (signals ?? []).filter((signal) => signal.kind !== "holds-files");
  const lines = [];
  if (holding) lines.push(`This card ${holding.detail.charAt(0).toLowerCase()}${holding.detail.slice(1)} or planban_move_files_out. Planban is an index, not file storage.`);
  if (rest.length) lines.push(`Stale signals: ${rest.map((signal) => `${signal.kind} (${signal.detail})`).join("; ")}. Re-read and fix the card in the same mutation batch if you own or touch it.`);
  return lines.length ? lines.join("\n") : null;
}

const METADATA_NOTE_BYTES = 4096;

function metadataNotes(card) {
  const bytes = card?.metadata ? Buffer.byteLength(JSON.stringify(card.metadata), "utf8") : 0;
  if (bytes <= METADATA_NOTE_BYTES) return [];
  return [`Metadata is ${Math.round(bytes / 1024)} KB. Consider moving evidence and ledgers into the Spec or Plan, or keeping them where they live and linking to them.`];
}

function findCard(state, cardId) {
  const card = state.roadmap.roadmapItems.find((item) => item.id === cardId);
  if (!card) throw new Error(`Card not found: ${cardId}`);
  return card;
}

function repoIdFromCwd(cwd) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(planbanProjectDir(cwd), ".planban/project.json"), "utf8"));
    return typeof manifest.repoId === "string" && manifest.repoId.trim() ? manifest.repoId.trim() : null;
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

async function verifyWebSurface(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (!body.includes('<div id="root"></div>')) throw new Error("response is not the Planban web surface");
    const parsedUrl = new URL(url);
    const boardMatch = parsedUrl.pathname.match(/^\/boards\/([^/]+)$/u);
    if (boardMatch) {
      const health = await fetch(`${parsedUrl.origin}/api/boards/${boardMatch[1]}/health`, { signal: controller.signal });
      if (!health.ok) throw new Error(`board health returned HTTP ${health.status}`);
      const payload = await health.json().catch(() => null);
      if (payload?.ok !== true) throw new Error("board health response was invalid");
    }
  } catch (error) {
    throw new Error(`Planban service resolved ${url}, but URL verification failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function verifiedLaunchResult({ cwd, port, started, url }) {
  return {
    ok: true,
    cwd,
    port,
    started,
    url,
    urlVerified: true,
    serviceReady: true,
    capabilities: {
      canonicalUrl: true,
      browserPresentation: "client-optional",
      userReplyRequiresUrl: true,
    },
    userReply: {
      urlRequired: true,
      url,
      markdown: `[Open the verified board](${url})`,
    },
    diagnostics: [
      {
        boundary: "service-url",
        status: "ready",
        code: started ? "service_started" : "service_reused",
      },
    ],
  };
}

async function statusFor(baseUrl) {
  return await fetchJson(`${baseUrl}/api/status`);
}

async function boardsFor(baseUrl) {
  return await fetchJson(`${baseUrl}/api/boards`);
}

async function waitForStatus(baseUrl, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await statusFor(baseUrl);
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw lastError ?? new Error("Timed out waiting for Planban.");
}

async function isPortOpen(port, timeoutMs = 750) {
  return await new Promise((resolveProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function boardUrl(baseUrl, status, cwd) {
  const targetRepoId = repoIdFromCwd(cwd);
  const statusRepoId = status.currentRepoId ?? status.repoId;

  if (targetRepoId && statusRepoId === targetRepoId) {
    return `${baseUrl}/boards/${encodeURIComponent(targetRepoId)}`;
  }

  const boards = await boardsFor(baseUrl).catch(() => null);
  const boardList = Array.isArray(boards?.boards) ? boards.boards : null;

  if (targetRepoId) {
    const hasTargetBoard = boardList?.some((board) => board.repoId === targetRepoId) ?? statusRepoId === targetRepoId;
    return hasTargetBoard ? `${baseUrl}/boards/${encodeURIComponent(targetRepoId)}` : `${baseUrl}/boards`;
  }

  if (boardList?.length === 1 && typeof boardList[0]?.repoId === "string") {
    return `${baseUrl}/boards/${encodeURIComponent(boardList[0].repoId)}`;
  }

  if (boardList && boardList.length !== 1) return `${baseUrl}/boards`;

  return statusRepoId ? `${baseUrl}/boards/${encodeURIComponent(statusRepoId)}` : `${baseUrl}/boards`;
}

async function launchBoard(args) {
  const cwd = optionalBoolean(args.demo, "demo") ? (await ensureDemoBoard()).cwd : await cwdFromArgs(args);
  const port = optionalNumber(args.port, "port") ?? 4317;
  if (!Number.isInteger(port) || port <= 0) throw new Error("port must be a positive integer.");
  const baseUrl = `http://127.0.0.1:${port}`;
  const existingStatus = await statusFor(baseUrl).catch(() => null);
  if (existingStatus) {
    const url = await boardUrl(baseUrl, existingStatus, cwd);
    await verifyWebSurface(url);
    return verifiedLaunchResult({ cwd, port, started: false, url });
  }

  if (await isPortOpen(port)) {
    throw new Error(`Port ${port} is already in use by another service. Stop that process or choose a different Planban port.`);
  }

  const repoRoot = process.env.PLANBAN_REPO_ROOT ? resolve(process.env.PLANBAN_REPO_ROOT) : resolve(process.cwd());
  const cliPath = resolve(repoRoot, "bin/planban.mjs");
  if (!existsSync(cliPath)) throw new Error(`Planban CLI not found at ${cliPath}`);

  const serveArgs = [cliPath, "serve", "--cwd", cwd, "--port", String(port)];
  if (HAS_BUILT_WEB_BUNDLE) serveArgs.push("--no-vite");

  const child = spawn(process.execPath, serveArgs, {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const status = await waitForStatus(baseUrl);
  const url = await boardUrl(baseUrl, status, cwd);
  await verifyWebSurface(url);
  return verifiedLaunchResult({ cwd, port, started: true, url });
}

const schema = {
  object(properties, required = []) {
    return {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    };
  },
};

const commonBoardProperties = {
  cwd: {
    type: "string",
    description: "Absolute path to a repository with .planban/project.json. Required unless repoId is provided.",
  },
  repoId: {
    type: "string",
    description: "Registered Planban repo id. Used only when cwd is omitted.",
  },
};

const tools = [
  {
    name: "planban_status",
    title: "Planban Status",
    description: "Check whether Planban is initialized for a repository, whether its board is local or online, and report live state paths.",
    inputSchema: schema.object(commonBoardProperties),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_list_boards",
    title: "List Planban Boards",
    description: "List the Planban boards registered on this device, local and online.",
    inputSchema: schema.object({
      includeArchived: { type: "boolean", description: "Include archived boards." },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_archive_board",
    title: "Archive Planban Board",
    description: "Archive a whole Planban board. This hides it from normal board lists but keeps local planning state intact.",
    inputSchema: schema.object({
      repoId: { type: "string", description: "Registered Planban repo id to archive." },
    }, ["repoId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_restore_board",
    title: "Restore Planban Board",
    description: "Restore an archived Planban board.",
    inputSchema: schema.object({
      repoId: { type: "string", description: "Registered Planban repo id to restore." },
    }, ["repoId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_duplicate_board",
    title: "Duplicate Planban Board",
    description: "Duplicate a whole Planban board into a new local Planban board. The source board is left untouched.",
    inputSchema: schema.object({
      sourceRepoId: { type: "string", description: "Registered Planban repo id to duplicate." },
      repoId: { type: "string", description: "Optional repo id for the duplicated board." },
      title: { type: "string", description: "Optional title for the duplicated board." },
    }, ["sourceRepoId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_delete_board",
    title: "Delete Planban Board",
    description: "Delete a whole local Planban board after creating a timestamped local backup. This never deletes the user's source project repository. An online board can't be deleted from a computer: this is refused, and says how its owner deletes it. With thisComputerOnly, an online board is only removed from this computer and stays online for everyone.",
    inputSchema: schema.object({
      repoId: { type: "string", description: "Registered Planban repo id to delete." },
      confirmRepoId: { type: "string", description: "Must exactly match repoId." },
      thisComputerOnly: { type: "boolean", description: "Online boards only: remove it from this computer's list and cache. The board itself stays online." },
    }, ["repoId", "confirmRepoId"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_get_board",
    title: "Get Planban Board",
    description: "Load one Planban board state for a repo path or registered repo id. Its attention section lists cards whose freshness needs fixing, and, on an Online Board with a linked GitHub repository, merged pull requests waiting in its inbox (landingInbox) to be assigned to a card or dismissed.",
    inputSchema: schema.object(commonBoardProperties),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_query_cards",
    title: "Query Planban Work Items",
    description: "Search and compose projection, hierarchy, Group-role, status, blocked, and tag filters without changing roadmap state.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      search: { type: "string", description: "Search id, title, summary, next action, and tags." },
      projection: { type: "string", enum: ["main", "group", "flattened"] },
      groupId: { type: "string", description: "Selected Group for Group projection or selected-Group scope." },
      hierarchyScope: { type: "string", enum: ["projection", "root", "owned", "leaf", "selected-group"] },
      groupRole: { type: "string", enum: ["any", "group", "item-only"] },
      statuses: { type: "array", items: { type: "string", enum: [...PLANBAN_STATUSES] } },
      blocked: { type: "string", enum: ["any", "blocked", "unblocked"] },
      tags: { type: "array", items: { type: "string" } },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_get_card",
    title: "Get Planban Card",
    description: "Read one Planban roadmap card and its metadata. On local boards it includes the linked document paths; read documents with planban_read_doc.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
    }, ["cardId"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_unresolved_changes",
    title: "Planban Unresolved Changes",
    description: "On an online board: agents' edits that were refused because something they touched changed since they read it, and are still waiting, with card, who, when, what each proposed and which fields clashed. planban_get_card includes a card's own. Save a reconsidered version of the same fields to settle one, or drop it with planban_drop_change and a reason.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Only this card's unresolved changes." },
    }, []),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_drop_change",
    title: "Drop Planban Unresolved Change",
    description: "On an online board: drop an unresolved change that is no longer needed (already covered, or overtaken), with a short reason. The card's history records it. Tell the person too.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      changeId: { type: "string", description: "The unresolved change's id." },
      reason: { type: "string", description: "Why it is dropped, in a sentence." },
      baseRevision: { type: "number", description: "Roadmap revision you last read." },
      idempotencyKey: { type: "string", description: "Reuse only to retry the same drop after a lost reply." },
    }, ["changeId", "reason", "baseRevision"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_clear_landing",
    title: "Clear a Planban Inbox Merge",
    description: "On an Online Board with a linked GitHub repository: take one merged pull request out of the board's inbox (planban_get_board's landingInbox). Assign it to the card it finished, which gets it as a landing note, or dismiss it with a reason when it needs no card (a release or dependency merge, say). Write what the merge means into the card first. Board history records it.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      pullRequest: { type: "string", description: "The inbox merge as owner/name#123, as the inbox lists it." },
      cardId: { type: "string", description: "The card it finished. Leave out to dismiss it." },
      reason: { type: "string", description: "Why it is dismissed, in a sentence." },
      idempotencyKey: { type: "string", description: "Reuse only to retry the same change after a lost reply." },
    }, ["pullRequest"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_history",
    title: "Planban Board History",
    description: "List recent changes to the board, newest first: what changed, when, and whether a person or an agent made it.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      limit: { type: "number", description: "Most recent entries to return. Defaults to 20." },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_read_goals",
    title: "Read Planban Goals",
    description: "Only when a board read lists goals: the board's whole Goals page, its goals in order with their notes, the Context section, suggestions waiting for the person, suggestions dismissed in the last 30 days, and retired goals. Board reads list only the goal statements.",
    inputSchema: schema.object(commonBoardProperties),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_suggest_goal_change",
    title: "Suggest a Planban Goals Change",
    description: "Leave one suggested change to the board's goals, with the evidence, on the Goals page for the person to accept or dismiss. Ask the person in chat first and use this only if they agree, or if no person is in the conversation (an unattended run). Only people change goals; agents can't edit them. A suggestion the person dismissed isn't shown again for 30 days.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      kind: { type: "string", enum: ["add", "reword", "reorder", "retire"] },
      goal: { type: "string", description: "reword, reorder, retire: the goal's number on the Goals page, or its id." },
      statement: { type: "string", description: "add, reword: the goal in one line." },
      notes: { type: "string", description: "add, reword: optional notes for the goal." },
      position: { type: "number", description: "add, reorder: where it goes, 1 for the top." },
      reason: { type: "string", description: "Why, with evidence the person can check, in a sentence or two." },
      idempotencyKey: { type: "string", description: "Reuse only to retry the same suggestion after a lost reply." },
    }, ["kind", "reason"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_export_flat_v1",
    title: "Export Recoverable Flat Version-1 Board",
    description: "Create a deliberate history-backed flat version-1 export without changing the live hierarchy.",
    inputSchema: schema.object({ ...commonBoardProperties, exportId: { type: "string" } }, ["exportId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_reconstruct_hierarchy",
    title: "Reconstruct Planban Hierarchy",
    description: "Atomically attach existing Work Items into explicit ordered Group mappings without recreating cards or documents.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      groups: { type: "array", items: { type: "object", properties: { id: { type: "string" }, childIds: { type: "array", items: { type: "string" } } }, required: ["id", "childIds"], additionalProperties: false } },
      baseRevision: { type: "number" },
    }, ["baseRevision"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_create_card",
    title: "Create Planban Card",
    description: `Create a Planban roadmap card with optional placement, tags, metadata, and initial spec or plan markdown. Follow the installed Planban house style for all owner-facing fields and documents. ${INDEX_RULE}`,
    inputSchema: schema.object({
      ...commonBoardProperties,
      title: { type: "string", description: "Card title." },
      status: { type: "string", enum: [...PLANBAN_STATUSES], description: "Initial status. Defaults to pending." },
      summary: { type: "string", description: "Optional card summary." },
      nextAction: { type: "string", description: "Optional next action." },
      tags: { type: "array", items: { type: "string" }, description: "Tags to attach." },
      metadata: { type: ["object", "null"], description: "Optional metadata object." },
      specMarkdown: { type: "string", description: "Optional initial spec markdown. A default spec is generated when omitted." },
      planMarkdown: { type: "string", description: "Optional initial plan markdown. Creates a plan document when supplied." },
      position: { type: "string", enum: ["top", "bottom"], description: "Insert at top or bottom of the target status column." },
      afterId: { type: "string", description: "Optional card id to insert after in the target status column." },
      parentId: { type: "string", description: "Optional existing Group id. Creates an owned Item." },
      completionConfirmed: { type: "boolean", description: "Required true when this would put a card in complete: only when a person on the board explicitly asks, confirms it after review or testing, or clearly waives review." },
      baseRevision: { type: "number", description: "Roadmap revision you last read, for stale-write protection. Optional on local boards; required on Online Boards." },
      idempotencyKey: { type: "string", description: "Online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores). Reuse it only to retry the same edit after a lost reply; a revised edit after a conflict gets a new key." },
    }, ["title"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_create_group",
    title: "Create Planban Group",
    description: "Create a distinct Group and place existing root Items inside it without changing their identities or documents. Follow the installed Planban house style. Agents should normally supply a concise objective unless explicitly asked not to.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      title: { type: "string", description: "Group title." },
      summary: { type: "string", description: "Group-level objective uniting its Items. Optional in storage and UI; agents should normally supply it unless explicitly asked not to." },
      nextAction: { type: "string", description: "Optional Group next action." },
      status: { type: "string", enum: [...PLANBAN_STATUSES], description: "Initial Group status." },
      itemIds: { type: "array", items: { type: "string" }, description: "Existing root Items to place inside the new Group." },
      anchorId: { type: "string", description: "Initial Item whose Main Board position the Group takes." },
      specMarkdown: { type: "string", description: "Optional initial Group spec markdown." },
      planMarkdown: { type: "string", description: "Optional initial Group plan markdown." },
      completionConfirmed: { type: "boolean", description: "Required true when this would put a card in complete: only when a person on the board explicitly asks, confirms it after review or testing, or clearly waives review." },
      baseRevision: { type: "number", description: "Roadmap revision you last read, for stale-write protection. Optional on local boards; required on Online Boards." },
      idempotencyKey: { type: "string", description: "Online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores). Reuse it only to retry the same edit after a lost reply; a revised edit after a conflict gets a new key." },
    }, ["title"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_create_cards",
    title: "Create Multiple Planban Cards",
    description: "Atomically create one or more sibling Work Item skeletons, optionally inside a Group. Follow the installed Planban house style and add current summaries, next actions, or document detail through focused follow-up mutations when the Items require them.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      titles: { type: "array", items: { type: "string" }, description: "One or more Work Item titles." },
      status: { type: "string", enum: [...PLANBAN_STATUSES], description: "Initial status. Defaults to pending." },
      parentId: { type: "string", description: "Optional parent Group id." },
      completionConfirmed: { type: "boolean", description: "Required true when this would put a card in complete: only when a person on the board explicitly asks, confirms it after review or testing, or clearly waives review." },
      baseRevision: { type: "number", description: "Roadmap revision you last read, for stale-write protection. Optional on local boards; required on Online Boards." },
      idempotencyKey: { type: "string", description: "Online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores). Reuse it only to retry the same edit after a lost reply; a revised edit after a conflict gets a new key." },
    }, ["titles"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_read_doc",
    title: "Read Planban Document",
    description: "Read a card spec or plan document.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      kind: { type: "string", enum: ["spec", "plan"], description: "Document kind to read." },
    }, ["cardId", "kind"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_move_card",
    title: "Place Planban Card",
    description:
      "Place an Item in one mutation: change status, move it into or out of an existing Group, and/or set its sibling rank. Groups cannot be placed inside Groups, and Items never become Groups through movement. Use null afterId for first position. Only use status complete when the user explicitly asks, confirms review/testing, or clearly waives user-side verification; set completionConfirmed true in that case. If refused because something changed since you read it, the refusal includes what changed, who changed it and the current version: apply only what is still needed, and tell the person if you drop or change your edit.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      status: { type: "string", enum: [...PLANBAN_STATUSES], description: "Optional target status." },
      parentId: { type: ["string", "null"], description: "Optional root Group/destination id, or null for the Main Board." },
      afterId: { type: ["string", "null"], description: "Optional sibling id to insert after, or null for first position." },
      baseRevision: { type: "number", description: "Roadmap revision you last read, for stale-write protection. Optional on local boards; required on Online Boards." },
      idempotencyKey: { type: "string", description: "Online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores). Reuse it only to retry the same edit after a lost reply; a revised edit after a conflict gets a new key." },
      completionConfirmed: {
        type: "boolean",
        description: "Required true when this would put a card in complete: only when a person on the board explicitly asks, confirms it after review or testing, or clearly waives review.",
      },
    }, ["cardId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_update_card",
    title: "Update Planban Card",
    description: `Update non-status card fields such as title, summary, next action, tags, blocked-by, or metadata. Follow the installed Planban house style when owner-facing content changes. ${INDEX_RULE} If refused because something changed since you read it, the refusal includes what changed, who changed it and the current version: apply only what is still needed, and tell the person if you drop or change your edit.`,
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      baseRevision: { type: "number", description: "Roadmap revision you last read, for stale-write protection. Optional on local boards; required on Online Boards." },
      idempotencyKey: { type: "string", description: "Online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores). Reuse it only to retry the same edit after a lost reply; a revised edit after a conflict gets a new key." },
      title: { type: "string", description: "New non-empty card title." },
      summary: { type: ["string", "null"], description: "New card summary, or null to clear." },
      nextAction: { type: ["string", "null"], description: "New next action, or null to clear." },
      tags: { type: "array", items: { type: "string" }, description: "Replacement tag list." },
      blockedBy: { type: ["string", "null"], description: "Blocking card id or null." },
      metadata: { type: ["object", "null"], description: "Metadata keys to set; other keys are kept. A key set to null is removed; null clears all metadata." },
    }, ["cardId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_set_card_parent",
    title: "Set Planban Card Parent",
    description: "Move an Item into an existing Group, or detach it to the Main Board. Groups cannot be attached and Items are never converted.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      parentId: { type: ["string", "null"], description: "Root Group/destination id, or null for the Main Board." },
      baseRevision: { type: "number", description: "Roadmap revision you last read, for stale-write protection. Optional on local boards; required on Online Boards." },
      idempotencyKey: { type: "string", description: "Online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores). Reuse it only to retry the same edit after a lost reply; a revised edit after a conflict gets a new key." },
    }, ["cardId", "parentId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_write_doc",
    title: "Write Planban Document",
    description: `Write a card Spec or Plan with optional stale-file protection. Follow the installed Planban house style, preserve the authoritative current section, and retain exact execution or evidence detail in its proper location. ${INDEX_RULE} Documents are limited to 1 MB; pictures stored inside a document (data: addresses) and base64 are refused. If refused because something changed since you read it, the refusal includes what changed, who changed it and the current version: apply only what is still needed, and tell the person if you drop or change your edit.`,
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      kind: { type: "string", enum: ["spec", "plan"], description: "Document kind to write." },
      markdown: { type: "string", description: "Full markdown contents." },
      expectedMtimeMs: { type: ["number", "null"], description: "The mtimeMs from planban_read_doc (null for a new document), for stale-write protection. Optional on local boards; required on Online Boards." },
      idempotencyKey: { type: "string", description: "Online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores). Reuse it only to retry the same edit after a lost reply; a revised edit after a conflict gets a new key." },
    }, ["cardId", "kind", "markdown"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_write_doc_section",
    title: "Write One Section of a Planban Document",
    description: "Replace one section of a card's Spec or Plan, by its heading, or add a new one. Pass the section's version from planban_read_doc (sections) as expectedSectionVersion, or null for a new section; only that section is checked, so edits to other sections never clash. markdown is the whole section, starting with its heading line. Follow the installed Planban house style. If refused because the section changed, the refusal includes the section as it is now: apply only what is still needed, and tell the person if you drop or change your edit.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      kind: { type: "string", enum: ["spec", "plan"], description: "Document kind." },
      heading: { type: "string", description: "The section's heading text, without the #s." },
      occurrence: { type: "number", description: "Which section with this heading (0 for the first), when headings repeat." },
      expectedSectionVersion: { type: ["string", "null"], description: "The section's version from planban_read_doc; null for a new section." },
      markdown: { type: "string", description: "The whole section, starting with its heading line." },
      after: { type: "string", description: "For a new section: the heading to put it after (else it goes at the end)." },
      idempotencyKey: { type: "string", description: "Online boards: reuse only to retry the same edit after a lost reply." },
    }, ["cardId", "kind", "heading", "expectedSectionVersion", "markdown"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_move_files_out",
    title: "Move Files Out of a Planban Card",
    description:
      "Tidy a card whose folder holds files, which Planban refuses to change until they are moved out. Moves every file in the card's folder, except its Spec and Plan, to the folder given in to (outside Planban, such as a folder in the project's repository), never overwriting or deleting anything, then adds a Files section to the card's Spec that refers to each file where it now lives, labelled with this machine's name. Run with dryRun true first and show the owner what would move; the owner chooses the destination.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      to: { type: "string", description: "Destination folder: an absolute path, or a path relative to the repository." },
      dryRun: { type: "boolean", description: "Report what would move, any paths that already exist there, and the Spec section, without changing anything." },
    }, ["cardId", "to"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_launch_board",
    title: "Launch Planban Board",
    description:
      "Start or discover the local Planban web app and return the verified board URL. Pass demo true to create/reuse the Planban Demo board. Open the returned URL in the host's in-app browser when one is available and the user wants the board visible. Every successful user-facing confirmation must still include the exact clickable URL, even when browser opening succeeds.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      demo: { type: "boolean", description: "Create or reuse the Planban Demo board instead of launching a specific repo board." },
      port: { type: "number", description: "Local port to use. Defaults to 4317." },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

const PROFILE_TOOL_NAMES = {
  admin: new Set([
    "planban_archive_board",
    "planban_restore_board",
    "planban_duplicate_board",
    "planban_delete_board",
  ]),
  maintenance: new Set([
    "planban_export_flat_v1",
    "planban_reconstruct_hierarchy",
  ]),
  legacy: new Set([
    "planban_set_card_parent",
  ]),
};

function advertisedTools() {
  const requested = new Set(
    String(process.env.PLANBAN_MCP_PROFILE ?? "default")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  if (requested.has("full")) return tools;
  return tools.filter((tool) => {
    if (PROFILE_TOOL_NAMES.admin.has(tool.name)) return requested.has("admin");
    if (PROFILE_TOOL_NAMES.maintenance.has(tool.name)) return requested.has("maintenance");
    if (PROFILE_TOOL_NAMES.legacy.has(tool.name)) return requested.has("legacy");
    return true;
  });
}

async function callToolImpl(name, args) {
  if (name === "planban_status") {
    const status = await getStatus(await cwdFromArgs(args));
    const board = status.initialized ? await projectStaleness(status.cwd) : null;
    const attention = board ? stalenessAttention(board.staleness, board.items, board.inbox) : null;
    const goals = status.initialized ? await readGoalsBlock(status.cwd) : null;
    return await boardResult(
      withLine(withLine(status.initialized ? `Planban is initialized for ${status.cwd}.` : `Planban is not initialized for ${status.cwd}.`, attention && stalenessLine(attention, "attention in this result")), goals),
      status.initialized ? status.repoId : null,
      // The Planban accounts signed in on this computer and which boards use each (emails only).
      { ...status, ...(attention ? { attention } : {}), ...(goals ? { goals } : {}), onlineAccounts: await accountsModule.listAccounts().catch(() => []) },
    );
  }

  if (name === "planban_list_boards") {
    const boards = optionalBoolean(args.includeArchived, "includeArchived") ? await listAllBoards() : await listBoards();
    return textResult(`Found ${boards.length} Planban board${boards.length === 1 ? "" : "s"}.`, { boards });
  }

  if (name === "planban_archive_board") {
    const board = await archiveBoard(requireString(args.repoId, "repoId"));
    return textResult(`Archived Planban board ${board.repoId}.`, { board });
  }

  if (name === "planban_restore_board") {
    const board = await restoreBoard(requireString(args.repoId, "repoId"));
    return textResult(`Restored Planban board ${board.repoId}.`, { board });
  }

  if (name === "planban_duplicate_board") {
    const result = await duplicateBoard({
      sourceRepoId: requireString(args.sourceRepoId, "sourceRepoId"),
      repoId: optionalString(args.repoId, "repoId"),
      title: optionalString(args.title, "title"),
    });
    return textResult(`Duplicated Planban board ${result.source.repoId} to ${result.board.repoId}.`, result);
  }

  if (name === "planban_delete_board") {
    const repoId = requireString(args.repoId, "repoId");
    const confirmRepoId = requireString(args.confirmRepoId, "confirmRepoId");
    if (confirmRepoId !== repoId) throw new Error("confirmRepoId must exactly match repoId.");
    const result = await deleteBoard(repoId, { thisComputerOnly: optionalBoolean(args.thisComputerOnly, "thisComputerOnly") === true });
    return textResult(
      result.removedFromThisComputerOnly
        ? `Removed online board ${repoId} from this computer. It is still online for everyone on it.`
        : result.backupPath
        ? `Deleted Planban board ${repoId}. A local backup was created at ${result.backupPath}.`
        : `Deleted Planban board ${repoId}. No planning root existed to back up.`,
      result,
    );
  }

  if (name === "planban_get_board") {
    const cwd = await cwdFromArgs(args);
    const state = await loadState(cwd);
    const attention = stalenessAttention(await boardStaleness(state), state.roadmap.roadmapItems, state.roadmap.landingInbox);
    const inbox = inboxForAgents(state.roadmap.landingInbox);
    const goals = await readGoalsBlock(cwd);
    // A board using features this Planban can't show: say so plainly, and how to update.
    const behind = state.planbanBehind ? `${state.planbanBehind.notice} ${UPDATE_HOW}` : null;
    return await boardResult(
      withLine(withLine(withLine(`Loaded Planban board ${state.manifest.repoId} at revision ${state.roadmap.revision}.`, behind), goals), stalenessLine(attention, "attention in this result")),
      state.manifest.repoId,
      { ...summarizeBoard(state), attention, ...(inbox.length ? { landingInbox: inbox } : {}), ...(goals ? { goals } : {}), ...(behind ? { planbanBehind: { ...state.planbanBehind, notice: behind } } : {}) },
    );
  }

  if (name === "planban_query_cards") {
    const cwd = await cwdFromArgs(args);
    const state = await loadState(cwd);
    const result = queryWorkItems(state.roadmap.roadmapItems, {
      search: optionalString(args.search, "search"),
      projection: optionalString(args.projection, "projection") === "programme" ? "group" : optionalString(args.projection, "projection"),
      groupId: optionalString(args.groupId, "groupId") ?? optionalString(args.programmeId, "programmeId"),
      hierarchyScope: optionalString(args.hierarchyScope, "hierarchyScope") === "selected-programme" ? "selected-group" : optionalString(args.hierarchyScope, "hierarchyScope"),
      groupRole: (() => {
        const role = optionalString(args.groupRole, "groupRole") ?? optionalString(args.programmeRole, "programmeRole");
        return role === "programme" ? "group" : role === "deliverable-only" ? "item-only" : role;
      })(),
      statuses: optionalStringArray(args.statuses, "statuses"),
      blocked: optionalString(args.blocked, "blocked"),
      tags: optionalStringArray(args.tags, "tags"),
    });
    const board = await boardStaleness(state);
    const staleness = Object.fromEntries(result.matches.flatMap((entry) => board.cards[entry.item.id] ? [[entry.item.id, board.cards[entry.item.id]]] : []));
    const staleCount = Object.keys(staleness).length;
    const stalenessNotes = board.notes ?? [];
    return textResult(withLine(withLine(
      `Matched ${result.matches.length} Planban Work Items at revision ${state.roadmap.revision}.`,
      staleCount ? `${staleCount} matched Item${staleCount === 1 ? " has" : "s have"} stale signals (see staleness).` : null,
    ), stalenessNotes.join(" ") || null), {
      cwd: state.cwd,
      repoId: state.manifest.repoId,
      revision: state.roadmap.revision,
      ...result,
      staleness,
      ...(stalenessNotes.length ? { stalenessNotes } : {}),
    });
  }

  if (name === "planban_get_card") {
    const cwd = await cwdFromArgs(args);
    const cardId = requireString(args.cardId, "cardId");
    const state = await loadState(cwd);
    const card = findCard(state, cardId);
    const board = await boardStaleness(state);
    const staleness = board.cards[card.id] ?? [];
    // Why some warnings may be missing (GitHub out of reach, not signed in, not fully checked yet).
    const stalenessNotes = board.notes ?? [];
    return textResult(withLine(withLine(`Loaded Planban card ${card.id}.`, signalsLine(staleness)), stalenessNotes.join(" ") || null), {
      cwd: state.cwd,
      repoId: state.manifest.repoId,
      revision: state.roadmap.revision,
      planningRoot: state.planningRoot,
      card,
      ancestry: cardAncestry(state.roadmap, cardId),
      // Pull requests that merged naming this card, as the board recorded them.
      ...(card.landings?.length ? { landingNotes: card.landings.map(landingNote) } : {}),
      staleness,
      ...(stalenessNotes.length ? { stalenessNotes } : {}),
      // Edits to this card that were refused and still wait, and who else is working on it (online boards; Spec point 20).
      ...await unresolvedFor(cwd, cardId),
      ...await workingFor(cwd, cardId),
    });
  }

  if (name === "planban_unresolved_changes") {
    const cwd = await cwdFromArgs(args);
    const result = await unresolvedChanges({ cwd, cardId: optionalString(args.cardId, "cardId") });
    return textResult(result.changes.length ? `${result.changes.length} unresolved change${result.changes.length === 1 ? "" : "s"} waiting.` : "No unresolved changes.", result);
  }

  if (name === "planban_drop_change") {
    const cwd = await cwdFromArgs(args);
    const state = await dropChange({
      cwd, changeId: requireString(args.changeId, "changeId"), reason: requireString(args.reason, "reason"),
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"), actor: "agent", idempotencyKey: optionalString(args.idempotencyKey, "idempotencyKey"),
    });
    return await boardResult(`Dropped unresolved change ${args.changeId}.`, state.manifest.repoId, compactBoardSummary(state));
  }

  if (name === "planban_clear_landing") {
    const cwd = await cwdFromArgs(args);
    const ref = parseLandingRef(requireString(args.pullRequest, "pullRequest"));
    if (!ref) throw new Error("Name the merge as owner/name#123, as the inbox lists it.");
    const cardId = optionalString(args.cardId, "cardId");
    const state = await clearLanding({
      cwd, ...ref, cardId, reason: optionalString(args.reason, "reason"), actor: "agent", idempotencyKey: optionalString(args.idempotencyKey, "idempotencyKey"),
    });
    const left = state.roadmap.landingInbox?.length ?? 0;
    return await boardResult(
      `${cardId ? `Assigned ${ref.repo}#${ref.number} to ${cardId}` : `Dismissed ${ref.repo}#${ref.number}`}; ${left} merge${left === 1 ? "" : "s"} left in the inbox.`,
      state.manifest.repoId,
      { ...compactBoardSummary(state), inboxLeft: left, ...(cardId ? { card: findCard(state, cardId) } : {}) },
    );
  }

  if (name === "planban_history") {
    const history = await historyPayload(await cwdFromArgs(args));
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(Math.floor(args.limit), 200) : 20;
    const entries = [...history.entries].sort((a, b) => b.version - a.version).slice(0, limit);
    return textResult(`${entries.length} most recent change${entries.length === 1 ? "" : "s"} of ${history.entries.length} kept.`, { currentVersion: history.currentVersion, entries });
  }

  if (name === "planban_read_goals") {
    const result = await readGoals({ cwd: await cwdFromArgs(args) });
    // The text in the structured part too, as the online server does: Claude Code shows agents only that part.
    const text = goalsPageText(result.page);
    return textResult(text, { revision: result.revision, text, ...result.page });
  }

  if (name === "planban_suggest_goal_change") {
    const cwd = await cwdFromArgs(args);
    const kind = requireString(args.kind, "kind");
    const change = { kind, goal: optionalString(args.goal, "goal"), statement: optionalString(args.statement, "statement"), notes: optionalString(args.notes, "notes"), position: args.position };
    const result = await suggestGoalChange({ cwd, change, reason: requireString(args.reason, "reason"), agentName: clientAgentName ?? undefined, idempotencyKey: optionalString(args.idempotencyKey, "idempotencyKey") });
    if (result.notAdded) return textResult(result.notAdded, { added: false, note: result.notAdded });
    const shown = result.page.suggestions.at(-1);
    return textResult(`Suggested to ${shown?.summary ?? "change the goals"}. It waits at the top of the Goals page for the person to accept or dismiss; tell them.`, { added: true, suggestion: shown, revision: result.revision });
  }

  if (name === "planban_export_flat_v1") {
    const result = await exportFlatVersion1({ cwd: await cwdFromArgs(args), exportId: requireString(args.exportId, "exportId"), actor: "agent" });
    return textResult(`Created recoverable flat version-1 export ${result.exportId}.`, result);
  }

  if (name === "planban_reconstruct_hierarchy") {
    const groups = args.groups ?? args.programmes;
    if (!Array.isArray(groups)) throw new Error("groups must be an array.");
    const result = await reconstructHierarchy({
      cwd: await cwdFromArgs(args),
      groups: groups.map((entry, index) => {
        const mapping = requireObject(entry, `groups[${index}]`);
        const childIds = optionalStringArray(mapping.childIds, `groups[${index}].childIds`);
        if (!childIds) throw new Error(`groups[${index}].childIds is required.`);
        return { id: requireString(mapping.id, `groups[${index}].id`), childIds };
      }),
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"), actor: "agent",
    });
    return await boardResult(`Reconstructed ${groups.length} Group mappings.`, result.manifest.repoId, { ...compactBoardSummary(result), cards: result.cards });
  }

  if (name === "planban_read_doc") {
    const cwd = await cwdFromArgs(args);
    // With each section's own version, for planban_write_doc_section.
    const payload = await readDocSections({
      cwd,
      cardId: requireString(args.cardId, "cardId"),
      kind: requireDocKind(args.kind),
    });
    void notePresence({ cwd, cardId: payload.cardId, agentName: clientAgentName ?? undefined }).catch(() => undefined);
    return textResult(
      payload.exists ? withLine(`Read ${payload.kind} document for ${payload.cardId}.`, docSizeLine(payload)) : `No ${payload.kind} document exists for ${payload.cardId}.`,
      payload,
    );
  }

  if (name === "planban_create_card") {
    const metadata = optionalMetadata(args.metadata, "metadata");
    const state = await createCard({
      cwd: await cwdFromArgs(args),
      title: requireString(args.title, "title"),
      status: optionalStatus(args.status, "status"),
      summary: optionalString(args.summary, "summary"),
      nextAction: optionalString(args.nextAction, "nextAction"),
      tags: optionalStringArray(args.tags, "tags"),
      metadata: metadata === null ? undefined : metadata,
      specMarkdown: args.specMarkdown === undefined ? undefined : requireText(args.specMarkdown, "specMarkdown"),
      planMarkdown: args.planMarkdown === undefined ? undefined : requireText(args.planMarkdown, "planMarkdown"),
      position: optionalCreatePosition(args.position, "position"),
      afterId: optionalString(args.afterId, "afterId"),
      parentId: optionalString(args.parentId, "parentId"),
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"),
      actor: "agent",
      idempotencyKey: optionalString(args.idempotencyKey, "idempotencyKey"),
      completionConfirmed: optionalBoolean(args.completionConfirmed, "completionConfirmed") === true,
    });
    const notes = metadataNotes(state.createdCard);
    return await boardResult(withLine(`Created Planban card ${state.createdCard.id}.`, notes[0]), state.manifest.repoId, {
      ...compactBoardSummary(state),
      card: state.createdCard,
      ...(notes.length ? { notes } : {}),
    });
  }

  if (name === "planban_create_cards") {
    const titles = optionalStringArray(args.titles, "titles");
    if (!titles?.length) throw new Error("titles must contain at least one title");
    const state = await createCards({
      cwd: await cwdFromArgs(args), titles,
      status: optionalStatus(args.status, "status"),
      parentId: optionalString(args.parentId, "parentId"),
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"), actor: "agent", idempotencyKey: optionalString(args.idempotencyKey, "idempotencyKey"),
      completionConfirmed: optionalBoolean(args.completionConfirmed, "completionConfirmed") === true,
    });
    return await boardResult(`Created ${state.createdCards.length} Planban cards.`, state.manifest.repoId, { ...compactBoardSummary(state), cards: state.createdCards });
  }

  if (name === "planban_create_group" || name === "planban_create_programme") {
    const itemIds = optionalStringArray(args.itemIds, "itemIds")
      ?? optionalStringArray(args.deliverableIds, "deliverableIds")
      ?? [];
    const state = await createGroup({
      cwd: await cwdFromArgs(args),
      title: requireString(args.title, "title"),
      summary: optionalString(args.summary, "summary"),
      nextAction: optionalString(args.nextAction, "nextAction"),
      status: optionalStatus(args.status, "status"),
      itemIds,
      anchorId: optionalString(args.anchorId, "anchorId"),
      specMarkdown: args.specMarkdown === undefined ? undefined : requireText(args.specMarkdown, "specMarkdown"),
      planMarkdown: args.planMarkdown === undefined ? undefined : requireText(args.planMarkdown, "planMarkdown"),
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"),
      actor: "agent",
      idempotencyKey: optionalString(args.idempotencyKey, "idempotencyKey"),
      completionConfirmed: optionalBoolean(args.completionConfirmed, "completionConfirmed") === true,
    });
    return await boardResult(`Created Group ${state.createdGroup.id} with ${itemIds.length} Items.`, state.manifest.repoId, {
      ...compactBoardSummary(state),
      group: state.createdGroup,
    });
  }

  if (name === "planban_move_card") {
    const status = optionalStatus(args.status, "status");
    const parentId = optionalNullableString(args.parentId, "parentId");
    const afterId = optionalNullableString(args.afterId, "afterId");
    if (status === undefined && parentId === undefined && afterId === undefined) {
      throw new Error("Provide status, parentId, or afterId.");
    }
    const state = await moveCard({
      cwd: await cwdFromArgs(args),
      cardId: requireString(args.cardId, "cardId"),
      status,
      parentId,
      afterId,
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"),
      actor: "agent",
      idempotencyKey: optionalString(args.idempotencyKey, "idempotencyKey"),
      completionConfirmed: optionalBoolean(args.completionConfirmed, "completionConfirmed") === true,
    });
    const card = findCard(state, requireString(args.cardId, "cardId"));
    return await boardResult(`Moved Planban card ${card.id} to ${card.status}.`, state.manifest.repoId, {
      ...compactBoardSummary(state),
      card,
    });
  }

  if (name === "planban_update_card") {
    const state = await updateCard({
      cwd: await cwdFromArgs(args),
      cardId: requireString(args.cardId, "cardId"),
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"),
      title: args.title === undefined ? undefined : requireString(args.title, "title"),
      summary: optionalNullableString(args.summary, "summary"),
      nextAction: optionalNullableString(args.nextAction, "nextAction"),
      tags: optionalStringArray(args.tags, "tags"),
      blockedBy: optionalNullableString(args.blockedBy, "blockedBy"),
      metadata: optionalMetadata(args.metadata, "metadata"),
      actor: "agent",
      idempotencyKey: optionalString(args.idempotencyKey, "idempotencyKey"),
    });
    const card = findCard(state, requireString(args.cardId, "cardId"));
    const notes = metadataNotes(card);
    return await boardResult(withLine(`Updated Planban card ${card.id}.`, notes[0]), state.manifest.repoId, {
      ...compactBoardSummary(state),
      card,
      ...(notes.length ? { notes } : {}),
    });
  }

  if (name === "planban_set_card_parent") {
    const cardId = requireString(args.cardId, "cardId");
    const parentId = args.parentId === null ? null : requireString(args.parentId, "parentId");
    const state = await setCardParent({
      cwd: await cwdFromArgs(args), cardId, parentId,
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"), actor: "agent", idempotencyKey: optionalString(args.idempotencyKey, "idempotencyKey"),
    });
    const card = findCard(state, cardId);
    return await boardResult(parentId ? `Moved ${card.id} into ${parentId}.` : `Moved ${card.id} to the main board.`, state.manifest.repoId, {
      ...compactBoardSummary(state), card, ancestry: cardAncestry(state.roadmap, cardId),
    });
  }

  if (name === "planban_write_doc") {
    const cardId = requireString(args.cardId, "cardId");
    const kind = requireDocKind(args.kind);
    const cwd = await cwdFromArgs(args);
    const payload = await writeDoc({
      cwd,
      cardId,
      kind,
      markdown: requireText(args.markdown, "markdown"),
      expectedMtimeMs: args.expectedMtimeMs === undefined ? undefined : optionalNumber(args.expectedMtimeMs, "expectedMtimeMs") ?? null,
      idempotencyKey: optionalString(args.idempotencyKey, "idempotencyKey"),
      history: {
        actor: "agent",
        operation: "doc.write",
        summary: `Edited ${kind} document`,
        affectedCards: [cardId],
        affectedDocs: [{ cardId, kind, path: `items/${cardId}/${kind}.md` }],
      },
    });
    return await boardResult(withLine(`Wrote ${payload.kind} document for ${payload.cardId}.`, docSizeLine(payload)), repoIdFromCwd(cwd), { ...payload, doc: payload });
  }

  if (name === "planban_write_doc_section") {
    const cwd = await cwdFromArgs(args);
    const expected = args.expectedSectionVersion;
    if (expected !== null && typeof expected !== "string") throw new Error("expectedSectionVersion is the section's version from planban_read_doc, or null for a new section.");
    const payload = await writeDocSection({
      cwd, cardId: requireString(args.cardId, "cardId"), kind: requireDocKind(args.kind), heading: requireString(args.heading, "heading"),
      occurrence: args.occurrence === undefined ? undefined : optionalNumber(args.occurrence, "occurrence"),
      expectedSectionVersion: expected, markdown: requireText(args.markdown, "markdown"), after: optionalString(args.after, "after"),
      actor: "agent", idempotencyKey: optionalString(args.idempotencyKey, "idempotencyKey"),
    });
    return await boardResult(withLine(`Wrote the "${args.heading}" section of the ${payload.kind} for ${payload.cardId}.`, docSizeLine(payload)), repoIdFromCwd(cwd), { ...payload, doc: payload });
  }

  if (name === "planban_move_files_out") {
    const cwd = await cwdFromArgs(args);
    const result = await moveFilesOut({
      cwd,
      cardId: requireString(args.cardId, "cardId"),
      to: requireString(args.to, "to"),
      dryRun: optionalBoolean(args.dryRun, "dryRun"),
      actor: "agent",
    });
    const count = `${result.moves.length} file${result.moves.length === 1 ? "" : "s"}`;
    const text = result.alreadyClean
      ? `Card ${result.cardId} holds no files in its folder. Nothing to move.`
      : result.dryRun
        ? `Dry run: nothing changed. ${count} would move from card ${result.cardId} to ${result.destination}.${result.conflicts.length ? ` ${result.conflicts.length} already exist there, so the move would be refused; choose another folder.` : ""}`
        : `Moved ${count} from card ${result.cardId} to ${result.destination} and added a Files section to its Spec. The card can be changed again.`;
    return await boardResult(text, repoIdFromCwd(cwd), result);
  }

  if (name === "planban_launch_board") {
    const launched = await launchBoard(args);
    return textResult(
      `Planban board URL: ${launched.url}\nInclude this exact clickable URL in the user-facing confirmation even if the in-app browser opened successfully.`,
      launched,
    );
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function callTool(name, rawArgs) {
  const args = requireObject(rawArgs ?? {}, "arguments");
  const activity = await startPlanbanMcpActivity({
    name,
    args,
    resolveBoard: async () => {
      const status = await getStatus(await cwdFromArgs(args));
      return status.initialized && "repoId" in status ? { repoId: status.repoId } : null;
    },
  });
  try {
    const result = await callToolImpl(name, args);
    // An agent editing a card is working on it: the app's own name, for "Claude (Sam) is working on this card".
    if (CARD_EDIT_TOOLS.has(name) && typeof args.cardId === "string") {
      void cwdFromArgs(args).then((cwd) => notePresence({ cwd, cardId: args.cardId, agentName: clientAgentName ?? undefined })).catch(() => undefined);
    }
    return result;
  } finally {
    await activity?.end();
  }
}

const CARD_EDIT_TOOLS = new Set(["planban_move_card", "planban_update_card", "planban_write_doc", "planban_write_doc_section", "planban_set_card_parent"]);

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    // Which app this is ("claude-code", "codex-mcp-client"), for "Claude (Sam) is working on this card".
    clientAgentName = typeof params?.clientInfo?.name === "string" ? params.clientInfo.name : null;
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, title: "Planban", version: SERVER_VERSION, websiteUrl: "https://planban.ai", icons: SERVER_ICONS },
      instructions: PLANBAN_MCP_INSTRUCTIONS,
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: advertisedTools() });
    return;
  }

  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments ?? {});
      sendResult(id, result);
    } catch (error) {
      // Bad arguments stay protocol errors. A tool that ran and was refused or
      // failed reports it as a tool result, with its kind and details readable
      // (conflict and the current revision, signed out, forbidden...).
      const report = errorReportModule.errorReport(error);
      if (report.category === "error") sendError(id, JsonRpcError.INVALID_PARAMS, report.message);
      else sendResult(id, { content: [{ type: "text", text: report.message }], structuredContent: { error: report }, isError: true });
    }
    return;
  }

  if (id !== undefined) {
    sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export function startMcpServer() {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  let requestQueue = Promise.resolve();

  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    requestQueue = requestQueue.then(() => handleRequest(message)).catch((error) => {
      if (message.id !== undefined) {
        sendError(message.id, JsonRpcError.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
      }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startMcpServer();
}
