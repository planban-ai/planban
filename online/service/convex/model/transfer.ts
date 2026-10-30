// Take Online in parts. A large board (Revival's history alone is 126 MB) is
// far beyond one request, so the upload is: begin (with the roadmap), parts
// (documents and history), commit. Each step is idempotent under one transfer
// id. Everything is written into a new board generation that stays invisible
// until commit flips the board to it in one transaction.
import {
  assertCommittable,
  committedRoadmap,
  createEmptyRoadmap,
  normalizeRoadmap,
} from "../../../../src/core/boardOperations";
import type { PlanbanHistoryEntry, PlanbanRoadmap } from "../../../../src/core/types";
import { checkedGoals, type GoalsFile } from "../../../../src/core/goals";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { BOARD_ID_PATTERN } from "./access";
import { packJson, packText } from "./codec";
import { asServiceError, fail } from "./errors";
import { checkCards, checkDocuments, checkImportedExtras } from "./indexRules";
import { addStored, chargeImport, chargeNewOnlineBoard, sizeOf } from "./limits";
import { seedCardChanges } from "./cardChanges";
import { importHistoryVersion, recordHistory, type Attribution, type BoardRows } from "./history";
import { DOC_KINDS, currentRoadmap, docRow, retiredIds, stateRow, type DocKind } from "./rows";
import { reserveRetiredId } from "./retired";
import { boardIdReserved } from "./erasureGate";

/** Delay before an old generation's clean-up (and file carry-over) starts after a commit. */
const CLEANUP_DELAY_MS = 5_000;

/** An open upload untouched for this long may be replaced by a new one. */
export const STALE_TRANSFER_MS = 10 * 60 * 1000;

export interface BeginInput {
  transferId: string;
  uid?: string;
  roadmap: unknown;
  retention?: unknown;
  retiredIds?: string[];
  goals?: unknown;
}

export interface PartInput {
  transferId: string;
  seq: number;
  docs?: Array<{ cardId: string; kind: DocKind; markdown: string }>;
  history?: Array<{ entry: PlanbanHistoryEntry; roadmap: unknown }>;
  historyDocs?: Array<{ version: number; cardId: string; kind: DocKind; markdown: string }>;
}

async function transferRow(ctx: MutationCtx, transferId: string) {
  return ctx.db.query("transfers").withIndex("by_transferId", (q) => q.eq("transferId", transferId)).unique();
}

async function boardRow(ctx: MutationCtx, boardId: string) {
  return ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", boardId)).unique();
}

function rowsOf(transfer: Doc<"transfers">): BoardRows {
  return { boardId: transfer.boardId, generation: transfer.generation };
}

/** Uploads are driven only by the person's own sign-in, never by an agent connection or a key. */
export function requireOwnConnection(connection: Doc<"connections">) {
  if (connection.boards !== "all" || !connection.canAdminister) {
    fail("forbidden", "Taking a board online needs the owner's own connection, not a per-board grant.");
  }
}

async function ownedOpenTransfer(ctx: MutationCtx, connection: Doc<"connections">, transferId: string) {
  requireOwnConnection(connection);
  const transfer = await transferRow(ctx, transferId);
  if (!transfer || transfer.userId !== connection.userId) fail("not_found", "Upload not found.");
  if (transfer!.state === "aborted") fail("conflict", "This upload was cancelled. Start Take Online again.");
  return transfer!;
}

/**
 * Generation numbers are unique across all boards and never reused, so a
 * clean-up job for an old upload can never touch a newer one, even if the
 * board was deleted and its id taken again.
 */
async function nextGeneration(ctx: MutationCtx) {
  const counter = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "generation")).unique();
  const value = (counter?.value ?? 0) + 1;
  if (counter) await ctx.db.patch(counter._id, { value });
  else await ctx.db.insert("counters", { name: "generation", value });
  return value;
}

