import { cp, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import {
  historyDocPath,
  historyIndexPath,
  historyRoadmapPath,
  historyRoot,
  historyVersionRoot,
  PlanbanPathError,
  resolveInsideRoot,
} from "./paths";
import { atomicWriteFile, withBoardWriteLock } from "./persistence";
import { roadmapSchema } from "./schema";
import type {
  PlanbanDocPayload,
  PlanbanHistoryActor,
  PlanbanHistoryDocRef,
  PlanbanHistoryEntry,
  PlanbanHistoryIndex,
  PlanbanHistoryPayload,
  PlanbanResolvedState,
  PlanbanRoadmap,
  PlanbanRoadmapItem,
} from "./types";

const HISTORY_RETENTION = {
  boardVersions: 100,
  cardVersions: 25,
  documentVersions: 25,
  hourlyDays: 2,
  maxAgeDays: 90,
};

// Removing a large backlog of snapshots can take long enough to outlive the
// stale-lock window, so each write removes at most this many directories and
// later writes finish the sweep.
const MAX_HISTORY_DELETIONS_PER_WRITE = 500;
const HISTORY_VERSION_DIR = /^v(\d+)$/;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface PlanbanHistoryMeta {
  actor?: PlanbanHistoryActor | undefined;
  operation: string;
  summary: string;
  affectedCards?: string[] | undefined;
  affectedDocs?: PlanbanHistoryDocRef[] | undefined;
  strictDocs?: boolean | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeHistoryRoadmap(input: unknown): PlanbanRoadmap {
  const parsed = roadmapSchema.parse(input);
  const roadmap: PlanbanRoadmap = {
    ...parsed,
    writerVersion: parsed.version === 2 ? parsed.writerVersion : 0,
    roadmapItems: parsed.roadmapItems.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      summary: item.summary,
      nextAction: item.nextAction,
      tags: item.tags,
      icon: item.icon,
      blockedBy: item.blockedBy?.trim() || null,
      specDoc: item.specDoc,
      planDoc: item.planDoc,
      completedAt: item.completedAt,
      updatedAt: item.updatedAt,
      isGroup: parsed.version === 2
        ? "isGroup" in item
          ? item.isGroup === true
          : "isProgramme" in item && item.isProgramme === true
        : false,
      parentId: parsed.version === 2 && parsed.writerVersion >= 2 ? item.parentId as string | null : null,
      boardRank: parsed.version === 2 && parsed.writerVersion >= 2 ? item.boardRank as number | null : item.priority,
      groupRank: parsed.version === 2 && parsed.writerVersion >= 2
        ? "groupRank" in item
          ? item.groupRank as number | null
          : "programmeRank" in item ? item.programmeRank as number | null : null
        : null,
      ...(item.metadata ? { metadata: item.metadata } : {}),
    })),
  };
  if (parsed.version === 1 || parsed.writerVersion < 2) {
    const counts = new Map<string, number>();
    roadmap.roadmapItems = roadmap.roadmapItems.map((item) => {
      const key = JSON.stringify([item.parentId, item.status]);
      const rank = (counts.get(key) ?? 0) + 1;
      counts.set(key, rank);
      return { ...item, boardRank: rank, groupRank: null };
    });
  }
  if (new Set(roadmap.roadmapItems.map((item) => item.id)).size !== roadmap.roadmapItems.length) {
    throw new Error("Historical Work Item ids must be unique.");
  }
  return roadmap;
}

function emptyIndex(): PlanbanHistoryIndex {
  return {
    version: 1,
    latestVersion: 0,
    retention: HISTORY_RETENTION,
    entries: [],
  };
}

