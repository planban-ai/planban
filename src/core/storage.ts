import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ensureHistoryBaseline,
  recordHistoryVersion,
  resolveHistoryDoc,
  restoreCardFromHistory,
  restoreRoadmapFromHistory,
  type PlanbanHistoryMeta,
} from "./history";
import {
  agentContextPath,
  defaultPlanningRoot,
  defaultRepoId,
  eventsPath,
  expandHome,
  itemRoot,
  historyDocPath,
  historyRoot,
  manifestPath,
  resolveInsideRoot,
  slugify,
  protocolDir,
  hasLiveRoadmap,
  isRetiredRoadmap,
  roadmapPath,
} from "./paths";
import { planbanCommand } from "./command";
import { appendLineDurably, atomicWriteFile, idempotencyFingerprint, runIdempotentBoardMutation, withBoardWriteLock } from "./persistence";
import { buildAgentContext, PLANBAN_INSTALL_URL } from "./protocol";
import { resolvePlanbanProjectDir } from "../../plugins/planban/scripts/project-dir.mjs";
import { registerBoardFromState } from "./registry";
import { manifestSchema, roadmapSchema } from "./schema";
import type {
  PlanbanDocPayload,
  PlanbanProjectManifest,
  PlanbanResolvedState,
  PlanbanRoadmap,
  PlanbanRoadmapItem,
  PlanbanStatus,
  PlanbanHistoryActor,
} from "./types";
import { PLANBAN_STATUSES } from "./types";
import { currentVersionInfo } from "./version";
import { flattenRoadmapForVersion1, hierarchyRecoveryManifest } from "./hierarchyMigration";
import { loadOnlineState, onlineCacheRoot, onlineOperation, onlineState, refuseOnline } from "./online/adapter";
import { boardPath, onlineRequest } from "./online/client";
import { cardSubject, changesSince, conflictMessage, lastDocChange, MAX_CONFLICT_DOCUMENT_CHARS, PlanbanEditConflictError, RECONCILE, type ConflictDetails } from "./conflicts";
import { editSection, sectionList } from "./docSections";
import { assertNotStaleCopy, checkInBackground, ONLINE_NOTE, STALE_MARKER } from "./online/copyCheck";
import { credentialsPath } from "./online/credentials";
import { ensureBoardIdentity } from "./boardIdentity";
import type { PlanbanHistoryPayload } from "./types";
import { assertCardsHoldNoFiles, cardFolder, cardsHoldingFiles, PlanbanCardHoldsFilesError } from "./cardFiles";
import { checkIndexCard, checkIndexDocument, checkIndexText, checkIndexValue, MAX_DETAILS_BYTES } from "./contentRules";
import { appName } from "./agentNames";
import { addSuggestion, applyGoalEdit, assertGoalsSize, decideSuggestion, emptyGoals, goalsBlock, goalsPage, normalizeGoals, PEOPLE_ONLY, type GoalsFile, type GoalsPage } from "./goals";

import { assertCompletionConfirmed,
  assertBaseRevision as assertRoadmapBaseRevision,
  assertCommittable,
  committedRoadmap,
  createEmptyRoadmap as createEmptyRoadmapAt,
  normalizeColumnPriorities,
  normalizeRoadmap,
  PlanbanBoardMovedError,
  PlanbanConflictError,
  PlanbanNotFoundError,
  PlanbanValidationError,
  planCreateCard,
  planCreateCards,
  planCreateGroup,
  planDeleteArchivedCard,
  planMoveCard,
  planReorderCards,
  planUpdateCard,
  planWriteDoc,
  type PlanbanCreateCardPosition,
  type PlannedChange,
} from "./boardOperations";

export {
  assertRoadmapRelations,
  cardAncestry,
  defaultColumns,
  normalizeRoadmap,
  PlanbanBoardMovedError,
  PlanbanConflictError,
  PlanbanNotFoundError,
  PlanbanValidationError,
  type PlanbanCreateCardPosition,
} from "./boardOperations";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A stale edit is refused with what changed since, who changed it on this
 * computer, and the card as it is now, as on an online board (owner
 * requirement, 15 October 2026).
 */
async function assertBaseRevision(state: PlanbanResolvedState, baseRevision?: number, cardId?: string, actor?: string) {
  if (baseRevision === undefined || baseRevision === state.roadmap.revision) return assertRoadmapBaseRevision(state.roadmap, baseRevision);
  // An invalid number is still a validation error.
  assertRoadmapBaseRevision({ ...state.roadmap, revision: baseRevision }, baseRevision);
  const { listHistory } = await import("./history");
  const entries = (await listHistory(state).catch(() => null))?.entries ?? [];
  const conflict: ConflictDetails = {
    currentRevision: state.roadmap.revision, yourRevision: baseRevision,
    changes: changesSince(entries, baseRevision, localAuthor),
    ...(cardId ? { card: state.roadmap.roadmapItems.find((item) => item.id === cardId) ?? null } : {}),
  };
  throw new PlanbanEditConflictError(conflictMessage(cardSubject(state.roadmap, cardId), conflict, actor === "agent"), conflict);
}

/** A Spec or Plan changed since it was read: the document as it is now, and who last changed it. */
async function documentConflict(state: PlanbanResolvedState, cardId: string, kind: "spec" | "plan", document: NonNullable<ConflictDetails["document"]>, actor?: string) {
  const { listHistory } = await import("./history");
  const entries = (await listHistory(state).catch(() => null))?.entries ?? [];
  const conflict: ConflictDetails = { currentRevision: state.roadmap.revision, changes: changesSince(lastDocChange(entries, cardId, kind), undefined, localAuthor), document };
  return new PlanbanEditConflictError(conflictMessage(`the ${kind === "spec" ? "Spec" : "Plan"} of ${cardSubject(state.roadmap, cardId)}`, conflict, actor === "agent"), conflict);
}

/** Who made a change on a local board, as a person would say it. */
function localAuthor(entry: { actor: string }) {
  return entry.actor === "agent" ? "an agent on this computer" : entry.actor === "user" ? "someone on this computer" : "Planban";
}

// Fields that only record a card's place or the time it was touched. Renumbering
// them when other cards move is not a change to the card.
const PLACEMENT_ONLY_FIELDS = new Set(["priority", "boardRank", "groupRank", "updatedAt"]);

function cardContent(item: PlanbanRoadmapItem) {
  return JSON.stringify(Object.entries(item).filter(([key]) => !PLACEMENT_ONLY_FIELDS.has(key)).sort(([a], [b]) => a.localeCompare(b)));
}

/** Cards a roadmap write adds, changes beyond placement, or removes. */
function changedCards(before: PlanbanRoadmap, after: PlanbanRoadmap) {
  const previous = new Map(before.roadmapItems.map((item) => [item.id, item]));
  const nextIds = new Set(after.roadmapItems.map((item) => item.id));
  return {
    written: after.roadmapItems.filter((item) => {
      const old = previous.get(item.id);
      return !old || cardContent(old) !== cardContent(item);
    }),
    removed: before.roadmapItems.filter((item) => !nextIds.has(item.id)),
  };
}

/**
 * Cards a write repositions within their column: the fewest cards whose moves explain the new order
 * (the longest common subsequence of old and new orders stays put). Where several explanations are
 * equally short, `pinned` cards are the ones left in place, so a card dragged past a pinned card
 * counts as the one that moved, and renumbering alone never counts.
 */
function repositionedCards(before: PlanbanRoadmap, after: PlanbanRoadmap, pinned: Set<string>): string[] {
  const scopeOf = (item: PlanbanRoadmapItem) => JSON.stringify([item.parentId, item.status]);
  const oldScope = new Map(before.roadmapItems.map((item) => [item.id, scopeOf(item)]));
  const scopes = new Map<string, string[]>();
  for (const item of after.roadmapItems) {
    // Cards that changed column are changes in their own right, checked separately.
    if (oldScope.get(item.id) !== scopeOf(item)) continue;
    scopes.set(scopeOf(item), [...(scopes.get(scopeOf(item)) ?? []), item.id]);
  }
  const moved: string[] = [];
  for (const [scope, newOrder] of scopes) {
    if (!newOrder.some((id) => pinned.has(id))) continue;
    const oldIndex = new Map(before.roadmapItems.filter((item) => scopeOf(item) === scope).map((item, index) => [item.id, index]));
    const positions = newOrder.map((id) => oldIndex.get(id)!);
    // Each card staying put counts n + 1, and a pinned one 1 more, so pinning only breaks ties.
    const weight = (id: string) => newOrder.length + 1 + (pinned.has(id) ? 1 : 0);
    // Heaviest increasing subsequence of old positions, in new order.
    const best = newOrder.map((id) => weight(id));
    const previous = newOrder.map(() => -1);
    for (let i = 0; i < newOrder.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        if (positions[j]! < positions[i]! && best[j]! + weight(newOrder[i]!) > best[i]!) {
          best[i] = best[j]! + weight(newOrder[i]!);
          previous[i] = j;
        }
      }
    }
    const kept = new Set<string>();
    for (let i = best.indexOf(Math.max(...best)); i >= 0; i = previous[i]!) kept.add(newOrder[i]!);
    moved.push(...newOrder.filter((id) => !kept.has(id)));
  }
  return moved;
}

