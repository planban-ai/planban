// Pure board domain operations shared by every authority (local files and the
// hosted Online Board service). Nothing here touches files, the network or the
// clock directly: callers pass the current roadmap and `now`, and commit the
// returned candidate roadmap, document writes and history entry themselves.
import { roadmapSchema } from "./schema";
import type {
  PlanbanHistoryActor,
  PlanbanHistoryDocRef,
  PlanbanRoadmap,
  PlanbanRoadmapItem,
  PlanbanStatus,
} from "./types";
import { PLANBAN_STATUSES } from "./types";

export const STATUS_LABELS: Record<PlanbanStatus, string> = {
  "in-progress": "In Progress",
  "up-next": "Up Next",
  pending: "Pending",
  complete: "Complete",
  archived: "Archived",
};

export class PlanbanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanConflictError";
  }
}

/**
 * A write waited for the board while it moved (Take Online or Take Local),
 * so it was not made where it was headed. Nothing was written. Writes that
 * can go to the board's new home are sent there again (againIfMoved).
 */
export class PlanbanBoardMovedError extends PlanbanConflictError {
  constructor() {
    super("This board moved online while this change was waiting for it, so nothing was written to the copy on this computer. Make the change again: it will go to the online board.");
    this.name = "PlanbanBoardMovedError";
  }
}

export class PlanbanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanValidationError";
  }
}

export class PlanbanNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanNotFoundError";
  }
}

export interface PlannedHistory {
  actor: PlanbanHistoryActor;
  operation: string;
  summary: string;
  affectedCards: string[];
  affectedDocs?: PlanbanHistoryDocRef[] | undefined;
}

export interface PlannedDocWrite {
  cardId: string;
  kind: "spec" | "plan";
  /** Path relative to the planning root, e.g. `items/<id>/spec.md`. */
  path: string;
  markdown: string;
}

export interface PlannedChange {
  /** Candidate roadmap before the authority bumps `revision` and `updatedAt`. */
  roadmap: PlanbanRoadmap;
  history: PlannedHistory;
  docWrites: PlannedDocWrite[];
}

export interface PlanContext {
  now: string;
  /** Extra id reservations beyond the roadmap, e.g. leftover item folders. */
  isIdReserved?: ((id: string) => boolean) | undefined;
}

export function assertBaseRevision(roadmap: PlanbanRoadmap, baseRevision?: number) {
  if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || baseRevision < 0)) {
    throw new PlanbanValidationError("baseRevision must be a non-negative integer.");
  }
  if (baseRevision !== undefined && baseRevision !== roadmap.revision) {
    throw new PlanbanConflictError(
      `Roadmap changed from revision ${baseRevision} to ${roadmap.revision}. Reload before saving.`,
    );
  }
}

/** Cards an edit would newly put in complete (current versus candidate roadmap). */
export function newlyCompleted(before: PlanbanRoadmap, after: PlanbanRoadmap) {
  const previous = new Map(before.roadmapItems.map((item) => [item.id, item.status]));
  return after.roadmapItems.filter((item) => item.status === "complete" && previous.get(item.id) !== "complete");
}

export const COMPLETION_CONFIRMATION_MESSAGE = "completionConfirmed must be true when this would put a card in complete (on the command line, --completion-confirmed). Only do this when a person on the board explicitly asks, confirms it after review or testing, or clearly waives review.";

/**
 * Complete is person-controlled: an agent's edit that would complete a card,
 * by any route (move, create, reorder, restore), states that a person
 * confirmed it. A person's own edits need no confirmation.
 */
export function assertCompletionConfirmed(before: PlanbanRoadmap, after: PlanbanRoadmap, actor: string | undefined, completionConfirmed: unknown) {
  if (actor !== "agent" || completionConfirmed === true) return;
  if (newlyCompleted(before, after).length) throw new PlanbanValidationError(COMPLETION_CONFIRMATION_MESSAGE);
}

export function defaultColumns() {
  return PLANBAN_STATUSES.map((id) => ({ id, label: STATUS_LABELS[id] }));
}

/**
 * The progressNotedAt to keep when a card changes without noting progress. Cards from before it
 * existed keep their last update time, so a touch now doesn't hide a merged PR they name.
 */
export function keptProgress(item: PlanbanRoadmapItem): Pick<PlanbanRoadmapItem, "progressNotedAt"> {
  const at = item.progressNotedAt ?? item.updatedAt;
  return at ? { progressNotedAt: at } : {};
}

