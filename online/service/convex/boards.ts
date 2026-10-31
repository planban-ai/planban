// The Online Board authority. Every change runs the shared planning rules from
// src/core/boardOperations.ts inside one Convex mutation, so the revision
// check, roadmap, documents and history version commit together or not at all.
import { v, type Value } from "convex/values";
import {
  assertBaseRevision,
  assertCommittable,
  COMPLETION_CONFIRMATION_MESSAGE,
  newlyCompleted,
  committedRoadmap,
  planCreateCard,
  planCreateCards,
  planCreateGroup,
  planDeleteArchivedCard,
  planMoveCard,
  planReorderCards,
  planUpdateCard,
  planWriteDoc,
  normalizeColumnPriorities,
  type PlannedChange,
} from "../../../src/core/boardOperations";
import type { PlanbanHistoryEntry, PlanbanHistoryPayload, PlanbanRoadmap } from "../../../src/core/types";
import { cardSubject, changesSince, clashSubject, conflictMessage, MAX_CONFLICT_CHANGES, MAX_CONFLICT_DOCUMENT_CHARS, RECONCILE, type ConflictDetails } from "../../../src/core/conflicts";
import { editSection, type SectionEdit } from "../../../src/core/docSections";
import { fieldValue, rebaseEdit, settlingFields, touchedFields, type FieldClash } from "../../../src/core/concurrent";
import { MAX_PER_BOARD, publicUnresolved, recordUnresolved, settledBy, unresolvedOn } from "./model/unresolved";
import { checkIndexValue, MAX_CARD_BYTES, MAX_DOCUMENT_BYTES } from "../../../src/core/contentRules";
import { appName, touchPresence, workingOn, workingSentence } from "./model/presence";
import type { Doc } from "./_generated/dataModel";
import { boardFeatures } from "../../../src/core/clientVersion";
import { addSuggestion, applyGoalEdit, assertGoalsSize, decideSuggestion, goalsPage, normalizeGoals, PEOPLE_ONLY, type GoalsFile } from "../../../src/core/goals";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { asAgent, boardAccess, liveConnection, reaches, refusalFor, type BoardAccess } from "./model/access";
import { packed, packJson, packText, unpackJson, unpackText } from "./model/codec";
import { asServiceError, fail, type ServiceErrorData } from "./model/errors";
import { checkCards, checkDocuments } from "./model/indexRules";
import { addStored, chargeWrite, sizeOf } from "./model/limits";
import { historyEntries, historyPage, recordHistory, roadmapAtVersion, type Attribution, type BoardRows } from "./model/history";
import { DOC_KINDS, currentRoadmap, docPayload, docRow, live, retiredIds, stateRow, type DocKind } from "./model/rows";
import { reserveRetiredId } from "./model/retired";
import { planClearLanding } from "../../../src/core/landings";
import { confirmedRepos } from "./model/githubLinks";

export const BOARD_OPERATIONS = [
  "createCard", "createCards", "createGroup", "updateCard", "moveCard",
  "setCardParent", "reorderCards", "deleteArchivedCard", "writeDoc",
  "restoreBoard", "restoreCard", "restoreDoc", "dropChange", "writeDocSection",
  "editGoals", "suggestGoalChange", "decideGoalSuggestion", "clearLanding",
] as const;
export type BoardOperation = (typeof BOARD_OPERATIONS)[number];

export interface BoardBundle {
  format: "planban-board-bundle";
  version: 1;
  roadmap: PlanbanRoadmap;
  docs: Array<{ cardId: string; kind: DocKind; markdown: string }>;
  history: Array<{ entry: PlanbanHistoryEntry; roadmap: PlanbanRoadmap }>;
  historyDocs?: Array<{ version: number; cardId: string; kind: DocKind; markdown: string }>;
  retiredIds?: string[];
  retention?: unknown;
}

// ---- helpers ------------------------------------------------------------

/** Who a request's change is credited to: always a person or their agent, never an integration. */
export function attributionFor(connection: Doc<"connections">, actor: unknown): Attribution & { actor: "user" | "agent" } {
  return { userId: connection.userId, clientName: connection.clientName, actor: connection.canAdminister && actor === "user" ? "user" : "agent", connectionId: connection._id };
}

/** Writes the roadmap, documents and one history version. Runs inside the caller's mutation. */
export async function commit(ctx: MutationCtx, board: Doc<"boards">, previous: PlanbanRoadmap, change: PlannedChange, attribution: Attribution, now: string) {
  assertCommittable(change.roadmap);
  // Planban is an index, not storage (owner decision 18).
  checkCards(change.roadmap, previous);
  checkDocuments(change.docWrites);
  const at = live(board);
  const committed = committedRoadmap(change.roadmap, now);
  // Daily limits for the account, and the board's own size limit (model/limits.ts).
  const before = new Map(previous.roadmapItems.map((item) => [item.id, JSON.stringify(item)]));
  const written = committed.roadmapItems.reduce((sum, item) => sum + (before.get(item.id) === JSON.stringify(item) ? 0 : sizeOf(item)), 0)
    + change.docWrites.reduce((sum, doc) => sum + sizeOf(doc.markdown), 0);
  await chargeWrite(ctx, attribution.userId, written);
  const state = await stateRow(ctx, at);
  const packedRoadmap = packJson(committed);
  await ctx.db.patch(state._id, { roadmap: packedRoadmap });
  await addStored(ctx, at, sizeOf(packedRoadmap) - sizeOf(state.roadmap));
  const remaining = new Set(committed.roadmapItems.map((item) => item.id));
  for (const item of previous.roadmapItems) {
    if (remaining.has(item.id)) continue;
    // Deleted ids are never reused, so history keeps one meaning per id.
    await reserveRetiredId(ctx, at, item.id);
    for (const kind of ["spec", "plan"] as const) {
      const row = await docRow(ctx, at, item.id, kind);
      if (row) {
        await ctx.db.delete(row._id);
        await addStored(ctx, at, -sizeOf(row.markdown));
      }
    }
  }
  for (const doc of change.docWrites) {
    const row = await docRow(ctx, at, doc.cardId, doc.kind);
    const stamp = Math.max(Date.now(), (row?.stamp ?? 0) + 1);
    const fields = {
      markdown: packText(doc.markdown), stamp, updatedAt: now, updatedBy: attribution.userId,
      updatedByAgent: attribution.actor === "agent", updatedByClient: attribution.clientName, updateSummary: change.history.summary.slice(0, 200),
    };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("docs", { ...at, cardId: doc.cardId, kind: doc.kind, ...fields });
    await addStored(ctx, at, sizeOf(fields.markdown) - (row ? sizeOf(row.markdown) : 0));
  }
  const listed = change.history.affectedDocs ?? [];
  const affectedDocs = [
    ...listed,
    ...change.docWrites
      .filter((doc) => !listed.some((ref) => ref.cardId === doc.cardId && ref.kind === doc.kind))
      .map((doc) => ({ cardId: doc.cardId, kind: doc.kind, path: doc.path })),
  ];
  await ctx.db.patch(board._id, { revision: committed.revision, updatedAt: now });
  const version = await recordHistory(ctx, {
    board: { ...board, revision: committed.revision },
    previous,
    committed,
    history: { ...change.history, affectedDocs },
    docs: change.docWrites.map(({ cardId, kind, markdown }) => ({ cardId, kind, markdown })),
    attribution,
    now,
  });
  return { committed, version };
}

/**
 * Completing and deleting cards stay with the owner. Judged on the operation's
 * effect (current versus candidate roadmap), so every route is covered.
 */
function checkOwnerControlled(before: PlanbanRoadmap, after: PlanbanRoadmap, access: BoardAccess, actor: "user" | "agent", completionConfirmed?: boolean) {
  const remaining = new Set(after.roadmapItems.map((item) => item.id));
  const completes = newlyCompleted(before, after).length > 0;
  const deletes = before.roadmapItems.some((item) => !remaining.has(item.id));
  if (deletes && !access.canAdminister) fail("forbidden", "Deleting a card is kept for the board owner's own sign-in. Ask the owner to do it.");
  if (completes && !access.canComplete) fail("forbidden", refusalFor(access, "complete"));
  // Complete is person-controlled: an agent's edit says a person confirmed it.
  if (completes && actor === "agent" && completionConfirmed !== true) fail("validation", COMPLETION_CONFIRMATION_MESSAGE);
}