// Planban is an index, not storage (owner decisions 18 and 20): every card a
// write touches must hold only text and must not hold files in its folder.
async function assertIndexWrite(state: PlanbanResolvedState, roadmap: PlanbanRoadmap) {
  const { written, removed } = changedCards(state.roadmap, roadmap);
  for (const card of written) checkIndexCard(card);
  if (JSON.stringify(roadmap.project) !== JSON.stringify(state.roadmap.project)) {
    checkIndexValue(roadmap.project, "the board details", MAX_DETAILS_BYTES);
  }
  await assertCardsHoldNoFiles(state.planningRoot, [...written, ...removed]);
  // Nor may a reorder reposition a card holding files, though other cards may move around it.
  const holding = await cardsHoldingFiles(state.planningRoot, state.roadmap.roadmapItems.map((item) => item.id));
  if (!Object.keys(holding).length) return;
  const moved = repositionedCards(state.roadmap, roadmap, new Set(Object.keys(holding))).find((id) => holding[id]);
  if (moved) {
    const card = state.roadmap.roadmapItems.find((item) => item.id === moved)!;
    throw new PlanbanCardHoldsFilesError({ cardId: card.id, title: card.title, folder: cardFolder(state.planningRoot, card.id), files: holding[moved]! });
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createEmptyRoadmap(input: { repoId: string; title: string }): PlanbanRoadmap {
  return createEmptyRoadmapAt({ ...input, now: nowIso() });
}
export function resolvePlanningRoot(manifest: PlanbanProjectManifest): string {
  if (manifest.storage?.kind === "online") return onlineCacheRoot(manifest.storage);
  return manifest.storage?.root
    ? resolve(expandHome(manifest.storage.root))
    : defaultPlanningRoot(manifest.repoId);
}

export function resolveProjectCwd(cwdInput: string): string {
  return resolvePlanbanProjectDir(cwdInput).projectDir;
}

async function onlineManifest(cwd: string) {
  const manifest = await readManifest(resolveProjectCwd(cwd));
  return manifest?.enabled && manifest.storage?.kind === "online" ? manifest : null;
}

export async function refuseForOnline(cwd: string, operation: string) {
  if (await onlineManifest(cwd)) refuseOnline(operation);
}

export { RETIRED_ROADMAP } from "./paths";

/** Sends a write that met PlanbanBoardMovedError again, to wherever the board lives now. */
export const againIfMoved = <T>(again: () => Promise<T>) => (error: unknown): Promise<T> =>
  error instanceof PlanbanBoardMovedError ? again() : Promise.reject(error);

export async function withRoadmapWriteLock<T>(cwdInput: string, callback: () => Promise<T>): Promise<T> {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest || !manifest.enabled) {
    throw new Error(`Planban is not initialized in ${cwd}`);
  }
  // Every caller is a local write. A project that points online now moved
  // after the caller chose the local path: nothing may run against the
  // online board's cache folder.
  if (manifest.storage?.kind === "online") throw new PlanbanBoardMovedError();
  const planningRoot = resolvePlanningRoot(manifest);
  await guardLocalCopy(planningRoot, cwd, manifest.repoId);
  // A card write takes the board first, before writing anything, so it can
  // give up cleanly if another process is stuck holding the board.
  return withBoardWriteLock(planningRoot, async () => {
    // The board may have moved while this write waited for it: the project
    // now points elsewhere, so nothing is written here.
    if (!(await stillLocalAt(cwd, planningRoot))) throw new PlanbanBoardMovedError();
    return callback();
  }, { giveUp: true });
}

/** Where this project's board is kept on this computer (an online board's cache folder), or null. */
export async function boardPlanningRoot(cwdInput: string): Promise<string | null> {
  const manifest = await readManifest(resolveProjectCwd(cwdInput));
  return manifest?.enabled ? resolvePlanningRoot(manifest) : null;
}

/** True while this project's board is a local board kept at planningRoot. */
export async function stillLocalAt(cwd: string, planningRoot: string): Promise<boolean> {
  const now = await readManifest(cwd);
  return !!now?.enabled && now.storage?.kind !== "online" && resolvePlanningRoot(now) === planningRoot;
}

/**
 * A local copy of a board that was taken online elsewhere refuses writes
 * (owner decision 14). Costs two file checks unless this machine has signed
 * in to an online service, the project has an online note, or the copy is
 * already marked stale.
 */
async function guardLocalCopy(planningRoot: string, cwd: string, repoId: string) {
  if (!(await pathExists(join(planningRoot, STALE_MARKER))) && !(await pathExists(credentialsPath())) && !(await pathExists(join(cwd, ".planban", ONLINE_NOTE)))) return;
  await assertNotStaleCopy(planningRoot, cwd, repoId);
}

async function checkLocalCopyInBackground(planningRoot: string) {
  if (await pathExists(credentialsPath())) checkInBackground(planningRoot);
}

export async function readManifest(cwd: string): Promise<PlanbanProjectManifest | null> {
  const path = manifestPath(cwd);
  if (!(await pathExists(path))) return null;
  return manifestSchema.parse(await readJson(path));
}

export async function loadState(cwdInput: string): Promise<PlanbanResolvedState> {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest || !manifest.enabled) {
    throw new Error(`Planban is not initialized in ${cwd}`);
  }
  if (manifest.storage?.kind === "online") return loadOnlineState(cwd, manifest);

  const planningRoot = resolvePlanningRoot(manifest);
  const liveRoadmapPath = roadmapPath(planningRoot);
  if (!(await hasLiveRoadmap(planningRoot))) {
    throw new Error(await missingRoadmapMessage(cwd, planningRoot));
  }

  const state = {
    cwd,
    manifestPath: manifestPath(cwd),
    agentContextPath: agentContextPath(cwd),
    planningRoot,
    roadmapPath: liveRoadmapPath,
    manifest,
    roadmap: normalizeRoadmap(await readJson(liveRoadmapPath)),
  };
  await ensureHistoryBaseline(state);
  void checkLocalCopyInBackground(planningRoot).catch(() => undefined);
  return state;
}

/** Why a local board has no live roadmap; for one that moved online, where it went and how to follow it. */
async function missingRoadmapMessage(cwd: string, planningRoot: string) {
  const missing = `Planban roadmap is missing at ${roadmapPath(planningRoot)}`;
  // A Take Online that has not finished: the board here is shut until it is finished or stopped.
  const moving = await readFile(join(planningRoot, "online-transfer.json"), "utf8").then((text) => JSON.parse(text) as { direction?: string; url?: string }, () => null);
  if (moving?.direction === "online" && await isRetiredRoadmap(roadmapPath(planningRoot))) {
    return `This board is partway through moving online${moving.url ? ` to ${moving.url}` : ""}, so it can't be changed on this computer: a change here would not reach the online board. Nothing was written. To finish the move, run: ${planbanCommand()} online take-online ${moving.url ?? "<url>"} --cwd "${cwd}". To cancel it instead: ${planbanCommand()} online stop-take-online --cwd "${cwd}".`;
  }
  const note = await readFile(join(planningRoot, "ONLINE-BOARD.txt"), "utf8").catch(() => null);
  if (note === null && !(await isRetiredRoadmap(roadmapPath(planningRoot)))) return missing;
  const moved = /Authority moved to (\S+), board ([^\s.]+)\./.exec(note ?? "");
  const attach = moved ? ` To use it from this folder, run: ${planbanCommand()} online attach ${moved[1]} ${moved[2]} --cwd "${cwd}"` : "";
  return `${missing}: this board moved online${moved ? ` to ${moved[1]}` : ""}, and the files here are kept only for recovery.${attach}`;
}

const AGENTS_BLOCK_START = "<!-- BEGIN PLANBAN -->";
const AGENTS_BLOCK_END = "<!-- END PLANBAN -->";

function buildAgentsBlock(): string {
  return `${AGENTS_BLOCK_START}

This repo uses Planban.

Canonical live planning state is not branch-local: it lives on this device for a local board, or at its online service for an online board.
Read \`.planban/project.json\` and \`.planban/agent-context.md\` before making roadmap or plan updates; the agent context says which applies.
If the user asks to update the roadmap, follow the Planban protocol described there.
If an agent starts implementation work on a roadmap item, move it to In Progress if needed; leave completed agent work In Progress with a review/testing next action until the user explicitly asks to mark it Complete or confirms completion.
If Planban tools (names ending in \`planban_<operation>\`) are unavailable in the current host, tell the user once that Planban is not installed for this host, link ${PLANBAN_INSTALL_URL}, then continue.

${AGENTS_BLOCK_END}`;
}

/**
 * Brings an existing Planban block in AGENTS.md up to date, keeping everything
 * around it; called when a board moves between local and online. A project
 * without the block (never initialised with it, or opted out) is left alone.
 */
export async function refreshAgentsBlock(cwd: string): Promise<boolean> {
  const agentsPath = join(cwd, "AGENTS.md");
  if (!(await pathExists(agentsPath))) return false;
  const existing = await readFile(agentsPath, "utf8");
  if (!existing.includes(AGENTS_BLOCK_START) || !existing.includes(AGENTS_BLOCK_END)) return false;
  const next = upsertManagedBlock(existing, buildAgentsBlock());
  if (next === existing) return false;
  await atomicWriteFile(agentsPath, next);
  return true;
}