/** A metadata patch applied to a card's metadata: each key set, a key set to null removed, null clearing all. */
export function patchedMetadata(current: Record<string, unknown> | undefined, patch: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (patch === null) return undefined;
  const next = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length ? next : undefined;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function normalizeRoadmap(input: unknown): PlanbanRoadmap {
  const parsed = roadmapSchema.parse(input);
  const roadmap: PlanbanRoadmap = {
    ...parsed,
    writerVersion: parsed.version === 2 ? parsed.writerVersion : 0,
    columns: parsed.columns.length > 0 ? parsed.columns : defaultColumns(),
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
      ...(item.progressNotedAt ? { progressNotedAt: item.progressNotedAt } : {}),
      isGroup: parsed.version === 2
        ? parsed.writerVersion >= 6
          ? "isGroup" in item && item.isGroup === true
          : "isProgramme" in item && item.isProgramme === true
        : false,
      parentId: parsed.version === 2 && parsed.writerVersion >= 2 ? item.parentId as string | null : null,
      boardRank: parsed.version === 2 && parsed.writerVersion >= 2
        ? item.boardRank as number | null
        : item.priority,
      groupRank: parsed.version === 2 && parsed.writerVersion >= 2
        ? parsed.writerVersion >= 6
          ? "groupRank" in item ? item.groupRank as number | null : null
          : "programmeRank" in item ? item.programmeRank as number | null : null
        : null,
      ...(item.metadata ? { metadata: item.metadata } : {}),
    })),
  };
  if (parsed.version === 1 || parsed.writerVersion < 6) {
    roadmap.roadmapItems = assignHierarchyRanks(roadmap.roadmapItems);
  }
  assertRoadmapRelations(roadmap);
  return roadmap;
}

export function assertRoadmapRelations(roadmap: PlanbanRoadmap): void {
  const byId = new Map(roadmap.roadmapItems.map((item) => [item.id, item]));
  if (byId.size !== roadmap.roadmapItems.length) {
    throw new PlanbanValidationError("Work Item ids must be unique.");
  }
  for (const item of roadmap.roadmapItems) {
    if (item.isGroup && item.parentId !== null) {
      throw new PlanbanValidationError(`Group ${item.id} must remain on the Main Board.`);
    }
    if (item.parentId === null) {
      if (!Number.isInteger(item.boardRank) || (item.boardRank ?? 0) < 1 || item.groupRank !== null) {
        throw new PlanbanValidationError(`Root ${item.id} must have a positive Board Rank and no Group Rank.`);
      }
    } else if (!Number.isInteger(item.groupRank) || (item.groupRank ?? 0) < 1 || item.boardRank !== null) {
      throw new PlanbanValidationError(`Owned item ${item.id} must have a positive Group Rank and no Board Rank.`);
    }
    if (item.parentId !== null && !byId.has(item.parentId)) {
      throw new PlanbanValidationError(`Parent not found for ${item.id}: ${item.parentId}`);
    }
    if (item.parentId !== null && byId.get(item.parentId)?.isGroup !== true) {
      throw new PlanbanValidationError(`Parent ${item.parentId} must have the Group role.`);
    }
    if (item.parentId === item.id) throw new PlanbanValidationError(`${item.id} cannot parent itself.`);
    if (item.blockedBy !== null && !byId.has(item.blockedBy)) {
      throw new PlanbanValidationError(`Dependency not found for ${item.id}: ${item.blockedBy}`);
    }
    if (item.blockedBy === item.id) throw new PlanbanValidationError(`${item.id} cannot block itself.`);
    for (const relation of ["parentId", "blockedBy"] as const) {
      const seen = new Set([item.id]);
      let cursor = item[relation];
      while (cursor) {
        if (seen.has(cursor)) throw new PlanbanValidationError(`${relation === "parentId" ? "Hierarchy" : "Dependency"} cycle detected at ${item.id}.`);
        seen.add(cursor);
        cursor = byId.get(cursor)?.[relation] ?? null;
      }
    }
  }
  const ranksByScope = new Map<string, number[]>();
  for (const item of roadmap.roadmapItems) {
    const key = JSON.stringify([item.parentId, item.status]);
    const ranks = ranksByScope.get(key) ?? [];
    ranks.push((item.parentId === null ? item.boardRank : item.groupRank)!);
    ranksByScope.set(key, ranks);
  }
  for (const [scope, ranks] of ranksByScope) {
    ranks.sort((a, b) => a - b);
    if (ranks.some((rank, index) => rank !== index + 1)) {
      throw new PlanbanValidationError(`Ranks must be unique and contiguous in ${scope}.`);
    }
  }
}