async function readHistoryIndex(planningRoot: string): Promise<PlanbanHistoryIndex> {
  const path = historyIndexPath(planningRoot);
  if (!(await pathExists(path))) return emptyIndex();
  const payload = (await readJson(path)) as PlanbanHistoryIndex;
  return {
    version: 1,
    latestVersion: payload.latestVersion ?? 0,
    retention: { ...HISTORY_RETENTION, ...(payload.retention ?? {}) },
    entries: Array.isArray(payload.entries) ? payload.entries.map((entry) => ({ ...entry, affectedDocs: historyDocRefs(entry.affectedDocs) })) : [],
  };
}

/**
 * An entry's documents as card id and kind. Some older boards list them as a
 * plain path such as "items/<card>/spec.md"; those are read as that card's
 * Spec or Plan, and anything else unrecognisable is left out.
 */
function historyDocRefs(docs: unknown): PlanbanHistoryDocRef[] {
  if (!Array.isArray(docs)) return [];
  return docs.flatMap((doc): PlanbanHistoryDocRef[] => {
    if (typeof doc === "string") {
      const match = /^items\/(.+)\/(spec|plan)\.md$/.exec(doc);
      return match ? [{ cardId: match[1]!, kind: match[2] as "spec" | "plan", path: doc }] : [];
    }
    if (doc && typeof doc === "object" && typeof doc.cardId === "string" && (doc.kind === "spec" || doc.kind === "plan")) {
      return [{ cardId: doc.cardId, kind: doc.kind, path: typeof doc.path === "string" ? doc.path : null }];
    }
    return [];
  });
}

async function writeHistoryIndex(planningRoot: string, index: PlanbanHistoryIndex) {
  await mkdir(dirname(historyIndexPath(planningRoot)), { recursive: true });
  await atomicWriteFile(historyIndexPath(planningRoot), JSON.stringify(index, null, 2) + "\n");
}

function docRefsForRoadmap(roadmap: PlanbanRoadmap): PlanbanHistoryDocRef[] {
  return roadmap.roadmapItems.flatMap((item) => {
    const refs: PlanbanHistoryDocRef[] = [];
    if (item.specDoc) refs.push({ cardId: item.id, kind: "spec", path: item.specDoc });
    if (item.planDoc) refs.push({ cardId: item.id, kind: "plan", path: item.planDoc });
    return refs;
  });
}

async function copyHistoryDoc(state: PlanbanResolvedState, version: number, doc: PlanbanHistoryDocRef, strict = false) {
  if (!doc.path) return;
  let source: string;
  try {
    source = resolveInsideRoot(state.planningRoot, doc.path, `${doc.kind} history document path for ${doc.cardId}`);
  } catch (error) {
    if (error instanceof PlanbanPathError && !strict) return;
    throw error;
  }
  if (!(await pathExists(source))) {
    if (strict) throw new Error(`Required ${doc.kind} history document for ${doc.cardId} does not exist: ${doc.path}`);
    return;
  }
  if (strict) {
    const [realRoot, realSource] = await Promise.all([realpath(state.planningRoot), realpath(source)]);
    const pathFromRoot = relative(realRoot, realSource);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new PlanbanPathError(`${doc.kind} history document path for ${doc.cardId} resolves outside the planning root.`);
    }
    source = realSource;
  }
  const target = historyDocPath(state.planningRoot, version, doc.cardId, doc.kind);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { force: true });
}

async function writeVersionFiles(
  state: PlanbanResolvedState,
  version: number,
  roadmap: PlanbanRoadmap,
  docs: PlanbanHistoryDocRef[],
  strictDocs = false,
) {
  await mkdir(historyVersionRoot(state.planningRoot, version), { recursive: true });
  await atomicWriteFile(historyRoadmapPath(state.planningRoot, version), JSON.stringify(roadmap, null, 2) + "\n");
  for (const doc of docs) await copyHistoryDoc(state, version, doc, strictDocs);
}

/**
 * Tiered retention: the newest `boardVersions` entries are always kept; older
 * entries keep the last version per hour for `hourlyDays`, then the last
 * version per day up to `maxAgeDays`. Buckets use UTC calendar hours and days
 * so the kept set does not depend on the host time zone or DST changes.
 */