/**
 * Every hosted edit states the revision it was based on (owner decision 10).
 * A stale one is refused with what changed since, who changed it, and the
 * card as it is now, so the agent can reconcile its intent (owner requirement,
 * 15 October 2026).
 */
async function requireBaseRevision(ctx: QueryCtx, at: BoardRows, current: PlanbanRoadmap, input: Record<string, unknown>, op: string, actor: "user" | "agent") {
  if (typeof input.baseRevision !== "number" || !Number.isInteger(input.baseRevision)) {
    fail("validation", `Online Board edits must state the board revision they were based on (baseRevision). The current revision is ${current.revision}; reread the board before editing.`, { currentRevision: current.revision });
  }
  const base = input.baseRevision as number;
  if (base === current.revision) return input;
  assertBaseRevision({ ...current, revision: base }, base);
  if (base > current.revision) assertBaseRevision(current, base);
  const cardId = typeof input.cardId === "string" ? input.cardId : undefined;
  // Editing at the same time (Spec point 20): only a field this edit touches
  // that changed since the revision it read is a clash; anything else applies
  // to the current board. Positions never clash.
  const read = await roadmapAtRevision(ctx, at, base);
  const rebased = read ? rebaseEdit(op, input, read, current) : null;
  if (rebased?.ok) return rebased.input;
  // Refused: now say what changed, and who changed what this edit clashes with.
  const changes = await describeChanges(ctx, await recentEntries(ctx, at, (entry) => entry.roadmapRevision <= base), base);
  const clashes = rebased && "clashes" in rebased ? rebased.clashes : undefined;
  const clashCards = new Set(clashes?.map((clash) => clash.cardId));
  // Who changed the very field that clashes is named, never someone who changed another field of the card.
  const authors = clashes && read ? await fieldAuthors(ctx, at, read, base, clashes, (await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", at.boardId)).unique())?.historyVersion ?? 0) : [];
  if (clashes) {
    // Recent changes to the clashing cards that aren't the field's own author are context, not blame.
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      if (changes[index]!.cards.some((id) => clashCards.has(id))) changes.splice(index, 1);
    }
    changes.unshift(...authors);
  }
  for (const clashCard of clashCards) {
    // Beyond the window history is read in: the card's own last-change record, said as that.
    if (authors.some((change) => change.cards.includes(clashCard))) continue;
    const last = await ctx.db.query("cardChanges").withIndex("by_board_generation_card", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", clashCard)).unique();
    // Beyond what history still shows: the card's last change, said as that (it may have been another field).
    if (last) changes.unshift({ at: last.at, by: await personName(ctx, last.userId, last.agent ? last.clientName ?? "" : null), agent: last.agent, summary: `the card's last change: ${last.summary.slice(0, 200)}`, cards: [clashCard], cardLevel: true });
  }
  const relevant = clashes ? changes.filter((change) => change.cards.some((id) => clashCards.has(id))) : changes;
  const conflict: ConflictDetails = {
    currentRevision: current.revision, yourRevision: base,
    changes: relevant.length ? relevant : changes,
    ...(cardId ? { card: current.roadmapItems.find((item) => item.id === cardId) ?? null } : {}),
    ...(clashes ? { clashes } : {}),
  };
  fail("conflict", conflictMessage(clashSubject(current, cardId, clashes), conflict, actor === "agent"), { currentRevision: current.revision, conflict: conflict as unknown as Value });
}

/** The history version that produced `revision`, or null when it is no longer kept. */
async function versionAtRevision(ctx: QueryCtx, at: BoardRows, revision: number) {
  for await (const row of ctx.db.query("history").withIndex("by_board_version", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).order("desc")) {
    const entry = row.entry as PlanbanHistoryEntry;
    if (entry.roadmapRevision === revision) return row.version;
    if (entry.roadmapRevision < revision) return null;
  }
  return null;
}

/** The board as it was at `revision`, from history, or null when that version is no longer kept. */
async function roadmapAtRevision(ctx: QueryCtx, at: BoardRows, revision: number) {
  const version = await versionAtRevision(ctx, at, revision);
  return version === null ? null : roadmapAtVersion(ctx, at, version);
}

/**
 * Who last changed each clashing field since the edit's read: the latest
 * version, among the next 50, whose board shows that field changing.
 */
async function fieldAuthors(ctx: QueryCtx, at: BoardRows, read: PlanbanRoadmap, base: number, clashes: FieldClash[], latestVersion: number) {
  const baseVersion = await versionAtRevision(ctx, at, base);
  if (baseVersion === null) return [];
  // The latest 50 versions since the read: the most recent change to each field is what counts.
  const from = Math.max(baseVersion, latestVersion - 50);
  const latest = new Map<string, PlanbanHistoryEntry>();
  let previous = from === baseVersion ? read : await roadmapAtVersion(ctx, at, from);
  if (!previous) return [];
  for (const { entry, roadmap } of await historyPage(ctx, at, from, 50)) {
    for (const clash of clashes) {
      const before = previous.roadmapItems.find((item) => item.id === clash.cardId);
      const after = roadmap.roadmapItems.find((item) => item.id === clash.cardId);
      const changed = clash.field === "*" ? JSON.stringify(before) !== JSON.stringify(after) : JSON.stringify(fieldValue(before, clash.field) ?? null) !== JSON.stringify(fieldValue(after, clash.field) ?? null);
      if (changed) latest.set(`${clash.cardId}|${clash.field}`, entry);
    }
    previous = roadmap;
  }
  const entries = [...new Map([...latest.values()].map((entry) => [entry.version, entry])).values()];
  return describeChanges(ctx, entries.sort((a, b) => b.version - a.version));
}

/** History entries newest first, until `stop` says an entry is old enough (at most a page). */
async function recentEntries(ctx: QueryCtx, at: BoardRows, stop: (entry: PlanbanHistoryEntry) => boolean, limit = MAX_CONFLICT_CHANGES) {
  const found: PlanbanHistoryEntry[] = [];
  const rows = ctx.db.query("history").withIndex("by_board_version", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).order("desc");
  for await (const row of rows) {
    const entry = row.entry as PlanbanHistoryEntry;
    if (stop(entry) || found.length >= limit) break;
    found.push(entry);
  }
  return found;
}

/** "Ana", or "Ana's agent (Claude)" when `agentClient` is given. */
async function personName(ctx: QueryCtx, userId: string, agentClient: string | null) {
  const person = await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", userId)).unique();
  const name = person?.name || person?.email || "someone on the board";
  return agentClient === null ? name : `${name}'s agent${agentClient ? ` (${agentClient})` : ""}`;
}

/** Names who made each change, as the people on the board see them. */
async function describeChanges(ctx: QueryCtx, entries: PlanbanHistoryEntry[], base?: number) {
  const names = new Map<string, string>();
  for (const entry of entries) {
    const userId = (entry as { attribution?: { userId?: string } }).attribution?.userId;
    if (userId && !names.has(userId)) {
      const person = await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", userId)).unique();
      names.set(userId, person?.name || person?.email || "someone on the board");
    }
  }
  return changesSince(entries, base, (entry) => {
    const attribution = (entry as { attribution?: { userId?: string; clientName?: string; actor?: string } }).attribution;
    const name = attribution?.userId ? names.get(attribution.userId)! : "someone on the board";
    // An integration (GitHub recording a merge) is named as itself.
    if (entry.actor === "system" && attribution?.clientName) return attribution.clientName;
    return entry.actor === "agent" ? `${name}'s agent${attribution?.clientName ? ` (${attribution.clientName})` : ""}` : name;
  });
}

// ---- reads --------------------------------------------------------------

export const me = internalQuery({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await liveConnection(ctx, connectionId);
    // A person's own sign-in (a computer, a browser) learns who it is signed in as; agents and keys don't need to.
    const profile = connection.canAdminister ? await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", connection.userId)).unique() : null;
    return {
      userId: connection.userId,
      ...(profile ? { person: { name: profile.name, ...(profile.email ? { email: profile.email } : {}) } } : {}),
      connectionId: connection._id,
      kind: connection.kind,
      name: connection.name,
      clientName: connection.clientName,
      boards: connection.boards,
      level: connection.level,
      canAdminister: connection.canAdminister,
    };
  },
});

/** A board's people count is shown as "200+" past this. */
const MAX_LISTED_PEOPLE = 200;

export const listBoards = internalQuery({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await liveConnection(ctx, connectionId);
    const memberships = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", connection.userId)).collect();
    const boards = [];
    for (const member of memberships) {
      if (!reaches(connection, member.boardId)) continue;
      const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", member.boardId)).unique();
      if (!board || board.authority === "importing") continue;
      const entry = { boardId: board.boardId, title: board.title, role: member.role, authority: board.authority, revision: board.revision, lastChangedAt: board.updatedAt };
      if (board.authority !== "online") { boards.push(entry); continue; }
      // The dashboard's summary of each online board (Planban 2.0 plan): people,
      // cards per column, the owner's name on shared boards, and, for the owner
      // only, how many cards wait on them.
      const roadmap = await currentRoadmap(ctx, { boardId: board.boardId, generation: board.generation });
      const cardCounts: Record<string, number> = {};
      let needYou = 0;
      for (const item of roadmap.roadmapItems) {
        if (item.isGroup) continue;
        cardCounts[item.status] = (cardCounts[item.status] ?? 0) + 1;
        if (item.status !== "complete" && item.status !== "archived" && /^\s*Owner:/.test(item.nextAction ?? "")) needYou += 1;
      }
      const people = (await ctx.db.query("members").withIndex("by_board", (q) => q.eq("boardId", board.boardId)).take(MAX_LISTED_PEOPLE + 1)).length;
      const owner = board.ownerId === connection.userId ? null
        : await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", board.ownerId)).unique();
      boards.push({
        ...entry,
        people,
        cardCounts,
        ...(member.role === "owner" ? { needYou } : { ownerName: owner?.name ?? "Someone" }),
      });
    }
    return boards;
  },
});