export async function abortTransfer(ctx: MutationCtx, transfer: Doc<"transfers">) {
  if (transfer.state !== "open") return;
  await ctx.db.patch(transfer._id, { state: "aborted", updatedAt: new Date().toISOString() });
  await ctx.scheduler.runAfter(0, internal.transfers.cleanupGeneration, { boardId: transfer.boardId, generation: transfer.generation });
}

export async function beginTransfer(ctx: MutationCtx, connection: Doc<"connections">, input: BeginInput) {
  requireOwnConnection(connection);
  if (!/^[A-Za-z0-9-]{8,80}$/.test(input.transferId)) fail("validation", "transferId must be 8 to 80 letters, digits or dashes.");
  const existing = await transferRow(ctx, input.transferId);
  if (existing) {
    if (existing.userId !== connection.userId) fail("conflict", "transferId is already in use.");
    if (existing.state === "aborted") fail("conflict", "This upload was cancelled. Start Take Online again.");
    const parts = await ctx.db.query("transferParts").withIndex("by_transfer_seq", (q) => q.eq("transferId", input.transferId)).collect();
    return { transferId: existing.transferId, boardId: existing.boardId, state: existing.state, receivedParts: parts.map((part) => part.seq) };
  }
  let roadmap: PlanbanRoadmap;
  let goals: GoalsFile | null = null;
  try {
    roadmap = normalizeRoadmap(input.roadmap);
    if (input.goals !== undefined && input.goals !== null) goals = checkedGoals(input.goals);
    assertCommittable(roadmap);
    // Planban is an index, not storage (owner decision 18): the board arrives as text only.
    checkCards(roadmap);
    checkImportedExtras({ retiredIds: input.retiredIds, retention: input.retention });
  } catch (error) {
    throw asServiceError(error);
  }
  const boardId = roadmap.project.id;
  if (!BOARD_ID_PATTERN.test(boardId)) fail("validation", "The board's project id must be a lowercase slug.");
  const now = new Date().toISOString();
  let board = await boardRow(ctx, boardId);
  let previousRevision = -1;
  if (board) {
    const member = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId).eq("userId", connection.userId)).unique();
    if (member?.role !== "owner") fail("conflict", `An Online Board called ${boardId} already exists.`);
    if (board.authority === "online") fail("conflict", "This board is already online. Take it local first, or edit it online.");
    // A Take Local still downloading reads the current generation; let it finish first.
    if (board.localTransfer && Date.now() - Date.parse(board.localTransfer.at) < 24 * 60 * 60 * 1000) {
      fail("conflict", "This board is still being taken local on a machine. Finish that Take Local first.");
    }
    // A board taken local that comes back online counts like a new one; an
    // upload already under way for it (below) is replaced, not counted twice.
    const underWay = await ctx.db.query("transfers").withIndex("by_board_state", (q) => q.eq("boardId", boardId).eq("state", "open")).first();
    if (board.authority === "returned-local" && !underWay) await chargeNewOnlineBoard(ctx, connection.userId);
    for (const open of await ctx.db.query("transfers").withIndex("by_board_state", (q) => q.eq("boardId", boardId).eq("state", "open")).collect()) {
      if (Date.now() - Date.parse(open.updatedAt) < STALE_TRANSFER_MS) fail("conflict", `${boardId} is being taken online right now. Try again in a few minutes.`);
      await abortTransfer(ctx, open);
    }
    if (board.authority === "returned-local") previousRevision = board.revision;
  } else {
    if (await boardIdReserved(ctx, boardId)) fail("conflict", `An online copy of ${boardId} is still being deleted. Try again in a few minutes.`);
    await chargeNewOnlineBoard(ctx, connection.userId);
    const id = await ctx.db.insert("boards", {
      boardId, title: roadmap.project.title, ownerId: connection.userId, authority: "importing",
      revision: roadmap.revision, generation: 0, historyVersion: 0, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("members", { boardId, userId: connection.userId, role: "owner" });
    board = (await ctx.db.get(id))!;
  }
  const generation = await nextGeneration(ctx);
  const at = { boardId, generation };
  // Take Online counts towards the account's daily import limit and the board's size limit.
  await chargeImport(ctx, connection.userId, sizeOf(input.roadmap) + sizeOf(input.retiredIds ?? []) + sizeOf(input.retention ?? null) + sizeOf(goals));
  const packedRoadmap = packJson(roadmap);
  const packedGoals = goals ? packJson(goals) : undefined;
  await ctx.db.insert("boardState", { ...at, roadmap: packedRoadmap, ...(packedGoals ? { goals: packedGoals } : {}) });
  await addStored(ctx, at, sizeOf(packedRoadmap) + (packedGoals ? sizeOf(packedGoals) : 0));
  const live = new Set(roadmap.roadmapItems.map((item) => item.id));
  for (const cardId of new Set(input.retiredIds ?? [])) {
    if (!live.has(cardId)) await reserveRetiredId(ctx, at, cardId);
  }
  await ctx.db.insert("transfers", {
    transferId: input.transferId, userId: connection.userId, boardId, generation, state: "open",
    previousRevision, maxVersion: 0, createdAt: now, updatedAt: now,
    ...(input.retention === undefined ? {} : { retention: input.retention }),
    ...(input.uid && /^[a-f0-9-]{36}$/.test(input.uid) ? { uid: input.uid } : {}),
  });
  return { transferId: input.transferId, boardId, state: "open" as const, receivedParts: [] as number[] };
}

export async function putPart(ctx: MutationCtx, connection: Doc<"connections">, input: PartInput) {
  const transfer = await ownedOpenTransfer(ctx, connection, input.transferId);
  if (transfer.state === "committed") return { duplicate: true };
  if (!Number.isInteger(input.seq) || input.seq < 0) fail("validation", "seq must be a whole number.");
  const seen = await ctx.db.query("transferParts").withIndex("by_transfer_seq", (q) => q.eq("transferId", input.transferId).eq("seq", input.seq)).unique();
  if (seen) return { duplicate: true };
  const at = rowsOf(transfer);
  const roadmap = await currentRoadmap(ctx, at);
  const live = new Set(roadmap.roadmapItems.map((item) => item.id));
  let stamp = Date.now();
  checkImportedExtras({ history: input.history ?? [] });
  await chargeImport(ctx, connection.userId, sizeOf({ docs: input.docs ?? [], history: input.history ?? [], historyDocs: input.historyDocs ?? [] }));
  checkDocuments((input.docs ?? []).filter((doc) => typeof doc?.markdown === "string"));
  checkDocuments((input.historyDocs ?? []).filter((doc) => typeof doc?.markdown === "string"));
  for (const doc of input.docs ?? []) {
    if (!DOC_KINDS.has(doc.kind) || typeof doc.markdown !== "string") fail("validation", `Document ${doc.cardId}/${doc.kind} is invalid.`);
    if (!live.has(doc.cardId)) fail("validation", `Upload contains a document for an unknown card: ${doc.cardId}`);
    if (await docRow(ctx, at, doc.cardId, doc.kind)) fail("validation", `Upload contains a duplicate document: ${doc.cardId}/${doc.kind}`);
    const markdown = packText(doc.markdown);
    await ctx.db.insert("docs", { ...at, cardId: doc.cardId, kind: doc.kind, markdown, stamp: stamp++, updatedAt: transfer.createdAt, updatedBy: connection.userId });
    await addStored(ctx, at, sizeOf(markdown));
  }
  const retired = await retiredIds(ctx, at);
  let maxVersion = transfer.maxVersion;
  const versions = new Set<number>();
  let previousHistorical: PlanbanRoadmap | null = null;
  for (const version of [...input.history ?? []].sort((a, b) => (a?.entry?.version ?? 0) - (b?.entry?.version ?? 0))) {
    const number = version?.entry?.version;
    if (!Number.isInteger(number) || number < 1 || versions.has(number)) fail("validation", "History versions must be unique whole numbers.");
    const clash = await ctx.db.query("history").withIndex("by_board_version", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("version", number)).first();
    if (clash) fail("validation", `Upload contains history version ${number} twice.`);
    versions.add(number);
    let historical: PlanbanRoadmap;
    try {
      historical = normalizeRoadmap(version.roadmap);
    } catch (error) {
      throw asServiceError(error);
    }
    // Only what changed since the previous version in this part needs checking again.
    checkCards(historical, previousHistorical);
    previousHistorical = historical;
    await importHistoryVersion(ctx, at, version.entry, historical);
    await ctx.db.insert("boardFingerprints", { ...at, key: `${number}|${version.entry.createdAt}|${version.entry.operation}` });
    // Every id the board ever used that is not live now stays retired.
    for (const item of historical.roadmapItems) {
      if (!live.has(item.id) && !retired.has(item.id)) {
        retired.add(item.id);
        await reserveRetiredId(ctx, at, item.id);
      }
    }
    maxVersion = Math.max(maxVersion, number);
  }
  for (const doc of input.historyDocs ?? []) {
    if (!DOC_KINDS.has(doc.kind) || typeof doc.markdown !== "string") fail("validation", "A historical document is invalid.");
    const known = versions.has(doc.version) || await ctx.db.query("history")
      .withIndex("by_board_version", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("version", doc.version)).first();
    if (!known) fail("validation", "Upload contains a document for an unknown history version.");
    const markdown = packText(doc.markdown);
    await ctx.db.insert("historyDocs", { ...at, version: doc.version, cardId: doc.cardId, kind: doc.kind, markdown });
    await addStored(ctx, at, sizeOf(markdown));
  }
  await ctx.db.insert("transferParts", { transferId: input.transferId, seq: input.seq });
  await ctx.db.patch(transfer._id, { maxVersion, updatedAt: new Date().toISOString() });
  return { duplicate: false };
}

export async function commitTransfer(ctx: MutationCtx, connection: Doc<"connections">, input: { transferId: string; partCount: number }, attribution: Attribution) {
  const transfer = await ownedOpenTransfer(ctx, connection, input.transferId);
  const board = await boardRow(ctx, transfer.boardId);
  if (!board) fail("not_found", `Online Board not found: ${transfer.boardId}`);
  if (transfer.state === "committed") {
    return { boardId: board!.boardId, roadmap: await currentRoadmap(ctx, { boardId: board!.boardId, generation: board!.generation }) };
  }
  // A Take Local that renewed its freeze still owns the board.
  if (board!.localTransfer && Date.now() - Date.parse(board!.localTransfer.at) < 24 * 60 * 60 * 1000) {
    fail("conflict", "This board is still being taken local on a machine. Finish that Take Local first.");
  }
  const parts = await ctx.db.query("transferParts").withIndex("by_transfer_seq", (q) => q.eq("transferId", input.transferId)).collect();
  if (parts.length !== input.partCount) fail("validation", `The upload is incomplete: ${parts.length} of ${input.partCount} parts arrived. Run Take Online again to resume.`);
  const at = rowsOf(transfer);
  const roadmap = await currentRoadmap(ctx, at);
  const now = new Date().toISOString();
  // Taking a board online is itself a change: it bumps the revision once and
  // adds a history version, keeping earlier version numbers intact. A board
  // taken online again never goes back to an older revision.
  const committed = committedRoadmap({ ...roadmap, revision: Math.max(roadmap.revision, transfer.previousRevision) }, now);
  const state = await stateRow(ctx, at);
  const packedRoadmap = packJson(committed);
  await ctx.db.patch(state._id, { roadmap: packedRoadmap });
  await addStored(ctx, at, sizeOf(packedRoadmap) - sizeOf(state.roadmap));
  const previousGeneration = board!.generation;
  // Version numbers are never reused, even if the local history was trimmed.
  const baseVersion = Math.max(transfer.maxVersion, transfer.previousRevision >= 0 ? board!.historyVersion : 0);
  await ctx.db.patch(board!._id, {
    generation: transfer.generation,
    authority: "online",
    localTransfer: undefined,
    onlineSince: now,
    revision: committed.revision,
    historyVersion: baseVersion,
    title: roadmap.project.title,
    updatedAt: now,
    ...(transfer.retention === undefined ? {} : { retention: transfer.retention }),
    ...(transfer.uid ? { uid: transfer.uid } : {}),
  });
  await seedCardChanges(ctx, { boardId: board!.boardId, generation: transfer.generation }, committed, board!.ownerId, now);
  await recordHistory(ctx, {
    board: { ...board!, generation: transfer.generation, historyVersion: baseVersion },
    previous: null,
    committed,
    history: { actor: "user", operation: "board.take-online", summary: "Took the board online", affectedCards: [] },
    docs: [],
    attribution,
    now,
  });
  await ctx.db.patch(transfer._id, { state: "committed", updatedAt: now });
  if (previousGeneration > 0) {
    // Clean-up of the previous generation is not urgent.
    await ctx.scheduler.runAfter(CLEANUP_DELAY_MS, internal.transfers.cleanupGeneration, { boardId: board!.boardId, generation: previousGeneration });
  }
  return { boardId: board!.boardId, roadmap: committed };
}

const MAX_BOARD_TITLE = 120;

/** A free board id from a title: its slug, or the slug with a short random suffix when taken. */
async function freeBoardId(ctx: MutationCtx, title: string) {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "") || "board";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = attempt === 0 ? slug : `${slug}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36).slice(0, 6)}`;
    if (BOARD_ID_PATTERN.test(candidate) && !await boardRow(ctx, candidate) && !await boardIdReserved(ctx, candidate)) return candidate;
  }
  fail("conflict", "Couldn't find a free name for this board. Try another name.");
  return "";
}