function upsertManagedBlock(existing: string, block: string): string {
  const start = existing.indexOf(AGENTS_BLOCK_START);
  const end = existing.indexOf(AGENTS_BLOCK_END);
  if (start >= 0 && end >= start) {
    const suffix = end + AGENTS_BLOCK_END.length;
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(suffix).trim();
    return [before, block, after].filter(Boolean).join("\n\n") + "\n";
  }
  return existing.trimEnd().length > 0 ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

export async function initializeProject(input: {
  cwd: string;
  title?: string | undefined;
  repoId?: string | undefined;
  updateAgents?: boolean | undefined;
}): Promise<PlanbanResolvedState> {
  const cwd = resolve(input.cwd);
  await refuseForOnline(cwd, "Reinitializing an existing board");
  const repoId = input.repoId ?? defaultRepoId(cwd);
  const title = input.title ?? repoId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  checkIndexText(title, "the board title", MAX_DETAILS_BYTES);
  const planningRoot = defaultPlanningRoot(repoId);
  const liveRoadmapPath = roadmapPath(planningRoot);

  return withBoardWriteLock(planningRoot, async () => {
  if (await pathExists(join(planningRoot, "ONLINE-BOARD.txt"))) {
    throw new PlanbanValidationError("This local planning root is an Online Board recovery snapshot. Use online attach or online take-local.");
  }
  const manifest: PlanbanProjectManifest = {
    version: 1,
    repoId,
    enabled: true,
    storage: { kind: "local" },
  };

  await mkdir(protocolDir(cwd), { recursive: true });
  await mkdir(planningRoot, { recursive: true });
  await mkdir(dirname(liveRoadmapPath), { recursive: true });

  await atomicWriteFile(manifestPath(cwd), JSON.stringify(manifest, null, 2) + "\n");
  await ensureBoardIdentity(planningRoot);
  await atomicWriteFile(
    agentContextPath(cwd),
    buildAgentContext({
      planningRoot,
      roadmapPath: liveRoadmapPath,
      manifestPath: manifestPath(cwd),
      repoId,
    }),
  );

  if (!(await pathExists(liveRoadmapPath))) {
    await atomicWriteFile(
      liveRoadmapPath,
      JSON.stringify(createEmptyRoadmap({ repoId, title }), null, 2) + "\n",
    );
  }

  if (input.updateAgents !== false) {
    const agentsPath = join(cwd, "AGENTS.md");
    const existing = (await pathExists(agentsPath)) ? await readFile(agentsPath, "utf8") : "";
    await atomicWriteFile(agentsPath, upsertManagedBlock(existing, buildAgentsBlock()));
  }

  const state = await loadState(cwd);
  await registerBoardFromState(state);
  return state;
  });
}

export async function saveRoadmap(
  state: PlanbanResolvedState,
  roadmap: PlanbanRoadmap,
  history: PlanbanHistoryMeta | false = {
    actor: "user",
    operation: "roadmap.save",
    summary: "Saved roadmap",
    affectedCards: roadmap.roadmapItems.map((item) => item.id),
  },
  /** Set only by a goals change, whose own pending file this write commits. */
  options: { goalsChange?: boolean } = {},
) {
  if (state.manifest.storage?.kind === "online") refuseOnline("Raw roadmap saving");
  await guardLocalCopy(state.planningRoot, state.cwd, state.manifest.repoId);
  return withBoardWriteLock(state.planningRoot, async () => {
  // A goals change that stopped part way is settled before any other write moves the
  // board on, while its history entry is certainly still there to say whether it happened.
  if (!options.goalsChange) await settleGoals(state.planningRoot, await readRoadmapRevision(state.planningRoot).catch(() => state.roadmap.revision));
  assertCommittable(roadmap);
  await assertIndexWrite(state, roadmap);
  if (history !== false) await ensureHistoryBaseline(state);
  const updated = committedRoadmap(roadmap, nowIso());
  await mkdir(dirname(state.roadmapPath), { recursive: true });
  const originalRoadmap = await readFile(state.roadmapPath, "utf8").catch(() => null);
  // Read before the board moved online: its local copy is retired, so nothing is saved there.
  if (originalRoadmap === null || await isRetiredRoadmap(state.roadmapPath)) throw new PlanbanBoardMovedError();
  await atomicWriteFile(state.roadmapPath, JSON.stringify(updated, null, 2) + "\n");
  try {
    if (history !== false) await recordHistoryVersion({ ...state, roadmap: updated }, updated, history);
  } catch (error) {
    await atomicWriteFile(state.roadmapPath, originalRoadmap);
    throw error;
  }
  await appendEvent(state.planningRoot, {
    type: "roadmap.saved",
    at: updated.updatedAt,
    revision: updated.revision,
  }).catch(() => undefined);
  return updated;
  });
}

export async function appendEvent(planningRoot: string, event: Record<string, unknown>) {
  await mkdir(planningRoot, { recursive: true });
  const line = JSON.stringify(event) + "\n";
  await appendLineDurably(eventsPath(planningRoot), line);
}

async function reservedItemIds(planningRoot: string): Promise<(id: string) => boolean> {
  const entries = new Set(await readdir(join(planningRoot, "items")).catch(() => [] as string[]));
  return (id) => entries.has(slugify(id));
}

async function writePlannedDocs(state: PlanbanResolvedState, change: PlannedChange) {
  for (const doc of change.docWrites) {
    const path = resolveInsideRoot(state.planningRoot, doc.path, `${doc.kind} document path for ${doc.cardId}`);
    await mkdir(dirname(path), { recursive: true });
    await atomicWriteFile(path, doc.markdown);
    await appendEvent(state.planningRoot, { type: "doc.written", at: nowIso(), cardId: doc.cardId, kind: doc.kind, path });
  }
}

/** Commits a change whose roadmap edit and documents land as one history version. */
async function commitWithDocs(state: PlanbanResolvedState, change: PlannedChange): Promise<PlanbanRoadmap> {
  for (const doc of change.docWrites) checkIndexDocument(doc.markdown, doc.cardId, doc.kind);
  const roadmap = await saveRoadmap(state, change.roadmap, false);
  await writePlannedDocs(state, change);
  await recordHistoryVersion({ ...state, roadmap }, roadmap, change.history);
  return roadmap;
}

export async function moveCard(input: {
  cwd: string;
  /** Online boards: one key per logical edit, reused only to retry that same edit. */
  idempotencyKey?: string | undefined;
  cardId: string;
  status?: PlanbanStatus | undefined;
  parentId?: string | null | undefined;
  afterId?: string | null | undefined;
  baseRevision?: number | undefined;
  actor?: PlanbanHistoryActor | undefined;
  completionConfirmed?: boolean | undefined;
}): Promise<PlanbanResolvedState> {
  const online = await onlineManifest(input.cwd);
  if (online) return (await onlineOperation(resolveProjectCwd(input.cwd), online, "moveCard", input)).state;
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  await assertBaseRevision(state, input.baseRevision, (input as { cardId?: string }).cardId, (input as { actor?: string }).actor);
  const item = state.roadmap.roadmapItems.find((entry) => entry.id === input.cardId);
  if (!item) throw new PlanbanNotFoundError(`Card not found: ${input.cardId}`);
  await assertCardsHoldNoFiles(state.planningRoot, [item]);
  const change = planMoveCard(state.roadmap, input, { now: nowIso() });
  assertCompletionConfirmed(state.roadmap, change.roadmap, input.actor, input.completionConfirmed);
  const roadmap = await saveRoadmap(state, change.roadmap, change.history);
  return { ...state, roadmap };
  }).catch(againIfMoved(() => moveCard(input)));
}

export async function updateCard(input: {
  cwd: string;
  /** Online boards: one key per logical edit, reused only to retry that same edit. */
  idempotencyKey?: string | undefined;
  cardId: string;
  baseRevision?: number | undefined;
  title?: string | undefined;
  summary?: string | null | undefined;
  nextAction?: string | null | undefined;
  tags?: string[] | undefined;
  blockedBy?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  actor?: PlanbanHistoryActor | undefined;
}): Promise<PlanbanResolvedState> {
  const online = await onlineManifest(input.cwd);
  if (online) return (await onlineOperation(resolveProjectCwd(input.cwd), online, "updateCard", input)).state;
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  await assertBaseRevision(state, input.baseRevision, (input as { cardId?: string }).cardId, (input as { actor?: string }).actor);
  const change = planUpdateCard(state.roadmap, input, { now: nowIso() });
  await assertCardsHoldNoFiles(state.planningRoot, [state.roadmap.roadmapItems.find((item) => item.id === input.cardId)!]);
  const roadmap = await saveRoadmap(state, change.roadmap, change.history);
  return { ...state, roadmap };
  }).catch(againIfMoved(() => updateCard(input)));
}

export async function setCardParent(input: {
  cwd: string;
  /** Online boards: one key per logical edit, reused only to retry that same edit. */
  idempotencyKey?: string | undefined;
  cardId: string;
  parentId: string | null;
  baseRevision?: number | undefined;
  actor?: PlanbanHistoryActor | undefined;
}): Promise<PlanbanResolvedState> {
  return moveCard(input);
}

export async function setCardStatus(cwd: string, cardId: string, status: PlanbanStatus, baseRevision?: number) {
  return moveCard({ cwd, cardId, status, baseRevision });
}