/** One current snapshot for permission-dependent MCP discovery, never cached. */
export const mcpPermissions = internalQuery({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await liveConnection(ctx, connectionId);
    const memberships = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", connection.userId)).collect();
    const permissions = [];
    for (const member of memberships) {
      if (!reaches(connection, member.boardId)) continue;
      const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", member.boardId)).unique();
      if (!board || board.authority === "importing") continue;
      const access = await boardAccess(ctx, connectionId, member.boardId);
      permissions.push({ boardId: board.boardId, level: access.level,
        canWrite: board.authority === "online" && access.canWrite,
        canComplete: board.authority === "online" && access.canComplete });
    }
    return permissions;
  },
});

async function readableBoard(ctx: Parameters<typeof boardAccess>[0], connectionId: Parameters<typeof boardAccess>[1], boardId: string) {
  const access = await boardAccess(ctx, connectionId, boardId);
  if (access.board.authority === "importing") fail("not_found", `Online Board not found: ${boardId}`);
  return access;
}

/** The board. With `since` equal to the current revision, returns only the revision: no roadmap is read. */
export const getBoard = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), since: v.optional(v.number()) },
  handler: async (ctx, { connectionId, boardId, since }) => packed(await (async () => {
    const { board, role } = await readableBoard(ctx, connectionId, boardId);
    if (since !== undefined && since === board.revision) return { unchanged: true as const, revision: board.revision, authority: board.authority };
    // The role lets the web page show a viewer a board they can read but not change. The
    // features let a computer's older Planban say it can't show everything (16 October 2026).
    const goals = await goalsOf(ctx, live(board));
    // The GitHub repositories whose merges the board records itself, for the hosted freshness note.
    // Only links GitHub confirmed count as checked.
    const repos = await confirmedRepos(ctx, boardId);
    return {
      roadmap: await currentRoadmap(ctx, live(board)), authority: board.authority, role, features: boardFeatures({ hasGoals: hasGoalsContent(goals) }),
      ...(repos.length ? { linkedRepos: repos } : {}),
    };
  })()),
});

/** A single small row: what live updates subscribe to. */
export const revision = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    return { revision: board.revision, authority: board.authority };
  },
});

export const readDoc = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), cardId: v.string(), kind: v.union(v.literal("spec"), v.literal("plan")) },
  handler: async (ctx, { connectionId, boardId, cardId, kind }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    const roadmap = await currentRoadmap(ctx, live(board));
    const item = roadmap.roadmapItems.find((entry) => entry.id === cardId);
    if (!item) fail("not_found", `Card not found: ${cardId}`);
    return docPayload(await docRow(ctx, live(board), cardId, kind), cardId, kind, (kind === "spec" ? item!.specDoc : item!.planDoc) ?? null);
  },
});

/** Agents' refused edits still waiting on this board, or one card (Spec point 20). For agent tools only. */
async function goalsOf(ctx: QueryCtx, at: BoardRows): Promise<GoalsFile> {
  const row = await stateRow(ctx, at);
  return normalizeGoals(row.goals ? unpackJson(row.goals) : null);
}

/** The board's Goals page, for people and agents; the stored goals too, for backups. */
/** Anything on the Goals page: goals, retired ones, the Context, or suggestions. */
function hasGoalsContent(file: GoalsFile) {
  return Boolean(file.goals.length || file.retired.length || file.context || file.suggestions.length || file.dismissed.length);
}

export const goals = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => packed(await (async () => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    const file = await goalsOf(ctx, live(board));
    return { page: goalsPage(file), revision: board.revision, ...(hasGoalsContent(file) ? { goals: file } : {}) };
  })()),
});

export const unresolved = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), cardId: v.optional(v.string()) },
  handler: async (ctx, { connectionId, boardId, cardId }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    const rows = await unresolvedOn(ctx, live(board), cardId);
    const changes = [];
    for (const row of rows) {
      const change = publicUnresolved(row);
      changes.push({ ...change, by: await personName(ctx, row.userId, row.clientName) });
    }
    return packed({ changes });
  },
});

export const history = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), after: v.optional(v.number()) },
  handler: async (ctx, { connectionId, boardId, after }): Promise<PlanbanHistoryPayload> => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    const entries = await historyEntries(ctx, live(board), after ?? 0);
    return {
      currentVersion: board.historyVersion,
      retention: { boardVersions: 1000, cardVersions: 1000, documentVersions: 1000, hourlyDays: 0, maxAgeDays: 0 },
      entries,
    } as PlanbanHistoryPayload;
  },
});

/**
 * A restored card keeps a reference to every document it still has: restoring
 * card details never drops a document, so the roadmap and stored documents
 * stay consistent for export and Take Local.
 */
async function keepLiveDocRefs(ctx: MutationCtx, at: BoardRows, current: PlanbanRoadmap, items: PlanbanRoadmap["roadmapItems"]) {
  const now = new Map(current.roadmapItems.map((item) => [item.id, item]));
  const out = [];
  for (const item of items) {
    let next = item;
    for (const [kind, field] of [["spec", "specDoc"], ["plan", "planDoc"]] as const) {
      if (next[field] || !(await docRow(ctx, at, item.id, kind))) continue;
      next = { ...next, [field]: now.get(item.id)?.[field] ?? `items/${item.id}/${kind}.md` };
    }
    out.push(next);
  }
  return out;
}

function historyVersionArg(input: Record<string, unknown>): number {
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) fail("validation", "version must be a history version number.");
  return version;
}

/** A document as it stood at a history version: its latest recorded body at or before it. */
async function historyDocAt(ctx: Parameters<typeof currentRoadmap>[0], at: BoardRows, version: number, cardId: string, kind: DocKind) {
  const row = await ctx.db.query("historyDocs").withIndex("by_board_doc_version", (q) =>
    q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", cardId).eq("kind", kind).lte("version", version)).order("desc").first();
  return row ? unpackText(row.markdown) : null;
}

/** The board as it stood at a history version, for reading. */
export const historyVersion = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), version: v.number() },
  handler: async (ctx, { connectionId, boardId, version }) => packed(await (async () => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    const roadmap = await roadmapAtVersion(ctx, live(board), version);
    if (!roadmap) fail("not_found", `History version not found: v${version}`);
    return { roadmap };
  })()),
});

export const historyDoc = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), version: v.number(), cardId: v.string(), kind: v.union(v.literal("spec"), v.literal("plan")) },
  handler: async (ctx, { connectionId, boardId, version, cardId, kind }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    const markdown = await historyDocAt(ctx, live(board), version, cardId, kind);
    return { cardId, kind, path: null, exists: markdown !== null, markdown: markdown ?? "", mtimeMs: null };
  },
});

