// Unresolved changes (Spec point 20): an agent's edit refused because
// something it touched changed since it read it is kept, so it is never lost
// silently. It clears when an agent saves a reconsidered version of the same
// fields, or drops it with a reason; both go in the card's history. Agents see
// these; the web page never shows them.
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { packJson, unpackJson } from "./codec";
import type { BoardRows } from "./history";

/**
 * At most this many wait on a board. Beyond that a refused edit is not kept,
 * and the refusal says so; nothing already waiting is ever removed to make room.
 */
export const MAX_PER_BOARD = 200;

export interface UnresolvedChange {
  changeId: string;
  cardId: string;
  by: { userId: string; app: string };
  at: string;
  op: string;
  proposed: unknown;
  fields: string[];
  refusedAtRevision: number;
  message: string;
}

export function publicUnresolved(row: Doc<"unresolvedChanges">): UnresolvedChange {
  const proposed = row.proposedPacked ? unpackJson<unknown>(row.proposedPacked) : row.proposed;
  return { changeId: row.changeId, cardId: row.cardId, by: { userId: row.userId, app: row.clientName }, at: row.createdAt, op: row.op, proposed, fields: row.fields, refusedAtRevision: row.refusedAtRevision, message: row.message };
}

/** Keeps a refused edit; null when the board already has as many waiting as it may (the refusal then says it wasn't kept). */
export async function recordUnresolved(ctx: MutationCtx, at: BoardRows, change: Omit<Doc<"unresolvedChanges">, "_id" | "_creationTime" | "boardId" | "generation" | "changeId">) {
  const waiting = await ctx.db.query("unresolvedChanges").withIndex("by_board_card", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).take(MAX_PER_BOARD);
  if (waiting.length >= MAX_PER_BOARD) return null;
  const changeId = crypto.randomUUID();
  // The proposed edit is kept packed: an edit may be shaped beyond what Convex documents allow.
  const { proposed, ...rest } = change as typeof change & { proposed?: unknown };
  await ctx.db.insert("unresolvedChanges", { ...at, changeId, ...rest, proposedPacked: packJson(proposed ?? null) });
  return changeId;
}

export async function unresolvedOn(ctx: QueryCtx, at: BoardRows, cardId?: string) {
  const rows = cardId
    ? await ctx.db.query("unresolvedChanges").withIndex("by_board_card", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", cardId)).collect()
    : await ctx.db.query("unresolvedChanges").withIndex("by_board_card", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).collect();
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The unresolved changes an agent's successful edit settles: on the same card
 * and fields, made from a revision at or after the refusal (so its author had
 * seen what changed).
 */
export async function settledBy(ctx: QueryCtx, at: BoardRows, touched: Array<{ cardId: string; field: string }>, baseRevision: number | null) {
  // Each settles only the fields this edit saved; the rest of it keeps waiting.
  const settled: Array<{ row: Doc<"unresolvedChanges">; fieldsLeft: string[] }> = [];
  for (const cardId of new Set(touched.map((entry) => entry.cardId))) {
    const fields = new Set(touched.filter((entry) => entry.cardId === cardId).map((entry) => entry.field));
    for (const row of await unresolvedOn(ctx, at, cardId)) {
      if (baseRevision !== null && baseRevision < row.refusedAtRevision) continue;
      // A whole-document write also settles a refused edit to one of its sections ("spec:Heading").
      const covers = (field: string) => fields.has("*") || fields.has(field) || fields.has(field.split(":")[0]!);
      if (!row.fields.some(covers) && !(row.fields.includes("*") && fields.size)) continue;
      const fieldsLeft = fields.has("*") || row.fields.includes("*") ? [] : row.fields.filter((field) => !covers(field));
      settled.push({ row, fieldsLeft });
    }
  }
  return settled;
}