export async function deleteArchivedCard(input: {
  cwd: string;
  /** Online boards: one key per logical edit, reused only to retry that same edit. */
  idempotencyKey?: string | undefined;
  cardId: string;
  baseRevision?: number | undefined;
}): Promise<PlanbanResolvedState> {
  const online = await onlineManifest(input.cwd);
  if (online) return (await onlineOperation(resolveProjectCwd(input.cwd), online, "deleteArchivedCard", input)).state;
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  await assertBaseRevision(state, input.baseRevision, (input as { cardId?: string }).cardId, (input as { actor?: string }).actor);
  const change = planDeleteArchivedCard(state.roadmap, input);
  const roadmap = await saveRoadmap(state, change.roadmap, change.history);
  await rm(itemRoot(state.planningRoot, input.cardId), { recursive: true, force: true });
  return { ...state, roadmap };
  }).catch(againIfMoved(() => deleteArchivedCard(input)));
}

export async function reorderCards(input: {
  cwd: string;
  /** Online boards: one key per logical edit, reused only to retry that same edit. */
  idempotencyKey?: string | undefined;
  items: Array<{ id: string; status: PlanbanStatus }>;
  baseRevision?: number | undefined;
  actor?: PlanbanHistoryActor | undefined;
  completionConfirmed?: boolean | undefined;
}): Promise<PlanbanResolvedState> {
  const online = await onlineManifest(input.cwd);
  if (online) return (await onlineOperation(resolveProjectCwd(input.cwd), online, "reorderCards", input)).state;
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  await assertBaseRevision(state, input.baseRevision, (input as { cardId?: string }).cardId, (input as { actor?: string }).actor);
  const change = planReorderCards(state.roadmap, input, { now: nowIso() });
  assertCompletionConfirmed(state.roadmap, change.roadmap, input.actor, input.completionConfirmed);
  const roadmap = await saveRoadmap(state, change.roadmap, change.history);
  return { ...state, roadmap };
  }).catch(againIfMoved(() => reorderCards(input)));
}

export async function createCard(input: {
  cwd: string;
  /** Online boards: one key per logical edit, reused only to retry that same edit. */
  idempotencyKey?: string | undefined;
  title: string;
  status?: PlanbanStatus | undefined;
  summary?: string | undefined;
  nextAction?: string | undefined;
  tags?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  specMarkdown?: string | undefined;
  planMarkdown?: string | undefined;
  position?: PlanbanCreateCardPosition | undefined;
  afterId?: string | undefined;
  actor?: PlanbanHistoryActor | undefined;
  parentId?: string | null | undefined;
  baseRevision?: number | undefined;
  completionConfirmed?: boolean | undefined;
}): Promise<PlanbanResolvedState & { createdCard: PlanbanRoadmapItem }> {
  const online = await onlineManifest(input.cwd);
  if (online) {
    const { state, result } = await onlineOperation<{ createdCard: PlanbanRoadmapItem }>(resolveProjectCwd(input.cwd), online, "createCard", input);
    return { ...state, createdCard: result.createdCard };
  }
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  await assertBaseRevision(state, input.baseRevision, (input as { cardId?: string }).cardId, (input as { actor?: string }).actor);
  const change = planCreateCard(state.roadmap, input, {
    now: nowIso(),
    isIdReserved: await reservedItemIds(state.planningRoot),
  });
  assertCompletionConfirmed(state.roadmap, change.roadmap, input.actor, input.completionConfirmed);
  if (input.specMarkdown !== undefined) checkIndexDocument(input.specMarkdown, input.title.trim(), "spec");
  if (input.planMarkdown !== undefined) checkIndexDocument(input.planMarkdown, input.title.trim(), "plan");
  await mkdir(itemRoot(state.planningRoot, change.cardId), { recursive: true });
  const roadmap = await commitWithDocs(state, change);
  const createdCard = roadmap.roadmapItems.find((entry) => entry.id === change.cardId)!;
  return { ...state, roadmap, createdCard };
  }).catch(againIfMoved(() => createCard(input)));
}

export async function createGroup(input: {
  cwd: string;
  /** Online boards: one key per logical edit, reused only to retry that same edit. */
  idempotencyKey?: string | undefined;
  title: string;
  summary?: string | undefined;
  nextAction?: string | undefined;
  status?: PlanbanStatus | undefined;
  itemIds?: string[] | undefined;
  anchorId?: string | undefined;
  specMarkdown?: string | undefined;
  planMarkdown?: string | undefined;
  baseRevision?: number | undefined;
  actor?: PlanbanHistoryActor | undefined;
  completionConfirmed?: boolean | undefined;
}): Promise<PlanbanResolvedState & { createdGroup: PlanbanRoadmapItem }> {
  const online = await onlineManifest(input.cwd);
  if (online) {
    const { state, result } = await onlineOperation<{ createdGroup: PlanbanRoadmapItem }>(resolveProjectCwd(input.cwd), online, "createGroup", input);
    return { ...state, createdGroup: result.createdGroup };
  }
  return withRoadmapWriteLock(input.cwd, async () => {
    const state = await loadState(input.cwd);
    await assertBaseRevision(state, input.baseRevision, (input as { cardId?: string }).cardId, (input as { actor?: string }).actor);
    const change = planCreateGroup(state.roadmap, input, {
      now: nowIso(),
      isIdReserved: await reservedItemIds(state.planningRoot),
    });
    assertCompletionConfirmed(state.roadmap, change.roadmap, input.actor, input.completionConfirmed);
    if (input.specMarkdown !== undefined) checkIndexDocument(input.specMarkdown, input.title.trim(), "spec");
    if (input.planMarkdown !== undefined) checkIndexDocument(input.planMarkdown, input.title.trim(), "plan");
    await mkdir(itemRoot(state.planningRoot, change.groupId), { recursive: true });
    const roadmap = await commitWithDocs(state, change);
    const createdGroup = roadmap.roadmapItems.find((item) => item.id === change.groupId)!;
    return { ...state, roadmap, createdGroup };
  }).catch(againIfMoved(() => createGroup(input)));
}