async function allDocs(ctx: Parameters<typeof currentRoadmap>[0], at: BoardRows, roadmap: PlanbanRoadmap, spend: (bytes: number) => void = () => undefined) {
  const docs: BoardBundle["docs"] = [];
  for (const item of roadmap.roadmapItems) {
    for (const kind of ["spec", "plan"] as const) {
      const row = await docRow(ctx, at, item.id, kind);
      if (!row) continue;
      const markdown = unpackText(row.markdown);
      spend(utf8Bytes(markdown));
      docs.push({ cardId: item.id, kind, markdown });
    }
  }
  return docs;
}

/** The whole board as one bundle. Large boards use the paged export below. */
export const exportBoard = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => packed(await (async () => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    const at = live(board);
    const tooLarge = () => fail("validation", "This board is too large to export in one response. Use the paged export: /export/meta, then /export/docs and /export/history (Planban's own export does this).");
    // What is stored is read whole: past the limit, refuse before reading it.
    const stored = (await ctx.db.query("boardSizes").withIndex("by_board_generation", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).unique())?.bytes ?? 0;
    if (stored > WHOLE_EXPORT_BYTES) tooLarge();
    const roadmap = await currentRoadmap(ctx, at);
    // Assembled against a running budget: history unpacks to a whole board per version, which can
    // far exceed what is stored, so it stops as soon as the export would pass the limit.
    let budget = WHOLE_EXPORT_BYTES - utf8Bytes(JSON.stringify(roadmap));
    const spend = (bytes: number) => { budget -= bytes; if (budget < 0) tooLarge(); };
    const history: Awaited<ReturnType<typeof historyPage>> = [];
    for (let after = 0; ;) {
      // Each version is measured as it is rebuilt; past the budget, the export stops there.
      const page = await historyPage(ctx, at, after, 10, (version) => { spend(utf8Bytes(JSON.stringify(version))); return true; });
      if (!page.length) break;
      history.push(...page);
      after = page.at(-1)!.entry.version;
    }
    const historyDocs: NonNullable<BoardBundle["historyDocs"]> = [];
    for await (const row of ctx.db.query("historyDocs").withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", board.generation))) {
      const markdown = unpackText(row.markdown);
      spend(utf8Bytes(markdown));
      historyDocs.push({ version: row.version, cardId: row.cardId, kind: row.kind, markdown });
    }
    const bundle = {
      format: "planban-board-bundle", version: 1, roadmap, docs: await allDocs(ctx, at, roadmap, spend), history, historyDocs,
      retiredIds: [...await retiredIds(ctx, at)],
      ...(board.retention === undefined ? {} : { retention: board.retention }),
      ...await storedGoals(ctx, at),
    };
    return bundle;
  })()),
});

async function storedGoals(ctx: QueryCtx, at: BoardRows): Promise<{ goals?: GoalsFile }> {
  const row = await stateRow(ctx, at);
  return row.goals ? { goals: normalizeGoals(unpackJson(row.goals)) } : {};
}

/** Estimated size above which the whole-board export refuses, within Convex's 16 MiB per response. */
const WHOLE_EXPORT_BYTES = 12 * 1024 * 1024;

/** Paged export, first page: the roadmap, retention, retired ids and the list of history versions. */
export const exportMeta = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), transferId: v.optional(v.string()) },
  handler: async (ctx, { connectionId, boardId, transferId }) => packed(await (async () => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    requireLocalTransfer(board, transferId);
    const at = live(board);
    const versions: number[] = [];
    for await (const row of ctx.db.query("history").withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", board.generation))) versions.push(row.version);
    return {
      format: "planban-board-bundle" as const, version: 1 as const, authority: board.authority,
      roadmap: await currentRoadmap(ctx, at), retiredIds: [...await retiredIds(ctx, at)], historyVersions: versions,
      ...(board.retention === undefined ? {} : { retention: board.retention }),
      ...(board.uid ? { uid: board.uid } : {}),
      ...await storedGoals(ctx, at),
    };
  })()),
});

/**
 * Pages stay well under Convex's 16 MiB limit on a function's result: a page
 * stops once it holds PAGE_BYTES of content, and always holds at least one
 * item so a single large one still gets through.
 */
const PAGE_BYTES = 6 * 1024 * 1024;
/** Pages are measured in the bytes they really take, not characters (non-Latin text takes up to four per character). */
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** Paged export: current documents, a page of cards at a time. */
export const exportDocs = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), offset: v.number(), limit: v.number(), transferId: v.optional(v.string()), revision: v.optional(v.number()) },
  handler: async (ctx, { connectionId, boardId, offset, limit, transferId, revision }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    requireLocalTransfer(board, transferId);
    // Pages are positions in the roadmap, so all pages must come from one revision.
    if (revision !== undefined && revision !== board.revision) fail("conflict", "The board changed while it was being read. Start again.", { currentRevision: board.revision });
    const at = live(board);
    const roadmap = await currentRoadmap(ctx, at);
    const docs: BoardBundle["docs"] = [];
    let index = offset;
    let bytes = 0;
    const end = Math.min(roadmap.roadmapItems.length, offset + Math.min(Math.max(limit, 1), 200));
    for (; index < end && (bytes < PAGE_BYTES || index === offset); index += 1) {
      const item = roadmap.roadmapItems[index]!;
      for (const kind of ["spec", "plan"] as const) {
        const row = await docRow(ctx, at, item.id, kind);
        if (!row) continue;
        const markdown = unpackText(row.markdown);
        bytes += utf8Bytes(markdown);
        docs.push({ cardId: item.id, kind, markdown });
      }
    }
    return packed({ docs, nextOffset: index < roadmap.roadmapItems.length ? index : null });
  },
});

/** Paged export: history versions after `after`, each with its roadmap and document bodies. */
export const exportHistory = internalQuery({
  args: {
    connectionId: v.id("connections"), boardId: v.string(), after: v.number(), limit: v.number(), transferId: v.optional(v.string()),
    /** Continuing one version's documents (moreDocs from the previous page). */
    docsOf: v.optional(v.number()), docsCursor: v.optional(v.string()),
  },
  handler: async (ctx, { connectionId, boardId, after, limit, transferId, docsOf, docsCursor }) => packed(await (async () => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    requireLocalTransfer(board, transferId);
    const at = live(board);
    const versionDocs = (version: number) => ctx.db.query("historyDocs")
      .withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", board.generation).eq("version", version));
    // One version's documents a page at a time (Convex allows one paginated query per function):
    // for a version holding more than one response may.
    if (docsOf !== undefined) {
      // At most five documents (each at most 1 MB of text): the compressed bytes read say little about the expanded size.
      const page = await versionDocs(docsOf).paginate({ numItems: 5, cursor: docsCursor ?? null, maximumBytesRead: PAGE_BYTES } as never) as unknown as { page: Array<Doc<"historyDocs">>; isDone: boolean; continueCursor: string };
      const docs = page.page.map((row) => ({ version: row.version, cardId: row.cardId, kind: row.kind, markdown: unpackText(row.markdown) }));
      return { history: [], historyDocs: docs, ...(page.isDone ? {} : { moreDocs: { version: docsOf, cursor: page.continueCursor } }) };
    }
    // Versions are measured as they are rebuilt: a page holds one version at least, then only what fits.
    let rebuilt = 0;
    const candidates = await historyPage(ctx, at, after, Math.min(Math.max(limit, 1), 20), (version) => {
      const size = utf8Bytes(JSON.stringify(version.roadmap));
      if (rebuilt > 0 && rebuilt + size > PAGE_BYTES) return false;
      rebuilt += size;
      return true;
    });
    const history: typeof candidates = [];
    const historyDocs: NonNullable<BoardBundle["historyDocs"]> = [];
    let bytes = 0;
    for (const version of candidates) {
      let size = utf8Bytes(JSON.stringify(version.roadmap));
      const docs: typeof historyDocs = [];
      let tooBig = false;
      // Read as a stream, stopping once this version passes what one page may hold.
      for await (const row of versionDocs(version.entry.version)) {
        const markdown = unpackText(row.markdown);
        size += utf8Bytes(markdown);
        if (size > PAGE_BYTES) {
          tooBig = true;
          break;
        }
        docs.push({ version: row.version, cardId: row.cardId, kind: row.kind, markdown });
      }
      if (history.length > 0 && (tooBig || bytes + size > PAGE_BYTES)) break;
      if (tooBig) {
        // Too big for any page: the version now, its documents on pages of their own (docsOf).
        history.push(version);
        return { history, historyDocs, moreDocs: { version: version.entry.version, cursor: "" } };
      }
      history.push(version);
      historyDocs.push(...docs);
      bytes += size;
    }
    return { history, historyDocs };
  })()),
});

