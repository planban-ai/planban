import React, { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { boardPath, boardWebAddress, cardIdFromHash, cardPath, linkedCardOnBoard } from "./apiPaths";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import { stripFrontMatter } from "../core/frontMatter";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  ExternalLink,
  FilePenLine,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderTree,
  HelpCircle,
  History,
  Info,
  Loader2,
  ListTree,
  Minimize2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  SquarePen,
  Trash2,
  X,
  Settings,
  Link2,
  Target,
} from "lucide-react";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  groupItems,
  groupItemsInCurrentOrder,
  previewCrossStatusDragOver,
  reorderItemsForDrop,
  resolveDropTargetId,
  statusForDropTarget,
  statuses,
  type Status,
} from "./boardOrdering";
import { mainBoardProjection, itemsInGroup, groupProgressSegments, groupRollup, workItemRank, type GroupRollup } from "./mainBoardProjection";
import { buildWorkItemReference } from "./workItemReference";
import { groupWorkspaceProjection } from "./groupWorkspaceProjection";
import { flattenedExecutionMoveForDrop, flattenedExecutionProjection } from "./flattenedExecutionProjection";
import {
  queryWorkItems,
  type PlanbanBlockedFilter,
  type PlanbanHierarchyScope,
  type PlanbanGroupRole,
} from "../core/workItemQuery";
import {
  boardViewPreferencesKey,
  normalizeBoardViewPreferences,
  resolveBoardQueryState,
  type BoardViewPreferences,
} from "./boardPreferences";
import {
  shouldOfferFirstRunTutorial,
  tutorialExitRepoId,
  tutorialPath,
  type TutorialProgress,
} from "./tutorialNavigation";
import { OverflowMarqueeText } from "./OverflowMarqueeText";
import { BoardPeopleContext, BoardSettingsModal, NewBoardModal, CardFace, CardWorking, ConnectionsModal, HistoryAuthor, InviteModal, PeopleModal, LocationPill, OlderCopyBanner, SignedOutScreen, useBoardPeople, useOnlineStatus, type SignedOut } from "./onlineBoard";
import {
  activityLabIsEnabled,
  activityVariantForIndex,
  activityVariantLabels,
  simulatedActivityBurst,
  strongestActivityPhase,
  type ActivityDemoMode,
  type ActivityPhase,
  type ActivityPresentation,
} from "./activityDemo";
import {
  activityPhaseAt,
  PLANBAN_ACTIVITY_HOLD_MS,
  PLANBAN_ACTIVITY_TAIL_MS,
  type PlanbanActivitySnapshot,
} from "../core/activity";
import { liveRefreshDecision } from "./liveSync";
import { capabilities } from "./capabilities";
import { Dropdown } from "./Dropdown";
import { useKeyboardInset, usePhoneLayout } from "./phoneLayout";
import { GoalsPage, GoalsStrip, useGoals } from "./goals";
import { latestRequestGate } from "./latestRequest";
import { AccountMenu, ApprovePage, HostedDashboard, InvitePage, JoinedNote, SignInPage, webScreen } from "./hostedScreens";
import { CardStackMark } from "./Wordmark";
import { captureAddressSecrets } from "./webAccount";

// On the web, an invitation's token or a sign-in request in the address is
// moved out of it before anything else runs.
if (capabilities.hosted) {
  captureAddressSecrets();
  // The web page's own look where it differs from the installed app's, such as dark primary buttons.
  document.documentElement.classList.add("web-hosted");
}
import { newIdempotencyKey } from "./hostedAdapter";
import { watchHostedBoard } from "./hostedLive";
import { hostedAdapter, pageFetch } from "./transport";
import { stalenessChipLabel, type StalenessSignal } from "../core/staleness";
import {
  canPlaceItemInside,
  groupPlacementDecision,
  groupPlacementPositionFromValue,
  groupPlacementPositionValue,
  previewGroupWorkspaceMove,
  groupWorkspaceDropOutcome,
  groupWorkspaceMoveForDrop,
  type PendingGroupPlacement,
  type GroupPlacementPosition,
  type GroupWorkspaceMove,
} from "./groupWorkspaceOrdering";
import {
  hierarchyColumnDropPreview,
  hierarchyColumnSpatialTarget,
  hierarchyContainmentCue,
  hierarchyContainmentLatch,
  hierarchyContainmentSourceFootprint,
  hierarchyDropCommitDecision,
  hierarchyDraggedSourceOpacity,
  hierarchyDropOperation,
  hierarchyPlacementChanges,
  hierarchyReorderPlaceholderVisible,
  hierarchyReorderPreviewIndex,
  type HierarchyDropOperation,
  type HierarchyDropRect,
} from "./hierarchyDropIntent";
import "./styles.css";
type DocKind = "spec" | "plan";

interface RoadmapItem {
  id: string;
  title: string;
  status: Status;
  priority: number | null;
  summary: string | null;
  nextAction: string | null;
  tags: string[];
  icon: string | null;
  blockedBy: string | null;
  specDoc: string | null;
  planDoc: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  isGroup?: boolean;
  parentId?: string | null;
  boardRank?: number | null;
  groupRank?: number | null;
  metadata?: Record<string, unknown>;
}

interface PlanbanState {
  staleness?: { cards: Record<string, StalenessSignal[]> };
  /** On the web: the person's role on this board. */
  hosted?: { boardId: string; role: "owner" | "editor" | "viewer" | null; authority: string | null };
  /** On a computer: the online board uses features this Planban can't show (16 October 2026). */
  planbanBehind?: { notice: string; features: string[] };
  cwd: string;
  manifest: { repoId: string };
  manifestPath: string;
  planningRoot: string;
  roadmapPath: string;
  roadmap: {
    revision: number;
    project: { id: string; title: string; status: string; description: string; tags: string[] };
    roadmapItems: RoadmapItem[];
  };
}

interface BoardRecord {
  repoId: string;
  title: string;
  cwd: string;
  planningRoot: string;
  roadmapPath: string;
  manifestPath: string;
  kind?: "project" | "demo";
  archivedAt?: string | null;
  lastOpenedAt: string;
  updatedAt: string;
}

interface BoardsPayload {
  currentRepoId: string | null;
  boards: BoardRecord[];
}

interface LiveSnapshot {
  liveVersion: number;
  stateVersion: number;
  boardsVersion: number;
  activityVersion: number;
  activities: PlanbanActivitySnapshot[];
}

interface VersionInfo {
  version: string;
  pluginVersion: string;
  mcpVersion: string;
  storageSchemaVersion: number;
  sourceUrl: string;
}

interface UpdateManifest {
  schemaVersion?: 1;
  version: string;
  pluginVersion: string;
  mcpVersion: string;
  storageSchemaVersion: number;
  minimumStorageSchemaVersion: number;
  publishedAt: string;
  sourceUrl: string;
  releaseNotesUrl: string;
  targetRef?: string;
  targetCommit?: string;
  summary: string;
  updatePrompt: string;
  postUpdateRoute?: "tutorial" | "board" | "board-with-changelog";
  tutorialVersion?: number;
  showTutorialWhenUpdatingFromBefore?: string;
  changelogTitle?: string;
  changelogSummary?: string;
}

interface UpdateStatusPayload {
  checkedAt: string;
  metadataUrl: string;
  current: VersionInfo;
  latest: UpdateManifest | null;
  updateAvailable: boolean;
  compatible: boolean;
  checkError: string | null;
}

interface CommandCheck {
  command: string;
  available: boolean;
  version: string | null;
  error: string | null;
}

interface UpdatePreflightPayload {
  checkedAt: string;
  runtimeRoot: string;
  codexHome: string;
  installShape: "git-marketplace" | "local-clone" | "local-dev" | "unknown";
  directUpdateAvailable: boolean;
  prerequisites: {
    node: CommandCheck;
    npm: CommandCheck;
    git: CommandCheck;
    codex: CommandCheck;
  };
  marketplace: {
    name: "planban";
    root: string | null;
    sourceType: "git" | "local" | "unknown";
    source: string | null;
  };
  git: {
    isRepo: boolean;
    root: string | null;
    branch: string | null;
    remote: string | null;
    head: string | null;
    dirtyFiles: string[];
    generatedSafeDirtyFiles: string[];
    blockingDirtyFiles: string[];
  };
  blockedReasons: string[];
  warnings: string[];
  recommendedAction: "update-now" | "update-with-codex" | "setup-prerequisites";
  setupPrompt: string | null;
  fallbackPrompt: string;
}

type UpdateStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
type UpdateRunStatus = "pending" | "running" | "succeeded" | "failed";

interface UpdateRunStepSnapshot {
  id: string;
  label: string;
  status: UpdateStepStatus;
  command: string;
  cwd: string | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

interface UpdateRunSnapshot {
  id: string;
  status: UpdateRunStatus;
  startedAt: string;
  completedAt: string | null;
  installShape: UpdatePreflightPayload["installShape"];
  targetVersion: string | null;
  targetRef: string | null;
  targetCommit: string | null;
  currentBoardUrl: string | null;
  restartRequired: boolean;
  message: string;
  error: string | null;
  steps: UpdateRunStepSnapshot[];
}

interface DocPayload {
  cardId: string;
  kind: DocKind;
  path: string | null;
  exists: boolean;
  markdown: string;
  mtimeMs: number | null;
}

type HistoryActor = "user" | "agent" | "import" | "system";

interface HistoryEntry {
  version: number;
  roadmapRevision: number;
  createdAt: string;
  actor: HistoryActor;
  operation: string;
  summary: string;
  affectedCards: string[];
  affectedDocs: Array<{ cardId: string; kind: DocKind; path: string | null }>;
  /** Online Boards: who made the change and through which app. */
  attribution?: { userId: string; clientName: string; actor: string };
}

interface HistoryPayload {
  currentVersion: number;
  retention: {
    boardVersions: number;
    cardVersions: number;
    documentVersions: number;
    hourlyDays: number;
    maxAgeDays: number;
  };
  entries: HistoryEntry[];
}

function repoIdFromPath() {
  const match = window.location.pathname.match(/^\/boards\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function isBoardDashboardPath() {
  return window.location.pathname === "/boards";
}

function isTutorialPath() {
  return window.location.pathname === "/tutorial";
}

function replaceBoardPath(repoId: string | null) {
  const nextPath = repoId ? `/boards/${encodeURIComponent(repoId)}` : "/boards";
  if (window.location.pathname !== nextPath) window.history.replaceState(null, "", nextPath);
}

function pushBoardPath(repoId: string | null) {
  const nextPath = repoId ? `/boards/${encodeURIComponent(repoId)}` : "/boards";
  if (window.location.pathname !== nextPath) window.history.pushState(null, "", nextPath);
}

function openTutorial(mode = "first-run", returnRepoId?: string | null) {
  window.location.assign(tutorialPath(mode, returnRepoId));
}

const tutorialStorageKey = "planban:tutorial:v1";

function readTutorialProgress(): TutorialProgress {
  try {
    const raw = window.localStorage.getItem(tutorialStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { status?: unknown };
    return parsed.status === "completed" || parsed.status === "skipped" ? parsed.status : null;
  } catch {
    return null;
  }
}

function writeTutorialProgress(status: Exclude<TutorialProgress, null>) {
  window.localStorage.setItem(
    tutorialStorageKey,
    JSON.stringify({
      status,
      updatedAt: new Date().toISOString(),
    }),
  );
}

interface BoardDashboardPreferences {
  showArchivedBoards?: boolean;
}

function readLocalJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Preference persistence should never block the board.
  }
}

function readBoardViewPreferences(repoId: string): BoardViewPreferences {
  return readLocalJson<BoardViewPreferences>(boardViewPreferencesKey(repoId), {});
}

function writeBoardViewPreferences(repoId: string, preferences: BoardViewPreferences) {
  writeLocalJson(boardViewPreferencesKey(repoId), {
    ...preferences,
    updatedAt: new Date().toISOString(),
  });
}

function initialBoardQueryState(repoId: string) {
  return resolveBoardQueryState(readBoardViewPreferences(repoId), new URLSearchParams(window.location.search));
}

const boardDashboardPreferencesKey = "planban:boards-dashboard:v1";

function groupRailPreferencesKey(repoId: string, groupId: string) {
  return `planban:group-rail:v1:${encodeURIComponent(repoId)}:${encodeURIComponent(groupId)}`;
}

function defaultGroupRailSections(items: RoadmapItem[], groupId: string): Partial<Record<Status, boolean>> {
  const openStatus = statuses.find((status) => items.some((entry) => entry.parentId === groupId && entry.status === status)) ?? "in-progress";
  return Object.fromEntries(statuses.map((status) => [status, status !== openStatus])) as Partial<Record<Status, boolean>>;
}

function readGroupRailSections(repoId: string, groupId: string) {
  return readLocalJson<Partial<Record<Status, boolean>> | null>(groupRailPreferencesKey(repoId, groupId), null);
}

function writeGroupRailSections(repoId: string, groupId: string, collapsed: Partial<Record<Status, boolean>>) {
  writeLocalJson(groupRailPreferencesKey(repoId, groupId), collapsed);
}

function readBoardDashboardPreferences(): BoardDashboardPreferences {
  return readLocalJson<BoardDashboardPreferences>(boardDashboardPreferencesKey, {});
}

function writeBoardDashboardPreferences(preferences: BoardDashboardPreferences) {
  writeLocalJson(boardDashboardPreferencesKey, {
    ...preferences,
    updatedAt: new Date().toISOString(),
  });
}

const labels: Record<Status, string> = {
  "in-progress": "In Progress",
  "up-next": "Up Next",
  pending: "Pending",
  complete: "Complete",
  archived: "Archived",
};

function formatOptionalLine(label: string, value: string | number | null | undefined) {
  return `${label}: ${value === null || value === undefined || value === "" ? "(none)" : value}`;
}

async function copyWorkItemReference(state: PlanbanState, item: RoadmapItem) {
  return await writeClipboardText(buildWorkItemReference(state.manifest.repoId, item));
}

function useTransientConfirmation(resetKey: string, durationMs = 1800) {
  const [confirmed, setConfirmed] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const clearConfirmation = useCallback(() => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    setConfirmed(false);
  }, []);

  const showConfirmation = useCallback(() => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    setConfirmed(true);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setConfirmed(false);
    }, durationMs);
  }, [durationMs]);

  useEffect(() => clearConfirmation, [clearConfirmation, resetKey]);

  return [confirmed, showConfirmation] as const;
}

function CopyConfirmationIcon({ confirmed }: { confirmed: boolean }) {
  return (
    <span className="copy-reference-icon" data-state={confirmed ? "confirmed" : "idle"} aria-hidden="true">
      <Copy className="copy-reference-icon-default" size={14} />
      <Check className="copy-reference-icon-success" size={15} strokeWidth={2.6} />
    </span>
  );
}