export async function createCards(input: {
  cwd: string;
  /** Online boards: one key per logical edit, reused only to retry that same edit. */
  idempotencyKey?: string | undefined;
  titles: string[];
  status?: PlanbanStatus | undefined;
  parentId?: string | null | undefined;
  baseRevision?: number | undefined;
  actor?: PlanbanHistoryActor | undefined;
  completionConfirmed?: boolean | undefined;
  writeSpecFile?: ((path: string, markdown: string) => Promise<void>) | undefined;
}): Promise<PlanbanResolvedState & { createdCards: PlanbanRoadmapItem[] }> {
  const online = await onlineManifest(input.cwd);
  if (online) {
    if (input.writeSpecFile) refuseOnline("Custom document file writers");
    const { state, result } = await onlineOperation<{ createdCards: PlanbanRoadmapItem[] }>(resolveProjectCwd(input.cwd), online, "createCards", input);
    return { ...state, createdCards: result.createdCards };
  }
  return withRoadmapWriteLock(input.cwd, async () => {
    const state = await loadState(input.cwd);
    await assertBaseRevision(state, input.baseRevision, (input as { cardId?: string }).cardId, (input as { actor?: string }).actor);
    const change = planCreateCards(state.roadmap, input, {
      now: nowIso(),
      isIdReserved: await reservedItemIds(state.planningRoot),
    });
    assertCompletionConfirmed(state.roadmap, change.roadmap, input.actor, input.completionConfirmed);
    const transactionRoot = join(state.planningRoot, ".transactions", `create-cards-${randomUUID()}`);
    const publishedRoots: string[] = [];
    const writeSpecFile = input.writeSpecFile ?? atomicWriteFile;
    let roadmap: PlanbanRoadmap;
    try {
      for (const doc of change.docWrites) {
        const stagedSpecPath = join(transactionRoot, doc.cardId, "spec.md");
        await mkdir(dirname(stagedSpecPath), { recursive: true });
        await writeSpecFile(stagedSpecPath, doc.markdown);
      }
      for (const cardId of change.cardIds) {
        const finalRoot = itemRoot(state.planningRoot, cardId);
        await mkdir(dirname(finalRoot), { recursive: true });
        await rename(join(transactionRoot, cardId), finalRoot);
        publishedRoots.push(finalRoot);
      }
      roadmap = await saveRoadmap(state, change.roadmap, change.history);
      for (const doc of change.docWrites) {
        const specPath = resolveInsideRoot(state.planningRoot, doc.path, `spec document path for ${doc.cardId}`);
        await appendEvent(state.planningRoot, { type: "doc.written", at: nowIso(), cardId: doc.cardId, kind: "spec", path: specPath }).catch(() => undefined);
      }
    } catch (error) {
      await Promise.allSettled(publishedRoots.map((root) => rm(root, { recursive: true, force: true })));
      await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    const createdIds = new Set(change.cardIds);
    return { ...state, roadmap, createdCards: roadmap.roadmapItems.filter((item) => createdIds.has(item.id)) };
  }).catch(againIfMoved(() => createCards(input)));
}

export function docPathForItem(state: PlanbanResolvedState, item: PlanbanRoadmapItem, kind: "spec" | "plan") {
  if (state.manifest.storage?.kind === "online") return null;
  const configured = kind === "spec" ? item.specDoc : item.planDoc;
  if (!configured) return null;
  return resolveInsideRoot(state.planningRoot, configured, `${kind} document path for ${item.id}`);
}

export async function readDoc(input: {
  cwd: string;
  cardId: string;
  kind: "spec" | "plan";
}): Promise<PlanbanDocPayload> {
  const online = await onlineManifest(input.cwd);
  if (online?.storage?.kind === "online") return onlineRequest<PlanbanDocPayload>(online.storage.url, boardPath(online.storage.boardId, `/docs/${encodeURIComponent(input.cardId)}/${input.kind}`));
  const state = await loadState(input.cwd);
  const item = state.roadmap.roadmapItems.find((entry) => entry.id === input.cardId);
  if (!item) throw new Error(`Card not found: ${input.cardId}`);
  const path = docPathForItem(state, item, input.kind);
  if (!path || !(await pathExists(path))) {
    return { cardId: input.cardId, kind: input.kind, path, exists: false, markdown: "", mtimeMs: null };
  }
  const stats = await stat(path);
  return {
    cardId: input.cardId,
    kind: input.kind,
    path,
    exists: true,
    markdown: await readFile(path, "utf8"),
    mtimeMs: stats.mtimeMs,
  };
}

export async function exportFlatVersion1(input: {
  cwd: string;
  exportId: string;
  actor?: PlanbanHistoryActor | undefined;
}) {
  await refuseForOnline(input.cwd, "Flat version-1 export");
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(input.exportId)) {
    throw new PlanbanValidationError("exportId must use 1-80 lowercase letters, numbers, or hyphens.");
  }
  return withRoadmapWriteLock(input.cwd, async () => {
    const state = await loadState(input.cwd);
    const exportRoot = join(state.planningRoot, "exports", input.exportId);
    if (await pathExists(exportRoot)) throw new PlanbanConflictError(`Export already exists: ${input.exportId}`);
    const affectedDocs = state.roadmap.roadmapItems.flatMap((item) => ([
      ...(item.specDoc ? [{ cardId: item.id, kind: "spec" as const, path: item.specDoc }] : []),
      ...(item.planDoc ? [{ cardId: item.id, kind: "plan" as const, path: item.planDoc }] : []),
    ]));
    const historyDocKeys = new Set<string>();
    const realPlanningRoot = await realpath(state.planningRoot);
    for (const doc of affectedDocs) {
      const historyDocKey = `${slugify(doc.cardId)}/${doc.kind}`;
      if (historyDocKeys.has(historyDocKey)) {
        throw new PlanbanValidationError(`Cannot export document evidence because Work Item ids collide after safe path encoding: ${doc.cardId}`);
      }
      historyDocKeys.add(historyDocKey);
      const livePath = resolveInsideRoot(state.planningRoot, doc.path, `${doc.kind} document path for ${doc.cardId}`);
      if (!(await pathExists(livePath))) {
        throw new PlanbanValidationError(`Cannot export ${doc.kind} evidence for ${doc.cardId}: ${doc.path} does not exist.`);
      }
      const realLivePath = await realpath(livePath);
      const pathFromRoot = relative(realPlanningRoot, realLivePath);
      if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
        throw new PlanbanValidationError(`Cannot export ${doc.kind} evidence for ${doc.cardId}: ${doc.path} resolves outside the planning root.`);
      }
    }
    const exportedDocPath = (cardId: string, kind: "spec" | "plan") => `documents/id-${encodeURIComponent(cardId)}/${kind}.md`;
    const flatRoadmap = flattenRoadmapForVersion1(state.roadmap);
    flatRoadmap.roadmapItems = flatRoadmap.roadmapItems.map((item) => ({
      ...item,
      specDoc: item.specDoc ? exportedDocPath(item.id, "spec") : null,
      planDoc: item.planDoc ? exportedDocPath(item.id, "plan") : null,
    }));
    await settleGoals(state.planningRoot, state.roadmap.revision);
    const historyEntry = await recordHistoryVersion(state, state.roadmap, {
      actor: input.actor ?? "user",
      operation: "roadmap.export.flat-v1.snapshot",
      summary: `Captured a recovery snapshot for a flat version-1 export of ${state.roadmap.project.title}`,
      affectedCards: state.roadmap.roadmapItems.map((item) => item.id),
      affectedDocs,
      strictDocs: true,
    });
    for (const doc of affectedDocs) {
      if (!(await pathExists(historyDocPath(state.planningRoot, historyEntry.version, doc.cardId, doc.kind)))) {
        throw new PlanbanValidationError(`Cannot export ${doc.kind} evidence for ${doc.cardId}: recovery snapshot capture failed.`);
      }
    }
    const transactionRoot = join(state.planningRoot, ".transactions", `flat-v1-export-${randomUUID()}`);
    try {
      await mkdir(transactionRoot, { recursive: true });
      await atomicWriteFile(join(transactionRoot, "roadmap.json"), JSON.stringify(flatRoadmap, null, 2) + "\n");
      await atomicWriteFile(join(transactionRoot, "hierarchy-recovery.json"), JSON.stringify(hierarchyRecoveryManifest(state.roadmap, historyEntry.version), null, 2) + "\n");
      for (const doc of affectedDocs) {
        const source = historyDocPath(state.planningRoot, historyEntry.version, doc.cardId, doc.kind);
        if (!(await pathExists(source))) throw new PlanbanValidationError(`Cannot export ${doc.kind} evidence for ${doc.cardId}: recovery snapshot is incomplete.`);
        const destination = resolveInsideRoot(transactionRoot, exportedDocPath(doc.cardId, doc.kind), `export ${doc.kind} document path for ${doc.cardId}`);
        await mkdir(dirname(destination), { recursive: true });
        await atomicWriteFile(destination, await readFile(source, "utf8"));
      }
      await cp(historyRoot(state.planningRoot), join(transactionRoot, "history"), { recursive: true });
      await mkdir(dirname(exportRoot), { recursive: true });
      await rename(transactionRoot, exportRoot);
    } catch (error) {
      await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await appendEvent(state.planningRoot, { type: "roadmap.exported", at: nowIso(), format: "flat-v1", exportId: input.exportId, historyVersion: historyEntry.version }).catch(() => undefined);
    return { exportId: input.exportId, exportRoot, roadmapPath: join(exportRoot, "roadmap.json"), recoveryPath: join(exportRoot, "hierarchy-recovery.json"), historyVersion: historyEntry.version, sourceRevision: state.roadmap.revision };
  });
}

export async function reconstructHierarchy(input: {
  cwd: string;
  groups: Array<{ id: string; childIds: string[] }>;
  baseRevision?: number | undefined;
  actor?: PlanbanHistoryActor | undefined;
}) {
  await refuseForOnline(input.cwd, "Hierarchy reconstruction");
  if (!Array.isArray(input.groups) || input.groups.length === 0) {
    throw new PlanbanValidationError("groups must contain at least one explicit hierarchy mapping.");
  }
  if (input.baseRevision === undefined) throw new PlanbanValidationError("baseRevision is required for hierarchy reconstruction.");
  return withRoadmapWriteLock(input.cwd, async () => {
    const state = await loadState(input.cwd);
    await assertBaseRevision(state, input.baseRevision, (input as { cardId?: string }).cardId, (input as { actor?: string }).actor);
    const byId = new Map(state.roadmap.roadmapItems.map((item) => [item.id, item]));
    const parentByChild = new Map<string, string>();
    const preferredIndex = new Map<string, number>();
    const groupIds = new Set<string>();
    for (const group of input.groups) {
      if (!group || typeof group.id !== "string" || !group.id.trim() || !Array.isArray(group.childIds) || group.childIds.some((id) => typeof id !== "string" || !id.trim())) {
        throw new PlanbanValidationError("Each Group mapping requires a non-empty id and childIds array of Work Item ids.");
      }
      const groupItem = byId.get(group.id);
      if (!groupItem) throw new PlanbanNotFoundError(`Group Work Item not found: ${group.id}`);
      if (!groupItem.isGroup) throw new PlanbanValidationError(`${groupItem.title} is an Item; hierarchy reconstruction requires an existing Group.`);
      if (groupIds.has(group.id)) throw new PlanbanValidationError(`Duplicate Group mapping: ${group.id}`);
      groupIds.add(group.id);
      for (const [index, childId] of group.childIds.entries()) {
        if (!byId.has(childId)) throw new PlanbanNotFoundError(`Child Work Item not found: ${childId}`);
        if (childId === group.id) throw new PlanbanValidationError(`${childId} cannot parent itself.`);
        if (parentByChild.has(childId)) throw new PlanbanValidationError(`${childId} appears beneath more than one Group.`);
        parentByChild.set(childId, group.id);
        preferredIndex.set(childId, index);
      }
    }
    for (const groupId of groupIds) {
      if (parentByChild.has(groupId)) {
        throw new PlanbanValidationError("A Group cannot be placed inside another Group.");
      }
    }
    for (const childId of parentByChild.keys()) {
      if (byId.get(childId)?.isGroup) {
        throw new PlanbanValidationError("A Group cannot be placed inside another Group.");
      }
    }
    const timestamp = nowIso();
    const detachedIds = new Set(state.roadmap.roadmapItems.filter((item) => item.parentId && groupIds.has(item.parentId) && !parentByChild.has(item.id)).map((item) => item.id));
    let roadmapItems = state.roadmap.roadmapItems.map((item) => {
      const nextParentId = parentByChild.has(item.id) ? parentByChild.get(item.id)! : detachedIds.has(item.id) ? null : item.parentId;
      const changed = nextParentId !== item.parentId;
      return {
        ...item,
        parentId: nextParentId,
        updatedAt: changed ? timestamp : item.updatedAt,
      };
    });
    const scopes = new Map<string, PlanbanRoadmapItem[]>();
    for (const item of roadmapItems) {
      const key = JSON.stringify([item.parentId, item.status]);
      const scope = scopes.get(key) ?? [];
      scope.push(item);
      scopes.set(key, scope);
    }
    const rankById = new Map<string, number>();
    for (const scope of scopes.values()) {
      scope.sort((a, b) => {
        const aPreferred = preferredIndex.get(a.id);
        const bPreferred = preferredIndex.get(b.id);
        if (aPreferred !== undefined && bPreferred !== undefined) return aPreferred - bPreferred;
        if (aPreferred !== undefined) return -1;
        if (bPreferred !== undefined) return 1;
        return (a.parentId === null ? a.boardRank ?? 9999 : a.groupRank ?? 9999) - (b.parentId === null ? b.boardRank ?? 9999 : b.groupRank ?? 9999);
      });
      scope.forEach((item, index) => rankById.set(item.id, index + 1));
    }
    roadmapItems = roadmapItems.map((item) => ({
      ...item,
      boardRank: item.parentId === null ? rankById.get(item.id)! : null,
      groupRank: item.parentId === null ? null : rankById.get(item.id)!,
    }));
    const affectedCards = [...new Set([...groupIds, ...parentByChild.keys(), ...detachedIds])];
    const roadmap = await saveRoadmap(state, { ...state.roadmap, roadmapItems }, {
      actor: input.actor ?? "user",
      operation: "hierarchy.reconstruct",
      summary: `Reconstructed ${input.groups.length} Group ${input.groups.length === 1 ? "mapping" : "mappings"}`,
      affectedCards,
    });
    return { ...state, roadmap, cards: affectedCards.map((id) => roadmap.roadmapItems.find((item) => item.id === id)!) };
  });
}