// ---- writes -------------------------------------------------------------

/** Take Local downloads stay frozen to one generation; anything else is a conflict. */
function requireLocalTransfer(board: Doc<"boards">, transferId: string | undefined) {
  if (transferId === undefined) return;
  if (board.localTransfer?.transferId !== transferId || board.localTransfer.generation !== board.generation) {
    fail("conflict", "This board changed since this Take Local started. Run Take Local again.");
  }
}

/**
 * Take Local, first step: freeze the board for one transfer. Retrying with
 * the same transfer id is safe; a different transfer, or a board that has
 * changed generation since, is refused, so a retry can never freeze a
 * board someone else has since taken online again.
 */
export const fence = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), transferId: v.string(), expectedGeneration: v.optional(v.number()), acknowledgedOthers: v.optional(v.array(v.string())) },
  handler: async (ctx, { connectionId, boardId, transferId, expectedGeneration, acknowledgedOthers }) => {
    const access = await readableBoard(ctx, connectionId, boardId);
    if (!access.canAdminister) fail("forbidden", "Moving a board between Online and Local Mode is kept for the board owner's own connection.");
    const board = access.board;
    if (board.localTransfer?.transferId === transferId) {
      // Resuming. If the freeze lapsed and someone has started taking the
      // board online again since, this Take Local has been superseded;
      // otherwise the freeze is renewed.
      const successor = await ctx.db.query("transfers").withIndex("by_board_state", (q) => q.eq("boardId", boardId).eq("state", "open")).first();
      if (successor || board.localTransfer.generation !== board.generation) {
        fail("conflict", "This board is being taken online again elsewhere, so this Take Local was superseded. Run Take Local again later.");
      }
      if (expectedGeneration !== undefined && expectedGeneration !== board.generation) fail("conflict", "This board was taken online again since this Take Local started. Run Take Local again.");
      await ctx.db.patch(board._id, { localTransfer: { ...board.localTransfer, at: new Date().toISOString() } });
      return { generation: board.localTransfer.generation, revision: board.revision, removedPeople: [] as string[] };
    }
    if (!/^[A-Za-z0-9-]{8,80}$/.test(transferId)) fail("validation", "transferId must be 8 to 80 letters, digits or dashes.");
    if (expectedGeneration !== undefined && expectedGeneration !== board.generation) fail("conflict", "This board was taken online again since this Take Local started. Run Take Local again.");
    if (board.authority !== "online") fail("conflict", "This board is already being taken local, or is local already.");
    // Owner decision 15: everyone else loses access, so the person must have
    // confirmed exactly who that is. Checked here, in the same step.
    const members = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId)).collect();
    const others = members.filter((member) => member.userId !== access.connection.userId);
    const acknowledged = new Set(acknowledgedOthers ?? []);
    if (acknowledged.size !== others.length || others.some((member) => !acknowledged.has(member.userId))) {
      fail("conflict", "The people on this board changed since you confirmed. Confirm again who loses access.");
    }
    const now = new Date().toISOString();
    const previous = await currentRoadmap(ctx, live(board));
    const committed = committedRoadmap(previous, now);
    const state = await stateRow(ctx, live(board));
    const packedRoadmap = packJson(committed);
    await ctx.db.patch(state._id, { roadmap: packedRoadmap });
    await addStored(ctx, live(board), sizeOf(packedRoadmap) - sizeOf(state.roadmap));
    // Bumping the revision tells every watching client the board changed.
    await ctx.db.patch(board._id, {
      authority: "returned-local", revision: committed.revision, updatedAt: now,
      localTransfer: { transferId, generation: board.generation, userId: access.connection.userId, at: now },
    });
    await recordHistory(ctx, {
      board, previous, committed,
      history: { actor: "user", operation: "board.take-local", summary: "Took the board back to Local Mode", affectedCards: [] },
      docs: [], attribution: attributionFor(access.connection, "user"), now,
    });
    // Owner decision 15: everyone else, and their agents, lose access now.
    // The online copy stays, read-only, for the person taking it local.
    const removedPeople: string[] = [];
    for (const member of others) {
      removedPeople.push(member.userId);
      await ctx.db.delete(member._id);
    }
    return { generation: board.generation, revision: committed.revision, removedPeople };
  },
});

/** Take Local, last step: the local copy is in place, so the board may be taken online again. */
export const finishTakeLocal = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), transferId: v.string() },
  handler: async (ctx, { connectionId, boardId, transferId }) => {
    const access = await readableBoard(ctx, connectionId, boardId);
    if (!access.canAdminister) fail("forbidden", "Moving a board between Online and Local Mode is kept for the board owner's own connection.");
    const frozen = access.board.localTransfer;
    if (frozen?.transferId === transferId) {
      if (frozen.userId !== access.connection.userId) fail("forbidden", "Only the person who started this Take Local can finish it.");
      await ctx.db.patch(access.board._id, { localTransfer: undefined });
    }
    // Finishing again, or after the freeze lapsed, is harmless.
    return { finished: true };
  },
});

interface Outcome {
  result: unknown;
  version: number;
  revision: number;
  generation?: number;
  /** A refused agent edit, kept as an unresolved change: a retry returns the same refusal. */
  refused?: unknown;
}