export function retainedHistoryEntries(
  entries: PlanbanHistoryEntry[],
  retention: PlanbanHistoryIndex["retention"],
  now = Date.now(),
): PlanbanHistoryEntry[] {
  const hourlyCutoff = now - retention.hourlyDays * DAY_MS;
  const dailyCutoff = now - retention.maxAgeDays * DAY_MS;
  const byVersionDesc = [...entries].sort((a, b) => b.version - a.version);
  const seenBuckets = new Set<string>();
  const kept = byVersionDesc.filter((entry, position) => {
    if (position < retention.boardVersions) return true;
    const createdAt = Date.parse(entry.createdAt);
    if (!(createdAt >= dailyCutoff)) return false;
    const iso = new Date(createdAt).toISOString();
    const bucket = createdAt >= hourlyCutoff ? `h${iso.slice(0, 13)}` : `d${iso.slice(0, 10)}`;
    // Entries are visited newest first, so the first one seen is the bucket's last.
    if (seenBuckets.has(bucket)) return false;
    seenBuckets.add(bucket);
    return true;
  });
  return kept.sort((a, b) => a.version - b.version);
}

async function pruneHistory(
  planningRoot: string,
  index: PlanbanHistoryIndex,
): Promise<{ index: PlanbanHistoryIndex; removeVersions: number[] }> {
  const kept = retainedHistoryEntries(index.entries, index.retention);
  const keptVersions = new Set(kept.map((entry) => entry.version));
  const onDisk = await readdir(historyRoot(planningRoot)).catch(() => [] as string[]);
  const removeVersions = onDisk
    .map((name) => HISTORY_VERSION_DIR.exec(name)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number)
    .filter((version) => !keptVersions.has(version))
    .sort((a, b) => a - b)
    .slice(0, MAX_HISTORY_DELETIONS_PER_WRITE);

  return {
    index: {
      ...index,
      latestVersion: kept.at(-1)?.version ?? 0,
      entries: kept,
    },
    removeVersions,
  };
}