export async function writeDoc(input: {
  cwd: string;
  /** Online boards: one key per logical edit, reused only to retry that same edit. */
  idempotencyKey?: string | undefined;
  cardId: string;
  kind: "spec" | "plan";
  markdown: string;
  expectedMtimeMs?: number | null | undefined;
  history?: PlanbanHistoryMeta | false | undefined;
  /** Who is writing; defaults to the history's actor. On an online board, an agent stays within the person's setting for their agents. */
  actor?: PlanbanHistoryActor | undefined;
  /** Only for move-files-out: records files it moved even when a failure left others in the card folder. */
  recordingMovedFiles?: boolean | undefined;
}): Promise<PlanbanDocPayload> {
  const online = await onlineManifest(input.cwd);
  if (online) {
    const { history, ...rest } = input;
    const actor = input.actor ?? (history ? history.actor : undefined);
    const { state, result } = await onlineOperation<{ doc: PlanbanDocPayload }>(resolveProjectCwd(input.cwd), online, "writeDoc", { ...rest, ...(actor ? { actor } : {}) });
    // A retried write says so, as card edits do.
    return { ...result.doc, ...(state.onlineReplay ?? {}) };
  }
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  const planned = planWriteDoc(state.roadmap, input, { now: nowIso() });
  const item = planned.item;
  checkIndexDocument(input.markdown, item.id, input.kind);
  if (!input.recordingMovedFiles) await assertCardsHoldNoFiles(state.planningRoot, [item]);
  if (planned.roadmap) await saveRoadmap(state, planned.roadmap, false);

  const path = resolveInsideRoot(state.planningRoot, planned.path, `${input.kind} document path for ${item.id}`);
  const existsBeforeWrite = await pathExists(path);
  if (input.expectedMtimeMs !== undefined) {
    if (existsBeforeWrite) {
      const currentStats = await stat(path);
      if (input.expectedMtimeMs === null || currentStats.mtimeMs !== input.expectedMtimeMs) {
        const markdown = await readFile(path, "utf8");
        // A very long document is left out of the answer, as online; its version is always there.
        const document = markdown.length > MAX_CONFLICT_DOCUMENT_CHARS
          ? { cardId: input.cardId, kind: input.kind, path, exists: true, markdown: "", mtimeMs: currentStats.mtimeMs, markdownOmitted: true as const }
          : { cardId: input.cardId, kind: input.kind, path, exists: true, markdown, mtimeMs: currentStats.mtimeMs };
        throw await documentConflict(state, input.cardId, input.kind, document, input.actor ?? (input.history ? input.history.actor : undefined));
      }
    } else if (input.expectedMtimeMs !== null) {
      throw await documentConflict(state, input.cardId, input.kind, { cardId: input.cardId, kind: input.kind, path, exists: false, markdown: "", mtimeMs: null }, input.actor ?? (input.history ? input.history.actor : undefined));
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, input.markdown);
  const stats = await stat(path);
  await appendEvent(state.planningRoot, {
    type: "doc.written",
    at: nowIso(),
    cardId: input.cardId,
    kind: input.kind,
    path,
  });
  if (input.history !== false) {
    const latestState = await loadState(input.cwd);
    // Like every write: an unfinished goals change is settled before history moves on.
    await settleGoals(latestState.planningRoot, latestState.roadmap.revision);
    await recordHistoryVersion(latestState, latestState.roadmap, input.history ?? { ...planned.history, ...(input.actor ? { actor: input.actor } : {}) });
  }
  return { cardId: input.cardId, kind: input.kind, path, exists: true, markdown: input.markdown, mtimeMs: stats.mtimeMs };
  }).catch(againIfMoved(() => writeDoc(input)));
}

export async function historyPayload(cwd: string) {
  const online = await onlineManifest(cwd);
  if (online?.storage?.kind === "online") return onlineRequest<PlanbanHistoryPayload>(online.storage.url, boardPath(online.storage.boardId, "/history"));
  const state = await loadState(cwd);
  const { listHistory } = await import("./history");
  return listHistory(state);
}

export async function loadHistoryState(input: { cwd: string; version: number }): Promise<PlanbanResolvedState> {
  const online = await onlineManifest(input.cwd);
  if (online?.storage?.kind === "online") {
    const { roadmap } = await onlineRequest<{ roadmap: PlanbanRoadmap }>(online.storage.url, boardPath(online.storage.boardId, `/history/${input.version}`));
    return onlineState(resolveProjectCwd(input.cwd), online, roadmap);
  }
  const state = await loadState(input.cwd);
  const { readHistoryRoadmap } = await import("./history");
  return { ...state, roadmap: await readHistoryRoadmap(state, input.version) };
}

/**
 * Agents' refused edits still waiting on an online board, or one card (Spec
 * point 20). A board only on this computer has one writer, so it has none.
 */
export async function unresolvedChanges(input: { cwd: string; cardId?: string | undefined }): Promise<{ changes: Array<Record<string, unknown>> }> {
  const online = await onlineManifest(input.cwd);
  if (!online || online.storage?.kind !== "online") return { changes: [] };
  const query = input.cardId ? `?card=${encodeURIComponent(input.cardId)}` : "";
  return onlineRequest(online.storage.url, boardPath(online.storage.boardId, `/unresolved${query}`));
}

/**
 * An agent on this computer is working on a card of an online board (Spec
 * point 20): a heads-up for others that ends 15 minutes after its last
 * activity. Never a lock; best effort, and nothing for a board on this computer.
 */
export async function notePresence(input: { cwd: string; cardId: string; agentName?: string | undefined }) {
  // Best effort from start to finish: a heads-up must never break or stall the agent's work.
  try {
    const online = await onlineManifest(input.cwd);
    if (!online || online.storage?.kind !== "online") return { noted: false };
    return await onlineRequest<{ noted: boolean }>(online.storage.url, boardPath(online.storage.boardId, "/presence"), { cardId: input.cardId, ...(input.agentName ? { agentName: input.agentName } : {}) }, { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) });
  } catch {
    return { noted: false };
  }
}

/** Who else is working on a card of an online board, in words: "Claude (Sam) is working on this card, started 4 minutes ago." */
export async function workingOnCard(input: { cwd: string; cardId: string; agentName?: string | undefined }): Promise<Array<{ who: string; startedAt: string; lastActiveAt: string; note: string }>> {
  try {
    const online = await onlineManifest(input.cwd);
    if (!online || online.storage?.kind !== "online") return [];
    const agent = input.agentName ? `&agent=${encodeURIComponent(input.agentName)}` : "";
    const result = await onlineRequest<{ working: Record<string, Array<{ who: string; startedAt: string; lastActiveAt: string; note: string }>> }>(online.storage.url, boardPath(online.storage.boardId, `/presence?card=${encodeURIComponent(input.cardId)}${agent}`), undefined, { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) });
    return result.working[input.cardId] ?? [];
  } catch {
    return [];
  }
}

/**
 * One section of a Spec or Plan, by heading (Spec point 20): checked against
 * that section's own version (from readDocSections), so edits to other
 * sections never clash. On a board on this computer, the same rules over the file.
 */