export const run = internalMutation({
  args: {
    connectionId: v.id("connections"),
    boardId: v.string(),
    op: v.string(),
    /** The operation's input, packed (see packed() in model/codec.ts). */
    payload: v.bytes(),
    completionConfirmed: v.optional(v.boolean()),
    idempotencyKey: v.optional(v.string()),
    requestHash: v.optional(v.string()),
  },
  handler: async (ctx, { connectionId, boardId, op, payload, completionConfirmed, idempotencyKey, requestHash }) => packed(await (async () => {
    const rawInput = unpackJson<unknown>(payload);
    const access = await readableBoard(ctx, connectionId, boardId);
    const at = live(access.board);
    // A retry of an edit that already happened returns its original result.
    if (idempotencyKey) {
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey) || !requestHash) fail("validation", "Idempotency keys are 8 to 100 letters, digits, dashes or underscores.");
      const seen = await ctx.db.query("operations").withIndex("by_user_key", (q) => q.eq("userId", access.connection.userId).eq("key", idempotencyKey)).unique();
      if (seen) {
        if (seen.requestHash !== requestHash || seen.boardId !== boardId) fail("validation", "This idempotency key was already used for a different request.");
        // The original result is returned exactly. The roadmap as it was right
        // after the edit is rebuilt from history; if that version is gone (the
        // board was taken online again, or history was trimmed), the current
        // roadmap is returned and says which revision the edit produced.
        const outcome = unpackJson<Outcome>(seen.outcome);
        if (outcome.refused) return { refused: outcome.refused as ServiceErrorData };
        const original = outcome.generation === at.generation ? await roadmapAtVersion(ctx, at, outcome.version) : null;
        if (original) return { roadmap: original, result: outcome.result, replayed: true };
        return { roadmap: await currentRoadmap(ctx, at), result: outcome.result, replayed: true, originalRevision: outcome.revision };
      }
    }
    if (!BOARD_OPERATIONS.includes(op as BoardOperation)) fail("not_found", `Unknown operation: ${op}`);
    if (access.board.authority !== "online") fail("conflict", "This board was taken back to Local Mode, so it is read-only online.");
    let input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
    const attribution = attributionFor(access.connection, input.actor);
    // An agent's edit, even through the person's own computer sign-in, stays within what the person lets their agents do.
    const acting = attribution.actor === "agent" ? asAgent(access) : access;
    if (!acting.canWrite) fail("forbidden", refusalFor(acting, "plan"));
    const current = await currentRoadmap(ctx, at);
    const now = new Date().toISOString();
    let outcome: { committed: PlanbanRoadmap; version: number; result: unknown };
    // An agent's earlier refused edits that this one settles (Spec point 20).
    let settled: Array<{ row: Doc<"unresolvedChanges">; fieldsLeft: string[] }> = [];
    try {
      if (op === "editGoals" || op === "suggestGoalChange" || op === "decideGoalSuggestion") {
        outcome = await changeGoals(ctx, access.board, current, op, input, now, attribution);
      } else if (op === "dropChange") {
        outcome = await dropChange(ctx, access.board, current, input, now, attribution);
      } else if (op === "clearLanding") {
        // The inbox merge is named by its repository and number, so a stale baseRevision doesn't matter;
        // one already cleared is refused as not found.
        const change = planClearLanding(current, {
          repo: String(input.repo ?? ""), number: Number(input.number), actor: attribution.actor,
          ...(typeof input.cardId === "string" && input.cardId ? { cardId: input.cardId } : {}),
          ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
        }, { now });
        const { committed, version } = await commit(ctx, access.board, current, change, attribution, now);
        outcome = { committed, version, result: { cleared: `${String(input.repo)}#${Number(input.number)}`, ...(typeof input.cardId === "string" && input.cardId ? { assignedTo: input.cardId } : { dismissed: true }) } };
      } else if (op === "writeDoc") {
        if (attribution.actor === "agent" && typeof input.cardId === "string" && (input.kind === "spec" || input.kind === "plan")) {
          settled = await settledBy(ctx, at, [{ cardId: input.cardId, field: input.kind }], null);
        }
        outcome = await writeDoc(ctx, access.board, current, input, now, attribution, settled.length ? " (reconsidered after an earlier clash)" : "");
      } else if (op === "writeDocSection") {
        if (attribution.actor === "agent" && typeof input.cardId === "string" && (input.kind === "spec" || input.kind === "plan")) {
          settled = await settledBy(ctx, at, [{ cardId: input.cardId, field: sectionField(input) }], null);
        }
        outcome = await writeDocSection(ctx, access.board, current, input, now, attribution, settled.length ? " (reconsidered after an earlier clash)" : "");
      } else if (op === "restoreBoard" || op === "restoreCard" || op === "restoreDoc") {
        // Restores state the revision they were based on, like any edit, and
        // pass the same completion and ownership checks.
        input = await requireBaseRevision(ctx, at, current, input, op, attribution.actor);
        const version = historyVersionArg(input);
        let change: PlannedChange;
        if (op === "restoreDoc") {
          const cardId = String(input.cardId ?? "");
          const kind = input.kind as DocKind;
          if (!DOC_KINDS.has(kind)) fail("validation", "kind must be spec or plan.");
          const markdown = await historyDocAt(ctx, at, version, cardId, kind);
          if (markdown === null) fail("not_found", `${kind} document not found in v${version}`);
          const planned = planWriteDoc(current, { cardId, kind }, { now });
          change = {
            roadmap: planned.roadmap ?? current,
            history: { actor: attribution.actor, operation: "history.restore.doc", summary: `Restored ${kind} document from v${version}`, affectedCards: [cardId], affectedDocs: [{ cardId, kind, path: planned.path }] },
            docWrites: [{ cardId, kind, path: planned.path, markdown: markdown! }],
          };
        } else {
          const snapshot = await roadmapAtVersion(ctx, at, version);
          if (!snapshot) fail("not_found", `History version not found: v${version}`);
          if (op === "restoreBoard") {
            // The whole board can change at once, so only the person's own sign-in may do it.
            if (!acting.connection.canAdminister || attribution.actor !== "user") fail("forbidden", "Only the person themselves can restore the whole board, from their own sign-in, not an agent.");
            change = {
              roadmap: { ...snapshot!, revision: current.revision, roadmapItems: await keepLiveDocRefs(ctx, at, current, snapshot!.roadmapItems) },
              history: { actor: attribution.actor, operation: "history.restore.board", summary: `Restored board from v${version}`, affectedCards: snapshot!.roadmapItems.map((item) => item.id) },
              docWrites: [],
            };
          } else {
            const cardId = String(input.cardId ?? "");
            const found = snapshot!.roadmapItems.find((item) => item.id === cardId);
            if (!found) fail("not_found", `Card ${cardId} does not exist in v${version}`);
            const [restored] = await keepLiveDocRefs(ctx, at, current, [found!]);
            const exists = current.roadmapItems.some((item) => item.id === cardId);
            const items = exists ? current.roadmapItems.map((item) => (item.id === cardId ? restored! : item)) : [...current.roadmapItems, restored!];
            change = {
              roadmap: { ...current, roadmapItems: normalizeColumnPriorities(items) },
              history: { actor: attribution.actor, operation: "history.restore.card", summary: `Restored ${restored!.title} from v${version}`, affectedCards: [cardId] },
              docWrites: [],
            };
          }
        }
        checkOwnerControlled(current, change.roadmap, acting, attribution.actor, completionConfirmed);
        settled = await settle(ctx, at, op, input, current, change, attribution.actor);
        const { committed, version: written } = await commit(ctx, access.board, current, change, attribution, now);
        outcome = { committed, version: written, result: {} };
      } else {
        if (op === "setCardParent") {
          // Only re-parenting: status and other move fields are not accepted here.
          input = { cardId: input.cardId, parentId: input.parentId, baseRevision: input.baseRevision };
        }
        input = await requireBaseRevision(ctx, at, current, input, op, attribution.actor);
        const plannerInput = { ...input, actor: attribution.actor } as never;
        const retired = await retiredIds(ctx, at);
        const reserve = { now, isIdReserved: (id: string) => retired.has(id) };
        let change: PlannedChange;
        let result: (roadmap: PlanbanRoadmap) => unknown = () => ({});
        switch (op as BoardOperation) {
          case "moveCard":
          case "setCardParent":
            change = planMoveCard(current, plannerInput, { now });
            break;
          case "updateCard":
            change = planUpdateCard(current, plannerInput, { now });
            break;
          case "reorderCards":
            change = planReorderCards(current, plannerInput, { now });
            break;
          case "deleteArchivedCard":
            change = planDeleteArchivedCard(current, plannerInput);
            break;
          case "createCard": {
            const planned = planCreateCard(current, plannerInput, reserve);
            change = planned;
            result = (roadmap) => ({ createdCard: roadmap.roadmapItems.find((item) => item.id === planned.cardId) });
            break;
          }
          case "createGroup": {
            const planned = planCreateGroup(current, plannerInput, reserve);
            change = planned;
            result = (roadmap) => ({ createdGroup: roadmap.roadmapItems.find((item) => item.id === planned.groupId) });
            break;
          }
          case "createCards": {
            const planned = planCreateCards(current, plannerInput, reserve);
            change = planned;
            const ids = new Set(planned.cardIds);
            result = (roadmap) => ({ createdCards: roadmap.roadmapItems.filter((item) => ids.has(item.id)) });
            break;
          }
          default:
            fail("not_found", `Unknown operation: ${op}`);
        }
        checkOwnerControlled(current, change.roadmap, acting, attribution.actor, completionConfirmed);
        settled = await settle(ctx, at, op, input, current, change, attribution.actor);
        const { committed, version } = await commit(ctx, access.board, current, change, attribution, now);
        outcome = { committed, version, result: result(committed) };
      }
    } catch (error) {
      const refusal = asServiceError(error, current.revision);
      const data = refusal.data as ServiceErrorData;
      // An agent's edit refused over a clash is kept, never lost silently (Spec point 20).
      const kept = data.code === "conflict" && data.conflict && attribution.actor === "agent"
        ? await keepRefused(ctx, at, op, input, data, current, attribution)
        : null;
      if (kept) {
        // A retry with the same key returns this same refusal, and keeps nothing twice.
        if (idempotencyKey) {
          await ctx.db.insert("operations", {
            userId: access.connection.userId, key: idempotencyKey, requestHash: requestHash!, boardId,
            outcome: packJson({ result: null, version: 0, revision: current.revision, generation: at.generation, refused: kept } satisfies Outcome), createdAt: now,
          });
        }
        return { refused: kept };
      }
      throw refusal;
    }
    // Settled fields leave the unresolved change; one with nothing left is gone.
    for (const { row, fieldsLeft } of settled) {
      if (fieldsLeft.length) {
        await ctx.db.patch(row._id, { fields: fieldsLeft });
      } else {
        await ctx.db.delete(row._id);
        await addStored(ctx, at, -(row.bytes ?? 0));
      }
    }
    // An agent editing a card is working on it (Spec point 20): a heads-up for others, not a lock.
    // Agents on a computer say so themselves, with their app's name; this covers apps connected to the service.
    if (attribution.actor === "agent" && !access.connection.canAdminister) {
      for (const cardId of editedCards(input, outcome.result)) {
        await touchPresence(ctx, at, { cardId, connectionId: access.connection._id, userId: access.connection.userId, app: appName(typeof input.agentName === "string" ? input.agentName : access.connection.clientName) });
      }
    }
    if (idempotencyKey) {
      await ctx.db.insert("operations", {
        userId: access.connection.userId, key: idempotencyKey, requestHash: requestHash!, boardId,
        outcome: packJson({ result: outcome.result, version: outcome.version, revision: outcome.committed.revision, generation: at.generation } satisfies Outcome),
        createdAt: now,
      });
    }
    return { roadmap: outcome.committed, result: outcome.result };
  })()),
});