export async function ensureHistoryBaseline(state: PlanbanResolvedState, strictDocs = false): Promise<PlanbanHistoryIndex> {
  return withBoardWriteLock(state.planningRoot, async () => {
  let index = await readHistoryIndex(state.planningRoot);
  if (index.entries.length > 0) return index;

  const baselineRoadmap = state.roadmap.version === 2 && state.roadmap.writerVersion < 6
    ? { ...state.roadmap, writerVersion: 6 as const }
    : state.roadmap;
  const docs = docRefsForRoadmap(state.roadmap);
  const entry: PlanbanHistoryEntry = {
    version: 1,
    roadmapRevision: state.roadmap.revision,
    createdAt: nowIso(),
    actor: "system",
    operation: "baseline",
    summary: "Initial Planban history baseline",
    affectedCards: state.roadmap.roadmapItems.map((item) => item.id),
    affectedDocs: docs,
  };
  try {
    await writeVersionFiles(state, 1, baselineRoadmap, docs, strictDocs);
  } catch (error) {
    await rm(historyVersionRoot(state.planningRoot, 1), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  index = {
    ...index,
    latestVersion: 1,
    entries: [entry],
  };
  await writeHistoryIndex(state.planningRoot, index);
  return index;
  });
}

export async function recordHistoryVersion(
  state: PlanbanResolvedState,
  roadmap: PlanbanRoadmap,
  meta: PlanbanHistoryMeta,
): Promise<PlanbanHistoryEntry> {
  return withBoardWriteLock(state.planningRoot, async () => {
  const baseline = await ensureHistoryBaseline(state, meta.strictDocs === true);
  let index = await readHistoryIndex(state.planningRoot);
  const nextVersion = Math.max(baseline.latestVersion, index.latestVersion) + 1;
  const affectedDocs = meta.affectedDocs ?? [];
  const entry: PlanbanHistoryEntry = {
    version: nextVersion,
    roadmapRevision: roadmap.revision,
    createdAt: nowIso(),
    actor: meta.actor ?? "user",
    operation: meta.operation,
    summary: meta.summary,
    affectedCards: [...new Set(meta.affectedCards ?? [])],
    affectedDocs,
  };

  try {
    await writeVersionFiles(state, nextVersion, roadmap, affectedDocs, meta.strictDocs === true);
  } catch (error) {
    await rm(historyVersionRoot(state.planningRoot, nextVersion), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  index = {
    ...index,
    latestVersion: nextVersion,
    entries: [...index.entries, entry],
  };
  const pruned = await pruneHistory(state.planningRoot, index);
  // Write the index before removing directories: a crash then leaves orphan
  // directories for the next sweep, never index entries without snapshots.
  await writeHistoryIndex(state.planningRoot, pruned.index);
  for (const version of pruned.removeVersions) {
    await rm(historyVersionRoot(state.planningRoot, version), { recursive: true, force: true });
  }
  return entry;
  });
}

export async function listHistory(state: PlanbanResolvedState): Promise<PlanbanHistoryPayload> {
  const index = await ensureHistoryBaseline(state);
  return {
    currentVersion: index.latestVersion,
    retention: index.retention,
    entries: [...index.entries].sort((a, b) => b.version - a.version),
  };
}

export async function readHistoryRoadmap(state: PlanbanResolvedState, version: number): Promise<PlanbanRoadmap> {
  await ensureHistoryBaseline(state);
  const path = historyRoadmapPath(state.planningRoot, version);
  if (!(await pathExists(path))) throw new Error(`History version not found: v${version}`);
  return normalizeHistoryRoadmap(await readJson(path));
}

export async function resolveHistoryDoc(
  state: PlanbanResolvedState,
  version: number,
  cardId: string,
  kind: "spec" | "plan",
): Promise<PlanbanDocPayload> {
  const history = await listHistory(state);
  // The newest stored body at or before the version applies. Usually that
  // version names the document; a board brought back from Online Mode can
  // also hold a body at a version that doesn't, because online pruning moves
  // the body that still applies onto the first kept version.
  const candidates = history.entries
    .filter((entry) => entry.version <= version)
    .sort((a, b) => b.version - a.version);

  for (const entry of candidates) {
    const found = await historyDocAt(state, entry.version, cardId, kind);
    if (found) return found;
  }

  return { cardId, kind, path: null, exists: false, markdown: "", mtimeMs: null };
}

async function historyDocAt(state: PlanbanResolvedState, version: number, cardId: string, kind: "spec" | "plan"): Promise<PlanbanDocPayload | null> {
  const path = historyDocPath(state.planningRoot, version, cardId, kind);
  if (!(await pathExists(path))) return null;
  const stats = await stat(path);
  return { cardId, kind, path, exists: true, markdown: await readFile(path, "utf8"), mtimeMs: stats.mtimeMs };
}

export async function restoreRoadmapFromHistory(input: {
  state: PlanbanResolvedState;
  version: number;
  actor?: PlanbanHistoryActor | undefined;
}): Promise<PlanbanRoadmap> {
  const snapshot = await readHistoryRoadmap(input.state, input.version);
  return {
    ...snapshot,
    revision: input.state.roadmap.revision,
  };
}

export async function restoreCardFromHistory(input: {
  state: PlanbanResolvedState;
  version: number;
  cardId: string;
}): Promise<PlanbanRoadmapItem> {
  const snapshot = await readHistoryRoadmap(input.state, input.version);
  const item = snapshot.roadmapItems.find((entry) => entry.id === input.cardId);
  if (!item) throw new Error(`Card ${input.cardId} does not exist in v${input.version}`);
  return item;
}