export function assertGroupLifecycle(candidate: PlanbanRoadmap): void {
  for (const group of candidate.roadmapItems.filter((entry) =>
    entry.isGroup && (entry.status === "complete" || entry.status === "archived")
  )) {
    const openItem = candidate.roadmapItems.find((entry) =>
      entry.parentId === group.id && entry.status !== "complete" && entry.status !== "archived"
    );
    if (openItem) {
      throw new PlanbanConflictError(
        `Cannot move ${group.title} to ${STATUS_LABELS[group.status]} while Item ${openItem.title} remains ${STATUS_LABELS[openItem.status]}.`,
      );
    }
  }
}

/** Checks every invariant an authority must enforce before committing a candidate. */
export function assertCommittable(candidate: PlanbanRoadmap): void {
  assertRoadmapRelations(candidate);
  assertGroupLifecycle(candidate);
}

export function cardAncestry(roadmap: PlanbanRoadmap, cardId: string): PlanbanRoadmapItem[] {
  const byId = new Map(roadmap.roadmapItems.map((item) => [item.id, item]));
  const item = byId.get(cardId);
  if (!item) throw new PlanbanNotFoundError(`Card not found: ${cardId}`);
  const result: PlanbanRoadmapItem[] = [];
  let parentId = item.parentId;
  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) throw new PlanbanValidationError(`Parent not found: ${parentId}`);
    result.unshift(parent);
    parentId = parent.parentId;
  }
  return result;
}

export function createEmptyRoadmap(input: { repoId: string; title: string; now: string }): PlanbanRoadmap {
  return {
    version: 2,
    writerVersion: 6,
    revision: 1,
    updatedAt: input.now,
    project: {
      id: input.repoId,
      title: input.title,
      status: "active",
      description: "",
      tags: [],
    },
    columns: defaultColumns(),
    roadmapItems: [],
  };
}

/** Bumps revision and timestamp the way every authority must when committing. */
export function committedRoadmap(candidate: PlanbanRoadmap, now: string): PlanbanRoadmap {
  return {
    ...candidate,
    version: 2,
    writerVersion: 6,
    revision: candidate.revision + 1,
    updatedAt: now,
  };
}

export function normalizeColumnPriorities(items: PlanbanRoadmapItem[]): PlanbanRoadmapItem[] {
  return assignHierarchyRanks(PLANBAN_STATUSES.flatMap((status) =>
    items
      .filter((item) => item.status === status)
      .map((item, index) => ({ ...item, priority: index + 1 })),
  ));
}

export function assignColumnPriorities(items: PlanbanRoadmapItem[]): PlanbanRoadmapItem[] {
  const counts = new Map<PlanbanStatus, number>();
  return assignHierarchyRanks(items.map((item) => {
    const priority = (counts.get(item.status) ?? 0) + 1;
    counts.set(item.status, priority);
    return { ...item, priority };
  }));
}

export function assignHierarchyRanks(items: PlanbanRoadmapItem[]): PlanbanRoadmapItem[] {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const key = JSON.stringify([item.parentId, item.status]);
    const rank = (counts.get(key) ?? 0) + 1;
    counts.set(key, rank);
    return { ...item, boardRank: item.parentId === null ? rank : null, groupRank: item.parentId === null ? null : rank };
  });
}

export type PlanbanCreateCardPosition = "top" | "bottom";

export function defaultSpecMarkdown(input: { title: string }) {
  return `# ${input.title} Spec\n\nStatus: **Draft. Complete the Current state section before using this Spec for execution.**\n\n## Purpose\n\nDescribe why this Item or Group exists.\n\n## Target outcome\n\nDescribe the future success condition.\n\n## Current state\n\nState what is true now. This section is authoritative for current execution after review.\n\n## Agent reference\n\nRecord applicable scope, decisions, constraints, acceptance, verification, rollback, and authoritative links.\n`;
}