/** The cards an edit worked on: the card it names, or the ones it created. */
function editedCards(input: Record<string, unknown>, result: unknown) {
  const made = result as { createdCard?: { id: string }; createdGroup?: { id: string }; createdCards?: Array<{ id: string }> } | null;
  const ids = [
    ...(typeof input.cardId === "string" ? [input.cardId] : []),
    ...(made?.createdCard ? [made.createdCard.id] : []), ...(made?.createdGroup ? [made.createdGroup.id] : []), ...(made?.createdCards ?? []).map((card) => card.id),
  ];
  return [...new Set(ids)].slice(0, 20);
}

/** An agent reading a card is working on it too. */
export const notePresence = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), cardId: v.string(), agentName: v.optional(v.string()) },
  handler: async (ctx, { connectionId, boardId, cardId, agentName }) => {
    const access = await readableBoard(ctx, connectionId, boardId);
    // A card id's shape only: reading the board here would make every board edit retry this.
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(cardId)) return { noted: false };
    await touchPresence(ctx, live(access.board), { cardId, connectionId: access.connection._id, userId: access.connection.userId, app: appName(agentName ?? access.connection.clientName) });
    return { noted: true };
  },
});

/** Who else is working on a card, or on each card, in words for agents. */
export const working = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), cardId: v.optional(v.string()), agentName: v.optional(v.string()) },
  handler: async (ctx, { connectionId, boardId, cardId, agentName }) => {
    const access = await readableBoard(ctx, connectionId, boardId);
    // Leaves out only the asking agent itself: another app on the same sign-in is someone else.
    const byCard = await workingOn(ctx, live(access.board), { ...(cardId ? { cardId } : {}), except: { connectionId: access.connection._id, app: appName(agentName ?? access.connection.clientName) } });
    const out: Record<string, Array<{ who: string; startedAt: string; lastActiveAt: string; note: string }>> = {};
    for (const [card, entries] of Object.entries(byCard)) {
      out[card] = [];
      for (const entry of entries) {
        const person = await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", entry.userId)).unique();
        const who = `${entry.app} (${person?.name || person?.email || "someone on the board"})`;
        out[card]!.push({ who, startedAt: entry.startedAt, lastActiveAt: entry.lastActiveAt, note: workingSentence(who, entry.startedAt) });
      }
    }
    return { working: out };
  },
});

/** A section's identity in an unresolved change: "spec:Heading#0" (repeated headings are told apart). */
function sectionField(input: Record<string, unknown>) {
  return `${String(input.kind)}:${String(input.heading ?? "").trim()}#${typeof input.occurrence === "number" ? input.occurrence : 0}`;
}

/** The unresolved changes this agent edit settles; its history says so, plainly. */
async function settle(ctx: MutationCtx, at: BoardRows, op: string, input: Record<string, unknown>, current: PlanbanRoadmap, change: PlannedChange, actor: "user" | "agent") {
  if (actor !== "agent") return [];
  const touched = settlingFields(op, input, current);
  if (!touched?.length) return [];
  const settled = await settledBy(ctx, at, touched, typeof input.baseRevision === "number" ? input.baseRevision : null);
  if (settled.length) change.history = { ...change.history, summary: `${change.history.summary} (reconsidered after an earlier clash)` };
  return settled;
}

/** Records a refused agent edit as an unresolved change on its card, and says so in the refusal. */
async function keepRefused(ctx: MutationCtx, at: BoardRows, op: string, input: Record<string, unknown>, data: ServiceErrorData, current: PlanbanRoadmap, attribution: Attribution) {
  const conflict = data.conflict as unknown as ConflictDetails;
  const cardId = typeof input.cardId === "string" ? input.cardId : conflict.clashes?.[0]?.cardId ?? conflict.document?.cardId;
  if (!cardId) return null;
  // Every field the refused edit wanted is unapplied, not only the ones that clashed.
  const wanted = touchedFields(op, input, current)?.filter((entry) => entry.cardId === cardId).map((entry) => entry.field) ?? [];
  const clashing = conflict.clashes?.filter((clash) => clash.cardId === cardId).map((clash) => clash.field) ?? [];
  const fields = conflict.section && conflict.document ? [sectionField(input)]
    : conflict.document ? [conflict.document.kind]
    : [...new Set([...clashing, ...wanted])];
  const { baseRevision: _base, actor: _actor, idempotencyKey: _key, ...proposed } = input;
  // Kept text follows the same rules and limits as any write: text only, counted toward the day's writes and the board's size.
  try {
    checkIndexValue(proposed, "the refused edit", MAX_DOCUMENT_BYTES + MAX_CARD_BYTES);
  } catch (error) {
    throw asServiceError(error);
  }
  const bytes = sizeOf(proposed);
  await chargeWrite(ctx, attribution.userId, bytes);
  const changeId = await recordUnresolved(ctx, at, {
    cardId, userId: attribution.userId, clientName: attribution.clientName, createdAt: new Date().toISOString(), op, proposed,
    fields: fields.length ? fields : ["*"], refusedAtRevision: current.revision, message: data.message.split(". The ")[0]!.slice(0, 500), bytes,
  });
  if (!changeId) {
    return { ...data, message: `${data.message} This board already has ${MAX_PER_BOARD} unresolved changes waiting, so this one is not kept: settle or drop some, then make this edit again from the current version.` };
  }
  await addStored(ctx, at, bytes);
  return {
    ...data,
    message: `${data.message} Until you save a reconsidered version or drop it (planban_drop_change with a reason), it is kept as unresolved change ${changeId} on this card, for agents to see.`,
    conflict: { ...conflict, unresolvedChange: changeId } as unknown as Value,
  };
}

/** Drops an unresolved change, with the reason, into the card's history. */
/**
 * Goals (owner decisions, 16 October 2026): people change them, from their own
 * sign-in; agents only suggest. Each change is a board revision with a history
 * entry, like any edit, so live updates, clashes and retries work the same.
 */
async function changeGoals(ctx: MutationCtx, board: Doc<"boards">, current: PlanbanRoadmap, op: string, input: Record<string, unknown>, now: string, attribution: Attribution) {
  if (op !== "suggestGoalChange" && attribution.actor !== "user") fail("forbidden", PEOPLE_ONLY);
  const at = live(board);
  const file = await goalsOf(ctx, at);
  const agentClient = attribution.actor === "agent" ? appName(typeof input.agentName === "string" ? input.agentName : attribution.clientName) : null;
  const stamp = { revision: current.revision + 1, baseRevision: typeof input.baseRevision === "number" ? input.baseRevision : undefined, by: await personName(ctx, attribution.userId, agentClient), now };
  let planned: { goals: GoalsFile; summary: string; suggestion?: unknown };
  if (op === "editGoals") planned = applyGoalEdit(file, input.edit, stamp);
  else if (op === "decideGoalSuggestion") planned = decideSuggestion(file, { suggestionId: input.suggestionId, decision: input.decision }, stamp);
  else {
    const added = addSuggestion(file, { change: input.change, reason: input.reason }, { ...stamp, id: crypto.randomUUID() });
    // Nothing new to show the person: no revision, no history entry.
    if (!added.goals) return { committed: current, version: 0, result: { page: goalsPage(file), revision: current.revision, notAdded: added.notAdded } };
    planned = added;
  }
  // The same measure as on a computer, so goals that fit online still fit after Take Local.
  try {
    assertGoalsSize(planned.goals);
  } catch (error) {
    throw asServiceError(error);
  }
  const packed = packJson(planned.goals);
  const { committed, version } = await commit(ctx, board, current, { roadmap: current, history: { actor: attribution.actor, operation: "goals.edit", summary: planned.summary, affectedCards: [] }, docWrites: [] }, attribution, now);
  const state = await stateRow(ctx, at);
  await chargeWrite(ctx, attribution.userId, sizeOf(packed));
  await ctx.db.patch(state._id, { goals: packed });
  await addStored(ctx, at, sizeOf(packed) - (state.goals ? sizeOf(state.goals) : 0));
  return { committed, version, result: { page: goalsPage(planned.goals), revision: committed.revision, ...(planned.suggestion ? { suggestion: planned.suggestion } : {}) } };
}