export async function writeDocSection(input: {
  cwd: string;
  cardId: string;
  kind: "spec" | "plan";
  heading: string;
  occurrence?: number | undefined;
  expectedSectionVersion: string | null;
  markdown: string;
  after?: string | undefined;
  actor?: PlanbanHistoryActor | undefined;
  idempotencyKey?: string | undefined;
}): Promise<PlanbanDocPayload & { section?: { heading: string; version: string } }> {
  const online = await onlineManifest(input.cwd);
  if (online) {
    const { state, result } = await onlineOperation<{ doc: PlanbanDocPayload; section: { heading: string; version: string } }>(resolveProjectCwd(input.cwd), online, "writeDocSection", input);
    return { ...result.doc, section: result.section, ...(state.onlineReplay ?? {}) };
  }
  // Another section saved at the same moment changes the file's version: read again and
  // re-apply, since only this section's own version decides.
  for (let attempt = 0; ; attempt += 1) {
    const doc = await readDoc(input);
    const edit = editSection(doc.markdown, { heading: input.heading, expectedVersion: input.expectedSectionVersion, text: input.markdown, ...(input.occurrence === undefined ? {} : { occurrence: input.occurrence }), ...(input.after ? { after: input.after } : {}) });
    if (!edit.ok) {
      const conflict: ConflictDetails = { currentRevision: (await loadState(input.cwd)).roadmap.revision, changes: [], section: edit.current, document: doc };
      throw new PlanbanEditConflictError(`Not saved: the "${input.heading}" section ${edit.reason === "missing" ? "is no longer there" : edit.reason === "exists" ? "was added since you read it" : "changed since you read it"}.${input.actor === "agent" ? ` ${RECONCILE}` : ""}`, conflict);
    }
    try {
      const written = await writeDoc({ cwd: input.cwd, cardId: input.cardId, kind: input.kind, markdown: edit.markdown, expectedMtimeMs: doc.exists ? doc.mtimeMs : null, actor: input.actor });
      return { ...written, section: edit.section };
    } catch (error) {
      if (!(error instanceof PlanbanEditConflictError) || attempt >= 4) throw error;
    }
  }
}

/** A document with each section's own version, for writeDocSection. */
export async function readDocSections(input: { cwd: string; cardId: string; kind: "spec" | "plan" }) {
  const doc = await readDoc(input);
  return { ...doc, sections: sectionList(doc.markdown) };
}

/** Drops an unresolved change with a reason, into the card's history. */
export async function dropChange(input: { cwd: string; changeId: string; reason: string; baseRevision?: number | undefined; actor?: PlanbanHistoryActor | undefined; idempotencyKey?: string | undefined }): Promise<PlanbanResolvedState> {
  const online = await onlineManifest(input.cwd);
  if (!online) throw new PlanbanValidationError("Only online boards keep unresolved changes; a board on this computer has one writer at a time.");
  return (await onlineOperation(resolveProjectCwd(input.cwd), online, "dropChange", input)).state;
}

/**
 * Takes one merged pull request out of an Online Board's inbox: onto the card it finished, as a
 * landing note, or dismissed. A board on this computer has no inbox (its merges come from git).
 */
export async function clearLanding(input: { cwd: string; repo: string; number: number; cardId?: string | undefined; reason?: string | undefined; actor?: PlanbanHistoryActor | undefined; idempotencyKey?: string | undefined }): Promise<PlanbanResolvedState> {
  const online = await onlineManifest(input.cwd);
  if (!online) throw new PlanbanValidationError("Only Online Boards with a linked GitHub repository have an inbox of merges.");
  return (await onlineOperation(resolveProjectCwd(input.cwd), online, "clearLanding", input)).state;
}

export async function readHistoryDoc(input: {
  cwd: string;
  version: number;
  cardId: string;
  kind: "spec" | "plan";
}): Promise<PlanbanDocPayload> {
  const online = await onlineManifest(input.cwd);
  if (online?.storage?.kind === "online") {
    return onlineRequest<PlanbanDocPayload>(online.storage.url, boardPath(online.storage.boardId, `/history/${input.version}/cards/${encodeURIComponent(input.cardId)}/docs/${input.kind}`));
  }
  const state = await loadState(input.cwd);
  return resolveHistoryDoc(state, input.version, input.cardId, input.kind);
}

export async function restoreBoardVersion(input: {
  cwd: string;
  /** Online boards: one key per logical edit, reused only to retry that same edit. */
  idempotencyKey?: string | undefined;
  version: number;
  actor?: PlanbanHistoryActor | undefined;
  baseRevision?: number | undefined;
  completionConfirmed?: boolean | undefined;
}): Promise<PlanbanResolvedState> {
  const online = await onlineManifest(input.cwd);
  if (online) return (await onlineOperation(resolveProjectCwd(input.cwd), online, "restoreBoard", input)).state;
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  const restored = await restoreRoadmapFromHistory({ state, version: input.version, actor: input.actor });
  assertCompletionConfirmed(state.roadmap, restored, input.actor, input.completionConfirmed);
  const roadmap = await saveRoadmap(state, restored, {
    actor: input.actor ?? "user",
    operation: "history.restore.board",
    summary: `Restored board from v${input.version}`,
    affectedCards: restored.roadmapItems.map((item) => item.id),
  });
  return { ...state, roadmap };
  }).catch(againIfMoved(() => restoreBoardVersion(input)));
}

export async function restoreCardVersion(input: {
  cwd: string;
  /** Online boards: one key per logical edit, reused only to retry that same edit. */
  idempotencyKey?: string | undefined;
  version: number;
  cardId: string;
  actor?: PlanbanHistoryActor | undefined;
  baseRevision?: number | undefined;
  completionConfirmed?: boolean | undefined;
}): Promise<PlanbanResolvedState> {
  const online = await onlineManifest(input.cwd);
  if (online) return (await onlineOperation(resolveProjectCwd(input.cwd), online, "restoreCard", input)).state;
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  const restoredCard = await restoreCardFromHistory({ state, version: input.version, cardId: input.cardId });
  const existing = state.roadmap.roadmapItems.some((item) => item.id === input.cardId);
  const roadmapItems = existing
    ? state.roadmap.roadmapItems.map((item) => (item.id === input.cardId ? restoredCard : item))
    : [...state.roadmap.roadmapItems, restoredCard];
  const candidate = { ...state.roadmap, roadmapItems: normalizeColumnPriorities(roadmapItems) };
  assertCompletionConfirmed(state.roadmap, candidate, input.actor, input.completionConfirmed);
  const roadmap = await saveRoadmap(state, candidate, {
    actor: input.actor ?? "user",
    operation: "history.restore.card",
    summary: `Restored ${restoredCard.title} from v${input.version}`,
    affectedCards: [input.cardId],
  });
  return { ...state, roadmap };
  }).catch(againIfMoved(() => restoreCardVersion(input)));
}

export async function restoreDocVersion(input: {
  cwd: string;
  /** Online boards: one key per logical edit, reused only to retry that same edit. */
  idempotencyKey?: string | undefined;
  version: number;
  cardId: string;
  kind: "spec" | "plan";
  actor?: PlanbanHistoryActor | undefined;
  baseRevision?: number | undefined;
}): Promise<PlanbanDocPayload> {
  const online = await onlineManifest(input.cwd);
  if (online) {
    await onlineOperation(resolveProjectCwd(input.cwd), online, "restoreDoc", input);
    return readDoc({ cwd: input.cwd, cardId: input.cardId, kind: input.kind });
  }
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  const historicalDoc = await resolveHistoryDoc(state, input.version, input.cardId, input.kind);
  if (!historicalDoc.exists) throw new Error(`${input.kind} document not found in v${input.version}`);
  const item = state.roadmap.roadmapItems.find((entry) => entry.id === input.cardId);
  const livePath = (item ? (input.kind === "spec" ? item.specDoc : item.planDoc) : null) ?? `items/${input.cardId}/${input.kind}.md`;
  return writeDoc({
    cwd: input.cwd,
    cardId: input.cardId,
    kind: input.kind,
    markdown: historicalDoc.markdown,
    history: {
      actor: input.actor ?? "user",
      operation: "history.restore.doc",
      summary: `Restored ${input.kind} document from v${input.version}`,
      affectedCards: [input.cardId],
      affectedDocs: [{ cardId: input.cardId, kind: input.kind, path: livePath }],
    },
  });
  }).catch(againIfMoved(() => restoreDocVersion(input)));
}

export async function getStatus(cwdInput: string) {
  const discovery = resolvePlanbanProjectDir(cwdInput);
  const cwd = discovery.projectDir;
  const manifest = await readManifest(cwd);
  if (!manifest) {
    return {
      initialized: false,
      cwd,
      manifestPath: manifestPath(cwd),
      version: currentVersionInfo(),
    };
  }
  if (manifest.storage?.kind === "online") {
    const state = await loadOnlineState(cwd, manifest);
    return {
      initialized: true, cwd,
      requestedCwd: discovery.via === "cwd" ? undefined : discovery.requestedCwd,
      discoveredVia: discovery.via === "cwd" ? undefined : discovery.via,
      manifestPath: state.manifestPath, agentContextPath: state.agentContextPath,
      planningRoot: state.planningRoot, roadmapPath: state.roadmapPath,
      roadmapExists: true, repoId: manifest.repoId, storage: manifest.storage, version: currentVersionInfo(),
    };
  }
  const planningRoot = resolvePlanningRoot(manifest);
  const liveRoadmapPath = roadmapPath(planningRoot);
  return {
    initialized: true,
    cwd,
    requestedCwd: discovery.via === "cwd" ? undefined : discovery.requestedCwd,
    discoveredVia: discovery.via === "cwd" ? undefined : discovery.via,
    manifestPath: manifestPath(cwd),
    agentContextPath: agentContextPath(cwd),
    planningRoot,
    roadmapPath: liveRoadmapPath,
    roadmapExists: await hasLiveRoadmap(planningRoot),
    repoId: manifest.repoId,
    version: currentVersionInfo(),
  };
}