/**
 * New board on the web: an empty online board owned by the person, created in
 * one transaction with its first history entry. Counts against the account's
 * online board limits before anything is written.
 */
export async function createOnlineBoard(ctx: MutationCtx, connection: Doc<"connections">, input: { title: string }, attribution: Attribution) {
  requireOwnConnection(connection);
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title || title.length > MAX_BOARD_TITLE) fail("validation", `Give the board a name of up to ${MAX_BOARD_TITLE} characters.`);
  await chargeNewOnlineBoard(ctx, connection.userId);
  const boardId = await freeBoardId(ctx, title);
  const now = new Date().toISOString();
  const roadmap = createEmptyRoadmap({ repoId: boardId, title, now });
  const generation = await nextGeneration(ctx);
  const at = { boardId, generation };
  const packedRoadmap = packJson(roadmap);
  await ctx.db.insert("boardState", { ...at, roadmap: packedRoadmap });
  await addStored(ctx, at, sizeOf(packedRoadmap));
  const id = await ctx.db.insert("boards", {
    boardId, title, ownerId: connection.userId, authority: "online", revision: roadmap.revision,
    generation, historyVersion: 0, onlineSince: now, uid: crypto.randomUUID(), createdAt: now, updatedAt: now,
  });
  await ctx.db.insert("members", { boardId, userId: connection.userId, role: "owner" });
  const board = (await ctx.db.get(id))!;
  await seedCardChanges(ctx, at, roadmap, connection.userId, now);
  await recordHistory(ctx, {
    board, previous: null, committed: roadmap,
    history: { actor: "user", operation: "board.create", summary: "Created the board online", affectedCards: [] },
    docs: [], attribution, now,
  });
  return { boardId, title, revision: roadmap.revision };
}