async function dropChange(ctx: MutationCtx, board: Doc<"boards">, current: PlanbanRoadmap, input: Record<string, unknown>, now: string, attribution: Attribution) {
  const changeId = String(input.changeId ?? "");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) fail("validation", "Say why the change is dropped (reason).");
  if (reason.length > 500) fail("validation", "Keep the reason under 500 characters.");
  const row = await ctx.db.query("unresolvedChanges").withIndex("by_changeId", (q) => q.eq("changeId", changeId)).unique();
  if (!row || row.boardId !== board.boardId || row.generation !== board.generation) fail("not_found", `Unresolved change not found: ${changeId}`);
  const card = current.roadmapItems.find((item) => item.id === row!.cardId);
  await ctx.db.delete(row!._id);
  await addStored(ctx, live(board), -(row!.bytes ?? 0));
  const change: PlannedChange = {
    roadmap: current,
    history: { actor: attribution.actor, operation: "card.change.dropped", summary: `Dropped an edit to ${card ? card.title : row!.cardId}: ${reason}`, affectedCards: card ? [card.id] : [] },
    docWrites: [],
  };
  const { committed, version } = await commit(ctx, board, current, change, attribution, now);
  return { committed, version, result: { dropped: changeId } };
}

/**
 * One section of a Spec or Plan, by heading (Spec point 20): checked against
 * that section's own version, so edits to other sections never clash.
 */
async function writeDocSection(ctx: MutationCtx, board: Doc<"boards">, current: PlanbanRoadmap, input: Record<string, unknown>, now: string, attribution: Attribution, note: string) {
  const cardId = String(input.cardId ?? "");
  const kind = input.kind as DocKind;
  if (!DOC_KINDS.has(kind)) fail("validation", "kind must be spec or plan.");
  const heading = typeof input.heading === "string" ? input.heading.trim() : "";
  if (!heading) fail("validation", "heading is the section's heading text, without the #s.");
  if (typeof input.markdown !== "string") fail("validation", "markdown is the whole section, starting with its heading line.");
  if (input.expectedSectionVersion !== null && typeof input.expectedSectionVersion !== "string") {
    fail("validation", "expectedSectionVersion is the section's version from read_doc (sections), or null for a new section.");
  }
  if (!current.roadmapItems.some((item) => item.id === cardId)) fail("not_found", `Card not found: ${cardId}`);
  const existing = await docRow(ctx, live(board), cardId, kind);
  const before = existing ? unpackText(existing.markdown) : "";
  let edit: SectionEdit;
  try {
    edit = editSection(before, {
      heading, expectedVersion: input.expectedSectionVersion as string | null, text: input.markdown as string,
      ...(typeof input.occurrence === "number" ? { occurrence: input.occurrence } : {}), ...(typeof input.after === "string" ? { after: input.after } : {}),
    });
  } catch (error) {
    throw asServiceError(error);
  }
  if (!edit.ok) {
    const changes = existing ? [{
      at: existing.updatedAt, by: await personName(ctx, existing.updatedBy, existing.updatedByAgent ? existing.updatedByClient ?? "" : null),
      agent: existing.updatedByAgent === true, summary: existing.updateSummary ?? `Edited the ${kind === "spec" ? "Spec" : "Plan"}`, cards: [cardId],
    }] : [];
    const document = docPayload(existing, cardId, kind, null);
    const conflict: ConflictDetails = {
      currentRevision: current.revision, changes, section: edit.current,
      document: document.markdown.length > MAX_CONFLICT_DOCUMENT_CHARS ? { ...document, markdown: "", markdownOmitted: true as const } : document,
    };
    const where = `the "${heading}" section of the ${kind === "spec" ? "Spec" : "Plan"} of ${cardSubject(current, cardId)}`;
    const message = edit.reason === "changed"
      ? conflictMessage(where, conflict, attribution.actor === "agent")
      : edit.reason === "missing"
        ? `Not saved: ${where} is no longer there (it was removed or renamed since you read it).${attribution.actor === "agent" ? ` ${RECONCILE}` : ""}`
        : `Not saved: a section called "${heading}" was added since you read it.${attribution.actor === "agent" ? ` ${RECONCILE}` : ""}`;
    fail("conflict", message, { currentRevision: current.revision, conflict: conflict as unknown as Value });
  }
  const written = await writeDoc(ctx, board, current, { cardId, kind, markdown: edit.markdown, expectedMtimeMs: existing?.stamp ?? null }, now, attribution, ` (the "${heading}" section)${note}`);
  return { ...written, result: { ...(written.result as Record<string, unknown>), section: edit.section } };
}

async function writeDoc(ctx: MutationCtx, board: Doc<"boards">, current: PlanbanRoadmap, input: Record<string, unknown>, now: string, attribution: Attribution, note = "") {
  const cardId = String(input.cardId ?? "");
  const kind = input.kind as DocKind;
  if (!DOC_KINDS.has(kind)) fail("validation", "kind must be spec or plan.");
  if (typeof input.markdown !== "string") fail("validation", "markdown must be a string.");
  // A document edit's base version is the document's own stamp (below); the
  // board revision is checked too when the caller states it.
  // A document's own version is its check (below); the board revision isn't, so edits elsewhere on the board never refuse it.
  const planned = planWriteDoc(current, { cardId, kind }, { now });
  const existing = await docRow(ctx, live(board), cardId, kind);
  // Documents also state the version they were based on: their stamp, or null for a new document.
  if (input.expectedMtimeMs === undefined) {
    fail("validation", "Online document edits must state the document version they were based on: expectedMtimeMs from reading it, or null for a new document (on the command line, --expected-mtime <mtimeMs> or --expected-mtime new).", { currentRevision: current.revision });
  }
  if ((existing && existing.stamp !== input.expectedMtimeMs) || (!existing && input.expectedMtimeMs !== null)) {
    // The document as it is now, and who last changed it, so the agent can reconcile.
    // A very long document is left out of the answer (read it with read_doc); its version is always there.
    const full = docPayload(existing, cardId, kind, planned.path);
    const document = full.markdown.length > MAX_CONFLICT_DOCUMENT_CHARS ? { ...full, markdown: "", markdownOmitted: true as const } : full;
    // Who last wrote it is kept on the document itself, so no history scan is needed.
    const changes = existing ? [{
      at: existing.updatedAt, by: await personName(ctx, existing.updatedBy, existing.updatedByAgent ? existing.updatedByClient ?? "" : null),
      agent: existing.updatedByAgent === true, summary: existing.updateSummary ?? `Edited the ${kind === "spec" ? "Spec" : "Plan"}`, cards: [cardId],
    }] : [];
    const conflict: ConflictDetails = { currentRevision: current.revision, changes, document };
    fail("conflict", conflictMessage(`the ${kind === "spec" ? "Spec" : "Plan"} of ${cardSubject(current, cardId)}`, conflict, attribution.actor === "agent"), { currentRevision: current.revision, conflict: conflict as unknown as Value });
  }
  const change: PlannedChange = {
    roadmap: planned.roadmap ?? current,
    history: { ...planned.history, actor: attribution.actor, summary: `${planned.history.summary}${note}` },
    docWrites: [{ cardId, kind, path: planned.path, markdown: input.markdown as string }],
  };
  // A document edit is a board change too: it bumps the revision so every
  // client watching for changes sees it, matching local document events.
  const { committed, version } = await commit(ctx, board, current, change, attribution, now);
  return { committed, version, result: { doc: docPayload(await docRow(ctx, live(board), cardId, kind), cardId, kind, planned.path) } };
}