// ---- Goals (owner decisions, 16 October 2026) ------------------------------
// Kept beside the board in goals.json, so the board file older Planban
// versions rewrite is untouched. Every change is a board revision with a
// history entry, so live updates, edit clashes and retries work as for cards.

const goalsPath = (planningRoot: string) => join(planningRoot, "goals.json");
/**
 * A change is written here first, stamped with the board revision it makes,
 * then the board's revision and history, then it becomes goals.json. If
 * anything stops in between, the stamp says whether the revision was
 * committed: if so the change stands, if not it never happened.
 */
const nextGoalsPath = (planningRoot: string) => join(planningRoot, "goals.next.json");

async function readGoalsAt(path: string): Promise<{ file: GoalsFile; revision?: number } | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as { revision?: unknown };
    return { file: normalizeGoals(parsed), ...(typeof parsed.revision === "number" ? { revision: parsed.revision } : {}) };
  } catch {
    throw new PlanbanValidationError(`This board's goals file is damaged (${path}). Restore it from a backup or move it aside to start the goals again.`);
  }
}

/** A local board's goals as stored, for moving the board online; null when it has none. */
export async function readLocalGoals(planningRoot: string, roadmapRevision?: number): Promise<GoalsFile | null> {
  const file = await readGoalsFile(planningRoot, roadmapRevision ?? (await readRoadmapRevision(planningRoot)));
  return file.goals.length || file.retired.length || file.context || file.suggestions.length || file.dismissed.length ? file : null;
}

async function readRoadmapRevision(planningRoot: string): Promise<number> {
  return (JSON.parse(await readFile(roadmapPath(planningRoot), "utf8")) as { revision?: number }).revision ?? 0;
}

/**
 * Whether a change written to goals.next.json was committed: the board
 * reached its revision, and that revision's history entry is a goals change
 * (another kind of edit reaching the same number doesn't count).
 */
async function nextCommitted(planningRoot: string, next: { revision?: number }, roadmapRevision: number) {
  if (next.revision === undefined || next.revision > roadmapRevision) return false;
  const index = await readFile(join(planningRoot, "history", "index.json"), "utf8").then((raw) => JSON.parse(raw) as { entries?: Array<{ roadmapRevision?: number; operation?: string }> }, () => null);
  return !!index?.entries?.some((entry) => entry.roadmapRevision === next.revision && entry.operation === "goals.edit");
}

/** The goals as of the board's committed revision (see nextGoalsPath). Never writes, so it is safe without the lock. */
async function readGoalsFile(planningRoot: string, roadmapRevision: number): Promise<GoalsFile> {
  const next = await readGoalsAt(nextGoalsPath(planningRoot));
  if (next && await nextCommitted(planningRoot, next, roadmapRevision)) return next.file;
  return (await readGoalsAt(goalsPath(planningRoot)))?.file ?? emptyGoals();
}

/** Under the board lock: settles a change that stopped part way, one way or the other. */
async function settleGoals(planningRoot: string, roadmapRevision: number) {
  const next = await readGoalsAt(nextGoalsPath(planningRoot)).catch(() => null);
  if (!next) {
    await rm(nextGoalsPath(planningRoot), { force: true });
    return;
  }
  if (await nextCommitted(planningRoot, next, roadmapRevision)) await rename(nextGoalsPath(planningRoot), goalsPath(planningRoot));
  else await rm(nextGoalsPath(planningRoot), { force: true });
}

export interface GoalsResult {
  page: GoalsPage;
  revision: number;
  /** Set when a suggestion wasn't added: why. */
  notAdded?: string | undefined;
  suggestion?: Record<string, unknown> | undefined;
}

/** The board's whole Goals page: goals with notes, context, retired goals and suggestions. */
export async function readGoals(input: { cwd: string }): Promise<GoalsResult> {
  const online = await onlineManifest(input.cwd);
  if (online && online.storage?.kind === "online") {
    return onlineRequest<GoalsResult>(online.storage.url, boardPath(online.storage.boardId, "/goals"));
  }
  const state = await loadState(input.cwd);
  return { page: goalsPage(await readGoalsFile(state.planningRoot, state.roadmap.revision)), revision: state.roadmap.revision };
}

/** The short Goals block for agents' board reads, or null when the board has no goals. */
export async function readGoalsBlock(cwd: string): Promise<string | null> {
  const { page } = await readGoals({ cwd }).catch(() => ({ page: null }));
  if (!page || !page.goals.length) return null;
  return goalsBlock({ ...emptyGoals(), goals: page.goals });
}

async function changeLocalGoals(
  cwd: string,
  actor: PlanbanHistoryActor,
  request: { op: string; input: unknown; idempotencyKey?: string | undefined },
  plan: (file: GoalsFile, stamp: { revision: number; now: string }) => { goals: GoalsFile | null; summary?: string; notAdded?: string; suggestion?: Record<string, unknown> },
): Promise<GoalsResult> {
  const { planningRoot } = await loadState(cwd);
  // A retry with the same key after a lost reply returns the first answer and changes nothing again.
  const { value } = await runIdempotentBoardMutation({
    planningRoot, idempotencyKey: request.idempotencyKey, scope: `goals.${request.op}`, fingerprint: idempotencyFingerprint(request.input),
    run: () => withRoadmapWriteLock(cwd, async () => {
      const state = await loadState(cwd);
      await settleGoals(state.planningRoot, state.roadmap.revision);
      const file = await readGoalsFile(state.planningRoot, state.roadmap.revision);
      const planned = plan(file, { revision: state.roadmap.revision + 1, now: nowIso() });
      if (!planned.goals) return { page: goalsPage(file), revision: state.roadmap.revision, notAdded: planned.notAdded } as GoalsResult;
      assertGoalsSize(planned.goals);
      await atomicWriteFile(nextGoalsPath(state.planningRoot), JSON.stringify({ ...planned.goals, revision: state.roadmap.revision + 1 }, null, 2) + "\n");
      let roadmap: PlanbanRoadmap;
      try {
        roadmap = await saveRoadmap(state, state.roadmap, { actor, operation: "goals.edit", summary: planned.summary!, affectedCards: [] }, { goalsChange: true });
      } catch (error) {
        await rm(nextGoalsPath(state.planningRoot), { force: true });
        throw error;
      }
      await rename(nextGoalsPath(state.planningRoot), goalsPath(state.planningRoot));
      return { page: goalsPage(planned.goals), revision: roadmap.revision, ...(planned.suggestion ? { suggestion: planned.suggestion } : {}) } as GoalsResult;
    }),
  });
  return value;
}

/** A person's change to the goals. Agents can't: they suggest (suggestGoalChange). */
export async function editGoals(input: { cwd: string; edit: unknown; baseRevision?: number | undefined; actor?: PlanbanHistoryActor | undefined; idempotencyKey?: string | undefined }): Promise<GoalsResult> {
  if (input.actor === "agent") throw new PlanbanValidationError(PEOPLE_ONLY);
  const online = await onlineManifest(input.cwd);
  if (online) return (await onlineOperation<GoalsResult>(resolveProjectCwd(input.cwd), online, "editGoals", input)).result;
  return changeLocalGoals(input.cwd, "user", { op: "edit", input: { edit: input.edit, baseRevision: input.baseRevision }, idempotencyKey: input.idempotencyKey },
    (file, stamp) => applyGoalEdit(file, input.edit, { ...stamp, baseRevision: input.baseRevision, by: "you" })).catch(againIfMoved(() => editGoals(input)));
}

/** A person accepts or dismisses an agent's suggestion. */
export async function decideGoalSuggestion(input: { cwd: string; suggestionId: string; decision: "accept" | "dismiss"; baseRevision?: number | undefined; actor?: PlanbanHistoryActor | undefined; idempotencyKey?: string | undefined }): Promise<GoalsResult> {
  if (input.actor === "agent") throw new PlanbanValidationError(PEOPLE_ONLY);
  const online = await onlineManifest(input.cwd);
  if (online) return (await onlineOperation<GoalsResult>(resolveProjectCwd(input.cwd), online, "decideGoalSuggestion", input)).result;
  return changeLocalGoals(input.cwd, "user", { op: "decide", input: { suggestionId: input.suggestionId, decision: input.decision, baseRevision: input.baseRevision }, idempotencyKey: input.idempotencyKey },
    (file, stamp) => decideSuggestion(file, input, { ...stamp, baseRevision: input.baseRevision, by: "you" })).catch(againIfMoved(() => decideGoalSuggestion(input)));
}

/** An agent suggests one change to the goals, with its reason, for the person to accept or dismiss. */
export async function suggestGoalChange(input: { cwd: string; change: unknown; reason: string; agentName?: string | undefined; idempotencyKey?: string | undefined }): Promise<GoalsResult> {
  const online = await onlineManifest(input.cwd);
  if (online) return (await onlineOperation<GoalsResult>(resolveProjectCwd(input.cwd), online, "suggestGoalChange", { ...input, actor: "agent" } as typeof input)).result;
  const by = appName(input.agentName);
  return changeLocalGoals(input.cwd, "agent", { op: "suggest", input: { change: input.change, reason: input.reason }, idempotencyKey: input.idempotencyKey }, (file, stamp) => {
    const added = addSuggestion(file, input, { ...stamp, by, id: randomUUID() });
    return added.goals ? added : { goals: null, notAdded: added.notAdded };
  }).catch(againIfMoved(() => suggestGoalChange(input)));
}