function getCodexThreadMeta(item: RoadmapItem) {
  const value = item.metadata?.codexThread;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getCodexThreadId(item: RoadmapItem) {
  const threadId = getCodexThreadMeta(item).threadId;
  return typeof threadId === "string" && threadId.trim() ? threadId.trim() : null;
}

function hasPendingCodexThread(item: RoadmapItem) {
  const meta = getCodexThreadMeta(item);
  return !getCodexThreadId(item) && meta.status === "pending" && typeof meta.launchToken === "string";
}

function buildFeedbackPrompt(state: PlanbanState, feedback: string) {
  const boardUrl = `${window.location.origin}/boards/${encodeURIComponent(state.manifest.repoId)}`;
  return [
    "Use the installed Planban Feedback skill (`planban-feedback`) to investigate and package this for planban-ai/planban.",
    "",
    "Draft only. Do not file or post publicly without my explicit approval of the exact destination and text.",
    "Treat this note and available conversation/workspace context as my initial account; do not ask me to repeat facts you can infer or safely inspect.",
    "For a bug, gather narrow local facts, search existing issues, pull requests, releases, and current source, then recommend one specific reporting route.",
    "Unknown details must not block the report. Tell me what you inspected and keep private context out of the public draft unless I approve it.",
    "Recommend a pull request only if you can verify that my agent already implemented and validated a focused fix for this same bug against current main. Otherwise recommend an issue or existing-issue comment only.",
    "",
    "Private orientation context; do not include publicly unless approved:",
    formatOptionalLine("Board", state.roadmap.project.title),
    formatOptionalLine("Repo id", state.manifest.repoId),
    formatOptionalLine("Board URL", boardUrl),
    "",
    "Feedback:",
    feedback.trim(),
    "",
    "User prompt:",
  ].join("\n");
}

async function openCodexFeedbackThread(state: PlanbanState, feedback: string) {
  const prompt = buildFeedbackPrompt(state, feedback);
  const url = new URL("codex://threads/new");
  url.searchParams.set("path", state.cwd);
  url.searchParams.set("prompt", prompt);

  try {
    await api<{ opened: boolean }>("/api/open-codex-thread", {
      method: "POST",
      body: JSON.stringify({ url: url.toString() }),
    });
    return { opened: true, copied: false };
  } catch (error) {
    await navigator.clipboard?.writeText(prompt).catch(() => undefined);
    window.alert(
      error instanceof Error
        ? `Could not open Codex automatically. The feedback prompt has been copied if clipboard access is available.\n\n${error.message}`
        : "Could not open Codex automatically. The feedback prompt has been copied if clipboard access is available.",
    );
    return { opened: false, copied: true };
  }
}

async function writeClipboardText(text: string) {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    // Keep going to the textarea fallback below.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

async function copyFeedbackPrompt(state: PlanbanState, feedback: string) {
  return await writeClipboardText(buildFeedbackPrompt(state, feedback));
}

async function openCodexPromptForState(state: PlanbanState, prompt: string) {
  const url = new URL("codex://threads/new");
  url.searchParams.set("path", state.cwd);
  url.searchParams.set("prompt", prompt);
  await api<{ opened: boolean }>("/api/open-codex-thread", {
    method: "POST",
    body: JSON.stringify({ url: url.toString() }),
  });
}

function buildUpdatePrompt(state: PlanbanState, status: UpdateStatusPayload) {
  const boardUrl = `${window.location.origin}/boards/${encodeURIComponent(state.manifest.repoId)}`;
  const tutorialUrl = `${window.location.origin}/tutorial?mode=first-run`;
  const latest = status.latest;
  const postUpdateInstruction = updatePostInstallInstruction(status, boardUrl, tutorialUrl);
  return [
    "Hit enter to update Planban with your agent.",
    "",
    "Use the Planban plugin or skill if it is available.",
    "I want to update my local Planban install safely.",
    "",
    formatOptionalLine("Current Planban version", status.current.version),
    formatOptionalLine("Current plugin version", status.current.pluginVersion),
    formatOptionalLine("Current MCP version", status.current.mcpVersion),
    formatOptionalLine("Latest Planban version", latest?.version ?? "(unknown)"),
    formatOptionalLine("Latest plugin version", latest?.pluginVersion ?? "(unknown)"),
    formatOptionalLine("Latest MCP version", latest?.mcpVersion ?? "(unknown)"),
    formatOptionalLine("Release notes", latest?.releaseNotesUrl ?? "(none)"),
    formatOptionalLine("Release-specific update instructions", latest?.updatePrompt ?? "(none)"),
    formatOptionalLine("Post-update route", postUpdateInstruction),
    formatOptionalLine("Source", latest?.sourceUrl ?? status.current.sourceUrl),
    formatOptionalLine("Current board", boardUrl),
    "",
    "Before changing anything, inspect how Planban is installed on this machine.",
    "The public README install flow normally creates a Git-backed Planban marketplace. If that is the install shape, refresh the marketplace snapshot first, then reinstall the Planban plugin.",
    "If this machine still uses an older local clone marketplace install, update that clone first, then reinstall the Planban plugin from the local marketplace.",
    "Before any storage migration, create a timestamped backup of the affected ~/.planban state and explain how to restore it.",
    "Do not upload or expose private board contents, repo paths, logs, or local project details.",
    "",
    "Primary Git-backed marketplace commands, to verify before running:",
    "codex plugin marketplace upgrade planban",
    "npm install",
    "node scripts/configure-local-plugin.mjs",
    "codex plugin add planban@planban",
    "",
    "Older local clone fallback, only if inspection confirms that install shape:",
    "git pull",
    "npm install",
    "node scripts/configure-local-plugin.mjs",
    "codex plugin add planban@planban",
    "",
    "After updating, verify the running Planban version, the installed plugin version, MCP tools, and board load.",
    postUpdateInstruction,
    "",
    "User prompt:",
  ].join("\n");
}

function versionParts(version: string) {
  const core = version.trim().replace(/^v/u, "").split(/[+-]/u)[0] ?? "0";
  return core.split(".").map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
}

function compareVersionStrings(left: string, right: string) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

function shouldRouteToTutorial(status: UpdateStatusPayload) {
  const latest = status.latest;
  if (!latest) return false;
  if (latest.postUpdateRoute === "tutorial") return true;
  if (!latest.showTutorialWhenUpdatingFromBefore) return false;
  return compareVersionStrings(status.current.version, latest.showTutorialWhenUpdatingFromBefore) < 0;
}

function updatePostInstallInstruction(status: UpdateStatusPayload, boardUrl: string, tutorialUrl: string) {
  const latest = status.latest;
  if (shouldRouteToTutorial(status)) {
    return `After updating, open ${tutorialUrl} in the Codex in-app browser so the user can see the Planban tutorial. If the board opens instead, make sure the Planban tour banner is visible when the tutorial has not been completed or skipped locally.`;
  }
  if (latest?.postUpdateRoute === "board-with-changelog") {
    const title = latest.changelogTitle ? ` titled "${latest.changelogTitle}"` : "";
    const summary = latest.changelogSummary ? ` Summary: ${latest.changelogSummary}` : "";
    return `After updating, reopen ${boardUrl} in the Codex in-app browser and show the what's-new modal${title}.${summary}`;
  }
  return `After updating, reopen ${boardUrl} in the Codex in-app browser and confirm the running version.`;
}

function postUpdateBrowserUrl(status: UpdateStatusPayload, boardUrl: string, tutorialUrl: string) {
  const latest = status.latest;
  if (!latest) return boardUrl;
  if (shouldRouteToTutorial(status)) return tutorialUrl;
  if (latest.postUpdateRoute === "board-with-changelog") {
    const url = new URL(boardUrl);
    url.searchParams.set("planbanUpdated", latest.version);
    return url.toString();
  }
  return boardUrl;
}

async function openCodexUpdateThread(state: PlanbanState, status: UpdateStatusPayload) {
  const prompt = buildUpdatePrompt(state, status);
  const url = new URL("codex://threads/new");
  url.searchParams.set("path", state.cwd);
  url.searchParams.set("prompt", prompt);

  try {
    await api<{ opened: boolean }>("/api/open-codex-thread", {
      method: "POST",
      body: JSON.stringify({ url: url.toString() }),
    });
    return { opened: true, copied: false };
  } catch (error) {
    await navigator.clipboard?.writeText(prompt).catch(() => undefined);
    window.alert(
      error instanceof Error
        ? `Could not open Codex automatically. The update prompt has been copied if clipboard access is available.\n\n${error.message}`
        : "Could not open Codex automatically. The update prompt has been copied if clipboard access is available.",
    );
    return { opened: false, copied: true };
  }
}

async function copyUpdatePrompt(state: PlanbanState, status: UpdateStatusPayload) {
  const prompt = buildUpdatePrompt(state, status);
  return { copied: await writeClipboardText(prompt), prompt };
}

function versionLabel(version: number, currentVersion: number | null) {
  return `v${version}${version === currentVersion ? " (current)" : ""}`;
}

function docKindLabel(kind: DocKind) {
  return kind === "spec" ? "Spec" : "Plan";
}

const boardCollisionDetection: CollisionDetection = (args) => {
  const activeId = String(args.active.id);
  const pointerCollisions = pointerWithin(args).filter((collision) => String(collision.id) !== activeId);
  const cardCollision = pointerCollisions.find((collision) => {
    const id = String(collision.id);
    return !statuses.includes(id as Status);
  });
  if (cardCollision) return [cardCollision];
  if (pointerCollisions.length > 0) return pointerCollisions;

  const rectCollisions = rectIntersection(args).filter((collision) => String(collision.id) !== activeId);
  if (rectCollisions.length > 0) return rectCollisions;

  return closestCorners(args).filter((collision) => String(collision.id) !== activeId);
};

function hierarchyBoardCollisionDetection(items: RoadmapItem[]): CollisionDetection {
  return (args) => {
    const collisions = boardCollisionDetection(args);
    const firstId = collisions[0] ? String(collisions[0].id) : null;
    if (!firstId || !statuses.includes(firstId as Status)) return collisions;
    const pointerY = args.pointerCoordinates?.y;
    if (pointerY === undefined) return collisions;
    const active = items.find((item) => item.id === String(args.active.id));
    if (!active) return collisions;
    const targetId = hierarchyColumnSpatialTarget(
      pointerY,
      items
        .filter((item) => item.id !== active.id && (item.parentId ?? null) === (active.parentId ?? null) && item.status === firstId)
        .flatMap((item) => {
          const rect = args.droppableRects.get(item.id);
          return rect ? [{ id: item.id, top: rect.top, bottom: rect.bottom }] : [];
        }),
    );
    return targetId ? [{ id: targetId }] : collisions;
  };
}

function dragPointerCoordinates(event: DragMoveEvent) {
  const activator = event.activatorEvent as PointerEvent;
  return { x: activator.clientX + event.delta.x, y: activator.clientY + event.delta.y };
}

function dragPointerY(event: DragMoveEvent) {
  return dragPointerCoordinates(event).y;
}

function stableDropRect(rect: { top: number; bottom: number; height: number; left: number; right: number; width: number }): HierarchyDropRect {
  return { top: rect.top, bottom: rect.bottom, height: rect.height, left: rect.left, right: rect.right, width: rect.width };
}

function hierarchySortingStrategy(
  itemIds: string[],
  targetId: string | null,
  operation: HierarchyDropOperation | null,
): SortingStrategy {
  return (args) => {
    if (!targetId || !operation || operation === "inside") return null;
    const targetIndex = itemIds.indexOf(targetId);
    if (targetIndex < 0 || args.activeIndex < 0) return verticalListSortingStrategy(args);
    return verticalListSortingStrategy({
      ...args,
      overIndex: hierarchyReorderPreviewIndex(args.activeIndex, targetIndex, operation),
    });
  };
}

async function api<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = {
    "Content-Type": "application/json",
    "X-Planban-Client": "web",
    ...(init?.headers ?? {}),
  } as Record<string, string>;
  if (method !== "GET" && method !== "HEAD" && !headers["Idempotency-Key"]) {
    // One key per logical edit, in the form the online service accepts too.
    headers["Idempotency-Key"] = newIdempotencyKey();
  }
  const timeoutController = timeoutMs ? new AbortController() : null;
  const timeout = timeoutController
    ? window.setTimeout(() => timeoutController.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs)
    : null;
  const signals = [init?.signal, timeoutController?.signal].filter((signal): signal is AbortSignal => Boolean(signal));
  let response: Response;
  try {
    const requestInit: RequestInit = {
      ...init,
      headers,
      ...(signals.length > 0 ? { signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0]! } : {}),
    };
    response = await pageFetch(path, requestInit);
  } catch (error) {
    if (timeoutController?.signal.aborted) {
      throw new Error("Planban took too long to respond. Try loading the Board again.");
    }
    throw error;
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
  }
  const text = await response.text();
  let payload: { error?: string } | T | null = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text) as { error?: string } | T;
    } catch {
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      throw new Error(`Expected JSON response from ${path}`);
    }
  }
  if (!response.ok) {
    const errorMessage =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Request failed: ${response.status}`;
    const error = new Error(errorMessage);
    Object.assign(error, { status: response.status });
    // A refused edit: what changed, by whom, and the current value or document (Spec point 20).
    if (payload && typeof payload === "object" && "conflict" in payload && payload.conflict && typeof payload.conflict === "object") {
      Object.assign(error, { conflict: payload.conflict });
    }
    // A missing or ended Online Board sign-in names the service, so the page can offer Sign in.
    if (payload && typeof payload === "object" && "signInNeeded" in payload && typeof payload.signInNeeded === "string") {
      const reason = "signedOut" in payload && payload.signedOut === "expired" ? "expired" : "missing";
      const command = "signInCommand" in payload && typeof payload.signInCommand === "string" ? payload.signInCommand : undefined;
      // A board linked to an account that isn't signed in here names that account.
      const account = "signInAccount" in payload ? (typeof payload.signInAccount === "string" ? payload.signInAccount : null) : undefined;
      Object.assign(error, { signedOut: { url: payload.signInNeeded, reason, ...(command ? { command } : {}), ...(account !== undefined ? { account } : {}) } satisfies SignedOut });
    }
    // A board of another account than the one signed in on this computer (from its own records).
    if (payload && typeof payload === "object" && "otherAccount" in payload && payload.otherAccount && typeof payload.otherAccount === "object") {
      const other = payload.otherAccount as { url?: unknown; boardAccount?: unknown; signedInAs?: unknown; signInCommand?: unknown };
      if (typeof other.url === "string") Object.assign(error, { signedOut: {
        url: other.url, reason: "other-account",
        otherAccount: { boardAccount: typeof other.boardAccount === "string" ? other.boardAccount : null, signedInAs: typeof other.signedInAs === "string" ? other.signedInAs : null },
        ...(typeof other.signInCommand === "string" ? { command: other.signInCommand } : {}),
      } satisfies SignedOut });
    }
    throw error;
  }
  if (payload === null) throw new Error(`Empty response from ${path}`);
  return payload as T;
}

/** One rule with section editing (src/core/frontMatter.ts), so they agree where the document starts. */
const stripFrontmatter = stripFrontMatter;

function formatHistoryTime(input: string) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

type TooltipPlacement = "top" | "bottom";

interface TooltipPosition {
  anchorLeft: number;
  anchorTop: number;
  anchorBottom: number;
  placement: TooltipPlacement;
}

function FloatingTooltip({ label, position }: { label: string; position: TooltipPosition }) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState({ left: position.anchorLeft, top: position.anchorTop });

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;

    const rect = tooltip.getBoundingClientRect();
    const viewportPadding = 8;
    const left = Math.min(
      Math.max(position.anchorLeft - rect.width / 2, viewportPadding),
      window.innerWidth - rect.width - viewportPadding,
    );
    let top =
      position.placement === "top"
        ? position.anchorTop - rect.height - viewportPadding
        : position.anchorBottom + viewportPadding;

    if (top < viewportPadding) top = position.anchorBottom + viewportPadding;
    if (top + rect.height > window.innerHeight - viewportPadding) {
      top = Math.max(viewportPadding, position.anchorTop - rect.height - viewportPadding);
    }

    setStyle({ left, top });
  }, [position]);

  return (
    <div ref={tooltipRef} className="floating-tooltip" role="tooltip" style={style}>
      {label}
    </div>
  );
}

function TooltipButton({
  label,
  className = "",
  tooltipPlacement = "top",
  children,
  onBlur,
  onFocus,
  onPointerEnter,
  onPointerLeave,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tooltipPlacement?: TooltipPlacement }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);
  const [tooltip, setTooltip] = useState<TooltipPosition | null>(null);

  function clearTimer() {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  function showTooltip() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      anchorLeft: rect.left + rect.width / 2,
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      placement: tooltipPlacement,
    });
  }

  function scheduleTooltip() {
    clearTimer();
    timerRef.current = window.setTimeout(showTooltip, 450);
  }

  function hideTooltip() {
    clearTimer();
    setTooltip(null);
  }

  useEffect(() => clearTimer, []);

  return (
    <>
      <button
        {...props}
        ref={buttonRef}
        aria-label={label}
        className={`tooltip-trigger ${className}`}
        onBlur={(event) => {
          onBlur?.(event);
          hideTooltip();
        }}
        onFocus={(event) => {
          onFocus?.(event);
          scheduleTooltip();
        }}
        onPointerEnter={(event) => {
          onPointerEnter?.(event);
          scheduleTooltip();
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          hideTooltip();
        }}
      >
        {children}
      </button>
      {tooltip ? createPortal(<FloatingTooltip label={label} position={tooltip} />, document.body) : null}
    </>
  );
}

function AutoSizingTextarea({
  value,
  onChange,
  className = "",
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resizeToContent = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  useLayoutEffect(resizeToContent, [resizeToContent, value]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      className={`auto-sizing-textarea ${className}`.trim()}
      value={value}
      rows={2}
      onChange={(event) => {
        onChange?.(event);
        requestAnimationFrame(resizeToContent);
      }}
    />
  );
}

function GroupIcon({
  status,
  size = 15,
  className,
  labelled = false,
}: {
  status?: Status | undefined;
  size?: number;
  className?: string;
  labelled?: boolean;
}) {
  const Icon = status === "complete" || status === "archived" ? Folder : FolderOpen;
  return (
    <Icon
      className={className}
      size={size}
      aria-label={labelled ? "Group" : undefined}
      aria-hidden={labelled ? undefined : true}
      role={labelled ? "img" : undefined}
    />
  );
}

// Stale signals by card id, from the board state API. Mutation responses omit them, so the board keeps the last set.
const StalenessContext = React.createContext<Record<string, StalenessSignal[]>>({});

function StalenessChip({ itemId }: { itemId: string }) {
  // Agent-maintenance signals stay in tool results; the board shows only what needs the owner, and cards holding files.
  const signal = React.useContext(StalenessContext)[itemId]?.find((entry) => stalenessChipLabel(entry));
  if (!signal) return null;
  // A card holding files explains itself on hover: Planban refuses changes until they are moved out.
  return <p className="staleness-note" title={signal.kind === "holds-files" ? signal.detail : undefined}>{stalenessChipLabel(signal)}</p>;
}

function CardContent({ item, rollup, ancestry = [], expanded = false }: { item: RoadmapItem; rollup: GroupRollup<RoadmapItem> | undefined; ancestry?: RoadmapItem[]; expanded?: boolean }) {
  const description = item.nextAction || item.summary || "";
  const progressSegments = rollup ? groupProgressSegments(rollup) : [];
  const visibleItemTotal = progressSegments.reduce((total, segment) => total + segment.count, 0);
  const progressLabel = progressSegments.map((segment) => `${segment.count} ${labels[segment.status]}`).join(", ");

  return (
    <>
      <div className="card-title-row">
        <p className="card-title">
          {item.isGroup ? <GroupIcon status={item.status} className="group-role-icon" size={15} labelled /> : null}
          {item.icon ? <span className="card-title-icon">{item.icon}</span> : null}
          {item.title}
        </p>
        <span className="card-title-tail">
          <CardWorking cardId={item.id} />
          <CardFace cardId={item.id} />
          {workItemRank(item) ? <span className="priority">P{workItemRank(item)}</span> : null}
        </span>
      </div>
      <StalenessChip itemId={item.id} />
      {ancestry.length > 0 ? <p className="card-ancestry">{ancestry.map((entry) => entry.title).join(" › ")}</p> : null}
      {description ? <p className="card-copy">{description}</p> : null}
      {rollup ? (
        <div className="group-rollup">
          <div className={visibleItemTotal > 0 ? "group-progress-region" : undefined}>
            <div className="group-progress-summary">
              <p className="group-remaining">{visibleItemTotal === 0 ? "No items yet" : `${rollup.complete}/${visibleItemTotal} complete`}</p>
            </div>
            {visibleItemTotal > 0 ? (
              <div className="group-progress" role="img" aria-label={progressLabel}>
                <div className="group-progress-track">
                  {progressSegments.map((segment) => (
                    <span
                      key={segment.status}
                      className={`group-progress-segment status-${segment.status}`}
                      style={{ flexGrow: segment.count }}
                      title={`${segment.count} ${labels[segment.status]}`}
                    />
                  ))}
                </div>
                <div className="group-progress-tooltip" role="tooltip">
                  {progressSegments.map((segment) => (
                    <span key={segment.status}>
                      <i className={`status-${segment.status}`} aria-hidden="true" />
                      <b>{segment.count}</b> {labels[segment.status]}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          {!expanded && rollup.previews.length > 0 ? (
            <div className="group-preview">
              <p className="group-preview-heading">Snapshot</p>
              <ul>{rollup.previews.map((preview) => (
                <li key={preview.id}>
                  <span>{preview.title}</span>
                  <small className={`work-status-label status-${preview.status}`}>{labels[preview.status] ?? "No status"}</small>
                </li>
              ))}</ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function AgentActivityEffect({
  activity,
  surface = "card",
}: {
  activity: ActivityPresentation | null | undefined;
  surface?: "card" | "header";
}) {
  if (!activity) return null;
  return (
    <span
      className={`agent-activity-effect agent-activity-${activity.variant} agent-activity-${activity.phase} agent-activity-${surface}`}
      aria-hidden="true"
    >
      <i /><i /><i /><i /><i />
    </span>
  );
}

function useActivityDemo(enabled: boolean, itemIds: string[]) {
  const [mode, setModeState] = useState<ActivityDemoMode>("compare");
  const [phases, setPhases] = useState<Record<string, ActivityPhase>>({});
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const phaseTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>[]>());
  const inFlightRef = useRef(new Map<string, number>());
  const cadenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemIdsRef = useRef(itemIds);

  useEffect(() => {
    itemIdsRef.current = itemIds;
  }, [itemIds]);

  const schedule = useCallback((callback: () => void, delayMs: number) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      callback();
    }, delayMs);
    timersRef.current.add(timer);
    return timer;
  }, []);

  const clearCardPhaseTimers = useCallback((cardId: string) => {
    for (const timer of phaseTimersRef.current.get(cardId) ?? []) {
      clearTimeout(timer);
      timersRef.current.delete(timer);
    }
    phaseTimersRef.current.delete(cardId);
  }, []);

  const clearAll = useCallback(() => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current.clear();
    phaseTimersRef.current.clear();
    inFlightRef.current.clear();
    cadenceTimerRef.current = null;
  }, []);

  const beginActivity = useCallback((cardId: string) => {
    clearCardPhaseTimers(cardId);
    inFlightRef.current.set(cardId, (inFlightRef.current.get(cardId) ?? 0) + 1);
    setPhases((current) => ({ ...current, [cardId]: "active" }));
  }, [clearCardPhaseTimers]);

  const endActivity = useCallback((cardId: string) => {
    const remaining = Math.max(0, (inFlightRef.current.get(cardId) ?? 1) - 1);
    if (remaining > 0) {
      inFlightRef.current.set(cardId, remaining);
      return;
    }
    inFlightRef.current.delete(cardId);
    setPhases((current) => ({ ...current, [cardId]: "cooldown" }));
    const fadeTimer = schedule(() => {
      setPhases((current) => current[cardId] ? { ...current, [cardId]: "fading" } : current);
    }, 420);
    const removeTimer = schedule(() => {
      setPhases((current) => {
        if (!current[cardId]) return current;
        const next = { ...current };
        delete next[cardId];
        return next;
      });
      phaseTimersRef.current.delete(cardId);
    }, 1200);
    phaseTimersRef.current.set(cardId, [fadeTimer, removeTimer]);
  }, [schedule]);

  const pulseCard = useCallback((cardId: string) => {
    const burst = simulatedActivityBurst();
    burst.operationOffsetsMs.forEach((offset, index) => {
      schedule(() => {
        beginActivity(cardId);
        schedule(() => endActivity(cardId), burst.operationDurationsMs[index] ?? 70);
      }, offset);
    });
    return burst.nextBurstDelayMs;
  }, [beginActivity, endActivity, schedule]);

  const pulseOne = useCallback(() => {
    const ids = itemIdsRef.current;
    if (!enabled || ids.length === 0) return;
    pulseCard(ids[Math.floor(Math.random() * ids.length)]!);
  }, [enabled, pulseCard]);

  const pulseAll = useCallback(() => {
    if (!enabled) return;
    itemIdsRef.current.forEach((cardId, index) => schedule(() => pulseCard(cardId), index * 70));
  }, [enabled, pulseCard, schedule]);

  const resetActivity = useCallback(() => {
    clearAll();
    setPhases({});
  }, [clearAll]);

  const setMode = useCallback((nextMode: ActivityDemoMode) => {
    resetActivity();
    setModeState(nextMode);
  }, [resetActivity]);

  const runManualPulse = useCallback((scope: "one" | "all") => {
    resetActivity();
    setModeState("paused");
    requestAnimationFrame(() => {
      if (scope === "all") pulseAll();
      else pulseOne();
    });
  }, [pulseAll, pulseOne, resetActivity]);

  const runCardPulse = useCallback((cardId: string) => {
    if (!enabled || !itemIdsRef.current.includes(cardId)) return;
    resetActivity();
    setModeState("paused");
    requestAnimationFrame(() => pulseCard(cardId));
  }, [enabled, pulseCard, resetActivity]);

  useEffect(() => {
    if (!enabled || mode !== "live") return;
    let cancelled = false;
    const run = () => {
      if (cancelled || itemIdsRef.current.length === 0) return;
      const ids = itemIdsRef.current;
      const cardId = ids[Math.floor(Math.random() * ids.length)]!;
      const nextDelay = pulseCard(cardId);
      cadenceTimerRef.current = schedule(run, nextDelay);
    };
    cadenceTimerRef.current = schedule(run, 240);
    return () => {
      cancelled = true;
      if (cadenceTimerRef.current) {
        clearTimeout(cadenceTimerRef.current);
        timersRef.current.delete(cadenceTimerRef.current);
        cadenceTimerRef.current = null;
      }
    };
  }, [enabled, mode, pulseCard, schedule]);

  useEffect(() => () => clearAll(), [clearAll]);

  useEffect(() => {
    if (!enabled) resetActivity();
  }, [enabled, resetActivity]);

  const phaseForId = useCallback((cardId: string): ActivityPhase | null => {
    if (!enabled) return null;
    if (mode === "compare") return "active";
    return phases[cardId] ?? null;
  }, [enabled, mode, phases]);

  return { mode, setMode, phaseForId, runManualPulse, runCardPulse };
}

function ActivityLabPanel({
  mode,
  cards,
  changedCardTitle,
  onModeChange,
  onFlashAndChange,
  onOpenDetail,
}: {
  mode: ActivityDemoMode;
  cards: RoadmapItem[];
  changedCardTitle: string | null;
  onModeChange: (mode: ActivityDemoMode) => void;
  onFlashAndChange: () => void;
  onOpenDetail: (kind: "item" | "group") => void;
}) {
  const status = mode === "compare"
    ? "All treatments are held active for visual comparison."
    : mode === "live"
      ? "Measured micro-bursts are moving between cards automatically."
      : changedCardTitle
        ? `Changed “${changedCardTitle}” as its activity effect began.`
        : "Automatic activity is paused. Use a pulse control to inspect entrances and fades.";
  return (
    <section className="activity-lab" aria-label="Agent activity animation lab">
      <div className="activity-lab-copy">
        <span className="activity-lab-kicker">Demo only</span>
        <div><b>Agent activity lab</b><small>{status}</small></div>
      </div>
      <div className="activity-lab-modes" role="group" aria-label="Activity lab mode">
        <button className={mode === "compare" ? "active" : ""} aria-pressed={mode === "compare"} onClick={() => onModeChange("compare")}>Compare</button>
        <button className={mode === "live" ? "active" : ""} aria-pressed={mode === "live"} onClick={() => onModeChange("live")}><Play size={12} />Live cadence</button>
        <button className={mode === "paused" ? "active" : ""} aria-pressed={mode === "paused"} onClick={() => onModeChange("paused")}><Pause size={12} />Pause</button>
      </div>
      <div className="activity-lab-pulses" role="group" aria-label="Manual activity pulses">
        <button onClick={onFlashAndChange}><SquarePen size={12} />Flash + change</button>
        <button onClick={() => onOpenDetail("item")}><FilePenLine size={12} />Item inside</button>
        <button onClick={() => onOpenDetail("group")}><FolderOpen size={12} />Group inside</button>
      </div>
      <div className="activity-lab-legend" aria-label="Animation treatments">
        {cards.slice(0, 5).map((card, index) => {
          const variant = activityVariantForIndex(index);
          return <span key={card.id} title={card.title}><i className={`activity-legend-${variant}`} />{activityVariantLabels[variant]}</span>;
        })}
      </div>
    </section>
  );
}

function SortableCard({
  item,
  onSelect,
  onCopyReference,
  onMove,
  onDelete,
  readOnly = false,
  rollup,
  onOpenGroup,
  expanded = false,
  onToggleExpanded,
  inlineChildren = [],
  dropOperation = null,
  reorderPreview = false,
  hideSourceDuringDrag = false,
  containmentActive = false,
  receiverDragHeight = null,
  ancestry = [],
  activity = null,
}: {
  item: RoadmapItem;
  onSelect: (id: string) => void;
  onCopyReference: (item: RoadmapItem) => Promise<boolean>;
  onMove: (id: string, status: Status) => void;
  onDelete: (id: string) => void;
  readOnly?: boolean;
  rollup: GroupRollup<RoadmapItem> | undefined;
  onOpenGroup?: ((id: string) => void) | undefined;
  expanded?: boolean;
  onToggleExpanded?: ((id: string) => void) | undefined;
  inlineChildren?: RoadmapItem[];
  dropOperation?: HierarchyDropOperation | null;
  reorderPreview?: boolean;
  hideSourceDuringDrag?: boolean;
  containmentActive?: boolean;
  receiverDragHeight?: number | null;
  ancestry?: RoadmapItem[];
  activity?: ActivityPresentation | null;
}) {
  const hasDescription = Boolean(item.nextAction || item.summary);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: readOnly,
  });
  const containmentCue = dropOperation === "inside" ? hierarchyContainmentCue(item.isGroup === true) : null;
  const containmentSourceFootprint = hierarchyContainmentSourceFootprint(receiverDragHeight, containmentActive);
  const style = {
    transform: isDragging || reorderPreview ? CSS.Transform.toString(transform) : undefined,
    transition: isDragging || reorderPreview ? transition : undefined,
    height: isDragging && receiverDragHeight ? containmentSourceFootprint ?? receiverDragHeight : undefined,
    opacity: isDragging ? hierarchyDraggedSourceOpacity(reorderPreview, hideSourceDuringDrag) : 1,
  } as React.CSSProperties;
  const [referenceCopied, showReferenceCopied] = useTransientConfirmation(item.id);

  return (
    <article
      ref={setNodeRef}
      style={style}
      {...(readOnly ? {} : attributes)}
      {...(readOnly ? {} : listeners)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(item.id);
        }
      }}
      onClick={() => onSelect(item.id)}
      aria-hidden={isDragging && hideSourceDuringDrag ? true : undefined}
      className={`card ${hasDescription ? "" : "compact"} ${readOnly ? "read-only" : ""} ${isDragging ? "is-dragging" : ""} ${isDragging && reorderPreview ? "hierarchy-reorder-placeholder" : ""} ${isDragging && hideSourceDuringDrag ? "hierarchy-hidden-drag-source" : ""} ${dropOperation ? `hierarchy-drop-${dropOperation}` : ""}`}
    >
      <CardContent item={item} rollup={rollup} ancestry={ancestry} expanded={expanded} />
      {containmentCue ? (
        <div className="hierarchy-drop-inside-label">
          <span>{item.isGroup ? <FolderInput size={15} /> : <FolderPlus size={15} />}{containmentCue.label}</span>
          <small>{containmentCue.detail}</small>
        </div>
      ) : null}
      {expanded && inlineChildren.length > 0 ? (
        <div className="inline-group-branch">
          {inlineChildren.map((child) => <div key={child.id}><span>{child.title}</span><small className={`work-status-label status-${child.status}`}>{labels[child.status] ?? "No status"}</small></div>)}
        </div>
      ) : null}
      <AgentActivityEffect activity={activity} />
      {!readOnly ? (
        <div
          className="card-actions"
          onPointerDown={(event) => {
            if (event.target instanceof Element && event.target.closest("button")) event.stopPropagation();
          }}
        >
          <div className="card-action-group">
            {item.isGroup && onOpenGroup ? (
              <>
                {inlineChildren.some((child) => !rollup?.previews.some((preview) => preview.id === child.id)) && onToggleExpanded ? <TooltipButton label={expanded ? "Hide items" : "Show all items"} onClick={(event) => { event.stopPropagation(); onToggleExpanded(item.id); }}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</TooltipButton> : null}
              </>
            ) : null}
            <TooltipButton
              className={`copy-reference-button ${referenceCopied ? "is-copied" : ""}`}
              label={referenceCopied ? `${item.isGroup ? "Group" : "Item"} reference copied` : `Copy ${item.isGroup ? "Group" : "Item"} reference`}
              onClick={(event) => {
                event.stopPropagation();
                void onCopyReference(item).then((copied) => {
                  if (!copied) {
                    window.alert(`Clipboard access was blocked. Open the ${item.isGroup ? "Group" : "Item"} and copy its title and ID from the detail view.`);
                    return;
                  }
                  showReferenceCopied();
                });
              }}
            >
              <CopyConfirmationIcon confirmed={referenceCopied} />
            </TooltipButton>
          </div>
          <div className="card-action-group">
            {item.status !== "complete" && item.status !== "archived" ? (
              <TooltipButton
                label="Mark complete"
                onClick={(event) => {
                  event.stopPropagation();
                  onMove(item.id, "complete");
                }}
              >
                <CheckCircle2 size={14} />
              </TooltipButton>
            ) : null}
            {item.status !== "archived" ? (
              <TooltipButton
                label="Archive"
                onClick={(event) => {
                  event.stopPropagation();
                  onMove(item.id, "archived");
                }}
              >
                <Archive size={14} />
              </TooltipButton>
            ) : (
              <TooltipButton
                label="Restore"
                onClick={(event) => {
                  event.stopPropagation();
                  onMove(item.id, "pending");
                }}
              >
                <RotateCcw size={14} />
              </TooltipButton>
            )}
            {item.status === "archived" ? (
              <TooltipButton
                label="Delete permanently"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(item.id);
                }}
              >
                <Trash2 size={14} />
              </TooltipButton>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

interface CrossColumnDropPreview {
  item: RoadmapItem;
  status: Status;
  targetId: string | null;
  operation: "before" | "after" | "empty";
}

function CrossColumnPreviewCard({ item, rollup }: { item: RoadmapItem; rollup: GroupRollup<RoadmapItem> | undefined }) {
  return (
    <article className={`card ${item.nextAction || item.summary ? "" : "compact"} hierarchy-reorder-placeholder cross-column-drop-preview`} aria-hidden="true">
      <CardContent item={item} rollup={rollup} />
    </article>
  );
}

function Column({
  status,
  items,
  collapsed,
  cardsHidden,
  highlighted,
  onToggleCollapsed,
  onToggleCards,
  onSelect,
  onCopyReference,
  onMove,
  onDelete,
  readOnly = false,
  groupRollups,
  onOpenGroup,
  expandedGroupIds,
  onToggleGroupExpanded,
  allItems = [],
  dropIntent = null,
  crossColumnDropPreview = null,
  receiverDragHeight = null,
  ancestryById,
  activityForItem,
  onHideArchived,
}: {
  status: Status;
  items: RoadmapItem[];
  collapsed: boolean;
  cardsHidden: boolean;
  highlighted: boolean;
  onToggleCollapsed: () => void;
  onToggleCards: () => void;
  onSelect: (id: string) => void;
  onCopyReference: (item: RoadmapItem) => Promise<boolean>;
  onMove: (id: string, status: Status) => void;
  onDelete: (id: string) => void;
  readOnly?: boolean;
  groupRollups?: Map<string, GroupRollup<RoadmapItem>>;
  onOpenGroup?: (id: string) => void;
  expandedGroupIds?: Set<string>;
  onToggleGroupExpanded?: (id: string) => void;
  allItems?: RoadmapItem[];
  dropIntent?: { targetId: string; operation: HierarchyDropOperation } | null;
  crossColumnDropPreview?: CrossColumnDropPreview | null;
  receiverDragHeight?: number | null;
  ancestryById?: Map<string, RoadmapItem[]>;
  activityForItem?: (item: RoadmapItem) => ActivityPresentation | null;
  onHideArchived?: () => void;
}) {
  const { setNodeRef } = useDroppable({ id: status });
  const destinationPreview = crossColumnDropPreview?.status === status ? crossColumnDropPreview : null;
  const previewCard = destinationPreview
    ? <CrossColumnPreviewCard item={destinationPreview.item} rollup={groupRollups?.get(destinationPreview.item.id)} />
    : null;

  if (collapsed) {
    return (
      <section ref={setNodeRef} className={`column collapsed ${highlighted && !readOnly ? "highlighted" : ""}`} data-status={status}>
        <button onClick={onToggleCollapsed} className="icon-button">
          <Minimize2 size={14} />
        </button>
        <div className="vertical-label">
          <span>{labels[status]}</span>
          <b>{items.length}</b>
        </div>
      </section>
    );
  }

  return (
    <section ref={setNodeRef} className={`column ${highlighted ? "highlighted" : ""}`} data-status={status}>
      <header className="column-header">
        <button onClick={onToggleCards} className="icon-button">
          {cardsHidden ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <h2>{labels[status]}</h2>
        <span className="count">{items.length}</span>
        {status === "archived" && onHideArchived ? (
          <TooltipButton label="Hide Archive" className="column-archive-toggle" aria-pressed={true} onClick={onHideArchived}>
            <span className="archive-switch" aria-hidden="true"><span className="archive-switch-knob" /></span>
          </TooltipButton>
        ) : null}
        <button onClick={onToggleCollapsed} className="icon-button right">
          <Minimize2 size={14} />
        </button>
      </header>
      <div className={`column-drop-zone ${highlighted && !readOnly ? "highlighted" : ""}`}>
        {!cardsHidden ? (
          <SortableContext
            items={items.map((item) => item.id)}
            strategy={hierarchySortingStrategy(
              items.map((item) => item.id),
              crossColumnDropPreview ? null : dropIntent?.targetId ?? null,
              crossColumnDropPreview ? null : dropIntent?.operation ?? null,
            )}
          >
            <div className="card-stack">
              {items.map((item) => (
                <React.Fragment key={item.id}>
                  {destinationPreview?.targetId === item.id && destinationPreview.operation === "before" ? previewCard : null}
                  <SortableCard
                    item={item}
                    onSelect={onSelect}
                    onCopyReference={onCopyReference}
                    onMove={onMove}
                    onDelete={onDelete}
                    readOnly={readOnly}
                    rollup={groupRollups?.get(item.id)}
                    onOpenGroup={onOpenGroup}
                    expanded={expandedGroupIds?.has(item.id) === true}
                    onToggleExpanded={onToggleGroupExpanded}
                    inlineChildren={itemsInGroup(allItems, item.id)}
                    dropOperation={dropIntent?.targetId === item.id && dropIntent.operation === "inside" ? "inside" : null}
                    reorderPreview={hierarchyReorderPlaceholderVisible(dropIntent?.operation ?? null) && !crossColumnDropPreview}
                    hideSourceDuringDrag={dropIntent?.operation === "inside" || Boolean(crossColumnDropPreview)}
                    containmentActive={dropIntent?.operation === "inside"}
                    receiverDragHeight={receiverDragHeight}
                    ancestry={ancestryById?.get(item.id) ?? []}
                    activity={activityForItem?.(item) ?? null}
                  />
                  {destinationPreview?.targetId === item.id && destinationPreview.operation === "after" ? previewCard : null}
                </React.Fragment>
              ))}
              {destinationPreview?.operation === "empty" ? previewCard : null}
              {items.length === 0 && !destinationPreview ? <div className="empty-drop">Drop here</div> : null}
            </div>
          </SortableContext>
        ) : (
          <div className="empty-drop hidden-cards-state"><span>{items.length} cards hidden</span></div>
        )}
      </div>
    </section>
  );
}

function useListboxPopover(
  open: boolean,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  disabled = false,
) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, setOpen]);

  function focusOption(preferSelected: boolean, direction: 1 | -1 = 1) {
    requestAnimationFrame(() => {
      const enabledOptions = [...(containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
      const selected = preferSelected
        ? containerRef.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]:not(:disabled)')
        : null;
      (selected ?? (direction > 0 ? enabledOptions[0] : enabledOptions.at(-1)))?.focus();
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      containerRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const direction: 1 | -1 = event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
    if (!open) {
      setOpen(true);
      focusOption(true, direction);
      return;
    }
    const enabledOptions = [...(containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
    if (enabledOptions.length === 0) return;
    if (event.key === "Home" || event.key === "End") {
      (event.key === "Home" ? enabledOptions[0] : enabledOptions.at(-1))?.focus();
      return;
    }
    const currentIndex = enabledOptions.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = currentIndex < 0
      ? (direction > 0 ? 0 : enabledOptions.length - 1)
      : (currentIndex + direction + enabledOptions.length) % enabledOptions.length;
    enabledOptions[nextIndex]?.focus();
  }

  return { containerRef, onKeyDown };
}

function useDialogFocus<T extends HTMLElement>(enabled = true) {
  const dialogRef = useRef<T>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const activeDialog = dialog;
    const focusableSelector = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';
    const focusableElements = () => [...activeDialog.querySelectorAll<HTMLElement>(focusableSelector)]
      .filter((element) => element.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => {
      if (activeDialog.contains(document.activeElement)) return;
      const preferred = activeDialog.querySelector<HTMLElement>('[data-dialog-initial-focus], [autofocus]');
      (preferred ?? focusableElements()[0] ?? activeDialog).focus();
    });
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        activeDialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [enabled]);

  return dialogRef;
}

function BoardPicker({
  boards,
  currentRepoId,
  onSelectBoard,
}: {
  boards: BoardRecord[];
  currentRepoId: string;
  onSelectBoard: (repoId: string) => void;
}) {
  const orderedBoards = useMemo(
    () => boards.slice().sort((a, b) => a.title.localeCompare(b.title) || a.cwd.localeCompare(b.cwd)),
    [boards],
  );
  const [open, setOpen] = useState(false);
  const [visibleBoards, setVisibleBoards] = useState(orderedBoards);
  const currentBoard = boards.find((board) => board.repoId === currentRepoId);
  const canSwitch = orderedBoards.length > 1;
  const pickerBoards = open ? visibleBoards : orderedBoards;
  const { containerRef, onKeyDown } = useListboxPopover(open, setOpen, !canSwitch);

  useEffect(() => {
    if (!open) setVisibleBoards(orderedBoards);
  }, [open, orderedBoards]);

  return (
    <div ref={containerRef} className="board-picker" onKeyDown={onKeyDown}>
      <button
        className={`board-picker-trigger ${canSwitch ? "" : "single-board"}`}
        aria-haspopup={canSwitch ? "listbox" : undefined}
        aria-expanded={canSwitch ? open : undefined}
        onClick={() => {
          if (!canSwitch) return;
          setOpen((value) => {
            const nextOpen = !value;
            if (nextOpen) setVisibleBoards(orderedBoards);
            return nextOpen;
          });
        }}
      >
        <span>{currentBoard?.title ?? currentRepoId}</span>
        {canSwitch ? <ChevronDown size={16} /> : null}
      </button>
      {open ? (
        <div className="board-picker-popover" role="listbox" aria-label="Switch Planban board">
          {pickerBoards.map((board) => (
            <button
              key={board.repoId}
              className={board.repoId === currentRepoId ? "active" : ""}
              role="option"
              aria-selected={board.repoId === currentRepoId}
              onClick={() => {
                setOpen(false);
                onSelectBoard(board.repoId);
              }}
            >
              <span>
                <b>{board.title}</b>
                {capabilities.projectFolders ? <small>{board.cwd}</small> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BoardMoreMenu({
  onOpenGoals,
  onOpenSettings,
  onOpenConnections,
  webAddress,
  onOpenHistory,
  onOpenTutorial,
  onOpenFeedback,
  hasArchivedCards,
  showArchived,
  onToggleArchived,
}: {
  onOpenGoals?: () => void;
  onOpenSettings?: () => void;
  onOpenConnections?: () => void;
  /** An online board's address on the web page, for the installed app's "Open on the web". */
  webAddress?: string | undefined;
  onOpenHistory?: () => void;
  onOpenTutorial?: () => void;
  onOpenFeedback: () => void;
  hasArchivedCards: boolean;
  showArchived: boolean;
  onToggleArchived: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { containerRef, onKeyDown } = useListboxPopover(open, setOpen);
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <div ref={containerRef} className="board-more-menu" onKeyDown={onKeyDown}>
      <TooltipButton
        label="More Board actions"
        className={`toolbar-icon-button tooltip-below ${open ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={15} />
      </TooltipButton>
      {open ? (
        <div className="board-more-popover" role="menu">
          {onOpenGoals ? <button role="menuitem" onClick={() => choose(onOpenGoals)}><Target size={14} /><span>Goals</span></button> : null}
          {onOpenSettings ? <button role="menuitem" onClick={() => choose(onOpenSettings)}><Settings size={14} /><span>Board settings</span></button> : null}
          {onOpenConnections ? <button role="menuitem" onClick={() => choose(onOpenConnections)}><Link2 size={14} /><span>Your connections</span></button> : null}
          {webAddress ? <button role="menuitem" onClick={() => choose(() => { window.open(webAddress, "_blank", "noopener,noreferrer"); })}><ExternalLink size={14} /><span>Open on the web</span></button> : null}
          {onOpenHistory ? <button role="menuitem" onClick={() => choose(onOpenHistory)}><History size={14} /><span>Board history</span></button> : null}
          {onOpenTutorial ? <button role="menuitem" onClick={() => choose(onOpenTutorial)}><HelpCircle size={14} /><span>Tutorial</span></button> : null}
          <button role="menuitem" onClick={() => choose(onOpenFeedback)}><Bug size={14} /><span>Feedback / Bug</span></button>
          {hasArchivedCards ? (
            <button
              className={`board-more-toggle ${showArchived ? "active" : ""}`}
              role="menuitemcheckbox"
              aria-checked={showArchived}
              onClick={() => choose(onToggleArchived)}
            >
              <Archive size={14} />
              <span>Archive</span>
              <span className="archive-switch" aria-hidden="true"><span className="archive-switch-knob" /></span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BoardHistoryModal({
  history,
  previewVersion,
  onSelectVersion,
  onReturnToCurrent,
  onClose,
}: {
  history: HistoryPayload | null;
  previewVersion: number | null;
  onSelectVersion: (version: number) => void;
  onReturnToCurrent: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLElement>();
  const currentVersion = history?.currentVersion ?? 1;
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} className="board-history-modal" role="dialog" aria-modal="true" aria-labelledby="board-history-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header className="feedback-modal-header">
          <div><p className="eyebrow">Recovery</p><h2 id="board-history-title">Board history</h2></div>
          <TooltipButton label="Close Board history" className="toolbar-icon-button" onClick={onClose}><X size={14} /></TooltipButton>
        </header>
        <div className="board-history-list" role="listbox" aria-label="Board version history">
          {(history?.entries ?? []).map((entry) => {
            const isCurrent = entry.version === currentVersion;
            const isPreview = entry.version === previewVersion || (isCurrent && previewVersion === null);
            return (
              <button key={entry.version} className={isPreview ? "active" : ""} role="option" aria-selected={isPreview} onClick={() => {
                if (isCurrent) onReturnToCurrent();
                else onSelectVersion(entry.version);
                onClose();
              }}>
                <span><b>{versionLabel(entry.version, currentVersion)}</b><HistoryAuthor attribution={entry.attribution} actor={entry.actor} /><small>{formatHistoryTime(entry.createdAt)} · {entry.actor} · {entry.summary}</small></span>
              </button>
            );
          })}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function FeedbackModal({
  state,
  onClose,
}: {
  state: PlanbanState;
  onClose: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<"open" | "copy" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLElement>();
  const canSubmit = feedback.trim().length > 0 && busy === null;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function openInCodex() {
    if (!canSubmit) return;
    setBusy("open");
    setStatus(null);
    try {
      const result = await openCodexFeedbackThread(state, feedback);
      setStatus(result.opened ? "Opened a Codex draft thread. Hit enter there to continue." : "Copied the feedback prompt.");
      if (result.opened) onClose();
    } finally {
      setBusy(null);
    }
  }

  async function copyPrompt() {
    if (!canSubmit) return;
    setBusy("copy");
    setStatus(null);
    try {
      const copied = await copyFeedbackPrompt(state, feedback);
      setStatus(copied
        ? "Copied. Paste it into Codex to provide feedback through your agent."
        : "Clipboard access was blocked. Use Open in Codex instead.");
    } catch {
      setStatus("Clipboard access was blocked. Try opening a Codex draft instead.");
    } finally {
      setBusy(null);
    }
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="feedback-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="feedback-modal-header">
          <div>
            <p className="eyebrow">Planban feedback</p>
            <h2 id="feedback-title">Tell us what happened</h2>
          </div>
          <TooltipButton label="Close feedback" className="toolbar-icon-button" onClick={onClose}>
            <X size={14} />
          </TooltipButton>
        </header>
        <textarea
          autoFocus
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder="Describe the bug, request, rough edge, or reaction. Your agent will turn this into the right feedback format."
        />
        <p className="feedback-privacy">
          Planban will hand this to your agent as a draft. Nothing is posted publicly until you confirm it.
        </p>
        {status ? <p className="feedback-status">{status}</p> : null}
        <footer className="feedback-actions">
          <button className="primary" onClick={copyPrompt} disabled={!canSubmit}>
            {busy === "copy" ? <Loader2 size={14} className="spin" /> : <Copy size={14} />}
            Copy prompt
          </button>
          {capabilities.localAgents ? (
            <button onClick={openInCodex} disabled={!canSubmit}>
              {busy === "open" ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
              Open in Codex
            </button>
          ) : null}
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function UpdateModal({
  state,
  status,
  postUpdateVersion,
  onClose,
}: {
  state: PlanbanState;
  status: UpdateStatusPayload | null;
  postUpdateVersion?: string | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<"open" | "copy" | "setup" | "direct" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<UpdatePreflightPayload | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [updateJob, setUpdateJob] = useState<UpdateRunSnapshot | null>(null);
  const dialogRef = useDialogFocus<HTMLElement>();
  const latest = status?.latest ?? null;
  const canDirectUpdate = Boolean(status?.updateAvailable && status.compatible && preflight?.directUpdateAvailable);
  const isPostUpdate = Boolean(postUpdateVersion && latest?.version === postUpdateVersion && !status?.updateAvailable);
  const showAgentUpdateFallback = Boolean(
    status?.updateAvailable &&
    !canDirectUpdate &&
    ((preflight && preflight.recommendedAction !== "setup-prerequisites") || preflightError),
  );
  const showSetupFallback = Boolean(status?.updateAvailable && !canDirectUpdate && preflight?.recommendedAction === "setup-prerequisites");
  const showWaitingForPreflight = Boolean(status?.updateAvailable && !preflight && !preflightError && !updateJob);
  const showUpdateJobDetails = Boolean(updateJob?.status === "failed");
  const updateInFlight = Boolean(
    updateJob &&
    (updateJob.status === "pending" || updateJob.status === "running" || (updateJob.status === "succeeded" && updateJob.restartRequired)),
  );
  const showChangelog = Boolean(status?.updateAvailable || (postUpdateVersion && latest?.version === postUpdateVersion));
  const completedUpdateSteps = updateJob?.steps.filter((step) => step.status === "succeeded" || step.status === "skipped").length ?? 0;
  const totalUpdateSteps = updateJob?.steps.length ?? 0;
  const updateProgressPercent = totalUpdateSteps > 0
    ? Math.max(6, Math.round((completedUpdateSteps / totalUpdateSteps) * 100))
    : updateJob
      ? 6
      : 0;
  const updateVersionLine = status
    ? status.updateAvailable && latest?.version && latest.version !== status.current.version
      ? `${status.current.version} -> ${latest.version}`
      : `Version ${status.current.version}`
    : null;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setPreflight(null);
    setPreflightError(null);

    api<UpdatePreflightPayload>("/api/update-preflight")
      .then((payload) => {
        if (!cancelled) setPreflight(payload);
      })
      .catch((error: unknown) => {
        if (!cancelled) setPreflightError(error instanceof Error ? error.message : "Could not inspect this Planban install.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!updateJob || (updateJob.status !== "pending" && updateJob.status !== "running")) return undefined;

    let cancelled = false;
    const timer = window.setInterval(() => {
      api<UpdateRunSnapshot>(`/api/update-run/${encodeURIComponent(updateJob.id)}`)
        .then((payload) => {
          if (!cancelled) {
            setUpdateJob(payload);
            if (payload.status === "succeeded" || payload.status === "failed") setBusy(null);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setBusy(null);
            if (updateJob.restartRequired && updateJob.targetVersion) {
              setUpdateJob({
                ...updateJob,
                status: "succeeded",
                message: "Planban is restarting locally. Waiting for the updated app...",
              });
            } else {
              setMessage(error instanceof Error ? error.message : "Could not read update progress.");
            }
          }
        });
    }, 350);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [updateJob]);

  useEffect(() => {
    if (!status || !updateJob || updateJob.status !== "succeeded" || !updateJob.restartRequired || !updateJob.targetVersion) {
      return undefined;
    }

    let cancelled = false;
    const boardUrl = updateJob.currentBoardUrl ?? `${window.location.origin}/boards/${encodeURIComponent(state.manifest.repoId)}`;
    const tutorialUrl = `${window.location.origin}/tutorial?mode=first-run`;
    const destination = postUpdateBrowserUrl(status, boardUrl, tutorialUrl);

    const timer = window.setInterval(() => {
      api<{ version: VersionInfo }>("/api/status")
        .then((payload) => {
          if (cancelled) return;
          if (compareVersionStrings(payload.version.version, updateJob.targetVersion ?? "0.0.0") >= 0) {
            window.clearInterval(timer);
            window.location.href = destination;
          }
        })
        .catch(() => {
          // The server may be between shutdown and restart; keep polling.
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state.manifest.repoId, status, updateJob]);


  async function runDirectUpdate() {
    if (!status || !canDirectUpdate) return;
    setBusy("direct");
    setMessage(null);
    setManualPrompt(null);
    try {
      const job = await api<UpdateRunSnapshot>("/api/update-run", {
        method: "POST",
        body: JSON.stringify({ currentBoardUrl: window.location.href }),
      });
      setUpdateJob(job);
    } catch (error) {
      setBusy(null);
      setMessage(error instanceof Error ? error.message : "Could not start Planban update.");
    }
  }

  async function openInCodex() {
    if (!status) return;
    setBusy("open");
    setMessage(null);
    setManualPrompt(null);
    try {
      const result = await openCodexUpdateThread(state, status);
      setMessage(result.opened ? "Opened a Codex draft thread. Hit enter there to continue." : "Copied the update prompt.");
      if (result.opened) onClose();
    } finally {
      setBusy(null);
    }
  }

  async function openSetupInCodex() {
    if (!preflight?.setupPrompt) return;
    setBusy("setup");
    setMessage(null);
    setManualPrompt(null);
    try {
      await openCodexPromptForState(state, preflight.setupPrompt);
      setMessage("Opened a Codex setup draft. Hit enter there to continue.");
      onClose();
    } finally {
      setBusy(null);
    }
  }

  async function copyPrompt() {
    if (!status) return;
    setBusy("copy");
    setMessage(null);
    setManualPrompt(null);
    try {
      const result = await copyUpdatePrompt(state, status);
      if (result.copied) {
        setMessage("Copied. Paste it into Codex to update Planban through your agent.");
      } else {
        setManualPrompt(result.prompt);
        setMessage("Clipboard access was blocked. Select the prompt below, or open a Codex draft instead.");
      }
    } catch {
      const prompt = buildUpdatePrompt(state, status);
      setManualPrompt(prompt);
      setMessage("Clipboard access was blocked. Select the prompt below, or open a Codex draft instead.");
    } finally {
      setBusy(null);
    }
  }

  function copySetupPrompt() {
    if (!preflight?.setupPrompt) return;
    setManualPrompt(preflight.setupPrompt);
    setMessage("Select or copy the setup prompt, then paste it into Codex.");
  }

  return createPortal(
    <div className="modal-backdrop update-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="update-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="feedback-modal-header">
          <div>
            <p className="eyebrow">Planban updates</p>
            <h2 id="update-title">{status?.updateAvailable ? "Update available" : postUpdateVersion ? "Update applied" : "Planban updates"}</h2>
            {updateVersionLine ? <p className="update-version-line">{updateVersionLine}</p> : null}
          </div>
          <TooltipButton label="Close updates" className="toolbar-icon-button" onClick={onClose}>
            <X size={14} />
          </TooltipButton>
        </header>
        <div className="update-modal-body">
          {status ? (
            <>
              {status.checkError ? (
                <p className="update-note">Could not check for updates: {status.checkError}</p>
              ) : showChangelog ? (
                <section className="update-summary">
                  <p className="eyebrow">What's changed</p>
                  {latest?.changelogTitle ? <h3>{latest.changelogTitle}</h3> : null}
                  <p>{latest?.changelogSummary ?? latest?.summary}</p>
                </section>
              ) : (
                <p className="update-note">You are on the latest known Planban version.</p>
              )}
              {!status.compatible ? (
                <p className="update-warning">This update may require a storage migration. Ask Codex to back up your Planban data before updating.</p>
              ) : null}
              <div className="update-links subtle">
                {latest?.releaseNotesUrl ? (
                  <a href={latest.releaseNotesUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={13} />
                    View release notes
                  </a>
                ) : null}
              </div>
              {showWaitingForPreflight ? (
                <p className="update-note">Checking whether this install can update directly...</p>
              ) : null}
              {showAgentUpdateFallback || showSetupFallback || preflightError ? (
                <section className="update-preflight" aria-label="Update readiness">
                  <div className="update-preflight-header">
                    <p className="eyebrow">{showSetupFallback ? "Setup needed" : "Update with Codex"}</p>
                    {preflight ? (
                      <span className={`update-preflight-badge ${preflight.recommendedAction}`}>
                        {preflight.recommendedAction === "update-now"
                          ? "Eligible"
                          : preflight.recommendedAction === "setup-prerequisites"
                            ? "Setup needed"
                            : "Use Codex"}
                      </span>
                    ) : null}
                  </div>
                  {preflightError ? (
                    <p className="update-note">Could not inspect this install: {preflightError}</p>
                  ) : preflight ? (
                    <>
                      <p className="update-preflight-summary">
                        {preflight.recommendedAction === "setup-prerequisites"
                          ? "Planban needs a local prerequisite before it can update this install."
                          : "This install needs the agent-guided update path. Copy the update prompt into Codex, or open a Codex draft to continue."}
                      </p>
                      {preflight.blockedReasons.length > 0 ? (
                        <ul className="update-preflight-list">
                          {preflight.blockedReasons.slice(0, 3).map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      ) : null}
                      {preflight.warnings.length > 0 ? (
                        <p className="update-preflight-warning">{preflight.warnings[0]}</p>
                      ) : null}
                      {preflight.setupPrompt ? (
                        <div className="update-preflight-actions">
                          <button onClick={copySetupPrompt} disabled={busy !== null}>
                            <Copy size={13} />
                            Copy setup prompt
                          </button>
                          <button className="primary" onClick={openSetupInCodex} disabled={busy !== null}>
                            {busy === "setup" ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
                            Open setup prompt in Codex
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </section>
              ) : null}
              {showUpdateJobDetails && updateJob ? (
                <section className="update-job" aria-label="Update progress">
                  <div className="update-preflight-header">
                    <p className="eyebrow">Update progress</p>
                    <span className={`update-preflight-badge ${updateJob.status}`}>
                      {updateJob.status}
                    </span>
                  </div>
                  <p className="update-preflight-summary">{updateJob.message}</p>
                  <div className="update-progress-track" aria-hidden="true">
                    <div style={{ width: `${updateProgressPercent}%` }} />
                  </div>
                  {updateJob.steps.length > 0 ? (
                    <details className="update-job-details">
                      <summary>Show technical steps</summary>
                      <ol className="update-job-steps">
                        {updateJob.steps.map((step) => (
                          <li key={step.id} className={step.status}>
                            <span>{step.label}</span>
                            <b>{step.status}</b>
                            {step.error ? <small>{step.error}</small> : null}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                  {updateJob.status === "succeeded" && updateJob.restartRequired ? (
                    <p className="update-preflight-warning">
                      Planban is restarting locally. This board will reopen when the updated app is ready.
                    </p>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : (
            <p className="update-note">Checking for updates...</p>
          )}
          {message ? <p className="feedback-status">{message}</p> : null}
          {manualPrompt ? (
            <textarea
              className="manual-prompt-fallback"
              readOnly
              value={manualPrompt}
              aria-label="Update prompt"
              onFocus={(event) => event.currentTarget.select()}
            />
          ) : null}
        </div>
        {!isPostUpdate && (canDirectUpdate || showAgentUpdateFallback) ? <footer className="feedback-actions">
          {canDirectUpdate ? (
            <button className="primary update-now-action" onClick={runDirectUpdate} disabled={busy !== null || updateInFlight}>
              {busy === "direct" || updateInFlight ? <Loader2 size={14} className="spin" /> : null}
              {busy === "direct" || updateInFlight ? "Updating" : "Update now"}
            </button>
          ) : null}
          {showAgentUpdateFallback ? (
            <>
              <button onClick={copyPrompt} disabled={!status || busy !== null || updateInFlight}>
                {busy === "copy" ? <Loader2 size={14} className="spin" /> : <Copy size={14} />}
                Copy update prompt
              </button>
              <button className="primary" onClick={openInCodex} disabled={!status || busy !== null || updateInFlight}>
                {busy === "open" ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                Update with Codex
              </button>
            </>
          ) : null}
        </footer> : null}
      </section>
    </div>,
    document.body,
  );
}

function FirstRunPrompt({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section className="first-run-prompt" aria-label="Planban tutorial">
      <div>
        <p className="eyebrow">Planban tour</p>
        <h2>Take the two-minute tour</h2>
        <p>
          Learn how the board, cards, specs, and Codex prompts stay in sync.
        </p>
      </div>
      <div className="first-run-prompt-actions">
        <button
          onClick={() => {
            writeTutorialProgress("skipped");
            onDismiss();
          }}
        >
          Skip
        </button>
        <button className="primary" onClick={() => openTutorial("first-run")}>
          <Play size={14} />
          Start tutorial
        </button>
      </div>
    </section>
  );
}

const fallbackTutorialItems: RoadmapItem[] = [
  {
    id: "drag-this-card-to-in-progress",
    title: "Drag this card to In Progress",
    status: "up-next",
    priority: 1,
    summary: "Try the board by moving this card into In Progress.",
    nextAction: "Move this card, then ask your agent to summarize the board.",
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: null,
    planDoc: null,
    completedAt: null,
    updatedAt: null,
  },
  {
    id: "copy-a-reference-into-agent-chat",
    title: "Copy a reference into agent chat",
    status: "up-next",
    priority: 2,
    summary: "Use a card to start an agent thread with the right context.",
    nextAction: "Copy the reference when you want an agent to pick up this exact Item.",
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: null,
    planDoc: null,
    completedAt: null,
    updatedAt: null,
  },
  {
    id: "send-feedback-from-the-toolbar",
    title: "Send feedback from the toolbar",
    status: "pending",
    priority: 3,
    summary: "Feedback is handed to your agent before anything is filed publicly.",
    nextAction: "Use More · Feedback / Bug or Planban Feedback when something is rough.",
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: null,
    planDoc: null,
    completedAt: null,
    updatedAt: null,
  },
  {
    id: "mark-a-card-complete-when-you-are-done",
    title: "Mark a card Complete when you are done",
    status: "in-progress",
    priority: 1,
    summary: "Completion should be intentional, especially when an agent is doing the work.",
    nextAction: "Drag this In Progress card to Complete once you are happy with the work.",
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: null,
    planDoc: null,
    completedAt: null,
    updatedAt: null,
  },
  {
    id: "ask-your-agent-to-create-roadmap-items-from-your-plans",
    title: "Ask your agent to create roadmap items from your plans",
    status: "pending",
    priority: 4,
    summary: "Bring existing project context from docs, issues, Notion, Jira, Linear, or plain notes.",
    nextAction: "Give your agent the current planning context and ask it to draft Planban roadmap items for review.",
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: null,
    planDoc: null,
    completedAt: null,
    updatedAt: null,
  },
];

function tutorialItemsFromState(state: PlanbanState | null) {
  const source = state?.roadmap.roadmapItems.length ? state.roadmap.roadmapItems : fallbackTutorialItems;
  return source.slice(0, 5).map((item) => ({ ...item }));
}

function TutorialBackground({ items }: { items: RoadmapItem[] }) {
  return (
    <div className="tutorial-background-board">
      <header>
        <div>
          <p className="eyebrow">Planban</p>
          <h2>Planban Demo</h2>
        </div>
        <div className="tutorial-background-actions">
          <span>v1</span>
          <span />
          <span />
        </div>
      </header>
      <TutorialMiniBoard items={items} selectedId={null} onSelect={() => undefined} />
    </div>
  );
}

function TutorialMiniBoard({
  items,
  selectedId,
  onSelect,
  onItemsChange,
  draggable = false,
}: {
  items: RoadmapItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onItemsChange?: (items: RoadmapItem[], selectedId?: string) => void;
  draggable?: boolean;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 3 } }));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeSize, setActiveSize] = useState<{ width: number; height: number } | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<Status | null>(null);
  const [draftItems, setDraftItems] = useState<RoadmapItem[] | null>(null);
  const draftItemsRef = useRef<RoadmapItem[] | null>(null);
  const dragStartItemsRef = useRef<RoadmapItem[] | null>(null);
  const lastDropTargetIdRef = useRef<string | null>(null);
  const displayItems = draftItems ?? items;
  const grouped = groupItemsInCurrentOrder(displayItems);
  const visible = statuses.filter((status) => status !== "archived");

  function updateDraftItems(nextItems: RoadmapItem[] | null) {
    draftItemsRef.current = nextItems;
    setDraftItems(nextItems);
  }

  function findStatus(id: string, currentItems = displayItems): Status | null {
    return statusForDropTarget(currentItems, id);
  }

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    setActiveId(id);
    dragStartItemsRef.current = items;
    lastDropTargetIdRef.current = null;
    updateDraftItems(items);
    onSelect(id);
    const rect = event.active.rect.current.initial;
    setActiveSize(rect ? { width: rect.width, height: rect.height } : null);
  }

  function handleDragOver(event: DragOverEvent) {
    const draggingId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId) return;
    if (overId === draggingId) return;
    const dragStartItems = dragStartItemsRef.current ?? items;
    const target = findStatus(overId, dragStartItems);
    setDragOverStatus(target);
    if (!target) return;
    lastDropTargetIdRef.current = overId;
    updateDraftItems(previewCrossStatusDragOver(dragStartItems, draggingId, overId));
  }

  function handleDragEnd(event: DragEndEvent) {
    const id = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    const dragStartItems = dragStartItemsRef.current ?? items;
    setActiveId(null);
    setActiveSize(null);
    setDragOverStatus(null);
    const resolvedOverId = resolveDropTargetId(dragStartItems, id, overId, lastDropTargetIdRef.current);
    dragStartItemsRef.current = null;
    lastDropTargetIdRef.current = null;
    updateDraftItems(null);
    if (!resolvedOverId) return;

    const target = findStatus(resolvedOverId, dragStartItems);
    if (!target) return;
    const nextItems = reorderItemsForDrop(dragStartItems, id, resolvedOverId);
    onItemsChange?.(nextItems, id);
  }

  function handleDragCancel() {
    setActiveId(null);
    setActiveSize(null);
    setDragOverStatus(null);
    dragStartItemsRef.current = null;
    lastDropTargetIdRef.current = null;
    updateDraftItems(null);
  }

  const board = (
    <div className="tutorial-mini-board" aria-label="Planban tutorial board preview">
      {visible.map((status) => (
        <TutorialMiniColumn
          key={status}
          status={status}
          items={grouped[status]}
          highlighted={dragOverStatus === status}
          draggable={draggable}
          onSelect={onSelect}
          selectedId={selectedId}
        />
      ))}
    </div>
  );

  if (!draggable) return board;

  const activeItem = activeId ? displayItems.find((item) => item.id === activeId) ?? items.find((item) => item.id === activeId) : null;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {board}
      <DragOverlay>
        {activeItem ? (
          <button className="tutorial-mini-card drag-card" style={activeSize ?? undefined}>
            <b>{activeItem.title}</b>
            {activeItem.nextAction || activeItem.summary ? <span>{activeItem.nextAction || activeItem.summary}</span> : null}
          </button>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function TutorialMiniColumn({
  status,
  items,
  highlighted,
  draggable,
  selectedId,
  onSelect,
}: {
  status: Status;
  items: RoadmapItem[];
  highlighted: boolean;
  draggable: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { setNodeRef } = useDroppable({ id: status, disabled: !draggable });
  return (
    <section ref={setNodeRef} className={`tutorial-mini-column ${draggable ? "drag-enabled" : ""} ${highlighted ? "highlighted" : ""}`}>
      <header>
        <span>{labels[status]}</span>
        <b>{items.length}</b>
      </header>
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        <div className="tutorial-mini-stack">
          {items.map((item) => (
            draggable ? (
              <TutorialMiniSortableCard
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onSelect={onSelect}
              />
            ) : (
              <button
                key={item.id}
                className={`tutorial-mini-card ${selectedId === item.id ? "active" : ""}`}
                onClick={() => onSelect(item.id)}
              >
                <b>{item.title}</b>
                {item.nextAction || item.summary ? <span>{item.nextAction || item.summary}</span> : null}
              </button>
            )
          ))}
        </div>
      </SortableContext>
    </section>
  );
}

function TutorialMiniSortableCard({
  item,
  selected,
  onSelect,
}: {
  item: RoadmapItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };
  return (
    <button
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`tutorial-mini-card ${selected ? "active" : ""} ${isDragging ? "is-dragging" : ""}`}
      onClick={() => onSelect(item.id)}
    >
      <b>{item.title}</b>
      {item.nextAction || item.summary ? <span>{item.nextAction || item.summary}</span> : null}
    </button>
  );
}

function TutorialLiveBoard({
  items: sourceItems,
  onSelect,
  onItemsChange,
  draggable = true,
}: {
  items: RoadmapItem[];
  onSelect: (id: string) => void;
  onItemsChange?: (items: RoadmapItem[], selectedId?: string) => void;
  draggable?: boolean;
}) {
  const [items, setItems] = useState<RoadmapItem[]>(sourceItems);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeSize, setActiveSize] = useState<{ width: number; height: number } | null>(null);
  const [dragOver, setDragOver] = useState<Status | null>(null);
  const dragStartItemsRef = useRef<RoadmapItem[] | null>(null);
  const lastDropTargetIdRef = useRef<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 3 } }));
  const grouped = useMemo(() => groupItemsInCurrentOrder(items), [items]);
  const activeItem = activeId ? items.find((item) => item.id === activeId) : null;
  const visibleStatuses = statuses.filter((status) => status !== "archived");

  useEffect(() => {
    setItems(sourceItems);
    dragStartItemsRef.current = null;
    lastDropTargetIdRef.current = null;
  }, [sourceItems]);

  function moveItem(id: string, status: Status) {
    if (!draggable) return;
    setItems((previous) => {
      const nextItems = previous.map((item) => (item.id === id ? { ...item, status } : item));
      onItemsChange?.(nextItems, id);
      return nextItems;
    });
    onSelect(id);
  }

  function findStatus(id: string): Status | null {
    return statusForDropTarget(dragStartItemsRef.current ?? items, id);
  }

  function onDragStart(event: DragStartEvent) {
    if (!draggable) return;
    const id = String(event.active.id);
    dragStartItemsRef.current = items;
    lastDropTargetIdRef.current = null;
    setActiveId(id);
    onSelect(id);
    const rect = event.active.rect.current.initial;
    setActiveSize(rect ? { width: rect.width, height: rect.height } : null);
  }

  function onDragOver(event: DragOverEvent) {
    if (!draggable) return;
    if (!event.over) return;
    const draggingId = String(event.active.id);
    const overId = String(event.over.id);
    if (overId === draggingId) return;
    const dragStartItems = dragStartItemsRef.current ?? items;
    const target = statusForDropTarget(dragStartItems, overId);
    setDragOver(target);
    if (!target) return;
    lastDropTargetIdRef.current = overId;
    setItems(previewCrossStatusDragOver(dragStartItems, draggingId, overId));
  }

  function onDragEnd(event: DragEndEvent) {
    if (!draggable) return;
    const id = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    const dragStartItems = dragStartItemsRef.current ?? items;
    const resolvedOverId = resolveDropTargetId(dragStartItems, id, overId, lastDropTargetIdRef.current);
    setActiveId(null);
    setActiveSize(null);
    setDragOver(null);
    if (!resolvedOverId) {
      dragStartItemsRef.current = null;
      lastDropTargetIdRef.current = null;
      setItems(sourceItems);
      return;
    }

    const targetStatus = statusForDropTarget(dragStartItems, resolvedOverId);
    dragStartItemsRef.current = null;
    lastDropTargetIdRef.current = null;
    if (!targetStatus) return;

    const nextItems = reorderItemsForDrop(dragStartItems, id, resolvedOverId);
    setItems(nextItems);
    onItemsChange?.(nextItems, id);
    onSelect(id);
  }

  function onDragCancel() {
    dragStartItemsRef.current = null;
    lastDropTargetIdRef.current = null;
    setActiveId(null);
    setActiveSize(null);
    setDragOver(null);
    setItems(sourceItems);
  }

  return (
    <section className="tutorial-live-board" aria-label="Interactive Planban board tutorial">
      <DndContext
        sensors={sensors}
        collisionDetection={boardCollisionDetection}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div className="board-grid" style={{ gridTemplateColumns: visibleStatuses.map(() => "minmax(230px, 1fr)").join(" ") }}>
          {visibleStatuses.map((status) => (
            <Column
              key={status}
              status={status}
              items={grouped[status]}
              collapsed={false}
              cardsHidden={false}
              highlighted={dragOver === status}
              onToggleCollapsed={() => undefined}
              onToggleCards={() => undefined}
              onSelect={onSelect}
              onCopyReference={async () => true}
              onMove={moveItem}
              onDelete={() => undefined}
              readOnly={!draggable}
            />
          ))}
        </div>
        <DragOverlay>
          {activeId ? (
            <article className={`card drag-card ${activeItem?.nextAction || activeItem?.summary ? "" : "compact"}`} style={activeSize ?? undefined}>
              {activeItem ? <CardContent item={activeItem} rollup={undefined} /> : null}
            </article>
          ) : null}
        </DragOverlay>
      </DndContext>
    </section>
  );
}

function TutorialIntroPreview() {
  return (
    <section className="tutorial-intro-preview">
      <div>
        <p className="eyebrow">Project memory</p>
        <h3>Use boards as a second brain</h3>
        <p>Store plans, ideas, rough notes, future features, priorities, and what to work on next.</p>
      </div>
      <ArrowRight size={18} />
      <div>
        <p className="eyebrow">Agent work</p>
        <h3>Start from the same state</h3>
        <p>Your agent can read and update the board, then keep the card status and docs in sync.</p>
      </div>
    </section>
  );
}

function TutorialGroupPreview() {
  return (
    <section className="tutorial-group-preview" aria-label="Group and Item model preview">
      <article className="tutorial-group-card">
        <header>
          <span><FolderOpen size={16} /> Launch readiness</span>
          <b>1/3 complete</b>
        </header>
        <p>Ship one coherent release across product, docs, migration, and public installation.</p>
        <div className="tutorial-group-progress" aria-label="One of three Items complete">
          <span className="complete" />
          <span className="in-progress" />
          <span className="pending" />
        </div>
      </article>
      <div className="tutorial-group-items">
        <p className="eyebrow">Items inside this Group</p>
        <article><span>Verify the release candidate</span><b className="status-in-progress">In Progress</b></article>
        <article><span>Refresh the tutorial</span><b className="status-up-next">Up Next</b></article>
        <article><span>Publish and verify</span><b>Pending</b></article>
      </div>
    </section>
  );
}

function TutorialDetailPreview({ item, onBack }: { item: RoadmapItem | null; onBack?: () => void }) {
  return (
    <aside className="tutorial-detail-preview revealed">
      <header>
        <div>
          <p className="eyebrow">Planban Demo</p>
          <h3>{item?.title ?? "Selected card"}</h3>
        </div>
        {onBack ? <button onClick={onBack}>Back to board</button> : null}
      </header>
      <dl>
        <div>
          <dt>Status</dt>
          <dd>{item ? labels[item.status] : "None"}</dd>
        </div>
        <div>
          <dt>Next action</dt>
          <dd>{item?.nextAction ?? "Each card can carry the next useful thing for you or your agent to do."}</dd>
        </div>
        <div>
          <dt>Spec</dt>
          <dd>Specs and plans sit with the card so any agent surface can start with context.</dd>
        </div>
      </dl>
    </aside>
  );
}

function TutorialAgentGuidance({ kind }: { kind: "reopen" | "planning" }) {
  const reopen = kind === "reopen";
  return (
    <section className="tutorial-agent-guidance">
      <p className="eyebrow">Work through your agent</p>
      <h3>{reopen ? "Bring the Board back whenever you need it" : "Describe the project in ordinary language"}</h3>
      <p>{reopen
        ? "Ask your current agent to open Planban or use the Planban command offered by that host. The exact shortcut can differ, but the Board and its planning state stay the same."
        : "Give your agent rough notes, repo context, issues, or an external planning export and ask it to create or refine Planban Items. Review the result on the Board instead of filling out a planning form."}</p>
      <code>{reopen ? "Open my Planban Board" : "Turn this context into reviewable Planban Items"}</code>
    </section>
  );
}

function TutorialFeedbackPreview() {
  return (
    <section className="tutorial-feedback-preview">
      <div className="tutorial-toolbar-preview" aria-hidden="true">
        <button><MoreHorizontal size={15} /></button>
      </div>
      <div>
        <p className="eyebrow">More · Feedback / Bug</p>
        <h3>Send rough feedback through your agent</h3>
        <p>
          Type the bug, request, fix idea, or reaction. Copy the agent-ready prompt, then the installed
          Planban Feedback skill helps prepare the right GitHub draft before anything is public.
        </p>
        <p className="tutorial-host-adapter-note">
          In Codex, choose <b>Planban Feedback</b> from <code>/planban</code>, enter <code>/Planban Feedback</code>,
          or simply ask your agent to send Planban feedback.
        </p>
      </div>
    </section>
  );
}

const tutorialSteps = [
  {
    title: "Planban keeps planning shared",
    copy: "Use each Planban board as a project second brain: plans, ideas, rough notes, future features, priorities, and roadmap state that your agents can read and update with you.",
  },
  {
    title: "Cards move as work changes",
    copy: "Drag cards between Up Next, In Progress, Pending, and Complete so priority and status stay visible. Try moving the In Progress card to Complete when the work is reviewed.",
  },
  {
    title: "Cards hold the working context",
    copy: "Click to open a card and see its next action, spec, plan, and the context an agent should use when starting work.",
  },
  {
    title: "Groups keep related outcomes together",
    copy: "Create a Group when several independently completable Items contribute to one larger outcome. The Group stays on the Main Board while its Items keep their own status, priority, documents, and history.",
  },
  {
    title: "Open Planban from any thread",
    copy: "Ask your current agent to open Planban, or use the verified Planban command offered by that host. The Board is not tied to one chat or browser tab.",
  },
  {
    title: "Create planning from rough context",
    copy: "Your agent can create and refine Planban Boards from notes, repo docs, issues, or connected tools. Describe the outcome naturally, then review the structured result on the Board.",
  },
  {
    title: "Feedback is agent-native too",
    copy: "Open Feedback/Bug from the Board’s More menu or invoke the Planban Feedback skill in your agent. Nothing is sent publicly until you approve the exact destination and text.",
  },
] as const;

function TutorialPage({ onSelectBoard }: { onSelectBoard: (repoId: string | null) => void }) {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode") ?? "first-run";
  const [state, setState] = useState<PlanbanState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [tutorialItems, setTutorialItems] = useState<RoadmapItem[]>(() => tutorialItemsFromState(null));
  const [selectedId, setSelectedId] = useState<string | null>("drag-this-card-to-in-progress");
  const [detailRevealed, setDetailRevealed] = useState(false);
  const [stepTwoMoved, setStepTwoMoved] = useState(false);
  const step = tutorialSteps[stepIndex]!;
  const selectedItem = tutorialItems.find((item) => item.id === selectedId) ?? tutorialItems[0] ?? null;
  const isFinalStep = stepIndex === tutorialSteps.length - 1;
  const nextButtonLabel = stepIndex === 1 ? "Next: open a card" : "Next";

  useEffect(() => {
    let cancelled = false;
    async function loadDemo() {
      try {
        const demoState = await api<PlanbanState>("/api/demo", { method: "POST", body: "{}" });
        if (cancelled) return;
        setState(demoState);
        const nextItems = tutorialItemsFromState(demoState);
        setTutorialItems(nextItems);
        setSelectedId(nextItems.find((item) => item.id === "drag-this-card-to-in-progress")?.id ?? nextItems[0]?.id ?? null);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not prepare the demo board");
      }
    }
    void loadDemo();
    return () => {
      cancelled = true;
    };
  }, []);

  function finish(status: "completed" | "skipped") {
    writeTutorialProgress(status);
    const destinationRepoId = tutorialExitRepoId(window.location.search, state?.manifest.repoId ?? null);
    if (destinationRepoId) onSelectBoard(destinationRepoId);
    else window.location.assign("/boards");
  }

  function goToStep(index: number) {
    setStepIndex(Math.max(0, Math.min(tutorialSteps.length - 1, index)));
    if (index !== 2) setDetailRevealed(false);
    if (index === 1) {
      const completionCard = tutorialItems.find((item) => item.id === "mark-a-card-complete-when-you-are-done");
      if (completionCard) setSelectedId(completionCard.id);
    }
  }

  function resetTutorialDemoState() {
    const nextItems = tutorialItemsFromState(state);
    setTutorialItems(nextItems);
    setSelectedId(nextItems.find((item) => item.id === "drag-this-card-to-in-progress")?.id ?? nextItems[0]?.id ?? null);
    setStepTwoMoved(false);
  }

  function moveTutorialItem(id: string, status: Status, beforeId: string | null = null) {
    setTutorialItems((current) => {
      const active = current.find((item) => item.id === id);
      if (!active) return current;
      const remaining = current.filter((item) => item.id !== id);
      const moved = { ...active, status };
      let insertAt = -1;
      if (beforeId) {
        insertAt = remaining.findIndex((item) => item.id === beforeId);
      }
      if (insertAt < 0) {
        const targetIndexes = remaining
          .map((item, index) => (item.status === status ? index : -1))
          .filter((index) => index >= 0);
        insertAt = targetIndexes.length ? Math.max(...targetIndexes) + 1 : remaining.length;
      }
      return [...remaining.slice(0, insertAt), moved, ...remaining.slice(insertAt)];
    });
    setSelectedId(id);
    if (status === "complete") setStepTwoMoved(true);
  }

  return (
    <main className="tutorial-screen">
      <div className="tutorial-background" aria-hidden="true">
        <TutorialBackground items={tutorialItems} />
      </div>

      <section className="tutorial-shell" aria-label="Planban tutorial">
        <header className="tutorial-header">
          <div>
            <p className="eyebrow">{mode === "whats-new" ? "Planban update" : "Welcome to Planban"}</p>
            <h1>A project board you and your agents can work from</h1>
          </div>
          <div className="tutorial-header-actions">
            <button
              onClick={() => {
                resetTutorialDemoState();
                setDetailRevealed(false);
                goToStep(0);
              }}
            >
              <RotateCcw size={14} />
              Restart
            </button>
            <button onClick={() => finish("skipped")}>Skip</button>
          </div>
        </header>

        <div className="tutorial-body">
          <section className="tutorial-copy">
            <div className="tutorial-progress" aria-label={`Step ${stepIndex + 1} of ${tutorialSteps.length}`}>
              {tutorialSteps.map((entry, index) => (
                <button
                  key={entry.title}
                  className={index === stepIndex ? "active" : index < stepIndex ? "done" : ""}
                  aria-label={`Go to step ${index + 1}: ${entry.title}`}
                  onClick={() => goToStep(index)}
                />
              ))}
            </div>
            <p className="tutorial-step-label">Step {stepIndex + 1} of {tutorialSteps.length}</p>
            <h2>{step.title}</h2>
            <p>{step.copy}</p>

            {stepIndex === 1 ? (
              <div className="tutorial-step-action">
                <div>
                  <b>Move a card</b>
                  <span>Try moving the selected In Progress card to Complete.</span>
                </div>
                <button className="tutorial-action" onClick={() => moveTutorialItem(selectedItem?.id ?? "mark-a-card-complete-when-you-are-done", "complete")}>
                  <ArrowRight size={14} />
                  Move selected card
                </button>
                {stepTwoMoved ? (
                  <p className="tutorial-status success">
                    Card moved. Choose Next: open a card to continue.
                  </p>
                ) : null}
              </div>
            ) : null}

            {stepIndex === 2 ? (
              <div className="tutorial-step-action">
                <div>
                  <b>Click any card</b>
                  <span>Planban cards open into working context your agents can read.</span>
                </div>
              </div>
            ) : null}

            {error ? <p className="tutorial-status">Demo board fallback active: {error}</p> : null}
          </section>

          <section className="tutorial-stage">
            {stepIndex === 0 ? (
              <TutorialIntroPreview />
            ) : stepIndex === 3 ? (
              <TutorialGroupPreview />
            ) : stepIndex === 4 ? (
              <TutorialAgentGuidance kind="reopen" />
            ) : stepIndex === 5 ? (
              <TutorialAgentGuidance kind="planning" />
            ) : stepIndex === 6 ? (
              <TutorialFeedbackPreview />
            ) : stepIndex === 2 && detailRevealed ? (
              <div className="tutorial-stage-board">
                <TutorialDetailPreview item={selectedItem} onBack={() => setDetailRevealed(false)} />
              </div>
            ) : (
              <div className="tutorial-stage-board">
                {stepIndex === 1 ? (
                  <TutorialLiveBoard
                    items={tutorialItems}
                    onSelect={setSelectedId}
                    onItemsChange={(nextItems, nextSelectedId) => {
                      setTutorialItems(nextItems);
                      if (nextSelectedId) setSelectedId(nextSelectedId);
                      setStepTwoMoved(true);
                    }}
                  />
                ) : stepIndex === 2 ? (
                  <TutorialLiveBoard
                    items={tutorialItems}
                    onSelect={(id) => {
                      setSelectedId(id);
                      setDetailRevealed(true);
                    }}
                    draggable={false}
                  />
                ) : (
                  <TutorialMiniBoard
                    items={tutorialItems}
                    selectedId={selectedId}
                    onSelect={(id) => {
                      setSelectedId(id);
                      if (stepIndex === 2) setDetailRevealed(true);
                    }}
                  />
                )}
              </div>
            )}
          </section>
        </div>

        <footer className="tutorial-footer">
          <button onClick={() => goToStep(stepIndex - 1)} disabled={stepIndex === 0}>
            Back
          </button>
          {isFinalStep ? (
            <button className="primary" onClick={() => finish("completed")}>
              <CheckCircle2 size={14} />
              Finish tutorial
            </button>
          ) : (
            <button className="primary" onClick={() => goToStep(stepIndex + 1)}>
              {nextButtonLabel}
              <ArrowRight size={14} />
            </button>
          )}
        </footer>
      </section>
    </main>
  );
}

function isCardDetailsHistory(entry: HistoryEntry, cardId: string) {
  return (
    entry.affectedCards.includes(cardId) &&
    !entry.operation.startsWith("doc.") &&
    entry.operation !== "history.restore.doc"
  );
}

function isDocHistory(entry: HistoryEntry, cardId: string, kind: DocKind) {
  return entry.affectedDocs.some((doc) => doc.cardId === cardId && doc.kind === kind);
}

function DetailHistoryMenu({
  itemEntries,
  documentEntries,
  documentKind,
  currentVersion,
  previewVersion,
  onSelectVersion,
  onReturnToCurrent,
}: {
  itemEntries: HistoryEntry[];
  documentEntries: HistoryEntry[];
  documentKind: DocKind;
  currentVersion: number | null;
  previewVersion: number | null;
  onSelectVersion: ((version: number) => void) | undefined;
  onReturnToCurrent: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { containerRef, onKeyDown } = useListboxPopover(open, setOpen);
  const hasHistory = itemEntries.length > 0 || documentEntries.length > 0 || previewVersion !== null;
  if (!hasHistory) return null;

  const select = (version: number) => {
    setOpen(false);
    if (version === currentVersion) onReturnToCurrent?.();
    else onSelectVersion?.(version);
  };
  const section = (label: string, entries: HistoryEntry[]) => entries.length > 0 ? (
    <section className="detail-history-section">
      <h3>{label}</h3>
      <div role="listbox" aria-label={label}>
        {entries.map((entry) => {
          const active = entry.version === (previewVersion ?? currentVersion);
          return (
            <button
              key={entry.version}
              className={active ? "active" : ""}
              role="option"
              aria-selected={active}
              disabled={active && previewVersion === null}
              onClick={() => select(entry.version)}
            >
              <span><b>{versionLabel(entry.version, currentVersion)}</b><HistoryAuthor attribution={entry.attribution} actor={entry.actor} /><small>{formatHistoryTime(entry.createdAt)} · {entry.summary}</small></span>
            </button>
          );
        })}
      </div>
    </section>
  ) : null;

  return (
    <div ref={containerRef} className="detail-history-menu" onKeyDown={onKeyDown}>
      <button
        className={`detail-history-trigger ${open ? "active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <History size={14} />
        <span>History</span>
      </button>
      {open ? (
        <div className="detail-history-popover" role="dialog" aria-label="Item and document history">
          <header>
            <div><p className="eyebrow">Recovery</p><h2>History</h2></div>
            {previewVersion !== null ? <button onClick={() => { setOpen(false); onReturnToCurrent?.(); }}>Return to current</button> : null}
          </header>
          {section("Item changes", itemEntries)}
          {section(`${docKindLabel(documentKind)} changes`, documentEntries)}
        </div>
      ) : null}
    </div>
  );
}

interface PlanbanSelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** The board page's dropdowns: the one Planban dropdown, with an optional label above it. */
function PlanbanSelectMenu<T extends string>({
  label,
  value,
  options,
  disabled = false,
  disabledReason,
  labelPlacement = "inside",
  initialFocus = false,
  onChange,
}: {
  label: string;
  value: T;
  options: PlanbanSelectOption<T>[];
  disabled?: boolean;
  disabledReason?: string | undefined;
  labelPlacement?: "inside" | "outside";
  initialFocus?: boolean;
  onChange: (value: T) => void;
}) {
  const disabledReasonId = useId();
  const dropdown = (
    <Dropdown
      label={label}
      value={value}
      options={options}
      disabled={disabled}
      initialFocus={initialFocus}
      prefix={labelPlacement === "inside" ? label : undefined}
      describedBy={disabled && disabledReason ? disabledReasonId : undefined}
      onChange={onChange}
    />
  );
  return labelPlacement === "outside" ? (
    <div className={`planban-select-field ${disabled && disabledReason ? "has-disabled-reason" : ""}`}>
      <span className="planban-select-field-label">{label}</span>
      {dropdown}
      {disabled && disabledReason ? <span className="disabled-control-tooltip" id={disabledReasonId} role="tooltip">{disabledReason}</span> : null}
    </div>
  ) : dropdown;
}

function WorkflowStatusMenu({
  status,
  busy,
  onChange,
}: {
  status: Status;
  busy: boolean;
  onChange: (status: Status) => void;
}) {
  return (
    <PlanbanSelectMenu
      label="Status"
      value={status}
      options={statuses.map((option) => ({ value: option, label: labels[option] }))}
      disabled={busy}
      labelPlacement="outside"
      onChange={onChange}
    />
  );
}

function GroupRailDropZone({ status, previewed, children }: { status: Status; previewed: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group-status:${status}` });
  return <div ref={setNodeRef} className={`group-rail-drop-zone ${isOver || previewed ? "active" : ""}`}>{children}</div>;
}

interface GroupRailDropPreview {
  item: RoadmapItem;
  status: Status;
  targetId: string | null;
  operation: "before" | "after" | "empty";
}

function GroupRailInsertionPreview() {
  return <div className="group-rail-insertion-preview" aria-hidden="true"><span /></div>;
}

function GroupRailCard({
  item,
  selected,
  disabled,
  canMoveUp,
  canMoveDown,
  onSelect,
  onMoveUp,
  onMoveDown,
  dropOperation,
  reorderPreview,
  hideSourceDuringDrag,
  readOnly = false,
}: {
  item: RoadmapItem;
  selected: boolean;
  disabled: boolean;
  /** A viewer on the web: no order controls at all. */
  readOnly?: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  dropOperation: HierarchyDropOperation | null;
  reorderPreview: boolean;
  hideSourceDuringDrag: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `group-item:${item.id}`, disabled });
  return (
    <article
      ref={setNodeRef}
      style={{
        transform: isDragging || reorderPreview ? CSS.Transform.toString(transform) : undefined,
        transition: [isDragging || reorderPreview ? transition : null, "border-color 140ms ease", "box-shadow 140ms ease", "background 140ms ease"].filter(Boolean).join(", "),
        opacity: isDragging ? hierarchyDraggedSourceOpacity(reorderPreview, hideSourceDuringDrag, 0.4) : 1,
      }}
      aria-hidden={isDragging && hideSourceDuringDrag ? true : undefined}
      className={`group-rail-card overflow-marquee-trigger ${selected ? "active" : ""} ${isDragging && reorderPreview ? "hierarchy-reorder-placeholder" : ""} ${isDragging && hideSourceDuringDrag ? "hierarchy-hidden-drag-source" : ""} ${dropOperation ? `hierarchy-drop-${dropOperation}` : ""}`}
    >
      <button className="group-rail-card-main" {...attributes} {...listeners} onClick={onSelect}>
        <span className="group-rail-card-title">
          {item.isGroup ? <GroupIcon status={item.status} size={13} /> : null}
          <OverflowMarqueeText text={item.title} className="group-rail-card-title-text" />
        </span>
      </button>
      {dropOperation === "inside" ? <div className="hierarchy-drop-inside-label"><GroupIcon size={13} /><span>Move inside</span></div> : null}
      {readOnly ? null : <div className="group-rank-actions" aria-label={`${item.title} order controls`}>
        <button title="Move up" aria-label={`Move ${item.title} up`} disabled={disabled || !canMoveUp} onClick={onMoveUp}><ChevronUp size={13} /></button>
        <button title="Move down" aria-label={`Move ${item.title} down`} disabled={disabled || !canMoveDown} onClick={onMoveDown}><ChevronDown size={13} /></button>
      </div>}
    </article>
  );
}

function GroupPlacementModal({
  active,
  parent,
  items,
  busy,
  onClose,
  onConfirm,
}: {
  active: RoadmapItem;
  parent: RoadmapItem;
  items: RoadmapItem[];
  busy: boolean;
  onClose: () => void;
  onConfirm: (decision:
    | { kind: "move"; status: Status; position: GroupPlacementPosition }
    | { kind: "create"; title: string; summary: string; status: Status }) => void;
}) {
  const [status, setStatus] = useState<Status>(active.status);
  const [position, setPosition] = useState<GroupPlacementPosition>({ kind: "last" });
  const [groupTitle, setGroupTitle] = useState(`${parent.title} Group`);
  const [groupSummary, setGroupSummary] = useState("");
  const [groupStatus, setGroupStatus] = useState<Status>(parent.status);
  const dialogRef = useDialogFocus<HTMLElement>();
  const siblings = useMemo(() => items
    .filter((entry) => entry.id !== active.id && entry.parentId === parent.id && entry.status === status)
    .sort((a, b) => (a.groupRank ?? Number.MAX_SAFE_INTEGER) - (b.groupRank ?? Number.MAX_SAFE_INTEGER)),
  [active.id, items, parent.id, status]);
  const parentIsClosed = parent.status === "complete" || parent.status === "archived";
  const statusIsAllowed = (option: Status) => {
    const optionIsClosed = option === "complete" || option === "archived";
    return !parentIsClosed || optionIsClosed;
  };
  const groupStatusIsAllowed = (option: Status) => {
    const hasOpenItem = [active, parent].some((item) => item.status !== "complete" && item.status !== "archived");
    return !hasOpenItem || (option !== "complete" && option !== "archived");
  };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  return createPortal(
    <div className="modal-backdrop group-placement-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section
        ref={dialogRef}
        className="group-placement-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-placement-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="group-placement-header">
          <div className="group-placement-heading">
            <span className="group-placement-heading-icon" aria-hidden="true">
              {parent.isGroup ? <FolderInput size={17} /> : <FolderPlus size={17} />}
            </span>
            <div>
              <h2 id="group-placement-title">{parent.isGroup ? `Add to ${parent.title}` : "Create Group"}</h2>
              <p>{parent.isGroup
                ? <>Choose where “{active.title}” belongs inside this Group.</>
                : <>Create a new Group for “{parent.title}” and “{active.title}”. Each Item keeps its own status and can still be completed independently.</>}</p>
            </div>
          </div>
          <TooltipButton label="Close" className="toolbar-icon-button" disabled={busy} onClick={onClose}>
            <X size={14} />
          </TooltipButton>
        </header>

        {parent.isGroup ? (
          <div className="group-placement-transfer" aria-label={`Move ${active.title} into ${parent.title}`}>
            <div className="group-placement-transfer-node item">
              <span>Item</span>
              <b>{active.title}</b>
            </div>
            <div className="group-placement-transfer-direction" aria-hidden="true">
              <FolderInput size={18} />
            </div>
            <div className="group-placement-transfer-node group">
              <span>Group</span>
              <b>{parent.title}</b>
            </div>
          </div>
        ) : null}

        {parent.isGroup ? <><div className={`group-placement-fields ${siblings.length === 0 ? "single-field" : ""}`}>
          <PlanbanSelectMenu
            label="Item status"
            value={status}
            options={statuses.map((option) => ({ value: option, label: labels[option], disabled: !statusIsAllowed(option) }))}
            disabled={busy}
            labelPlacement="outside"
            initialFocus
            onChange={(nextStatus) => { setStatus(nextStatus); setPosition({ kind: "last" }); }}
          />
          {siblings.length > 0 ? <PlanbanSelectMenu
            label={`Position in ${labels[status]}`}
            value={groupPlacementPositionValue(position)}
            options={[
              { value: "first", label: "First" },
              { value: "last", label: "Last" },
              ...siblings.map((entry) => ({ value: `after:${entry.id}`, label: `After ${entry.title}` })),
            ]}
            disabled={busy}
            labelPlacement="outside"
            onChange={(nextPosition) => setPosition(groupPlacementPositionFromValue(nextPosition))}
          /> : null}
        </div>

        {siblings.length > 0 ? <p className="group-placement-outcome">
          {active.title} will be {position.kind === "first" ? "first" : position.kind === "last" ? "last" : `placed after ${siblings.find((entry) => entry.id === position.siblingId)?.title ?? "the selected item"}`} in {labels[status]}.
        </p> : null}</> : <>
          <div className="group-placement-fields group-creation-fields">
            <label>
              <span>Group title</span>
              <input value={groupTitle} disabled={busy} onChange={(event) => setGroupTitle(event.target.value)} aria-required="true" autoFocus />
            </label>
            <PlanbanSelectMenu
              label="Group status"
              value={groupStatus}
              options={statuses.map((option) => ({ value: option, label: labels[option], disabled: !groupStatusIsAllowed(option) }))}
              disabled={busy}
              labelPlacement="outside"
              onChange={setGroupStatus}
            />
            <label className="group-objective-field">
              <span>Group objective</span>
              <textarea value={groupSummary} disabled={busy} onChange={(event) => setGroupSummary(event.target.value)} placeholder="What larger outcome do these Items achieve together? Add this now or define it later." rows={3} />
            </label>
          </div>
        </>}

        <footer className="feedback-actions group-placement-actions">
          <button disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || (!parent.isGroup && !groupTitle.trim())} onClick={() => parent.isGroup
            ? onConfirm({ kind: "move", status, position })
            : onConfirm({ kind: "create", title: groupTitle.trim(), summary: groupSummary.trim(), status: groupStatus })}>
            {busy ? <Loader2 size={14} className="spin" /> : parent.isGroup ? <FolderInput size={14} /> : <FolderPlus size={14} />}
            {parent.isGroup ? "Add to group" : "Create Group"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function DetailView({
  state,
  item,
  boardId,
  onBack,
  onStateRefresh,
  history,
  previewVersion = null,
  previewEntry = null,
  onSelectVersion,
  onReturnToCurrent,
  onRestoreCard,
  onRestoreDoc,
  onSelectWorkItem,
  activity = null,
  activityDemoControl,
}: {
  state: PlanbanState;
  item: RoadmapItem;
  boardId: string;
  onBack: () => void;
  onStateRefresh: () => void;
  history?: HistoryPayload | null;
  previewVersion?: number | null;
  previewEntry?: HistoryEntry | null;
  onSelectVersion?: (version: number) => void;
  onReturnToCurrent?: () => void;
  onRestoreCard?: (cardId: string) => void;
  onRestoreDoc?: (cardId: string, kind: DocKind) => void;
  onSelectWorkItem?: (cardId: string) => void;
  activity?: ActivityPresentation | null;
  activityDemoControl?: {
    kind: "item" | "group";
    onFlashAndChange: () => void;
  };
}) {
  const availableDocKinds = useMemo<DocKind[]>(
    () => ["spec", ...(item.planDoc ? (["plan"] as const) : [])],
    [item.planDoc],
  );
  const [activeTab, setActiveTab] = useState<DocKind>("spec");
  const [docsByKind, setDocsByKind] = useState<Partial<Record<DocKind, DocPayload>>>({});
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  /** A save refused because the document changed meanwhile: the newer version, and who made it. */
  // Someone else's version landed while editing (Spec point 20): shown beside yours, to keep theirs, use yours, or edit.
  const [conflict, setConflict] = useState<{ theirs: DocPayload; who: string | null; showing: boolean; seen: boolean; choosing: boolean } | null>(null);
  const boardPeople = useContext(BoardPeopleContext);
  const [objectiveEditing, setObjectiveEditing] = useState(false);
  // Someone else's objective landed while editing (Spec point 20): theirs beside yours, to keep theirs, use yours, or edit.
  const [objectiveConflict, setObjectiveConflict] = useState<{ theirs: string | null; who: string | null; revision: number; choosing: boolean } | null>(null);
  const [objectiveDraft, setObjectiveDraft] = useState(item.summary ?? "");
  const [busy, setBusy] = useState(false);
  const [referenceCopied, showReferenceCopied] = useTransientConfirmation(`${boardId}:${item.id}`);
  const [placementOpen, setPlacementOpen] = useState(false);
  const [placementQuery, setPlacementQuery] = useState("");
  const [placementDestination, setPlacementDestination] = useState<{
    id: string | null;
    title: string;
    isGroup: boolean;
  } | null>(null);
  const [placementStatus, setPlacementStatus] = useState<Status>(item.status);
  const [placementPosition, setPlacementPosition] = useState<GroupPlacementPosition>({ kind: "last" });
  const [collapsedGroupStatuses, setCollapsedGroupStatuses] = useState<Partial<Record<Status, boolean>>>({});
  const [groupDragId, setGroupDragId] = useState<string | null>(null);
  const [groupDropIntent, setGroupDropIntent] = useState<{ targetId: string; operation: HierarchyDropOperation } | null>(null);
  const [groupColumnDropPreview, setGroupColumnDropPreview] = useState<{ status: Status; targetId: string | null; operation: "after" | "empty" } | null>(null);
  const [groupOptimisticItems, setGroupOptimisticItems] = useState<RoadmapItem[] | null>(null);
  const phone = usePhoneLayout();
  const groupPointer = useSensor(PointerSensor, { activationConstraint: { distance: 3 } });
  // No dragging for viewers, or on a phone, where a swipe scrolls.
  const groupSensors = useSensors(phone || state.hosted?.role === "viewer" ? undefined : groupPointer);
  const groupDropIntentRef = useRef<{ targetId: string; operation: HierarchyDropOperation } | null>(null);
  const groupColumnDropPreviewRef = useRef<{ status: Status; targetId: string | null; operation: "after" | "empty" } | null>(null);
  const groupDropRectsRef = useRef(new Map<string, HierarchyDropRect>());
  const doc = docsByKind[activeTab] ?? null;
  const isPreviewing = previewVersion !== null;
  // A viewer on the web reads the card, its Spec, Plan and History, and changes nothing.
  const viewOnly = state.hosted?.role === "viewer";
  const locked = isPreviewing || viewOnly;
  const currentVersion = history?.currentVersion ?? null;
  const cardHistoryEntries = useMemo(
    () => (history?.entries ?? []).filter((entry) => isCardDetailsHistory(entry, item.id)),
    [history, item.id],
  );
  const activeDocHistoryEntries = useMemo(
    () => (history?.entries ?? []).filter((entry) => isDocHistory(entry, item.id, activeTab)),
    [activeTab, history, item.id],
  );
  const canRestoreActiveDoc = isPreviewing && activeDocHistoryEntries.some((entry) => entry.version === previewVersion);
  const byId = useMemo(() => new Map(state.roadmap.roadmapItems.map((entry) => [entry.id, entry])), [state.roadmap.roadmapItems]);
  const ancestry = useMemo(() => {
    const parent = item.parentId ? byId.get(item.parentId) : null;
    return parent ? [parent] : [];
  }, [byId, item.parentId]);
  const workspaceRoot = item.isGroup ? item : (item.parentId ? byId.get(item.parentId) ?? null : null);
  const workspaceItems = useMemo(() => {
    if (!workspaceRoot) return [];
    return (groupOptimisticItems ?? state.roadmap.roadmapItems)
      .filter((entry) => entry.parentId === workspaceRoot.id)
      .sort((a, b) => statuses.indexOf(a.status) - statuses.indexOf(b.status)
        || (a.groupRank ?? Number.MAX_SAFE_INTEGER) - (b.groupRank ?? Number.MAX_SAFE_INTEGER));
  }, [groupOptimisticItems, state.roadmap.roadmapItems, workspaceRoot]);
  const workspaceGroups = useMemo(() => {
    const groups: Record<Status, RoadmapItem[]> = {
      "in-progress": [],
      "up-next": [],
      pending: [],
      complete: [],
      archived: [],
    };
    for (const entry of workspaceItems) groups[entry.status].push(entry);
    return groups;
  }, [workspaceItems]);
  const groupRailDropPreview = useMemo<GroupRailDropPreview | null>(() => {
    if (!groupDragId) return null;
    const active = byId.get(groupDragId);
    if (!active) return null;
    if (groupColumnDropPreview) return { item: active, ...groupColumnDropPreview };
    if (!groupDropIntent || groupDropIntent.operation === "inside") return null;
    const target = byId.get(groupDropIntent.targetId);
    if (!target) return null;
    return {
      item: active,
      status: target.status,
      targetId: target.id,
      operation: groupDropIntent.operation,
    };
  }, [byId, groupColumnDropPreview, groupDragId, groupDropIntent]);
  const groupRailPreviewStatus = groupRailDropPreview?.status
    ?? (groupDropIntent && hierarchyReorderPlaceholderVisible(groupDropIntent.operation)
      ? byId.get(groupDropIntent.targetId)?.status ?? null
      : null);
  const placementCandidates = useMemo(() => {
    const query = placementQuery.trim().toLocaleLowerCase();
    return state.roadmap.roadmapItems
      .filter((entry) => entry.parentId === null && entry.id !== item.id && entry.isGroup)
      .filter((entry) => !query || entry.title.toLocaleLowerCase().includes(query) || entry.id.toLocaleLowerCase().includes(query))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [item.id, placementQuery, state.roadmap.roadmapItems]);
  const placementSiblings = useMemo(() => {
    if (!placementDestination) return [];
    return state.roadmap.roadmapItems
      .filter((entry) => entry.id !== item.id && entry.parentId === placementDestination.id && entry.status === placementStatus)
      .sort((a, b) => (workItemRank(a) ?? Number.MAX_SAFE_INTEGER) - (workItemRank(b) ?? Number.MAX_SAFE_INTEGER));
  }, [item.id, placementDestination, placementStatus, state.roadmap.roadmapItems]);
  const placementParent = placementDestination?.id ? byId.get(placementDestination.id) ?? null : null;
  const placementStatusAllowed = (status: Status) => {
    if (!placementParent || (placementParent.status !== "complete" && placementParent.status !== "archived")) return true;
    return status === "complete" || status === "archived";
  };
  async function changeWorkflowStatus(status: Status) {
    if (status === item.status) return;
    setBusy(true);
    try {
      await api<PlanbanState>(cardPath(boardId, item.id, `/move`), {
        method: "POST",
        body: JSON.stringify({ status, baseRevision: state.roadmap.revision }),
      });
      await onStateRefresh();
    } catch (error) { window.alert(error instanceof Error ? error.message : "Status update failed"); }
    finally { setBusy(false); }
  }

  function choosePlacementDestination(destination: { id: string | null; title: string; isGroup: boolean }) {
    const destinationGroup = destination.id ? byId.get(destination.id) : null;
    const destinationIsClosed = destinationGroup?.status === "complete" || destinationGroup?.status === "archived";
    setPlacementDestination(destination);
    setPlacementStatus(destinationIsClosed ? destinationGroup.status : item.status);
    setPlacementPosition({ kind: "last" });
  }

  async function moveToParent(parentId: string | null, status: Status, position: GroupPlacementPosition) {
    const afterId = position.kind === "first"
      ? null
      : position.kind === "after"
        ? position.siblingId
        : placementSiblings.at(-1)?.id ?? null;
    setBusy(true);
    try {
      await api<PlanbanState>(cardPath(boardId, item.id, `/move`), {
        method: "POST",
        body: JSON.stringify({ parentId, status, afterId, baseRevision: state.roadmap.revision }),
      });
      setPlacementOpen(false);
      setPlacementQuery("");
      setPlacementDestination(null);
      setPlacementStatus(item.status);
      setPlacementPosition({ kind: "last" });
      await onStateRefresh();
    } catch (error) { window.alert(error instanceof Error ? error.message : "Move failed"); }
    finally { setBusy(false); }
  }

  async function saveObjective() {
    setBusy(true);
    try {
      await api<PlanbanState>(cardPath(boardId, item.id, ``), {
        method: "PATCH",
        body: JSON.stringify({
          summary: objectiveDraft.trim() || null,
          // After seeing theirs, "use mine" saves over the version shown.
          baseRevision: objectiveConflict?.revision ?? state.roadmap.revision,
        }),
      });
      setObjectiveConflict(null);
      setObjectiveEditing(false);
      await onStateRefresh();
    } catch (error) {
      const conflict = (error as { status?: number; conflict?: { currentRevision: number; card?: { summary?: string | null } | null; changes?: Array<{ by: string }> } } | null);
      if (conflict?.status === 409 && conflict.conflict) {
        // Theirs beside yours; the text you wrote stays.
        setObjectiveConflict({ theirs: conflict.conflict.card?.summary ?? null, who: conflict.conflict.changes?.[0]?.by ?? null, revision: conflict.conflict.currentRevision, choosing: true });
        return;
      }
      window.alert(error instanceof Error ? error.message : "Group objective update failed");
      setObjectiveDraft(item.summary ?? "");
    } finally {
      setBusy(false);
    }
  }

  async function applyWorkspaceMove(activeId: string, move: GroupWorkspaceMove) {
    setGroupOptimisticItems(previewGroupWorkspaceMove(state.roadmap.roadmapItems, activeId, move));
    setBusy(true);
    try {
      await api<PlanbanState>(cardPath(boardId, activeId, `/move`), {
        method: "POST",
        body: JSON.stringify({ ...move, baseRevision: state.roadmap.revision }),
      });
      await onStateRefresh();
      return true;
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Workflow move failed");
      return false;
    } finally {
      setGroupOptimisticItems(null);
      setBusy(false);
    }
  }

  function clearGroupColumnDropPreview() {
    groupColumnDropPreviewRef.current = null;
    setGroupColumnDropPreview(null);
  }

  function clearGroupDropIntent() {
    groupDropIntentRef.current = null;
    groupDropRectsRef.current.clear();
    setGroupDropIntent(null);
    clearGroupColumnDropPreview();
  }

  function considerGroupDropIntent(event: DragMoveEvent) {
    const activeId = String(event.active.id).replace("group-item:", "");
    const overId = event.over ? String(event.over.id) : null;
    const candidateId = overId?.startsWith("group-item:") ? overId.slice("group-item:".length) : null;
    if (candidateId === activeId) {
      groupDropIntentRef.current = null;
      setGroupDropIntent(null);
      clearGroupColumnDropPreview();
      return;
    }
    if (!candidateId || !event.over) {
      groupDropIntentRef.current = null;
      setGroupDropIntent(null);
      const targetStatus = overId?.startsWith("group-status:")
        ? overId.slice("group-status:".length) as Status
        : null;
      const active = state.roadmap.roadmapItems.find((entry) => entry.id === activeId);
      if (active && targetStatus && targetStatus !== active.status && !collapsedGroupStatuses[targetStatus]) {
        const tail = workspaceGroups[targetStatus].filter((entry) => entry.id !== activeId).at(-1) ?? null;
        const next = {
          status: targetStatus,
          targetId: tail?.id ?? null,
          operation: tail ? "after" as const : "empty" as const,
        };
        groupColumnDropPreviewRef.current = next;
        setGroupColumnDropPreview(next);
      } else {
        clearGroupColumnDropPreview();
      }
      return;
    }
    clearGroupColumnDropPreview();
    const rect = groupDropRectsRef.current.get(candidateId) ?? stableDropRect(event.over.rect);
    groupDropRectsRef.current.set(candidateId, rect);
    const previous = groupDropIntentRef.current?.targetId === candidateId ? groupDropIntentRef.current.operation : null;
    const operation = hierarchyDropOperation(dragPointerY(event), rect, {
      canMoveInside: false,
      previous,
    });
    if (operation !== "inside" && !hierarchyPlacementChanges(state.roadmap.roadmapItems, activeId, candidateId, operation)) {
      groupDropIntentRef.current = null;
      setGroupDropIntent(null);
      return;
    }
    const next = { targetId: candidateId, operation };
    groupDropIntentRef.current = next;
    setGroupDropIntent(next);
  }

  function handleWorkspaceDrop(activeId: string, overId: string) {
    const outcome = groupWorkspaceDropOutcome(state.roadmap.roadmapItems, activeId, overId);
    if (!outcome) return;
    void applyWorkspaceMove(outcome.activeId, outcome.move);
  }

  async function reorderWorkspaceItem(targetId: string, direction: "up" | "down") {
    const target = byId.get(targetId);
    if (!target || viewOnly) return;
    const siblings = workspaceGroups[target.status];
    const index = siblings.findIndex((entry) => entry.id === target.id);
    if (index < 0 || (direction === "up" && index === 0) || (direction === "down" && index === siblings.length - 1)) return;
    const afterId = direction === "up"
      ? (index <= 1 ? null : siblings[index - 2]?.id ?? null)
      : siblings[index + 1]?.id ?? null;
    setGroupOptimisticItems(previewGroupWorkspaceMove(state.roadmap.roadmapItems, target.id, { afterId }));
    setBusy(true);
    try {
      await api<PlanbanState>(cardPath(boardId, target.id, `/move`), {
        method: "POST",
        body: JSON.stringify({ afterId, baseRevision: state.roadmap.revision }),
      });
      await onStateRefresh();
    } catch (error) { window.alert(error instanceof Error ? error.message : "Group order update failed"); }
    finally {
      setGroupOptimisticItems(null);
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!availableDocKinds.includes(activeTab)) setActiveTab("spec");
  }, [activeTab, availableDocKinds]);

  useEffect(() => {
    setDocsByKind({});
    setDraft("");
    setEditing(false);
    setActiveTab("spec");
    setPlacementOpen(false);
    setPlacementQuery("");
    setPlacementDestination(null);
    setPlacementStatus(item.status);
    setPlacementPosition({ kind: "last" });
    setGroupOptimisticItems(null);
  }, [boardId, item.id, previewVersion]);

  // The objective as it was when editing began, and the board revision then.
  const objectiveStart = useRef<{ value: string; revision: number } | null>(null);
  useEffect(() => {
    if (objectiveEditing && objectiveStart.current === null) objectiveStart.current = { value: item.summary ?? "", revision: state.roadmap.revision };
    if (!objectiveEditing) objectiveStart.current = null;
  }, [objectiveEditing, item.summary, state.roadmap.revision]);
  useEffect(() => {
    setObjectiveEditing(false);
    setObjectiveConflict(null);
    setObjectiveDraft(item.summary ?? "");
  }, [item.id]);
  useEffect(() => {
    const start = objectiveStart.current;
    // Someone else's objective landed while editing: keep the draft and offer the choice (Spec point 20).
    if (objectiveEditing && start && (item.summary ?? "") !== start.value) {
      setObjectiveConflict((current) => current ?? { theirs: item.summary ?? null, who: null, revision: state.roadmap.revision, choosing: true });
      return;
    }
    if (!objectiveEditing) setObjectiveDraft(item.summary ?? "");
  }, [item.summary]);

  useEffect(() => {
    if (!workspaceRoot) return;
    const saved = readGroupRailSections(boardId, workspaceRoot.id);
    const next = { ...(saved ?? defaultGroupRailSections(state.roadmap.roadmapItems, workspaceRoot.id)) };
    if (item.parentId === workspaceRoot.id) next[item.status] = false;
    setCollapsedGroupStatuses(next);
    if (item.parentId === workspaceRoot.id && saved?.[item.status] === true) {
      writeGroupRailSections(boardId, workspaceRoot.id, next);
    }
  }, [boardId, item.id, item.parentId, item.status, state.roadmap.roadmapItems, workspaceRoot]);

  useEffect(() => {
    if (!placementOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      setPlacementOpen(false);
      setPlacementQuery("");
      setPlacementDestination(null);
      setPlacementStatus(item.status);
      setPlacementPosition({ kind: "last" });
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, item.status, placementOpen]);

  /** A Spec or Plan that couldn't be read: said plainly, with Try again, never "Loading" for ever. */
  const [docErrors, setDocErrors] = useState<Partial<Record<DocKind, string>>>({});
  // Which document is on screen now: an answer for an earlier card or version must not land on this one.
  const docIdentity = `${boardId}\n${item.id}\n${previewVersion ?? "current"}`;
  const docIdentityRef = useRef(docIdentity);
  docIdentityRef.current = docIdentity;
  const [docRequests] = useState(() => latestRequestGate<DocKind>());
  useEffect(() => setDocErrors({}), [docIdentity]);
  const loadDoc = useCallback(
    async (kind: DocKind) => {
      // Only the newest request for this kind, for the document still on screen, may land.
      const current = docRequests.begin(kind, `${boardId}\n${item.id}\n${previewVersion ?? "current"}`, () => docIdentityRef.current);
      setDocErrors((errors) => ({ ...errors, [kind]: undefined }));
      try {
        const payload = await api<DocPayload>(
          previewVersion
            ? cardPath(boardId, item.id, `/docs/${kind}`, previewVersion)
            : cardPath(boardId, item.id, `/docs/${kind}`),
          undefined,
          30_000,
        );
        if (current()) setDocsByKind((docs) => ({ ...docs, [kind]: payload }));
        return payload;
      } catch (error) {
        if (current()) setDocErrors((errors) => ({ ...errors, [kind]: error instanceof Error ? error.message : "This document couldn't be loaded." }));
        throw error;
      }
    },
    [boardId, item.id, previewVersion, docRequests],
  );

  useEffect(() => {
    // loadDoc itself shows the answer, if it is still the newest for the document on screen.
    for (const kind of availableDocKinds) void loadDoc(kind).catch(() => undefined);
  }, [availableDocKinds, loadDoc]);

  useEffect(() => {
    setEditing(false);
    setDraft(doc?.markdown ?? "");
    setConflict(null);
  }, [activeTab, doc]);

  /** Who last changed this document, for the conflict note: "Maya", "Maya's agent", or null. */
  async function latestDocAuthor(): Promise<string | null> {
    const latest = await api<HistoryPayload>(boardPath(boardId, "/history")).catch(() => null);
    const entry = latest?.entries.filter((candidate) => isDocHistory(candidate, item.id, activeTab)).sort((a, b) => b.version - a.version)[0];
    if (!entry?.attribution) return null;
    const name = boardPeople?.people.find((person) => person.userId === entry.attribution!.userId)?.name;
    if (!name) return null;
    const first = name.split(/\s+/)[0] ?? name;
    return entry.attribution.actor === "agent" ? `${first}'s agent` : first;
  }

  async function saveDoc() {
    setBusy(true);
    // After a conflict, the person has been shown that the document changed; save over that version.
    const base = conflict?.theirs ?? doc;
    try {
      const payload = await api<DocPayload>(cardPath(boardId, item.id, `/docs/${activeTab}`), {
        method: "PUT",
        body: JSON.stringify({ markdown: draft, expectedMtimeMs: base?.mtimeMs ?? null }),
      });
      setConflict(null);
      setDocsByKind((current) => ({ ...current, [activeTab]: payload }));
      setDraft(payload.markdown);
      setEditing(false);
      onStateRefresh();
    } catch (error) {
      if ((error as { status?: number } | null)?.status === 409) {
        // Someone else saved first. Their version is fetched to look at; the person's text stays in the editor.
        const theirs = await api<DocPayload>(cardPath(boardId, item.id, `/docs/${activeTab}`)).catch(() => null);
        if (theirs) {
          // Theirs is shown beside yours, with a simple choice.
          setConflict({ theirs, who: await latestDocAuthor(), showing: true, seen: true, choosing: true });
          return;
        }
      }
      // Nothing is thrown away: the text stays in the editor to try again.
      window.alert(error instanceof Error ? error.message : "Document save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <main className={`detail ${workspaceRoot ? "group-detail" : ""}`}>
      <header className="detail-header">
        <AgentActivityEffect activity={activity} surface="header" />
        <button onClick={onBack} className="back-button">
          <ArrowLeft size={16} />
        </button>
        <div>
          <p className="eyebrow">{isPreviewing ? `${state.roadmap.project.title} · Historical v${previewVersion}` : state.roadmap.project.title}</p>
          <h1>{item.title}</h1>
          {previewEntry ? (
            <p className="detail-history-note">
              {formatHistoryTime(previewEntry.createdAt)} · {previewEntry.summary}
            </p>
          ) : null}
        </div>
        <div className="detail-header-actions">
          {activityDemoControl ? (
            <div className="activity-detail-demo" aria-label={`${activityDemoControl.kind} activity preview`}>
              <span>{activityDemoControl.kind === "group" ? "Group inside" : "Item inside"}</span>
              <button onClick={activityDemoControl.onFlashAndChange}><SquarePen size={12} />Flash + change</button>
            </div>
          ) : null}
          <DetailHistoryMenu
            itemEntries={cardHistoryEntries}
            documentEntries={activeDocHistoryEntries}
            documentKind={activeTab}
            currentVersion={currentVersion}
            previewVersion={previewVersion}
            onSelectVersion={onSelectVersion}
            onReturnToCurrent={onReturnToCurrent}
          />
        {isPreviewing ? (
          <div className="detail-history-actions">
            <span>Viewing v{previewVersion}</span>
            <button onClick={onReturnToCurrent}>Return to current</button>
            {!viewOnly ? (
              <button className="primary" onClick={() => onRestoreCard?.(item.id)}>
                Restore card details
              </button>
            ) : null}
          </div>
        ) : null}
        </div>
      </header>

      <div className={workspaceRoot ? "group-workspace" : "detail-content"}>
        {workspaceRoot ? (
          <aside className="group-navigator" aria-label={`${workspaceRoot.title} items`}>
            <nav>
              <button className={`group-nav-root overflow-marquee-trigger ${item.id === workspaceRoot.id ? "active" : ""}`} onClick={() => onSelectWorkItem?.(workspaceRoot.id)}>
                <GroupIcon status={workspaceRoot.status} size={14} />
                <OverflowMarqueeText text={workspaceRoot.title} className="group-nav-root-title" title={workspaceRoot.title} />
                <small className="count count-compact">{workspaceItems.length}</small>
              </button>
              <DndContext
                sensors={groupSensors}
                collisionDetection={(args) => {
                  const collisions = pointerWithin(args);
                  const itemCollision = collisions.find((collision) => String(collision.id).startsWith("group-item:")
                    && String(collision.id) !== String(args.active.id));
                  if (itemCollision) return [itemCollision];
                  const statusCollision = collisions.find((collision) => String(collision.id).startsWith("group-status:"));
                  if (!statusCollision) return collisions;
                  const activeId = String(args.active.id).replace("group-item:", "");
                  const status = String(statusCollision.id).slice("group-status:".length) as Status;
                  const pointerY = args.pointerCoordinates?.y;
                  if (pointerY === undefined) return collisions;
                  const targetId = hierarchyColumnSpatialTarget(
                    pointerY,
                    workspaceGroups[status]
                      .filter((entry) => entry.id !== activeId)
                      .flatMap((entry) => {
                        const rect = args.droppableRects.get(`group-item:${entry.id}`);
                        return rect ? [{ id: entry.id, top: rect.top, bottom: rect.bottom }] : [];
                      }),
                  );
                  return targetId ? [{ id: `group-item:${targetId}` }] : collisions;
                }}
                onDragStart={(event) => {
                  clearGroupDropIntent();
                  setGroupDragId(String(event.active.id).replace("group-item:", ""));
                }}
                onDragMove={considerGroupDropIntent}
                onDragCancel={() => {
                  setGroupDragId(null);
                  clearGroupDropIntent();
                }}
                onDragEnd={(event) => {
                  const active = String(event.active.id).replace("group-item:", "");
                  const rawOver = event.over ? String(event.over.id) : null;
                  const intent = groupDropIntentRef.current;
                  const columnDropPreview = groupColumnDropPreviewRef.current;
                  const activeItem = state.roadmap.roadmapItems.find((entry) => entry.id === active);
                  const overItemId = rawOver?.startsWith("group-item:") ? rawOver.slice("group-item:".length) : null;
                  const overStatus = overItemId
                    ? state.roadmap.roadmapItems.find((entry) => entry.id === overItemId)?.status ?? null
                    : rawOver?.startsWith("group-status:")
                      ? rawOver.slice("group-status:".length)
                      : null;
                  const decision = hierarchyDropCommitDecision(
                    active,
                    activeItem?.status ?? "",
                    overItemId ?? rawOver,
                    overStatus,
                    intent,
                  );
                  const over = decision.kind === "hierarchy"
                    ? `group-${decision.operation}:${decision.targetId}`
                    : decision.kind === "move"
                      ? columnDropPreview && rawOver === `group-status:${columnDropPreview.status}`
                        ? columnDropPreview.targetId
                          ? `group-after:${columnDropPreview.targetId}`
                          : rawOver
                        : null
                      : null;
                  setGroupDragId(null);
                  clearGroupDropIntent();
                  if (over) handleWorkspaceDrop(active, over);
                }}
              >
                {statuses.map((status) => {
                  const group = workspaceGroups[status];
                  if (status === "archived" && group.length === 0) return null;
                  const collapsed = collapsedGroupStatuses[status] === true;
                  return (
                    <section key={status} className="group-rail-section">
                      <button className="group-rail-section-header" aria-expanded={!collapsed} onClick={() => setCollapsedGroupStatuses((current) => {
                        const next = { ...current, [status]: !current[status] };
                        if (workspaceRoot) writeGroupRailSections(boardId, workspaceRoot.id, next);
                        return next;
                      })}>
                        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        <span>{labels[status]}</span>
                        <small className="count count-compact">{group.length}</small>
                      </button>
                      {!collapsed ? (
                        <GroupRailDropZone status={status} previewed={groupRailPreviewStatus === status}>
                          <SortableContext
                            items={group.map((entry) => `group-item:${entry.id}`)}
                            strategy={hierarchySortingStrategy(
                              group.map((entry) => `group-item:${entry.id}`),
                              groupRailDropPreview ? null : groupDropIntent ? `group-item:${groupDropIntent.targetId}` : null,
                              groupRailDropPreview ? null : groupDropIntent?.operation ?? null,
                            )}
                          >
                            {group.map((entry, index) => (
                              <React.Fragment key={entry.id}>
                                {groupRailDropPreview?.status === status && groupRailDropPreview.targetId === entry.id && groupRailDropPreview.operation === "before"
                                  ? <GroupRailInsertionPreview />
                                  : null}
                                <GroupRailCard
                                  item={entry}
                                  selected={item.id === entry.id}
                                  disabled={isPreviewing || busy || viewOnly}
                                  readOnly={viewOnly}
                                  canMoveUp={index > 0}
                                  canMoveDown={index < group.length - 1}
                                  onSelect={() => onSelectWorkItem?.(entry.id)}
                                  onMoveUp={() => void reorderWorkspaceItem(entry.id, "up")}
                                onMoveDown={() => void reorderWorkspaceItem(entry.id, "down")}
                                dropOperation={groupDropIntent?.targetId === entry.id && groupDropIntent.operation === "inside" ? "inside" : null}
                                reorderPreview={hierarchyReorderPlaceholderVisible(groupDropIntent?.operation ?? null) && !groupRailDropPreview}
                                hideSourceDuringDrag={groupDropIntent?.operation === "inside" || Boolean(groupRailDropPreview)}
                                />
                                {groupRailDropPreview?.status === status && groupRailDropPreview.targetId === entry.id && groupRailDropPreview.operation === "after"
                                  ? <GroupRailInsertionPreview />
                                  : null}
                              </React.Fragment>
                            ))}
                            {groupRailDropPreview?.status === status && groupRailDropPreview.operation === "empty"
                              ? <GroupRailInsertionPreview />
                              : null}
                          </SortableContext>
                          {group.length === 0 && groupRailDropPreview?.status !== status ? <div className="group-rail-empty">Drop here</div> : null}
                        </GroupRailDropZone>
                      ) : null}
                    </section>
                  );
                })}
                <DragOverlay>
                  {groupDragId ? <div className="group-rail-drag">{byId.get(groupDragId)?.title}</div> : null}
                </DragOverlay>
              </DndContext>
            </nav>
          </aside>
        ) : null}
        <div className="group-workspace-detail">

      {item.isGroup ? (
        <section className={`group-objective-panel ${objectiveEditing ? "editing" : ""} ${item.summary ? "" : "empty"}`}>
          <span className="group-objective-label">Group objective</span>
          {objectiveEditing ? (
            <div className="editor-pane group-objective-editor">
              {objectiveConflict ? (
                <div className="doc-conflict-note" role="alert">
                  <b>{objectiveConflict.who ? `${objectiveConflict.who} changed the objective while you were editing.` : "The objective changed while you were editing."}</b>{" "}
                  {objectiveConflict.choosing ? "Theirs is beside yours. Keep theirs, use yours, or edit yours." : "Edit yours with theirs in view, then save."}
                </div>
              ) : null}
              <div className={objectiveConflict ? "doc-conflict-compare" : undefined}>
                {objectiveConflict ? (
                  <section className="doc-conflict-side">
                    <p className="doc-conflict-label">{objectiveConflict.who ? `${objectiveConflict.who}'s version` : "The new version"}</p>
                    <p className="group-objective-theirs">{objectiveConflict.theirs || "No objective"}</p>
                  </section>
                ) : null}
                <section className={objectiveConflict ? "doc-conflict-side" : undefined}>
                  {objectiveConflict ? <p className="doc-conflict-label">Yours</p> : null}
                  <AutoSizingTextarea
                    autoFocus
                    aria-label="Group objective"
                    value={objectiveDraft}
                    disabled={busy}
                    readOnly={objectiveConflict?.choosing === true}
                    onChange={(event) => setObjectiveDraft(event.target.value)}
                    placeholder="What larger outcome do these Items achieve together?"
                  />
                </section>
              </div>
              {objectiveConflict?.choosing ? (
                <div className="editor-actions group-objective-actions doc-conflict-choice">
                  <button disabled={busy} onClick={() => {
                    setObjectiveDraft(objectiveConflict.theirs ?? "");
                    setObjectiveConflict(null);
                    setObjectiveEditing(false);
                    void onStateRefresh();
                  }}>Keep theirs</button>
                  <button disabled={busy} onClick={() => setObjectiveConflict({ ...objectiveConflict, choosing: false })}>Edit</button>
                  <button className="primary" disabled={busy} onClick={() => void saveObjective()}>
                    {busy ? <Loader2 size={14} className="spin" /> : <Pencil size={14} />}
                    Use mine
                  </button>
                </div>
              ) : (
              <div className="editor-actions group-objective-actions">
                <button disabled={busy} onClick={() => {
                  setObjectiveDraft(item.summary ?? "");
                  setObjectiveConflict(null);
                  setObjectiveEditing(false);
                }}>Cancel</button>
                <button
                  className="primary"
                  disabled={busy || objectiveDraft.trim() === (item.summary ?? "")}
                  onClick={() => void saveObjective()}
                >
                  {busy ? <Loader2 size={14} className="spin" /> : <Pencil size={14} />}
                  Save objective
                </button>
              </div>
              )}
            </div>
          ) : item.summary ? (
            <div className="group-objective-body editable-content-region">
              {!locked ? (
                <TooltipButton
                  label="Edit Group objective"
                  className="content-edit-action"
                  onClick={() => setObjectiveEditing(true)}
                >
                  <FilePenLine size={14} />
                </TooltipButton>
              ) : null}
              <p>{item.summary}</p>
            </div>
          ) : locked ? (
            <div className="group-objective-empty"><p>No objective recorded.</p></div>
          ) : (
            <div className="group-objective-empty">
              <p>No Group objective yet.</p>
              <button onClick={() => setObjectiveEditing(true)}>Add objective</button>
            </div>
          )}
        </section>
      ) : null}

      <section className={`overview-panel ${item.isGroup ? "after-group-objective" : ""}`}>
        <div className="meta-grid">
          <div className="workflow-status-summary">
            {locked ? <><span>Status</span><b>{labels[item.status]}</b></> : (
              <WorkflowStatusMenu status={item.status} busy={busy} onChange={(status) => void changeWorkflowStatus(status)} />
            )}
          </div>
          {!isPreviewing ? (
            <div className="detail-item-actions" aria-label={`${item.isGroup ? "Group" : "Item"} actions`}>
              <TooltipButton
                className={`copy-reference-button ${referenceCopied ? "is-copied" : ""}`}
                label={referenceCopied ? `${item.isGroup ? "Group" : "Item"} reference copied` : `Copy ${item.isGroup ? "Group" : "Item"} reference`}
                onClick={() => void copyWorkItemReference(state, item).then((copied) => {
                  if (!copied) {
                    window.alert(`Clipboard access was blocked. Copy this ${item.isGroup ? "Group" : "Item"} ID manually: ${item.id}`);
                    return;
                  }
                  showReferenceCopied();
                })}
              ><CopyConfirmationIcon confirmed={referenceCopied} /></TooltipButton>
              {!item.isGroup && !viewOnly ? (
                <TooltipButton label="Move Item" aria-expanded={placementOpen} onClick={() => setPlacementOpen(true)}>
                  <ArrowRightLeft size={14} />
                </TooltipButton>
              ) : null}
              {item.status !== "complete" && item.status !== "archived" && !viewOnly ? (
                <TooltipButton label="Mark complete" disabled={busy} onClick={() => void changeWorkflowStatus("complete")}>
                  <CheckCircle2 size={14} />
                </TooltipButton>
              ) : null}
              {item.status !== "archived" && !viewOnly ? (
                <TooltipButton label="Archive" disabled={busy} onClick={() => void changeWorkflowStatus("archived")}>
                  <Archive size={14} />
                </TooltipButton>
              ) : null}
            </div>
          ) : null}
        </div>
        {item.nextAction ? (
          <div className="next-action">
            <span>Next action</span>
            <p>{item.nextAction}</p>
          </div>
        ) : null}
      </section>

      {!isPreviewing && !item.isGroup && placementOpen ? createPortal(
        <div className="modal-backdrop" role="presentation" onMouseDown={() => {
          if (busy) return;
          setPlacementOpen(false);
          setPlacementQuery("");
          setPlacementDestination(null);
        }}>
          <section className="group-placement-modal item-move-modal" role="dialog" aria-modal="true" aria-labelledby="item-move-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="group-placement-header">
              <div className="group-placement-heading">
                <span className="group-placement-heading-icon" aria-hidden="true"><ArrowRightLeft size={17} /></span>
                <div>
                  <h2 id="item-move-title">Move Item</h2>
                  <p>{placementDestination ? "Review the destination before moving this Item." : `Choose a new location for “${item.title}”.`}</p>
                </div>
              </div>
              <TooltipButton label="Close" className="toolbar-icon-button" disabled={busy} onClick={() => {
                setPlacementOpen(false);
                setPlacementQuery("");
                setPlacementDestination(null);
              }}>
                <X size={14} />
              </TooltipButton>
            </header>
            {placementDestination ? (
              <>
                <div className="item-move-review">
                  <div className="group-placement-transfer" aria-label={`${item.title} will move to ${placementDestination.title}`}>
                    <div className="group-placement-transfer-node item">
                      <span>Item</span>
                      <b>{item.title}</b>
                    </div>
                    <div className="group-placement-transfer-direction" aria-hidden="true">
                      <FolderInput size={18} />
                    </div>
                    <div className="group-placement-transfer-node group">
                      <span>{placementDestination.isGroup ? "Group" : "Board"}</span>
                      <b>{placementDestination.title}</b>
                    </div>
                  </div>
                  <div className={`group-placement-fields ${placementSiblings.length === 0 ? "single-field" : ""}`}>
                    <PlanbanSelectMenu
                      label="Item status"
                      value={placementStatus}
                      options={statuses.map((status) => ({ value: status, label: labels[status], disabled: !placementStatusAllowed(status) }))}
                      disabled={busy}
                      labelPlacement="outside"
                      onChange={(status) => {
                        setPlacementStatus(status);
                        setPlacementPosition({ kind: "last" });
                      }}
                    />
                    {placementSiblings.length > 0 ? (
                      <PlanbanSelectMenu
                        label={`Position in ${labels[placementStatus]}`}
                        value={groupPlacementPositionValue(placementPosition)}
                        options={[
                          { value: "first", label: "First", disabled: placementPosition.kind === "first" },
                          { value: "last", label: "Last", disabled: placementPosition.kind === "last" },
                          ...placementSiblings
                            .filter((entry) => entry.id !== placementSiblings.at(-1)?.id)
                            .map((entry) => ({
                              value: `after:${entry.id}`,
                              label: `After ${entry.title}`,
                              disabled: placementPosition.kind === "after" && placementPosition.siblingId === entry.id,
                            })),
                        ]}
                        disabled={busy}
                        labelPlacement="outside"
                        onChange={(position) => setPlacementPosition(groupPlacementPositionFromValue(position))}
                      />
                    ) : null}
                  </div>
                </div>
                <footer className="feedback-actions group-placement-actions">
                  <button disabled={busy} onClick={() => setPlacementDestination(null)}>Back</button>
                  <button className="primary" disabled={busy} onClick={() => void moveToParent(placementDestination.id, placementStatus, placementPosition)}>
                    <ArrowRightLeft size={14} /> {busy ? "Moving…" : "Confirm move"}
                  </button>
                </footer>
              </>
            ) : <div className="hierarchy-editor">
              <div className="placement-picker">
                <label>
                  <Search size={14} aria-hidden="true" />
                  <input
                    autoFocus
                    value={placementQuery}
                    onChange={(event) => setPlacementQuery(event.target.value)}
                    placeholder="Find a Group…"
                    aria-label="Find a destination"
                  />
                </label>
                <div className="placement-options" role="listbox" aria-label="Item location">
                  <button
                    className={!item.parentId ? "active" : ""}
                    role="option"
                    aria-selected={!item.parentId}
                    disabled={busy || !item.parentId}
                    onClick={() => choosePlacementDestination({ id: null, title: "Main Board", isGroup: false })}
                  >
                    <span><b>Main Board</b></span>
                  </button>
                  {placementCandidates.map((entry) => (
                    <button
                      key={entry.id}
                      className={item.parentId === entry.id ? "active" : ""}
                      role="option"
                      aria-selected={item.parentId === entry.id}
                      disabled={busy || item.parentId === entry.id}
                      onClick={() => choosePlacementDestination({ id: entry.id, title: entry.title, isGroup: true })}
                    >
                      <GroupIcon status={entry.status} size={14} />
                      <span><b>{entry.title}</b></span>
                    </button>
                  ))}
                  {placementCandidates.length === 0 ? <p>No matching destinations</p> : null}
                </div>
              </div>
            </div>}
          </section>
        </div>,
        document.body,
      ) : null}

      <section className="doc-shell">
        <div className="doc-tabs">
          <button className={activeTab === "spec" ? "active" : ""} onClick={() => setActiveTab("spec")}>
            Spec
          </button>
          {item.planDoc ? (
            <button className={activeTab === "plan" ? "active" : ""} onClick={() => setActiveTab("plan")}>
              Plan
            </button>
          ) : null}
        </div>

        {doc ? (
          editing ? (
            <div className="editor-pane">
              {conflict ? (
                <div className="doc-conflict-note" role="alert">
                  <b>{conflict.who ? `${conflict.who} changed this ${docKindLabel(activeTab)} while you were editing.` : `This ${docKindLabel(activeTab)} changed while you were editing.`}</b>{" "}
                  {conflict.choosing ? "Theirs is beside yours. Keep theirs, use yours, or edit yours." : "Edit yours with theirs in view, then save."}
                </div>
              ) : null}
              <div className={conflict?.showing ? "doc-conflict-compare" : undefined}>
                {conflict?.showing ? (
                  <section className="doc-conflict-side">
                    <p className="doc-conflict-label">{conflict.who ? `${conflict.who}'s version` : "The new version"}</p>
                    <article className="markdown-body doc-conflict-theirs" aria-label={`${conflict.who ? `${conflict.who}'s` : "The new"} version`}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(conflict.theirs.markdown)}</ReactMarkdown>
                    </article>
                  </section>
                ) : null}
                <section className={conflict?.showing ? "doc-conflict-side" : undefined}>
                  {conflict?.showing ? <p className="doc-conflict-label">Yours</p> : null}
                  <AutoSizingTextarea value={draft} readOnly={conflict?.choosing === true} onChange={(event) => setDraft(event.target.value)} />
                </section>
              </div>
              {conflict?.choosing ? (
                <div className="editor-actions doc-conflict-choice">
                  <button disabled={busy} onClick={() => {
                    // Keep theirs: yours is set aside, and the document shows theirs.
                    setDocsByKind((current) => ({ ...current, [activeTab]: conflict.theirs }));
                    setDraft(conflict.theirs.markdown);
                    setConflict(null);
                    setEditing(false);
                    onStateRefresh();
                  }}>Keep theirs</button>
                  <button disabled={busy} onClick={() => setConflict({ ...conflict, choosing: false })}>Edit</button>
                  <button className="primary" disabled={busy} onClick={saveDoc}>
                    {busy ? <Loader2 size={14} className="spin" /> : <Pencil size={14} />}
                    Use mine
                  </button>
                </div>
              ) : (
                <div className="editor-actions">
                  <button disabled={busy} onClick={() => {
                    setDraft(doc.markdown);
                    setConflict(null);
                    setEditing(false);
                  }}>Cancel</button>
                  {conflict ? (
                    <button disabled={busy} aria-pressed={conflict.showing} onClick={() => setConflict({ ...conflict, showing: !conflict.showing, seen: true })}>
                      {conflict.showing ? "Hide" : "See"} {conflict.who ? `${conflict.who}'s` : "the new"} version
                    </button>
                  ) : null}
                  <button className="primary" onClick={saveDoc} disabled={busy || draft === (conflict?.theirs.markdown ?? doc.markdown)}>
                    {busy ? <Loader2 size={14} className="spin" /> : <Pencil size={14} />}
                    Save {activeTab}
                  </button>
                </div>
              )}
            </div>
          ) : doc.exists ? (
            <article className="markdown-body">
              {canRestoreActiveDoc && !viewOnly ? (
                <div className="doc-preview-row">
                  <span>Historical {docKindLabel(activeTab).toLowerCase()}</span>
                  <button className="primary" onClick={() => onRestoreDoc?.(item.id, activeTab)}>
                    Restore {docKindLabel(activeTab).toLowerCase()} to latest
                  </button>
                </div>
              ) : null}
              <div className="markdown-content-region">
                {!locked ? (
                  <TooltipButton
                    label={`Edit ${docKindLabel(activeTab)}`}
                    className="content-edit-action doc-content-edit-action"
                    onClick={() => setEditing(true)}
                  >
                    <FilePenLine size={14} />
                  </TooltipButton>
                ) : null}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(doc.markdown)}</ReactMarkdown>
              </div>
            </article>
          ) : isPreviewing ? (
            <div className="missing-doc">
              <p>No {activeTab} document snapshot exists for this card in v{previewVersion}.</p>
            </div>
          ) : viewOnly ? (
            <div className="missing-doc">
              <p>No {activeTab} document exists for this card yet.</p>
            </div>
          ) : (
            <div className="missing-doc">
              <p>No {activeTab} document exists for this card yet.</p>
              <button onClick={() => setEditing(true)}>Create {activeTab}</button>
            </div>
          )
        ) : docErrors[activeTab] ? (
          <div className="missing-doc" role="alert">
            <p>Couldn't load this {docKindLabel(activeTab).toLowerCase()}. {docErrors[activeTab]}</p>
            <button onClick={() => void loadDoc(activeTab).catch(() => undefined)}>Try again</button>
          </div>
        ) : (
          <div className="loading">Loading document...</div>
        )}
      </section>
        </div>
      </div>
    </main>
    </>
  );
}

function WorkItemSearchModal({
  items,
  onClose,
  onSelect,
}: {
  items: RoadmapItem[];
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useDialogFocus<HTMLElement>();
  const matches = useMemo(() => {
    if (!query.trim()) return [];
    return queryWorkItems(items, {
      search: query,
      projection: "flattened",
      hierarchyScope: "projection",
      groupRole: "any",
      statuses: [],
      blocked: "any",
      tags: [],
    }).matches.slice(0, 40);
  }, [items, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function choose(id: string) {
    onSelect(id);
    onClose();
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" && matches.length) {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % matches.length);
      return;
    }
    if (event.key === "ArrowUp" && matches.length) {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + matches.length) % matches.length);
      return;
    }
    if (event.key === "Enter" && matches[activeIndex]) {
      event.preventDefault();
      choose(matches[activeIndex].item.id);
    }
  }

  return createPortal(
    <div className="modal-backdrop work-item-search-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="work-item-search-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Search Work Items"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <label className="work-item-search-input">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            aria-label="Search Work Items"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search titles, summaries, next actions, and tags"
          />
          <button type="button" aria-label="Close search" onClick={onClose}><X size={15} /></button>
        </label>
        <div className="work-item-search-results" aria-live="polite">
          {!query.trim() ? (
            <div className="work-item-search-empty">
              <Search size={18} aria-hidden="true" />
              <span>Find any Work Item, including Items inside Groups.</span>
            </div>
          ) : matches.length ? matches.map((entry, index) => (
            <button
              key={entry.item.id}
              type="button"
              className={index === activeIndex ? "active" : ""}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(entry.item.id)}
            >
              <span className="work-item-search-result-title">
                <b>{entry.item.title}</b>
                {entry.item.isGroup ? <small>Group</small> : null}
              </span>
              <span className="work-item-search-result-meta">
                {labels[entry.item.status]}
                {entry.ancestry.length ? ` · ${entry.ancestry.map((ancestor) => ancestor.title).join(" › ")}` : " · Main Board"}
              </span>
            </button>
          )) : (
            <div className="work-item-search-empty">No Work Items match “{query.trim()}”.</div>
          )}
        </div>
        <footer className="work-item-search-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

/** On a phone: one chip per column, each jumping to its group in the list. */
function PhoneStatusTabs({ statuses: shown, counts }: { statuses: readonly Status[]; counts: Record<string, number> }) {
  return (
    <nav className="phone-status-tabs" aria-label="Columns">
      {shown.map((status) => (
        <button key={status} type="button" onClick={() => document.querySelector(`.board-grid [data-status="${status}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" })}>
          {labels[status]} <span>{counts[status] ?? 0}</span>
        </button>
      ))}
    </nav>
  );
}

function BoardView({
  state,
  boards,
  activities,
  onStateChange,
  onSelectBoard,
}: {
  state: PlanbanState;
  boards: BoardRecord[];
  activities: PlanbanActivitySnapshot[];
  onStateChange: (next: PlanbanState) => void;
  onSelectBoard: (repoId: string | null) => void;
}) {
  const boardId = state.manifest.repoId;
  const lastStalenessRef = useRef<{ boardId: string; cards: Record<string, StalenessSignal[]> }>({ boardId, cards: {} });
  if (state.staleness) lastStalenessRef.current = { boardId, cards: state.staleness.cards };
  else if (lastStalenessRef.current.boardId !== boardId) lastStalenessRef.current = { boardId, cards: {} };
  const stalenessCards = lastStalenessRef.current.cards;
  const [items, setItems] = useState<RoadmapItem[]>(state.roadmap.roadmapItems);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return ["group", "programme"].includes(params.get("projection") ?? "") ? params.get("groupId") ?? params.get("programmeId") : null;
  });
  // A second card link while this board is already open only changes the address's "#card=".
  const boardItemsRef = useRef(state.roadmap.roadmapItems);
  boardItemsRef.current = state.roadmap.roadmapItems;
  useEffect(() => {
    const onHashChange = () => {
      if (!cardIdFromHash(window.location.hash)) return;
      const cardId = linkedCardOnBoard(window.location.hash, boardItemsRef.current.map((item) => item.id));
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
      if (cardId) setSelectedId(cardId);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const [showArchived, setShowArchived] = useState(() => normalizeBoardViewPreferences(readBoardViewPreferences(state.manifest.repoId)).showArchived);
  const [search, setSearch] = useState(() => initialBoardQueryState(state.manifest.repoId).search);
  const [queryError, setQueryError] = useState<string | null>(() => initialBoardQueryState(state.manifest.repoId).error);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hierarchyScope, setHierarchyScope] = useState<PlanbanHierarchyScope>(() => initialBoardQueryState(state.manifest.repoId).hierarchyScope);
  const [groupRole, setGroupRoleFilter] = useState<PlanbanGroupRole>(() => initialBoardQueryState(state.manifest.repoId).groupRole);
  const [filterStatuses, setFilterStatuses] = useState<Status[]>(() => initialBoardQueryState(state.manifest.repoId).statuses);
  const [blockedFilter, setBlockedFilter] = useState<PlanbanBlockedFilter>(() => initialBoardQueryState(state.manifest.repoId).blocked);
  const [filterTags, setFilterTags] = useState<string[]>(() => initialBoardQueryState(state.manifest.repoId).tags);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [projection, setProjection] = useState<"main" | "flattened">(() => {
    const queryProjection = new URLSearchParams(window.location.search).get("projection");
    return queryProjection === "flattened" ? "flattened" : "main";
  });
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set(normalizeBoardViewPreferences(readBoardViewPreferences(state.manifest.repoId)).expandedGroupIds));
  const boardGridRef = useRef<HTMLDivElement | null>(null);
  const skipNextPreferenceWriteRef = useRef(false);
  const [collapsed, setCollapsed] = useState<Partial<Record<Status, boolean>>>(() => normalizeBoardViewPreferences(readBoardViewPreferences(state.manifest.repoId)).collapsed);
  const [hiddenCards, setHiddenCards] = useState<Partial<Record<Status, boolean>>>(() => normalizeBoardViewPreferences(readBoardViewPreferences(state.manifest.repoId)).hiddenCards);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeSize, setActiveSize] = useState<{ width: number; height: number } | null>(null);
  const [dragOver, setDragOver] = useState<Status | null>(null);
  const [boardDropIntent, setBoardDropIntent] = useState<{ targetId: string; operation: HierarchyDropOperation } | null>(null);
  const [boardColumnDropPreview, setBoardColumnDropPreview] = useState<{ status: Status; targetId: string | null; operation: "after" | "empty" } | null>(null);
  const [pendingBoardPlacement, setPendingBoardPlacement] = useState<PendingGroupPlacement | null>(null);
  const [boardPlacementBusy, setBoardPlacementBusy] = useState(false);
  const dragStartItemsRef = useRef<RoadmapItem[] | null>(null);
  const lastDropTargetIdRef = useRef<string | null>(null);
  const boardDropIntentRef = useRef<{ targetId: string; operation: HierarchyDropOperation } | null>(null);
  const boardColumnDropPreviewRef = useRef<{ status: Status; targetId: string | null; operation: "after" | "empty" } | null>(null);
  const boardDropRectsRef = useRef(new Map<string, HierarchyDropRect>());
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [preview, setPreview] = useState<{ version: number; entry: HistoryEntry | null; state: PlanbanState } | null>(null);
  const [boardHistoryOpen, setBoardHistoryOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onlineScreen, setOnlineScreen] = useState<"people" | "invite" | "connections" | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [postUpdateVersion, setPostUpdateVersion] = useState<string | null>(() => {
    const value = new URLSearchParams(window.location.search).get("planbanUpdated");
    return value && value.trim() ? value.trim() : null;
  });
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusPayload | null>(null);
  const [tutorialProgress, setTutorialProgress] = useState<TutorialProgress>(() => readTutorialProgress());
  const [activityChangedCardTitle, setActivityChangedCardTitle] = useState<string | null>(null);
  const [activityDetailKind, setActivityDetailKind] = useState<"item" | "group" | null>(null);
  const [activityDetailEditSerial, setActivityDetailEditSerial] = useState(0);
  const activityEditCursorRef = useRef(0);
  const activityEditSerialRef = useRef(0);
  const phone = usePhoneLayout();
  // A viewer on the web reads everything and changes nothing.
  const viewOnly = state.hosted?.role === "viewer";
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 3 } });
  // Phones move cards with Status and Move to, not by dragging, so a swipe always scrolls.
  // Always one argument, so switching to phone width really turns dragging off.
  const sensors = useSensors(phone || viewOnly ? undefined : pointerSensor);
  const displayState = preview?.state ?? state;
  const previewVersion = preview?.version ?? null;
  const isPreviewing = preview !== null;
  const boardKind = boards.find((board) => board.repoId === boardId)?.kind;
  const isDemoBoard = boardKind === "demo";
  // The board's goals (owner decisions, 16 October 2026): read again with each revision; "#goals" opens their page.
  const [goals] = useGoals(boardId, state.roadmap.revision, api);
  const [goalsOpen, setGoalsOpen] = useState(() => window.location.hash === "#goals");
  const openGoals = () => {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#goals`);
    setGoalsOpen(true);
  };
  const closeGoals = () => {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    setGoalsOpen(false);
  };
  const online = useOnlineStatus(isDemoBoard ? null : boardId, state.roadmap.revision);
  const boardPeople = useBoardPeople(isDemoBoard ? null : boardId, online.status?.location === "online", `${state.roadmap.revision}:${online.status?.location}`);
  const isActivityLab = activityLabIsEnabled(boardId, boardKind, window.location.search);
  const activityLabCards = useMemo(
    () => items.filter((item) => item.status !== "archived"),
    [items],
  );
  const activityLabRootCards = useMemo(
    () => activityLabCards.filter((item) => item.parentId === null),
    [activityLabCards],
  );
  const activityLabCardIds = useMemo(() => activityLabCards.map((item) => item.id), [activityLabCards]);
  const activityVariantById = useMemo(
    () => new Map(activityLabCards.map((item, index) => [item.id, activityVariantForIndex(index)])),
    [activityLabCards],
  );
  const activityDemo = useActivityDemo(isActivityLab, activityLabCardIds);
  const [activityNow, setActivityNow] = useState(() => Date.now());
  const liveActivityById = useMemo(
    () => new Map(activities.filter((activity) => activity.repoId === boardId).map((activity) => [activity.cardId, activity])),
    [activities, boardId],
  );
  useEffect(() => {
    setActivityNow(Date.now());
  }, [activities, boardId]);
  useEffect(() => {
    const now = Date.now();
    const boundaries = activities
      .filter((activity) => activity.repoId === boardId && activity.endedAt !== null)
      .flatMap((activity) => [
        activity.endedAt! + PLANBAN_ACTIVITY_HOLD_MS,
        activity.removeAt ?? activity.endedAt! + PLANBAN_ACTIVITY_TAIL_MS,
      ])
      .filter((boundary) => boundary > now);
    if (boundaries.length === 0) return undefined;
    const timer = window.setTimeout(() => setActivityNow(Date.now()), Math.max(0, Math.min(...boundaries) - now + 16));
    return () => window.clearTimeout(timer);
  }, [activities, boardId, activityNow]);
  const activityDetailSource = activityLabRootCards[1] ?? activityLabRootCards[0] ?? null;
  const flashAndChangeActivityCard = useCallback(() => {
    const candidates = activityLabRootCards.slice(0, 5);
    if (!isActivityLab || candidates.length === 0) return;
    const target = candidates[activityEditCursorRef.current % candidates.length]!;
    activityEditCursorRef.current += 1;
    activityEditSerialRef.current += 1;
    const editSerial = activityEditSerialRef.current;
    setItems((current) => current.map((item) => item.id === target.id
      ? { ...item, nextAction: `Agent edit ${editSerial} just replaced this card’s next action.` }
      : item));
    setActivityChangedCardTitle(target.title);
    activityDemo.runCardPulse(target.id);
  }, [activityDemo.runCardPulse, activityLabRootCards, isActivityLab]);
  const openActivityDetail = useCallback((kind: "item" | "group") => {
    if (!isActivityLab || !activityDetailSource) return;
    setActivityChangedCardTitle(null);
    setActivityDetailKind(kind);
    setActivityDetailEditSerial(0);
    setSelectedId(activityDetailSource.id);
    activityDemo.runCardPulse(activityDetailSource.id);
  }, [activityDemo.runCardPulse, activityDetailSource, isActivityLab]);
  const flashAndChangeActivityDetail = useCallback(() => {
    if (!isActivityLab || !activityDetailSource || !activityDetailKind) return;
    activityEditSerialRef.current += 1;
    const editSerial = activityEditSerialRef.current;
    setActivityDetailEditSerial(editSerial);
    if (activityDetailKind === "item") {
      setItems((current) => current.map((item) => item.id === activityDetailSource.id
        ? { ...item, nextAction: `Agent edit ${editSerial} just replaced this Item’s next action.` }
        : item));
    }
    activityDemo.runCardPulse(activityDetailSource.id);
  }, [activityDemo.runCardPulse, activityDetailKind, activityDetailSource, isActivityLab]);
  const activityForItem = useCallback((item: RoadmapItem): ActivityPresentation | null => {
    const phases: Array<ActivityPhase | null> = [
      isActivityLab ? activityDemo.phaseForId(item.id) : null,
      liveActivityById.get(item.id) ? activityPhaseAt(liveActivityById.get(item.id)!, activityNow) : null,
    ];
    if (item.isGroup) {
      for (const child of items) {
        if (child.parentId === item.id) {
          if (isActivityLab) phases.push(activityDemo.phaseForId(child.id));
          const childActivity = liveActivityById.get(child.id);
          if (childActivity) phases.push(activityPhaseAt(childActivity, activityNow));
        }
      }
    }
    const phase = strongestActivityPhase(phases);
    if (!phase) return null;
    return {
      phase,
      variant: isActivityLab ? activityVariantById.get(item.id) ?? "illumination" : "aurora",
    };
  }, [activityDemo, activityNow, activityVariantById, isActivityLab, items, liveActivityById]);

  useEffect(() => {
    const preferences = normalizeBoardViewPreferences(readBoardViewPreferences(boardId));
    skipNextPreferenceWriteRef.current = true;
    setCollapsed(preferences.collapsed);
    setHiddenCards(preferences.hiddenCards);
    setShowArchived(preferences.showArchived);
    setExpandedGroupIds(new Set(preferences.expandedGroupIds));
    const params = new URLSearchParams(window.location.search);
    const queryProjection = params.get("projection");
    const isGroupProjection = queryProjection === "group" || queryProjection === "programme";
    // A link to a card (from ChatGPT, Claude or a copied address) opens it once, then leaves the address as the board's.
    const opensCard = linkedCardOnBoard(window.location.hash, state.roadmap.roadmapItems.map((item) => item.id));
    if (cardIdFromHash(window.location.hash)) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    setSelectedId(isGroupProjection ? params.get("groupId") ?? params.get("programmeId") : opensCard);
    setGroupId(null);
    setProjection(queryProjection === "flattened" ? "flattened" : "main");
    setActivityChangedCardTitle(null);
    setActivityDetailKind(null);
    setActivityDetailEditSerial(0);
    activityEditCursorRef.current = 0;
    activityEditSerialRef.current = 0;
    if (isGroupProjection) {
      const url = new URL(window.location.href);
      url.searchParams.delete("projection");
      url.searchParams.delete("groupId");
      url.searchParams.delete("programmeId");
      window.history.replaceState({}, "", url.toString());
    }
    const nextQuery = initialBoardQueryState(boardId);
    setSearch(nextQuery.search);
    setQueryError(nextQuery.error);
    setHierarchyScope(nextQuery.hierarchyScope);
    setGroupRoleFilter(nextQuery.groupRole);
    setFilterStatuses(nextQuery.statuses);
    setBlockedFilter(nextQuery.blocked);
    setFilterTags(nextQuery.tags);
  }, [boardId]);

  useEffect(() => {
    setItems(displayState.roadmap.roadmapItems);
    dragStartItemsRef.current = null;
    lastDropTargetIdRef.current = null;
    setSelectedId((current) => {
      if (!current) return null;
      return displayState.roadmap.roadmapItems.some((item) => item.id === current) ? current : null;
    });
  }, [displayState.manifest.repoId, displayState.roadmap.roadmapItems]);

  const loadHistory = useCallback(async () => {
    const payload = await api<HistoryPayload>(boardPath(boardId, "/history"));
    setHistory(payload);
    return payload;
  }, [boardId]);

  const loadUpdateStatus = useCallback(async () => {
    const payload = await api<UpdateStatusPayload>("/api/update-status");
    setUpdateStatus(payload);
    return payload;
  }, []);

  useEffect(() => {
    setPreview(null);
    void loadHistory().catch(() => setHistory(null));
    if (capabilities.updates) void loadUpdateStatus().catch(() => undefined);
  }, [boardId, loadHistory, loadUpdateStatus]);

  useEffect(() => {
    if (!postUpdateVersion || !updateStatus?.latest || updateStatus.latest.version !== postUpdateVersion) return;
    setUpdateOpen(true);
    const url = new URL(window.location.href);
    url.searchParams.delete("planbanUpdated");
    window.history.replaceState({}, "", url.toString());
  }, [postUpdateVersion, updateStatus]);

  const activityDetailState = useMemo<PlanbanState>(() => {
    if (activityDetailKind !== "group" || !activityDetailSource) return displayState;
    const childIds = new Set(activityLabRootCards
      .filter((item) => item.id !== activityDetailSource.id)
      .slice(0, 2)
      .map((item) => item.id));
    const previewItems = items.map((item, index) => {
      if (item.id === activityDetailSource.id) {
        return {
          ...item,
          title: "Agent activity Group preview",
          summary: activityDetailEditSerial > 0
            ? `Agent edit ${activityDetailEditSerial} just replaced this Group objective.`
            : "Coordinate the Items in this Group while keeping agent activity visible at the shared divider.",
          nextAction: "Review the Group objective and its active Items.",
          isGroup: true,
          parentId: null,
        };
      }
      if (childIds.has(item.id)) return { ...item, parentId: activityDetailSource.id, groupRank: index + 1 };
      return item;
    });
    return {
      ...displayState,
      roadmap: { ...displayState.roadmap, roadmapItems: previewItems },
    };
  }, [activityDetailEditSerial, activityDetailKind, activityDetailSource, activityLabRootCards, displayState, items]);
  const detailItems = activityDetailKind === "group" ? activityDetailState.roadmap.roadmapItems : items;
  const selectedItem = selectedId ? detailItems.find((item) => item.id === selectedId) ?? null : null;
  const activeItem = activeId ? items.find((item) => item.id === activeId) : null;
  const activeGroup = groupId ? items.find((item) => item.id === groupId && item.isGroup) ?? null : null;
  const groupWorkspace = useMemo(() => groupId ? groupWorkspaceProjection(items, groupId) : null, [items, groupId]);
  const rootItems = useMemo(() => mainBoardProjection(items), [items]);
  const flattened = useMemo(() => flattenedExecutionProjection(items), [items]);
  const queryResult = useMemo(() => queryWorkItems(items, {
    search,
    projection: groupWorkspace ? "group" : projection,
    groupId,
    hierarchyScope,
    groupRole,
    statuses: filterStatuses,
    blocked: blockedFilter,
    tags: filterTags,
  }), [blockedFilter, filterStatuses, filterTags, hierarchyScope, groupWorkspace, items, groupId, groupRole, projection, search]);
  const queryActive = Boolean(
    search.trim() || hierarchyScope !== "projection" || groupRole !== "any" || filterStatuses.length ||
    blockedFilter !== "any" || filterTags.length,
  );
  const filteredItems = queryResult.matches.map((entry) => entry.item);
  const groupRollups = useMemo(() => new Map(items.filter((item) => item.isGroup).map((item) => [item.id, groupRollup(items, item.id)])), [items]);

  useEffect(() => {
    if (groupId && !activeGroup) setGroupId(null);
  }, [activeGroup, groupId]);
  const grouped = useMemo(
    () => projection === "flattened" && !groupWorkspace ? groupItemsInCurrentOrder(filteredItems) : groupItems(filteredItems),
    [filteredItems, groupWorkspace, projection],
  );
  const hasArchivedCards = grouped.archived.length > 0;
  const visibleStatuses = showArchived && hasArchivedCards ? statuses : statuses.filter((status) => status !== "archived");
  const isFlattenedRoot = projection === "flattened" && !groupWorkspace;
  const hierarchyCollisionDetection = useMemo(() => hierarchyBoardCollisionDetection(items), [items]);
  const containmentTarget = boardDropIntent?.operation === "inside"
    ? items.find((item) => item.id === boardDropIntent.targetId) ?? null
    : null;
  const containmentCue = containmentTarget ? hierarchyContainmentCue(containmentTarget.isGroup === true) : null;
  const crossColumnDropPreview = useMemo<CrossColumnDropPreview | null>(() => {
    if (isFlattenedRoot || !activeItem) return null;
    if (boardColumnDropPreview) return { item: activeItem, ...boardColumnDropPreview };
    if (!boardDropIntent || boardDropIntent.operation === "inside") return null;
    const target = items.find((item) => item.id === boardDropIntent.targetId);
    if (!target || target.status === activeItem.status) return null;
    return {
      item: activeItem,
      status: target.status,
      targetId: target.id,
      operation: boardDropIntent.operation,
    };
  }, [activeItem, boardColumnDropPreview, boardDropIntent, isFlattenedRoot, items]);

  function selectProjection(nextProjection: "main" | "flattened") {
    setGroupId(null);
    setProjection(nextProjection);
    const url = new URL(window.location.href);
    url.searchParams.delete("groupId");
    if (nextProjection === "flattened") url.searchParams.set("projection", "flattened");
    else url.searchParams.delete("projection");
    window.history.replaceState({}, "", url.toString());
  }

  function openGroup(id: string) {
    setSelectedId(id);
    setGroupId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("projection");
    url.searchParams.delete("groupId");
    window.history.replaceState({}, "", url.toString());
  }

  function leaveGroup(parentId: string | null) {
    if (parentId) {
      openGroup(parentId);
      return;
    }
    selectProjection(projection);
  }

  function clearQuery() {
    setSearch("");
    setHierarchyScope("projection");
    setGroupRoleFilter("any");
    setFilterStatuses([]);
    setBlockedFilter("any");
    setFilterTags([]);
    setQueryError(null);
    const url = new URL(window.location.href);
    for (const name of ["q", "scope", "groupRole", "status", "blocked", "tag"]) url.searchParams.delete(name);
    window.history.replaceState({}, "", url.toString());
  }

  useEffect(() => {
    if (skipNextPreferenceWriteRef.current) {
      skipNextPreferenceWriteRef.current = false;
      return;
    }
    writeBoardViewPreferences(boardId, {
      collapsed,
      hiddenCards,
      showArchived: hasArchivedCards ? showArchived : false,
      expandedGroupIds: [...expandedGroupIds],
      groupId,
      projection,
      hierarchyScope,
      groupRole,
      filterStatuses,
      blockedFilter,
      filterTags,
    });
  }, [blockedFilter, boardId, collapsed, expandedGroupIds, filterStatuses, filterTags, hasArchivedCards, hiddenCards, hierarchyScope, groupId, groupRole, projection, showArchived]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const replace = (name: string, values: string[]) => {
      url.searchParams.delete(name);
      for (const value of values) url.searchParams.append(name, value);
    };
    if (search.trim()) url.searchParams.set("q", search.trim()); else url.searchParams.delete("q");
    if (hierarchyScope !== "projection") url.searchParams.set("scope", hierarchyScope); else url.searchParams.delete("scope");
    if (groupRole !== "any") url.searchParams.set("groupRole", groupRole); else url.searchParams.delete("groupRole");
    replace("status", filterStatuses);
    if (blockedFilter !== "any") url.searchParams.set("blocked", blockedFilter); else url.searchParams.delete("blocked");
    replace("tag", filterTags);
    window.history.replaceState({}, "", url.toString());
  }, [blockedFilter, filterStatuses, filterTags, hierarchyScope, groupRole, search]);

  useEffect(() => {
    if (!hasArchivedCards) setShowArchived(false);
  }, [hasArchivedCards]);

  useLayoutEffect(() => {
    if (!showArchived || !hasArchivedCards) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const grid = boardGridRef.current;
      const archiveColumn = grid?.querySelector<HTMLElement>('[data-status="archived"]');
      if (!grid || !archiveColumn) return;

      const nextLeft = Math.max(0, archiveColumn.offsetLeft + archiveColumn.offsetWidth - grid.clientWidth + 12);
      grid.scrollTo({ left: nextLeft, behavior: "smooth" });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [hasArchivedCards, showArchived]);

  async function refreshState() {
    const next = await api<PlanbanState>(boardPath(boardId, "/state"));
    onStateChange(next);
    await loadHistory().catch(() => undefined);
  }

  useEffect(() => {
    if (isPreviewing || !capabilities.localAgents) return undefined;
    const pendingItems = state.roadmap.roadmapItems.filter(hasPendingCodexThread);
    if (pendingItems.length === 0) return undefined;
    let cancelled = false;
    let timeoutId: number | null = null;
    let nextDelayMs = 3000;

    async function syncPendingCodexThreads() {
      for (const item of pendingItems) {
        try {
          const result = await api<{ linked: boolean; state?: PlanbanState }>(
            cardPath(boardId, item.id, `/codex-thread/sync`),
            { method: "POST", body: "{}" },
          );
          if (!cancelled && result.linked && result.state) {
            onStateChange(result.state);
            await loadHistory().catch(() => undefined);
            return true;
          }
        } catch {
          // Keep the board usable if Codex session discovery is temporarily unavailable.
        }
      }
      return false;
    }

    async function scheduleSync() {
      const linked = await syncPendingCodexThreads();
      if (cancelled || linked) return;
      nextDelayMs = Math.min(Math.round(nextDelayMs * 1.5), 15000);
      timeoutId = window.setTimeout(() => void scheduleSync(), nextDelayMs);
    }

    void scheduleSync();
    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [boardId, isPreviewing, loadHistory, onStateChange, state.roadmap.revision, state.roadmap.roadmapItems]);

  async function previewHistoryVersion(version: number) {
    if (history && version === history.currentVersion) {
      setPreview(null);
      return;
    }
    const next = await api<PlanbanState>(boardPath(boardId, `/history/${version}`));
    const entry = history?.entries.find((candidate) => candidate.version === version) ?? null;
    setPreview({ version, entry, state: next });
  }

  function returnToCurrent() {
    setPreview(null);
  }

  async function restoreBoardFromPreview() {
    if (!preview) return;
    const confirmed = window.confirm(`Restore the board state from v${preview.version} to the latest version?`);
    if (!confirmed) return;
    const next = await api<PlanbanState>(boardPath(boardId, `/history/${preview.version}/restore-board`), {
      method: "POST",
      body: JSON.stringify({ actor: "user", baseRevision: state.roadmap.revision }),
    });
    setPreview(null);
    onStateChange(next);
    await loadHistory().catch(() => undefined);
  }

  async function restoreCardFromPreview(cardId: string) {
    if (!preview) return;
    const item = preview.state.roadmap.roadmapItems.find((entry) => entry.id === cardId);
    const confirmed = window.confirm(`Restore "${item?.title ?? cardId}" card details from v${preview.version} to the latest version?`);
    if (!confirmed) return;
    const next = await api<PlanbanState>(cardPath(boardId, cardId, `/restore`, preview.version), {
      method: "POST",
      body: JSON.stringify({ actor: "user", baseRevision: state.roadmap.revision }),
    });
    setPreview(null);
    onStateChange(next);
    await loadHistory().catch(() => undefined);
  }

  async function restoreDocFromPreview(cardId: string, kind: DocKind) {
    if (!preview) return;
    const confirmed = window.confirm(`Restore this ${kind} document from v${preview.version} to the latest version?`);
    if (!confirmed) return;
    await api<DocPayload>(cardPath(boardId, cardId, `/docs/${kind}/restore`, preview.version), {
      method: "POST",
      body: JSON.stringify({ actor: "user", baseRevision: state.roadmap.revision }),
    });
    setPreview(null);
    await refreshState();
  }

  async function moveItem(id: string, status: Status) {
    if (isPreviewing) return;
    try {
      const next = await api<PlanbanState>(cardPath(boardId, id, `/move`), {
        method: "POST",
        body: JSON.stringify({ status, baseRevision: state.roadmap.revision }),
      });
      onStateChange(next);
      await loadHistory().catch(() => undefined);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Card move failed");
      await refreshState();
    }
  }

  async function deleteItem(id: string) {
    if (isPreviewing) return;
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    const confirmed = window.confirm(
      `Delete "${item.title}" permanently from this Planban board? This also removes its local Planban docs.`,
    );
    if (!confirmed) return;

    try {
      const next = await api<PlanbanState>(cardPath(boardId, id, ``), {
        method: "DELETE",
        body: JSON.stringify({ baseRevision: state.roadmap.revision }),
      });
      onStateChange(next);
      await loadHistory().catch(() => undefined);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Card delete failed");
      await refreshState();
    }
  }

  function findStatus(id: string): Status | null {
    return statusForDropTarget(dragStartItemsRef.current ?? items, id);
  }

  function clearBoardColumnDropPreview() {
    boardColumnDropPreviewRef.current = null;
    setBoardColumnDropPreview(null);
  }

  function onDragStart(event: DragStartEvent) {
    if (isPreviewing) return;
    const id = String(event.active.id);
    dragStartItemsRef.current = items;
    lastDropTargetIdRef.current = null;
    boardDropIntentRef.current = null;
    clearBoardColumnDropPreview();
    boardDropRectsRef.current.clear();
    setBoardDropIntent(null);
    setActiveId(id);
    setDragOver(findStatus(id));
    const rect = event.active.rect.current.initial;
    setActiveSize(rect ? { width: rect.width, height: rect.height } : null);
  }

  function onDragMove(event: DragMoveEvent) {
    if (isPreviewing || isFlattenedRoot) return;
    const draggingId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    const dragItems = dragStartItemsRef.current ?? items;
    const pointer = dragPointerCoordinates(event);
    const previousIntent = boardDropIntentRef.current;
    const previousRect = previousIntent?.operation === "inside" ? boardDropRectsRef.current.get(previousIntent.targetId) : null;
    const latchedTarget = previousIntent?.operation === "inside" && previousRect && hierarchyContainmentLatch(pointer, previousRect)
      ? dragItems.find((entry) => entry.id === previousIntent.targetId) ?? null
      : null;
    const target = latchedTarget ?? (overId ? dragItems.find((entry) => entry.id === overId) ?? null : null);
    if (target?.id === draggingId) {
      boardDropIntentRef.current = null;
      setBoardDropIntent(null);
      clearBoardColumnDropPreview();
      return;
    }
    if (!target || !event.over) {
      boardDropIntentRef.current = null;
      setBoardDropIntent(null);
      const targetStatus = overId && statuses.includes(overId as Status) ? overId as Status : null;
      const next = targetStatus ? hierarchyColumnDropPreview(dragItems, draggingId, targetStatus) : null;
      if (next) {
        boardColumnDropPreviewRef.current = next;
        setBoardColumnDropPreview(next);
      } else {
        clearBoardColumnDropPreview();
      }
      return;
    }
    clearBoardColumnDropPreview();
    const rect = boardDropRectsRef.current.get(target.id) ?? stableDropRect(event.over.rect);
    boardDropRectsRef.current.set(target.id, rect);
    const previous = boardDropIntentRef.current?.targetId === target.id ? boardDropIntentRef.current.operation : null;
    const operation = hierarchyDropOperation(dragPointerY(event), rect, {
      canMoveInside: canPlaceItemInside(dragStartItemsRef.current ?? items, draggingId, target.id),
      previous,
      deadbandPx: 8,
    });
    if (operation !== "inside" && !hierarchyPlacementChanges(dragItems, draggingId, target.id, operation)) {
      boardDropIntentRef.current = null;
      setBoardDropIntent(null);
      return;
    }
    const next = { targetId: target.id, operation };
    boardDropIntentRef.current = next;
    setBoardDropIntent(next);
  }

  function onDragOver(event: DragOverEvent) {
    if (isPreviewing) return;
    if (!event.over) {
      setDragOver(null);
      return;
    }
    const draggingId = String(event.active.id);
    const overId = String(event.over.id);
    const dragStartItems = dragStartItemsRef.current ?? items;
    if (overId === draggingId) {
      setDragOver(dragStartItems.find((entry) => entry.id === draggingId)?.status ?? null);
      return;
    }
    if (dragStartItems.some((entry) => entry.id === overId)) {
      setDragOver(dragStartItems.find((entry) => entry.id === overId)?.status ?? null);
      lastDropTargetIdRef.current = overId;
      return;
    }
    const target = statusForDropTarget(dragStartItems, overId);
    setDragOver(target);
    if (!target) {
      setDragOver(null);
      lastDropTargetIdRef.current = overId;
      return;
    }
    lastDropTargetIdRef.current = overId;
  }

  async function onDragEnd(event: DragEndEvent) {
    if (isPreviewing) return;
    const id = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    const dragStartItems = dragStartItemsRef.current ?? items;
    const dropIntent = boardDropIntentRef.current;
    const columnDropPreview = boardColumnDropPreviewRef.current;
    const resolvedOverId = resolveDropTargetId(dragStartItems, id, overId, lastDropTargetIdRef.current);
    setActiveId(null);
    setActiveSize(null);
    setDragOver(null);
    boardDropIntentRef.current = null;
    clearBoardColumnDropPreview();
    boardDropRectsRef.current.clear();
    setBoardDropIntent(null);
    if (!resolvedOverId) {
      dragStartItemsRef.current = null;
      lastDropTargetIdRef.current = null;
      setItems(state.roadmap.roadmapItems);
      return;
    }

    if (isFlattenedRoot) {
      dragStartItemsRef.current = null;
      lastDropTargetIdRef.current = null;
      setItems(state.roadmap.roadmapItems);
      const move = flattenedExecutionMoveForDrop(dragStartItems, id, resolvedOverId);
      if (!move) return;
      try {
        const placed = await api<PlanbanState>(cardPath(boardId, id, `/move`), {
          method: "POST",
          body: JSON.stringify({ ...move, baseRevision: state.roadmap.revision }),
        });
        onStateChange(placed);
        await loadHistory().catch(() => undefined);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "Card status move failed");
        await refreshState();
      }
      return;
    }

    const activeItem = dragStartItems.find((entry) => entry.id === id);
    const directOverStatus = overId ? statusForDropTarget(dragStartItems, overId) : null;
    const decision = hierarchyDropCommitDecision(
      id,
      activeItem?.status ?? "",
      overId,
      directOverStatus,
      dropIntent,
    );

    if (decision.kind === "hierarchy") {
      dragStartItemsRef.current = null;
      lastDropTargetIdRef.current = null;
      if (decision.operation === "inside") {
        setItems(state.roadmap.roadmapItems);
        setPendingBoardPlacement({ activeId: id, parentId: decision.targetId });
        return;
      }
      const move = groupWorkspaceMoveForDrop(dragStartItems, id, `group-${decision.operation}:${decision.targetId}`);
      if (!move) return;
      setItems(previewGroupWorkspaceMove(dragStartItems, id, move));
      try {
        const placed = await api<PlanbanState>(cardPath(boardId, id, `/move`), {
          method: "POST",
          body: JSON.stringify({ ...move, baseRevision: state.roadmap.revision }),
        });
        onStateChange(placed);
        await loadHistory().catch(() => undefined);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "Card reorder failed");
        await refreshState();
      }
      return;
    }

    if (decision.kind === "noop") {
      dragStartItemsRef.current = null;
      lastDropTargetIdRef.current = null;
      setItems(state.roadmap.roadmapItems);
      return;
    }

    if (!columnDropPreview || overId !== columnDropPreview.status) {
      dragStartItemsRef.current = null;
      lastDropTargetIdRef.current = null;
      setItems(state.roadmap.roadmapItems);
      return;
    }

    const targetStatus = statusForDropTarget(dragStartItems, decision.overId);
    dragStartItemsRef.current = null;
    lastDropTargetIdRef.current = null;
    if (!targetStatus) return;

    const nextItems = reorderItemsForDrop(dragStartItems, id, decision.overId);
    const movedItem = nextItems.find((entry) => entry.id === id);
    if (!movedItem) return;
    const scopedItems = nextItems.filter((entry) => entry.parentId === movedItem.parentId && entry.status === movedItem.status);
    const movedIndex = scopedItems.findIndex((entry) => entry.id === id);
    const afterId = movedIndex > 0 ? scopedItems[movedIndex - 1]!.id : null;
    setItems(previewGroupWorkspaceMove(dragStartItems, id, {
      status: movedItem.status,
      parentId: movedItem.parentId ?? null,
      afterId,
    }));

    try {
      const reordered = await api<PlanbanState>(cardPath(boardId, id, `/move`), {
        method: "POST",
        body: JSON.stringify({
          baseRevision: state.roadmap.revision,
          status: movedItem.status,
          parentId: movedItem.parentId,
          afterId,
        }),
      });
      onStateChange(reordered);
      await loadHistory().catch(() => undefined);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Card reorder failed");
      await refreshState();
    }
  }

  function onDragCancel() {
    dragStartItemsRef.current = null;
    lastDropTargetIdRef.current = null;
    setActiveId(null);
    setActiveSize(null);
    setDragOver(null);
    boardDropIntentRef.current = null;
    clearBoardColumnDropPreview();
    boardDropRectsRef.current.clear();
    setBoardDropIntent(null);
    setItems(state.roadmap.roadmapItems);
  }

  async function confirmBoardPlacement(decisionInput:
    | { kind: "move"; status: Status; position: GroupPlacementPosition }
    | { kind: "create"; title: string; summary: string; status: Status }) {
    if (!pendingBoardPlacement) return;
    const active = items.find((entry) => entry.id === pendingBoardPlacement.activeId);
    const parent = items.find((entry) => entry.id === pendingBoardPlacement.parentId);
    if (!active || !parent) return;
    setBoardPlacementBusy(true);
    try {
      const placed = decisionInput.kind === "create"
        ? await api<PlanbanState>(boardPath(boardId, "/groups"), {
            method: "POST",
            body: JSON.stringify({
              title: decisionInput.title,
              summary: decisionInput.summary,
              status: decisionInput.status,
              itemIds: [parent.id, active.id],
              anchorId: parent.id,
              baseRevision: state.roadmap.revision,
            }),
          })
        : await (async () => {
            const decision = groupPlacementDecision(pendingBoardPlacement, decisionInput.status, decisionInput.position);
            if (!decision) throw new Error("Placement is no longer valid.");
            return api<PlanbanState>(cardPath(boardId, decision.activeId, `/move`), {
              method: "POST",
              body: JSON.stringify({ ...decision.move, baseRevision: state.roadmap.revision }),
            });
          })();
      setPendingBoardPlacement(null);
      onStateChange(placed);
      await loadHistory().catch(() => undefined);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Group placement failed");
      await refreshState();
    } finally {
      setBoardPlacementBusy(false);
    }
  }

  if (goalsOpen && !isDemoBoard) {
    return (
      <GoalsPage
        boardId={boardId}
        boardTitle={state.roadmap.project.title}
        viewOnly={viewOnly}
        phone={phone}
        request={api}
        initial={goals}
        onBack={closeGoals}
      />
    );
  }

  if (selectedItem) {
    return (
      <BoardPeopleContext.Provider value={boardPeople.people}>
      <DetailView
        state={activityDetailKind === "group" ? activityDetailState : displayState}
        item={selectedItem}
        boardId={boardId}
        onBack={() => {
          setSelectedId(null);
          setActivityDetailKind(null);
          setActivityDetailEditSerial(0);
        }}
        onStateRefresh={refreshState}
        history={history}
        previewVersion={previewVersion}
        previewEntry={preview?.entry ?? null}
        onSelectVersion={previewHistoryVersion}
        onReturnToCurrent={returnToCurrent}
        onRestoreCard={restoreCardFromPreview}
        onRestoreDoc={restoreDocFromPreview}
        onSelectWorkItem={setSelectedId}
        activity={activityForItem(selectedItem)}
        {...(activityDetailKind ? {
          activityDemoControl: {
            kind: activityDetailKind,
            onFlashAndChange: flashAndChangeActivityDetail,
          },
        } : {})}
      />
      </BoardPeopleContext.Provider>
    );
  }

  return (
    <StalenessContext.Provider value={stalenessCards}>
    <BoardPeopleContext.Provider value={boardPeople.people}>
    <main className={`board-screen ${online.status?.location === "local" && online.status.stale ? "older-copy" : ""}`}>
      {/* One line (owner decision, 16 October 2026): the card stack back to all boards, the
          board's name opening the switcher, and where it lives; then Update (on a computer,
          only when there is one) and the board's tools. */}
      <header className="app-header">
        <div className="board-title-row">
          <TooltipButton label="Your boards" tooltipPlacement="bottom" className="board-home-mark" onClick={() => onSelectBoard(null)}>
            <CardStackMark />
          </TooltipButton>
          <BoardPicker boards={boards} currentRepoId={boardId} onSelectBoard={onSelectBoard} />
          <LocationPill status={online.status} />
        </div>
        <div className="header-controls">
          {!capabilities.hosted && updateStatus?.updateAvailable ? (
            <button
              className="toolbar-button update-available-button"
              onClick={() => {
                setUpdateOpen(true);
                void loadUpdateStatus().catch(() => undefined);
              }}
            >
              <span>Update</span>
            </button>
          ) : null}
          <div className="header-actions">
            <TooltipButton
              label="Search Work Items"
              className="toolbar-icon-button tooltip-below"
              aria-haspopup="dialog"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={15} />
            </TooltipButton>
            <TooltipButton
              label={projection === "main" ? "See all Items" : "Return to Main Board"}
              className={`toolbar-icon-button board-header-tool ${projection === "flattened" ? "active" : ""}`}
              aria-pressed={projection === "flattened"}
              onClick={() => selectProjection(projection === "main" ? "flattened" : "main")}
            >
              {projection === "main" ? <ListTree size={15} /> : <FolderTree size={15} />}
            </TooltipButton>
            <BoardMoreMenu
              {...(!isDemoBoard ? { onOpenGoals: openGoals } : {})}
              {...(!isDemoBoard && online.status ? { onOpenSettings: () => setSettingsOpen(true) } : {})}
              {...(!isDemoBoard && online.status?.signedIn.length ? { onOpenConnections: () => setOnlineScreen("connections") } : {})}
              {...(!capabilities.hosted && online.status?.location === "online" && online.status.url && online.status.boardId ? { webAddress: boardWebAddress(online.status.url, online.status.boardId) } : {})}
              {...(!isDemoBoard ? { onOpenHistory: () => setBoardHistoryOpen(true) } : {})}
              {...(capabilities.tutorial ? { onOpenTutorial: () => openTutorial("first-run", isDemoBoard ? null : boardId) } : {})}
              onOpenFeedback={() => setFeedbackOpen(true)}
              hasArchivedCards={hasArchivedCards}
              showArchived={showArchived}
              onToggleArchived={() => setShowArchived((value) => !value)}
            />
            {capabilities.hosted ? <AccountMenu /> : null}
          </div>
        </div>
      </header>
      {capabilities.hosted ? <JoinedNote /> : null}
      {!capabilities.hosted && state.planbanBehind ? (
        <div className="older-copy-banner planban-behind-banner" role="status">
          <Info size={16} />
          <div className="grow">
            <b>Your Planban is behind this board</b>
            <p>{state.planbanBehind.notice}</p>
          </div>
          <div className="acts">
            <button className="online-board-button primary-accent" onClick={() => { setUpdateOpen(true); void loadUpdateStatus().catch(() => undefined); }}>Update</button>
          </div>
        </div>
      ) : null}
      {capabilities.olderCopyCheck ? <OlderCopyBanner repoId={boardId} boardTitle={state.roadmap.project.title} status={online.status} reload={online.reload} /> : null}

      {isActivityLab ? (
        <ActivityLabPanel
          mode={activityDemo.mode}
          cards={activityLabRootCards}
          changedCardTitle={activityChangedCardTitle}
          onModeChange={(mode) => {
            setActivityChangedCardTitle(null);
            activityDemo.setMode(mode);
          }}
          onFlashAndChange={flashAndChangeActivityCard}
          onOpenDetail={openActivityDetail}
        />
      ) : null}

      {feedbackOpen ? <FeedbackModal state={state} onClose={() => setFeedbackOpen(false)} /> : null}
      {settingsOpen && online.status ? (
        <BoardSettingsModal repoId={boardId} boardTitle={state.roadmap.project.title} status={online.status} reload={online.reload}
          onManagePeople={() => { setSettingsOpen(false); setOnlineScreen("people"); }} onClose={() => setSettingsOpen(false)} />
      ) : null}
      {onlineScreen === "people" ? <PeopleModal repoId={boardId} boardTitle={state.roadmap.project.title} onInvite={() => setOnlineScreen("invite")} onClose={() => { setOnlineScreen(null); void boardPeople.reload(); }} /> : null}
      {onlineScreen === "invite" ? <InviteModal repoId={boardId} boardTitle={state.roadmap.project.title} onClose={() => setOnlineScreen("people")} /> : null}
      {onlineScreen === "connections" ? <ConnectionsModal onClose={() => setOnlineScreen(null)} /> : null}
      {boardHistoryOpen ? (
        <BoardHistoryModal
          history={history}
          previewVersion={previewVersion}
          onSelectVersion={previewHistoryVersion}
          onReturnToCurrent={returnToCurrent}
          onClose={() => setBoardHistoryOpen(false)}
        />
      ) : null}
      {updateOpen ? (
        <UpdateModal
          state={state}
          status={updateStatus}
          postUpdateVersion={postUpdateVersion}
          onClose={() => {
            setUpdateOpen(false);
            setPostUpdateVersion(null);
          }}
        />
      ) : null}

      {searchOpen ? (
        <WorkItemSearchModal
          items={items}
          onClose={() => setSearchOpen(false)}
          onSelect={(id) => setSelectedId(id)}
        />
      ) : null}

      {pendingBoardPlacement ? (() => {
        const active = items.find((entry) => entry.id === pendingBoardPlacement.activeId);
        const parent = items.find((entry) => entry.id === pendingBoardPlacement.parentId);
        return active && parent ? (
          <GroupPlacementModal
            active={active}
            parent={parent}
            items={items}
            busy={boardPlacementBusy}
            onClose={() => { if (!boardPlacementBusy) setPendingBoardPlacement(null); }}
            onConfirm={(decision) => void confirmBoardPlacement(decision)}
          />
        ) : null;
      })() : null}

      {!isActivityLab && shouldOfferFirstRunTutorial({ progress: tutorialProgress, boardKind, isPreviewing }) ? (
        <FirstRunPrompt onDismiss={() => setTutorialProgress("skipped")} />
      ) : null}

      {queryError ? <section className="query-error" role="alert"><span>{queryError}</span><button onClick={clearQuery}>Clear invalid query</button></section> : null}

      {preview ? (
        <section className="history-preview-banner">
          <div>
            <b>Viewing v{preview.version}</b>
            <span>
              {preview.entry ? `${formatHistoryTime(preview.entry.createdAt)} · ${preview.entry.summary}` : "Historical board snapshot"}
            </span>
          </div>
          <button onClick={returnToCurrent}>Close preview</button>
          {!viewOnly ? (
            <button className="primary" onClick={restoreBoardFromPreview}>
              Restore board state
            </button>
          ) : null}
        </section>
      ) : null}

      {!isDemoBoard && goals ? <GoalsStrip goals={goals.goals} phone={phone} onOpen={openGoals} /> : null}
      {queryActive ? (
        <section className="query-results" aria-label="Filtered Work Items">
          <header><div><span>Query results</span><b>{queryResult.matches.length} matching {queryResult.matches.length === 1 ? "Work Item" : "Work Items"}</b><small>WIP {queryResult.wip} · {queryResult.context.length} muted {queryResult.context.length === 1 ? "ancestor" : "ancestors"}</small></div><button onClick={clearQuery}>Clear</button></header>
          <div className="query-result-list">
            {queryResult.visible.map((entry) => (
              <article key={entry.item.id} className={`query-result ${entry.kind === "context" ? "context" : ""}`} style={{ marginLeft: `${Math.min(entry.ancestry.length, 8) * 22}px` }}>
                <button onClick={() => entry.kind === "context" && entry.item.isGroup ? openGroup(entry.item.id) : setSelectedId(entry.item.id)}>
                  <span className="query-result-title">{entry.item.title}</span>
                  <span className="query-result-meta">{entry.kind === "context" ? "Ancestor context" : labels[entry.item.status]}{entry.item.isGroup ? " · Group" : ""}</span>
                  {entry.ancestry.length ? <span className="query-result-ancestry">{entry.ancestry.map((ancestor) => ancestor.title).join(" › ")}</span> : null}
                </button>
              </article>
            ))}
            {queryResult.matches.length === 0 ? <div className="query-empty">No Work Items match this query.</div> : null}
          </div>
        </section>
      ) : <>
      {phone ? <PhoneStatusTabs statuses={visibleStatuses} counts={Object.fromEntries(visibleStatuses.map((status) => [status, grouped[status].length]))} /> : null}
      <DndContext
        sensors={sensors}
        collisionDetection={isFlattenedRoot ? boardCollisionDetection : hierarchyCollisionDetection}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div
          ref={boardGridRef}
          className="board-grid"
          style={{ gridTemplateColumns: visibleStatuses.map((status) => (collapsed[status] ? "72px" : "minmax(280px, 1fr)")).join(" ") }}
        >
          {visibleStatuses.map((status) => (
            <Column
              key={status}
              status={status}
              items={grouped[status]}
              collapsed={!phone && collapsed[status] === true}
              cardsHidden={hiddenCards[status] === true}
              highlighted={dragOver === status}
              onToggleCollapsed={() => setCollapsed((value) => ({ ...value, [status]: !value[status] }))}
              onToggleCards={() => setHiddenCards((value) => ({ ...value, [status]: !value[status] }))}
              onSelect={setSelectedId}
              onCopyReference={(item) => copyWorkItemReference(state, item)}
              onMove={moveItem}
              onDelete={deleteItem}
              readOnly={isPreviewing || viewOnly}
              groupRollups={isFlattenedRoot ? new Map() : groupRollups}
              onOpenGroup={openGroup}
              expandedGroupIds={isFlattenedRoot ? new Set() : expandedGroupIds}
              {...(!isFlattenedRoot ? { onToggleGroupExpanded: (id: string) => setExpandedGroupIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }) } : {})}
              allItems={items}
              dropIntent={isFlattenedRoot ? null : boardDropIntent}
              crossColumnDropPreview={crossColumnDropPreview}
              receiverDragHeight={activeSize?.height ?? null}
              {...(isFlattenedRoot ? { ancestryById: flattened.ancestryById } : {})}
              activityForItem={activityForItem}
              {...(status === "archived" && showArchived ? { onHideArchived: () => setShowArchived(false) } : {})}
            />
          ))}
        </div>
        {containmentTarget && containmentCue && activeItem ? (
          <div className="visually-hidden" role="status" aria-live="polite">
            {containmentCue.label}: {activeItem.title} with {containmentTarget.title}. {containmentCue.detail}.
          </div>
        ) : null}
        <DragOverlay>
          {activeId ? (
            <div
              className={`hierarchy-drag-overlay-shell ${containmentTarget ? "hierarchy-drag-card-docking" : ""}`}
              style={activeSize ?? undefined}
            >
              <article className={`card drag-card ${activeItem?.nextAction || activeItem?.summary ? "" : "compact"}`}>
                {activeItem ? containmentTarget ? (
                  <div className="hierarchy-drag-card-docking-content" title={activeItem.title}>
                    {activeItem.title}
                  </div>
                ) : <CardContent item={activeItem} rollup={groupRollups.get(activeItem.id)} /> : null}
              </article>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      </>}
    </main>
    </BoardPeopleContext.Provider>
    </StalenessContext.Provider>
  );
}

function BoardDashboard({
  boards,
  onSelectBoard,
  onBoardsChanged,
}: {
  boards: BoardRecord[];
  onSelectBoard: (repoId: string) => void;
  onBoardsChanged: () => Promise<void>;
}) {
  const [showArchivedBoards, setShowArchivedBoards] = useState(() => readBoardDashboardPreferences().showArchivedBoards === true);
  const [pendingAction, setPendingAction] = useState<{ kind: "archive" | "delete"; board: BoardRecord } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [busyAction, setBusyAction] = useState<"archive" | "delete" | "restore" | null>(null);
  const [newBoardOpen, setNewBoardOpen] = useState(false);
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string; detail?: string } | null>(null);
  const boardActionDialogRef = useDialogFocus<HTMLElement>(Boolean(pendingAction));
  const activeBoards = boards.filter((board) => !board.archivedAt);
  const archivedBoards = boards.filter((board) => board.archivedAt);
  const visibleBoards = showArchivedBoards ? archivedBoards : activeBoards;

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (showArchivedBoards && archivedBoards.length === 0) {
      setShowArchivedBoards(false);
    }
  }, [archivedBoards.length, showArchivedBoards]);

  useEffect(() => {
    writeBoardDashboardPreferences({
      showArchivedBoards: archivedBoards.length > 0 ? showArchivedBoards : false,
    });
  }, [archivedBoards.length, showArchivedBoards]);

  useEffect(() => {
    if (!pendingAction) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyAction) closeBoardActionModal();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busyAction, pendingAction]);

  function closeBoardActionModal() {
    setPendingAction(null);
    setDeleteConfirm("");
  }

  function startBoardAction(kind: "archive" | "delete", board: BoardRecord) {
    setDeleteConfirm("");
    setPendingAction({ kind, board });
  }

  async function restoreWholeBoard(board: BoardRecord) {
    setBusyAction("restore");
    try {
      await api<{ board: BoardRecord }>(`/api/boards/${encodeURIComponent(board.repoId)}/restore`, {
        method: "POST",
        body: "{}",
      });
      await onBoardsChanged();
      setToast({ tone: "success", message: `Restored ${board.title}` });
    } catch (error) {
      setToast({
        tone: "error",
        message: `Could not restore ${board.title}`,
        detail: error instanceof Error ? error.message : "Restore failed.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function confirmBoardAction() {
    if (!pendingAction) return;
    const { kind, board } = pendingAction;
    if (kind === "delete" && deleteConfirm !== board.repoId) return;
    setBusyAction(kind);
    try {
      if (kind === "archive") {
        await api<{ board: BoardRecord }>(`/api/boards/${encodeURIComponent(board.repoId)}/archive`, {
          method: "POST",
          body: "{}",
        });
        await onBoardsChanged();
        setToast({ tone: "success", message: `Archived ${board.title}` });
      } else {
        const result = await api<{ repoId: string; backupPath: string | null }>(`/api/boards/${encodeURIComponent(board.repoId)}`, {
          method: "DELETE",
          body: JSON.stringify({ confirmRepoId: board.repoId }),
        });
        await onBoardsChanged();
        setToast({
          tone: "success",
          message: `Deleted ${board.title}`,
          detail: result.backupPath ? "Backup saved locally." : "No local planning root existed to back up.",
        });
      }
      closeBoardActionModal();
    } catch (error) {
      setToast({
        tone: "error",
        message: kind === "archive"
          ? `Could not archive ${board.title}`
          : `Could not delete ${board.title}`,
        detail: error instanceof Error ? error.message : "Board action failed.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <main className="board-dashboard">
      <header className="app-header">
        <div>
          <picture className="dashboard-wordmark">
            <source srcSet="/assets/planban-logo-wordmark-white.svg" media="(prefers-color-scheme: dark)" />
            <img src="/assets/planban-logo-wordmark-black.svg" alt="Planban" />
          </picture>
          <h1>Boards</h1>
        </div>
        {archivedBoards.length > 0 ? (
          <button
            className={`archive-toggle ${showArchivedBoards ? "active" : ""}`}
            aria-pressed={showArchivedBoards}
            onClick={() => setShowArchivedBoards((value) => !value)}
          >
            <span>Archive</span>
            <span className="archive-switch" aria-hidden="true">
              <span className="archive-switch-knob" />
            </span>
          </button>
        ) : null}
        {capabilities.hosted ? (
          <button className="primary" onClick={() => setNewBoardOpen(true)}><Plus size={14} /> New board</button>
        ) : null}
      </header>
      {newBoardOpen ? (
        <NewBoardModal onClose={() => setNewBoardOpen(false)} onCreated={(repoId) => {
          setNewBoardOpen(false);
          void onBoardsChanged().then(() => onSelectBoard(repoId));
        }} />
      ) : null}
      <section className="board-list">
        {visibleBoards.length > 0 ? (
          visibleBoards.map((board) => (
            <article key={board.repoId} className={`board-list-item ${board.archivedAt ? "archived" : ""}`}>
              <button className="board-list-open" onClick={() => onSelectBoard(board.repoId)} disabled={Boolean(board.archivedAt)}>
                <span>
                  <span className="board-list-title-row">
                    <b>{board.title}</b>
                    {board.kind === "demo" ? <small className="board-kind-pill">Demo</small> : null}
                    {board.archivedAt ? <small className="board-kind-pill">Archived</small> : null}
                  </span>
                  {capabilities.projectFolders ? <small>{board.cwd}</small> : null}
                </span>
                <small>{board.repoId}</small>
              </button>
              {capabilities.projectFolders ? <span className="board-list-actions">
                {board.archivedAt ? (
                  <TooltipButton
                    label={`Restore ${board.title}`}
                    tooltipPlacement="top"
                    className="board-list-action-button"
                    onClick={() => void restoreWholeBoard(board)}
                  >
                    <RotateCcw size={14} />
                  </TooltipButton>
                ) : (
                  <TooltipButton
                    label={`Archive ${board.title}`}
                    tooltipPlacement="top"
                    className="board-list-action-button"
                    onClick={() => startBoardAction("archive", board)}
                  >
                    <Archive size={14} />
                  </TooltipButton>
                )}
                <TooltipButton
                  label={`Delete ${board.title}`}
                  tooltipPlacement="top"
                  className="board-list-action-button danger"
                  onClick={() => startBoardAction("delete", board)}
                >
                  <Trash2 size={14} />
                </TooltipButton>
              </span> : null}
            </article>
          ))
        ) : (
          <div className="empty-boards">
            <h2>{showArchivedBoards ? "No archived boards" : "No Planban boards registered yet"}</h2>
            <p>
              {showArchivedBoards
                ? "Archived boards will appear here when you hide boards from your normal list."
                : "Open Planban from a project or initialize a repo to add it to this device."}
            </p>
          </div>
        )}
      </section>
      {pendingAction ? (
        <div className="modal-backdrop board-action-backdrop" role="presentation" onMouseDown={() => {
          if (!busyAction) closeBoardActionModal();
        }}>
          <section
            ref={boardActionDialogRef}
            className="board-action-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="board-action-title"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="feedback-modal-header">
              <div>
                <p className="eyebrow">
                  {pendingAction.kind === "archive"
                    ? "Archive board"
                    : "Delete board"}
                </p>
                <h2 id="board-action-title">
                  {pendingAction.kind === "archive"
                    ? pendingAction.board.kind === "demo"
                      ? "Remove this demo board?"
                      : `Archive ${pendingAction.board.title}?`
                    : `Delete ${pendingAction.board.title}?`}
                </h2>
              </div>
              <TooltipButton label="Close" className="toolbar-icon-button" onClick={closeBoardActionModal} disabled={Boolean(busyAction)}>
                <X size={14} />
              </TooltipButton>
            </header>
            <div className="board-action-modal-body">
              {pendingAction.kind === "archive" ? (
                <>
                  <p>Archive hides this board from your normal board list while keeping its local Planban state intact.</p>
                  <p>You can restore it later from the archived boards view.</p>
                </>
              ) : (
                <>
                  <p>Delete removes this board from Planban after creating a timestamped local backup.</p>
                  <p>Planban will not delete the source project repository.</p>
                  <label className="board-delete-confirm">
                    <span>Type <b>{pendingAction.board.repoId}</b> to confirm.</span>
                    <input
                      autoFocus
                      value={deleteConfirm}
                      onChange={(event) => setDeleteConfirm(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && deleteConfirm === pendingAction.board.repoId && !busyAction) {
                          event.preventDefault();
                          void confirmBoardAction();
                        }
                      }}
                      placeholder={pendingAction.board.repoId}
                      disabled={busyAction === "delete"}
                    />
                  </label>
                </>
              )}
            </div>
            <footer className="feedback-actions">
              <button onClick={closeBoardActionModal} disabled={Boolean(busyAction)}>Cancel</button>
              <button
                className={`board-action-confirm ${pendingAction.kind === "delete" ? "danger primary" : "archive primary"}`}
                onClick={() => void confirmBoardAction()}
                disabled={Boolean(busyAction) || (pendingAction.kind === "delete" && deleteConfirm !== pendingAction.board.repoId)}
              >
                {busyAction === pendingAction.kind
                  ? <Loader2 size={14} className="spin" />
                  : pendingAction.kind === "archive"
                    ? <Archive size={14} />
                    : <Trash2 size={14} />}
                {pendingAction.kind === "archive"
                  ? "Archive"
                  : "Delete board"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {toast ? (
        <div className={`toast ${toast.tone}`} role="status" aria-live="polite">
          <b>{toast.message}</b>
          {toast.detail ? <span>{toast.detail}</span> : null}
        </div>
      ) : null}
    </main>
  );
}

function Onboarding({ onReady }: { onReady: (state: PlanbanState) => void }) {
  const [busy, setBusy] = useState(false);
  async function enable() {
    setBusy(true);
    try {
      onReady(await api<PlanbanState>("/api/init", { method: "POST", body: "{}" }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="onboarding">
      <div className="onboarding-copy">
        <p className="eyebrow">Project planning protocol</p>
        <h1>Enable Planban for this repo</h1>
        <p>
          Planban will create repo-local discovery files and a device-local board so Codex and you
          can work from the same roadmap.
        </p>
        <button className="primary large" onClick={enable} disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : null}
          Enable Planban
        </button>
      </div>
      <div className="ghost-board">
        {statuses.filter((status) => status !== "archived").map((status) => (
          <section key={status}>
            <b>{labels[status]}</b>
            <span />
            <span />
          </section>
        ))}
      </div>
    </main>
  );
}

function App() {
  const [state, setState] = useState<PlanbanState | null>(null);
  const [boards, setBoards] = useState<BoardRecord[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState<SignedOut | null>(null);
  const [activities, setActivities] = useState<PlanbanActivitySnapshot[]>([]);
  const appLoadRequestRef = useRef(0);
  const boardLoadRequestRef = useRef(0);
  const selectedRepoIdRef = useRef<string | null>(selectedRepoId);
  const liveVersionRef = useRef<Pick<LiveSnapshot, "stateVersion" | "boardsVersion"> | null>(null);

  useEffect(() => {
    selectedRepoIdRef.current = selectedRepoId;
  }, [selectedRepoId]);

  const selectBoard = useCallback((repoId: string | null) => {
    appLoadRequestRef.current += 1;
    boardLoadRequestRef.current += 1;
    pushBoardPath(repoId);
    setSelectedRepoId(repoId);
    setState(null);
  }, []);

  const loadSelectedBoard = useCallback(async (repoId: string, preserveCurrentOnError = false) => {
    const requestId = ++boardLoadRequestRef.current;
    try {
      const nextState = await api<PlanbanState>(boardPath(repoId, "/state"), undefined, 5_000);
      if (requestId !== boardLoadRequestRef.current) return null;
      const routeRepoId = repoIdFromPath();
      if (routeRepoId !== repoId && selectedRepoIdRef.current !== repoId) return null;
      setState(nextState);
      setError(null);
      setSignedOut(null);
      return nextState;
    } catch (loadError) {
      if (requestId === boardLoadRequestRef.current && !preserveCurrentOnError) {
        const needed = (loadError as { signedOut?: SignedOut } | null)?.signedOut;
        setSignedOut(needed ?? null);
        if (!needed) setError(loadError instanceof Error ? loadError.message : "Failed to load the Board");
      }
      return null;
    }
  }, []);

  const load = useCallback(async (preserveCurrentOnError = false) => {
    // The web's own screens (sign-in, invitations, approvals) load what they need themselves.
    if (capabilities.hosted && webScreen()) return;
    const requestId = ++appLoadRequestRef.current;
    try {
      const [status, boardsPayload] = await Promise.all([
        api<{ initialized: boolean; currentRepoId: string | null }>("/api/status", undefined, 5_000),
        api<BoardsPayload>("/api/boards?includeArchived=true", undefined, 5_000),
      ]);
      if (requestId !== appLoadRequestRef.current) return;
      setInitialized(status.initialized);
      setBoards(boardsPayload.boards);
      if (capabilities.tutorial && isTutorialPath()) {
        selectedRepoIdRef.current = null;
        setSelectedRepoId(null);
        setState(null);
        return;
      }
      const routeRepoId = repoIdFromPath();
      const activeBoards = boardsPayload.boards.filter((board) => !board.archivedAt);
      const nextRepoId = isBoardDashboardPath()
        ? null
        : routeRepoId ?? selectedRepoIdRef.current ?? status.currentRepoId ?? null;
      if (nextRepoId) {
        if (!activeBoards.some((board) => board.repoId === nextRepoId)) {
          replaceBoardPath(null);
          selectedRepoIdRef.current = null;
          setSelectedRepoId(null);
          setState(null);
          return;
        }
        replaceBoardPath(nextRepoId);
        selectedRepoIdRef.current = nextRepoId;
        setSelectedRepoId(nextRepoId);
      } else {
        selectedRepoIdRef.current = null;
        setSelectedRepoId(null);
        setState(null);
      }
    } catch (loadError) {
      if (preserveCurrentOnError) return;
      // Signed out on the web: the board address stays, and the signed-out screen offers Log in.
      // On a computer too, when the address names a board (its project's board needs a sign-in, or another account's).
      const needed = (loadError as { signedOut?: SignedOut } | null)?.signedOut;
      if (needed && (capabilities.hosted || repoIdFromPath())) {
        const routeRepoId = repoIdFromPath();
        selectedRepoIdRef.current = routeRepoId;
        setSelectedRepoId(routeRepoId);
        setSignedOut(needed);
        return;
      }
      setError(loadError instanceof Error ? loadError.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // On the web, live updates come from the service instead (below).
    if (!state || capabilities.hosted) return;
    let stopped = false;
    let pollTimer: number | null = null;
    const poll = async () => {
      try {
        const watchedRepoId = selectedRepoIdRef.current;
        const snapshot = await api<LiveSnapshot>(watchedRepoId ? `/api/live?repoId=${encodeURIComponent(watchedRepoId)}` : "/api/live", undefined, 3_000);
        if (stopped) return;
        setActivities(snapshot.activities);
        const previous = liveVersionRef.current;
        liveVersionRef.current = {
          stateVersion: snapshot.stateVersion,
          boardsVersion: snapshot.boardsVersion,
        };
        const decision = liveRefreshDecision(previous, snapshot);
        if (decision.refreshBoards) {
          await load(true);
        }
        const currentRepoId = selectedRepoIdRef.current;
        if (decision.refreshSelectedBoard && currentRepoId) {
          await loadSelectedBoard(currentRepoId, true);
        }
      } catch {
        // A transient live-update failure must not replace an already loaded Board.
      } finally {
        if (!stopped) pollTimer = window.setTimeout(poll, document.hidden ? 750 : 200);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [load, loadSelectedBoard, Boolean(state)]);

  // On the web: the board's revision arrives over the service's live
  // connection, and the board reloads only when it differs from what's shown.
  useKeyboardInset();
  const shownRevisionRef = useRef<number | null>(null);
  shownRevisionRef.current = state?.roadmap.revision ?? null;
  const [liveEpoch, setLiveEpoch] = useState(0);
  const watchedBoard = hostedAdapter && state ? state.manifest.repoId : null;
  useEffect(() => {
    const adapter = hostedAdapter;
    if (!adapter || !watchedBoard) return;
    const boardId = watchedBoard;
    const known = shownRevisionRef.current;
    const watch = watchHostedBoard({
      boardId,
      ...(known === null ? {} : { knownRevision: known }),
      liveToken: () => adapter.liveToken(),
      revision: (id) => adapter.revision(id),
      onRevision: (revision) => {
        if (selectedRepoIdRef.current !== boardId || revision === shownRevisionRef.current) return;
        void loadSelectedBoard(boardId, true);
      },
      onLost: () => {
        if (selectedRepoIdRef.current !== boardId) return;
        // Reloading shows why (signed out, or no longer on this board); a board that still loads is watched again.
        void loadSelectedBoard(boardId).then((next) => {
          if (next) setLiveEpoch((epoch) => epoch + 1);
        });
      },
    });
    return () => watch.close();
  }, [watchedBoard, liveEpoch, loadSelectedBoard]);

  // On the web, the board list is rechecked when the page regains focus.
  useEffect(() => {
    if (!capabilities.hosted) return;
    const recheck = () => {
      if (!document.hidden) void load(true);
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [load]);

  useEffect(() => {
    const onPopState = () => {
      const next = repoIdFromPath();
      // Only the "#card=" part changed (a card link on the open board): the board itself stays.
      if (next !== null && next === selectedRepoIdRef.current && cardIdFromHash(window.location.hash)) return;
      setSelectedRepoId(next);
      setState(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadSelectedBoard]);

  useEffect(() => {
    // A signed-out screen belongs to the board that showed it.
    setSignedOut(null);
    if (!selectedRepoId) return;
    void loadSelectedBoard(selectedRepoId);
  }, [loadSelectedBoard, selectedRepoId]);

  const screen = capabilities.hosted ? webScreen() : null;
  if (screen === "sign-in") return <SignInPage />;
  if (screen === "invite") return <InvitePage onOpenBoard={(boardId) => window.location.assign(`/boards/${encodeURIComponent(boardId)}`)} />;
  if (screen === "approve") return <ApprovePage />;
  if (signedOut && !selectedRepoId && capabilities.hosted) {
    // Signed out on the web away from a board, such as on the board list.
    return <SignedOutScreen signedOut={signedOut} onSignedIn={() => void load()} />;
  }
  if (signedOut && selectedRepoId) {
    const repoId = selectedRepoId;
    // Keyed by board, so a sign-in started on another board's screen can't finish on this one.
    return <SignedOutScreen key={repoId} signedOut={signedOut} onSignedIn={() => {
      if (selectedRepoIdRef.current !== repoId) return;
      setSignedOut(null);
      // Start-up may have stopped at this board, before the list of boards loaded.
      if (initialized === null) void load(true);
      void loadSelectedBoard(repoId);
    }} />;
  }
  if (error) {
    return (
      <main className="error-screen">
        <div className="load-error-card">
          <p>{error}</p>
          <button
            className="primary"
            onClick={() => {
              setError(null);
              setState(null);
              void load();
            }}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }
  if (capabilities.tutorial && isTutorialPath()) return <TutorialPage onSelectBoard={selectBoard} />;
  if (capabilities.hosted && !selectedRepoId) {
    if (initialized === null) return <main className="loading-screen">Loading Planban...</main>;
    return <HostedDashboard boards={boards} onSelectBoard={selectBoard} onBoardsChanged={load} />;
  }
  if (!selectedRepoId && boards.length > 0) return <BoardDashboard boards={boards} onSelectBoard={selectBoard} onBoardsChanged={load} />;
  if (initialized === false && boards.length === 0) {
    return (
      <Onboarding
        onReady={(next) => {
          setState(next);
          setBoards([
            {
              repoId: next.manifest.repoId,
              title: next.roadmap.project.title,
              cwd: next.cwd,
              planningRoot: next.planningRoot,
              roadmapPath: next.roadmapPath,
              manifestPath: next.manifestPath,
              lastOpenedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ]);
          setSelectedRepoId(next.manifest.repoId);
          replaceBoardPath(next.manifest.repoId);
        }}
      />
    );
  }
  if (!selectedRepoId && boards.length === 0) return <BoardDashboard boards={boards} onSelectBoard={selectBoard} onBoardsChanged={load} />;
  if (!state) return <main className="loading-screen">Loading Planban...</main>;
  return <BoardView state={state} boards={boards.filter((board) => !board.archivedAt)} activities={activities} onStateChange={setState} onSelectBoard={selectBoard} />;
}

createRoot(document.getElementById("root")!).render(<App />);