function insertCreatedCard(
  items: PlanbanRoadmapItem[],
  item: PlanbanRoadmapItem,
  input: { position?: PlanbanCreateCardPosition | undefined; afterId?: string | undefined },
) {
  if (input.position !== undefined && input.position !== "top" && input.position !== "bottom") {
    throw new Error("position must be top or bottom");
  }

  if (input.afterId) {
    const afterIndex = items.findIndex((entry) => entry.id === input.afterId);
    if (afterIndex < 0) throw new Error(`afterId not found: ${input.afterId}`);
    if (items[afterIndex]?.status !== item.status) {
      throw new Error(`afterId must refer to a card in ${STATUS_LABELS[item.status]}`);
    }
    if (items[afterIndex]?.parentId !== item.parentId) {
      throw new Error("afterId must refer to a sibling in the same Group or on the main board");
    }
    const result = [...items];
    result.splice(afterIndex + 1, 0, item);
    return result;
  }

  const result = [...items];
  if (input.position === "top") {
    const firstTargetIndex = result.findIndex((entry) => entry.status === item.status);
    if (firstTargetIndex >= 0) result.splice(firstTargetIndex, 0, item);
    else result.push(item);
    return result;
  }

  const lastTargetIndex = result.map((entry) => entry.status).lastIndexOf(item.status);
  if (lastTargetIndex >= 0) result.splice(lastTargetIndex + 1, 0, item);
  else result.push(item);
  return result;
}

function findCard(roadmap: PlanbanRoadmap, cardId: string): PlanbanRoadmapItem {
  const item = roadmap.roadmapItems.find((entry) => entry.id === cardId);
  if (!item) throw new Error(`Card not found: ${cardId}`);
  return item;
}

function slugId(title: string) {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function resolveGroupParent(roadmap: PlanbanRoadmap, parentIdInput: string | null | undefined) {
  if (typeof parentIdInput === "string" && !parentIdInput.trim()) {
    throw new PlanbanValidationError("parentId must be a non-empty card id or null.");
  }
  const parentId = parentIdInput?.trim() || null;
  const parent = parentId ? roadmap.roadmapItems.find((entry) => entry.id === parentId) : null;
  if (parentId && !parent) throw new PlanbanNotFoundError(`Parent not found: ${parentId}`);
  if (parent && parent.parentId !== null) {
    throw new PlanbanValidationError("An owned Item cannot own another Work Item. Move it to the Main Board first.");
  }
  if (parent && !parent.isGroup) {
    throw new PlanbanValidationError("The destination must be an existing Group.");
  }
  return { parentId, parent: parent ?? null };
}

export interface MoveCardInput {
  cardId: string;
  status?: PlanbanStatus | undefined;
  parentId?: string | null | undefined;
  afterId?: string | null | undefined;
  actor?: PlanbanHistoryActor | undefined;
}

export function planMoveCard(roadmap: PlanbanRoadmap, input: MoveCardInput, ctx: PlanContext): PlannedChange {
  const item = findCard(roadmap, input.cardId);
  if (input.status === undefined && input.parentId === undefined && input.afterId === undefined) {
    throw new PlanbanValidationError("A status, parentId, or rank position is required.");
  }
  if (typeof input.parentId === "string" && !input.parentId.trim()) {
    throw new PlanbanValidationError("parentId must be a non-empty card id or null.");
  }
  const status = input.status ?? item.status;
  const parentId = input.parentId === undefined ? item.parentId : input.parentId?.trim() || null;
  if (parentId === item.id) throw new PlanbanValidationError(`${item.id} cannot parent itself.`);
  const parent = parentId ? roadmap.roadmapItems.find((entry) => entry.id === parentId) : null;
  if (parentId && !parent) throw new PlanbanNotFoundError(`Parent not found: ${parentId}`);
  if (parentId && item.isGroup) {
    throw new PlanbanValidationError("A Group cannot be placed inside another Group.");
  }
  if (parent && parent.parentId !== null) {
    throw new PlanbanValidationError("An owned Item cannot own another Work Item. Move it to the Main Board first.");
  }
  if (parent && !parent.isGroup) {
    throw new PlanbanValidationError("The destination must be an existing Group.");
  }
  if (typeof input.afterId === "string") {
    const after = roadmap.roadmapItems.find((entry) => entry.id === input.afterId);
    if (!after) throw new PlanbanNotFoundError(`afterId not found: ${input.afterId}`);
    if (after.id === item.id || after.parentId !== parentId || after.status !== status) {
      throw new PlanbanValidationError("afterId must refer to another Work Item in the target ownership and status scope.");
    }
  }

  const remaining = roadmap.roadmapItems.filter((entry) => entry.id !== input.cardId);
  const moved = {
    ...item,
    status,
    parentId,
    completedAt: status === "complete" ? item.completedAt ?? ctx.now : null,
    updatedAt: ctx.now,
    // Completing a card settles any merged PR it names; other moves leave that warning alone.
    ...(status === "complete" && item.status !== "complete" ? { progressNotedAt: ctx.now } : keptProgress(item)),
  };
  const result: PlanbanRoadmapItem[] = [];
  let inserted = false;

  for (const entry of remaining) {
    if (input.afterId === null && !inserted && entry.parentId === parentId && entry.status === status) {
      result.push(moved);
      inserted = true;
    }
    result.push(entry);
    if (typeof input.afterId === "string" && entry.id === input.afterId) {
      result.push(moved);
      inserted = true;
    }
  }

  if (!inserted) {
    const lastTargetIndex = result.map((entry) => entry.parentId === parentId && entry.status === status).lastIndexOf(true);
    if (lastTargetIndex >= 0) result.splice(lastTargetIndex + 1, 0, moved);
    else result.push(moved);
  }

  return {
    roadmap: { ...roadmap, roadmapItems: normalizeColumnPriorities(result) },
    history: {
      actor: input.actor ?? "user",
      operation: parentId !== item.parentId ? "card.parent.update" : "card.move",
      summary: parentId !== item.parentId
        ? parent ? `Moved ${item.title} into ${parent.title}` : `Moved ${item.title} to the main board`
        : status !== item.status ? `Moved ${item.title} to ${STATUS_LABELS[status]}` : `Placed ${item.title} in ${STATUS_LABELS[status]}`,
      affectedCards: parent ? [item.id, parent.id] : [item.id],
    },
    docWrites: [],
  };
}

export interface UpdateCardInput {
  cardId: string;
  title?: string | undefined;
  summary?: string | null | undefined;
  nextAction?: string | null | undefined;
  tags?: string[] | undefined;
  blockedBy?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  actor?: PlanbanHistoryActor | undefined;
}

export function planUpdateCard(roadmap: PlanbanRoadmap, input: UpdateCardInput, ctx: PlanContext): PlannedChange {
  const item = findCard(roadmap, input.cardId);
  const title = input.title === undefined ? undefined : input.title.trim();
  if (title !== undefined && !title) throw new PlanbanValidationError("title is required");

  const changed: PlanbanRoadmapItem = {
    ...item,
    ...(title !== undefined ? { title } : {}),
    ...(input.summary !== undefined ? { summary: input.summary?.trim() || null } : {}),
    ...(input.nextAction !== undefined ? { nextAction: input.nextAction?.trim() || null } : {}),
    ...(input.tags !== undefined ? { tags: input.tags.map((tag) => tag.trim()).filter(Boolean) } : {}),
    ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy?.trim() || null } : {}),
  };
  // Metadata is a patch: the keys given are set, a key given as null is removed, and null clears it all.
  const metadata = input.metadata === undefined ? item.metadata : patchedMetadata(item.metadata, input.metadata);
  delete changed.metadata;
  if (metadata) changed.metadata = metadata;
  const progressed = changed.summary !== item.summary || changed.nextAction !== item.nextAction;
  // An update that changes nothing leaves the card's times alone, so it doesn't read as activity.
  const real = progressed || (["title", "tags", "blockedBy", "metadata"] as const).some((field) => !sameValue(changed[field], item[field]));
  const updatedItem: PlanbanRoadmapItem = {
    ...changed,
    ...(real ? { updatedAt: ctx.now } : {}),
    ...(progressed ? { progressNotedAt: ctx.now } : real ? keptProgress(item) : {}),
  };

  if (input.blockedBy !== undefined) {
    const blockerId = input.blockedBy?.trim() || null;
    if (blockerId === item.id) throw new PlanbanValidationError(`${item.id} cannot block itself.`);
    if (blockerId && !roadmap.roadmapItems.some((entry) => entry.id === blockerId)) {
      throw new PlanbanNotFoundError(`Dependency not found: ${blockerId}`);
    }
    assertRoadmapRelations({
      ...roadmap,
      roadmapItems: roadmap.roadmapItems.map((entry) => entry.id === item.id ? updatedItem : entry),
    });
  }

  return {
    roadmap: {
      ...roadmap,
      roadmapItems: roadmap.roadmapItems.map((entry) => entry.id === input.cardId ? updatedItem : entry),
    },
    history: {
      actor: input.actor ?? "user",
      operation: "card.update",
      summary: !real
        ? `Saved ${item.title} unchanged`
        : title !== undefined && title !== item.title
          ? `Renamed ${item.title} to ${title}`
          : `Updated ${item.title}`,
      // An edit that changes nothing touches no card, so freshness checks never count it as activity.
      affectedCards: real ? [item.id] : [],
    },
    docWrites: [],
  };
}

export function planDeleteArchivedCard(roadmap: PlanbanRoadmap, input: { cardId: string }): PlannedChange {
  const item = findCard(roadmap, input.cardId);
  if (item.status !== "archived") {
    throw new PlanbanConflictError("Only archived cards can be deleted.");
  }
  if (roadmap.roadmapItems.some((entry) => entry.parentId === item.id)) {
    throw new PlanbanConflictError("A Group with children cannot be deleted.");
  }
  return {
    roadmap: {
      ...roadmap,
      roadmapItems: normalizeColumnPriorities(roadmap.roadmapItems.filter((entry) => entry.id !== input.cardId)),
    },
    history: {
      actor: "user",
      operation: "card.delete",
      summary: `Deleted ${item.title}`,
      affectedCards: [item.id],
    },
    docWrites: [],
  };
}

export function planReorderCards(
  roadmap: PlanbanRoadmap,
  input: { items: Array<{ id: string; status: PlanbanStatus }> },
  ctx: PlanContext,
): PlannedChange {
  const existingById = new Map(roadmap.roadmapItems.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const reordered: PlanbanRoadmapItem[] = [];

  for (const entry of input.items) {
    const existing = existingById.get(entry.id);
    if (!existing) throw new Error(`Unknown card in reorder payload: ${entry.id}`);
    if (seen.has(entry.id)) throw new Error(`Duplicate card in reorder payload: ${entry.id}`);
    seen.add(entry.id);
    reordered.push(existing.status === entry.status ? existing : {
      ...existing,
      status: entry.status,
      updatedAt: ctx.now,
      ...(entry.status === "complete" ? { progressNotedAt: ctx.now } : keptProgress(existing)),
    });
  }

  if (seen.size !== existingById.size) {
    throw new Error("Reorder payload must include every card id");
  }

  return {
    roadmap: { ...roadmap, roadmapItems: normalizeColumnPriorities(reordered) },
    history: {
      actor: "user",
      operation: "cards.reorder",
      summary: "Reordered board cards",
      affectedCards: input.items.map((item) => item.id),
    },
    docWrites: [],
  };
}

export interface CreateCardInput {
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
}

export function planCreateCard(
  roadmap: PlanbanRoadmap,
  input: CreateCardInput,
  ctx: PlanContext,
): PlannedChange & { cardId: string } {
  const title = input.title.trim();
  if (!title) throw new Error("title is required");
  const baseId = slugId(input.title);
  const existingIds = new Set(roadmap.roadmapItems.map((item) => item.id));
  let id = baseId || "card";
  let suffix = 2;
  while (existingIds.has(id) || ctx.isIdReserved?.(id)) {
    id = `${baseId || "card"}-${suffix}`;
    suffix += 1;
  }

  const status = input.status ?? "pending";
  const { parentId, parent } = resolveGroupParent(roadmap, input.parentId);
  const priority = roadmap.roadmapItems.filter((item) => item.status === status && item.parentId === parentId).length + 1;
  const item: PlanbanRoadmapItem = {
    id,
    title,
    status,
    priority,
    summary: input.summary?.trim() || null,
    nextAction: input.nextAction?.trim() || null,
    tags: input.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [],
    icon: null,
    blockedBy: null,
    specDoc: `items/${id}/spec.md`,
    planDoc: input.planMarkdown !== undefined ? `items/${id}/plan.md` : null,
    completedAt: null,
    updatedAt: ctx.now,
    isGroup: false,
    parentId,
    boardRank: parentId === null ? priority : null,
    groupRank: parentId === null ? null : priority,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };

  const docWrites: PlannedDocWrite[] = [
    { cardId: id, kind: "spec", path: item.specDoc!, markdown: input.specMarkdown ?? defaultSpecMarkdown({ title }) },
  ];
  if (item.planDoc !== null && input.planMarkdown !== undefined) {
    docWrites.push({ cardId: id, kind: "plan", path: item.planDoc, markdown: input.planMarkdown });
  }

  return {
    cardId: id,
    roadmap: { ...roadmap, roadmapItems: assignColumnPriorities(insertCreatedCard(roadmap.roadmapItems, item, input)) },
    history: {
      actor: input.actor ?? "user",
      operation: "card.create",
      summary: `Created ${item.title}`,
      affectedCards: parent ? [item.id, parent.id] : [item.id],
      affectedDocs: docWrites.map((doc) => ({ cardId: doc.cardId, kind: doc.kind, path: doc.path })),
    },
    docWrites,
  };
}

export interface CreateGroupInput {
  title: string;
  summary?: string | undefined;
  nextAction?: string | undefined;
  status?: PlanbanStatus | undefined;
  itemIds?: string[] | undefined;
  anchorId?: string | undefined;
  specMarkdown?: string | undefined;
  planMarkdown?: string | undefined;
  actor?: PlanbanHistoryActor | undefined;
}

export function planCreateGroup(
  roadmap: PlanbanRoadmap,
  input: CreateGroupInput,
  ctx: PlanContext,
): PlannedChange & { groupId: string } {
  const title = input.title.trim();
  if (!title) throw new PlanbanValidationError("title is required");
  const summary = input.summary?.trim() || null;

  const itemIds = [...new Set((input.itemIds ?? []).map((id) => id.trim()))];
  if (itemIds.some((id) => !id)) throw new PlanbanValidationError("itemIds must contain non-empty card ids.");
  const itemIdSet = new Set(itemIds);
  const items = itemIds.map((id) => {
    const item = roadmap.roadmapItems.find((entry) => entry.id === id);
    if (!item) throw new PlanbanNotFoundError(`Item not found: ${id}`);
    if (item.isGroup) throw new PlanbanValidationError(`${item.title} is a Group and cannot be placed inside another Group.`);
    if (item.parentId !== null) throw new PlanbanValidationError(`${item.title} is already owned by a Group. Move it to the Main Board first.`);
    return item;
  });
  const anchorId = input.anchorId?.trim();
  if (anchorId && !itemIdSet.has(anchorId)) {
    throw new PlanbanValidationError("anchorId must identify one of the initial Items.");
  }
  const anchor = anchorId ? items.find((item) => item.id === anchorId)! : null;

  const baseId = slugId(title);
  const existingIds = new Set(roadmap.roadmapItems.map((item) => item.id));
  let id = baseId || "group";
  let suffix = 2;
  while (existingIds.has(id) || ctx.isIdReserved?.(id)) {
    id = `${baseId || "group"}-${suffix}`;
    suffix += 1;
  }

  const status = input.status ?? anchor?.status ?? "pending";
  const group: PlanbanRoadmapItem = {
    id,
    title,
    status,
    priority: 1,
    summary,
    nextAction: input.nextAction?.trim() || null,
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: `items/${id}/spec.md`,
    planDoc: input.planMarkdown !== undefined ? `items/${id}/plan.md` : null,
    completedAt: null,
    updatedAt: ctx.now,
    isGroup: true,
    parentId: null,
    boardRank: 1,
    groupRank: null,
  };

  const anchorIndex = anchor ? roadmap.roadmapItems.findIndex((item) => item.id === anchor.id) : roadmap.roadmapItems.length;
  const remaining = roadmap.roadmapItems.filter((item) => !itemIdSet.has(item.id));
  const rootsBeforeAnchor = roadmap.roadmapItems.slice(0, anchorIndex).filter((item) => !itemIdSet.has(item.id)).length;
  const ownedItems = roadmap.roadmapItems
    .filter((item) => itemIdSet.has(item.id))
    .map((item) => ({ ...item, parentId: id, boardRank: null, groupRank: 1, updatedAt: ctx.now, ...keptProgress(item) }));
  const arranged = [...remaining];
  arranged.splice(rootsBeforeAnchor, 0, group);
  arranged.push(...ownedItems);

  const docWrites: PlannedDocWrite[] = [
    { cardId: id, kind: "spec", path: group.specDoc!, markdown: input.specMarkdown ?? defaultSpecMarkdown({ title }) },
  ];
  if (group.planDoc && input.planMarkdown !== undefined) {
    docWrites.push({ cardId: id, kind: "plan", path: group.planDoc, markdown: input.planMarkdown });
  }

  return {
    groupId: id,
    roadmap: { ...roadmap, roadmapItems: normalizeColumnPriorities(arranged) },
    history: {
      actor: input.actor ?? "user",
      operation: "group.create",
      summary: items.length > 0
        ? `Created ${title} with ${items.length} ${items.length === 1 ? "Item" : "Items"}`
        : `Created empty Group ${title}`,
      affectedCards: [id, ...itemIds],
      affectedDocs: docWrites.map((doc) => ({ cardId: doc.cardId, kind: doc.kind, path: doc.path })),
    },
    docWrites,
  };
}

export interface CreateCardsInput {
  titles: string[];
  status?: PlanbanStatus | undefined;
  parentId?: string | null | undefined;
  actor?: PlanbanHistoryActor | undefined;
}

export function planCreateCards(
  roadmap: PlanbanRoadmap,
  input: CreateCardsInput,
  ctx: PlanContext,
): PlannedChange & { cardIds: string[] } {
  const titles = input.titles.map((title) => title.trim());
  if (titles.length === 0 || titles.some((title) => !title)) {
    throw new PlanbanValidationError("titles must contain at least one non-empty title.");
  }
  const parentId = input.parentId?.trim() || null;
  const parent = parentId ? roadmap.roadmapItems.find((entry) => entry.id === parentId) : null;
  if (parentId && !parent) throw new PlanbanNotFoundError(`Parent not found: ${parentId}`);
  if (parent && parent.parentId !== null) {
    throw new PlanbanValidationError("An owned Item cannot own another Work Item. Move it to the Main Board first.");
  }
  if (parent && !parent.isGroup) {
    throw new PlanbanValidationError("The destination must be an existing Group.");
  }
  const status = input.status ?? "pending";
  const existingIds = new Set(roadmap.roadmapItems.map((item) => item.id));
  const createdItems: PlanbanRoadmapItem[] = [];
  for (const title of titles) {
    const baseId = slugId(title) || "card";
    let id = baseId;
    let suffix = 2;
    while (existingIds.has(id) || ctx.isIdReserved?.(id)) { id = `${baseId}-${suffix}`; suffix += 1; }
    existingIds.add(id);
    createdItems.push({
      id,
      title,
      status,
      priority: 1,
      summary: null,
      nextAction: null,
      tags: [],
      icon: null,
      blockedBy: null,
      specDoc: `items/${id}/spec.md`,
      planDoc: null,
      completedAt: null,
      updatedAt: ctx.now,
      isGroup: false,
      parentId,
      boardRank: parentId === null ? 1 : null,
      groupRank: parentId === null ? null : 1,
    });
  }
  const docWrites = createdItems.map((item) => ({
    cardId: item.id,
    kind: "spec" as const,
    path: item.specDoc!,
    markdown: defaultSpecMarkdown({ title: item.title }),
  }));
  return {
    cardIds: createdItems.map((item) => item.id),
    roadmap: { ...roadmap, roadmapItems: assignColumnPriorities([...roadmap.roadmapItems, ...createdItems]) },
    history: {
      actor: input.actor ?? "user",
      operation: "cards.create",
      summary: `Created ${createdItems.length} Items`,
      affectedCards: [...createdItems.map((item) => item.id), ...(parent ? [parent.id] : [])],
      affectedDocs: docWrites.map((doc) => ({ cardId: doc.cardId, kind: doc.kind, path: doc.path })),
    },
    docWrites,
  };
}

/**
 * Resolves where a document lives and, when the card has no path for that kind
 * yet, returns the candidate roadmap that records the new path.
 */
export function planWriteDoc(
  roadmap: PlanbanRoadmap,
  input: { cardId: string; kind: "spec" | "plan" },
  ctx: PlanContext,
): { item: PlanbanRoadmapItem; path: string; roadmap: PlanbanRoadmap | null; history: PlannedHistory } {
  const item = findCard(roadmap, input.cardId);
  const existingPath = input.kind === "spec" ? item.specDoc : item.planDoc;
  const path = existingPath ?? `items/${item.id}/${input.kind}.md`;
  const candidate = existingPath
    ? null
    : {
        ...roadmap,
        roadmapItems: roadmap.roadmapItems.map((entry) =>
          entry.id === item.id
            ? { ...entry, ...(input.kind === "spec" ? { specDoc: path } : { planDoc: path }), updatedAt: ctx.now, ...keptProgress(entry) }
            : entry,
        ),
      };
  return {
    item,
    path,
    roadmap: candidate,
    history: {
      actor: "user",
      operation: "doc.write",
      summary: `Edited ${item.title} ${input.kind}`,
      affectedCards: [item.id],
      affectedDocs: [{ cardId: item.id, kind: input.kind, path }],
    },
  };
}
