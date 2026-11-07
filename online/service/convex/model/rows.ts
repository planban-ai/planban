// Reading and writing a board's rows in one generation.
import type { PlanbanDocPayload } from "../../../../src/core/types";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { unpackText } from "./codec";
import type { BoardRows } from "./history";
export { currentRoadmap, stateRow } from "./roadmapStore";

export type DocKind = "spec" | "plan";
export const DOC_KINDS = new Set<string>(["spec", "plan"]);

export function live(board: Doc<"boards">): BoardRows {
  return { boardId: board.boardId, generation: board.generation };
}

export async function docRow(ctx: QueryCtx, at: BoardRows, cardId: string, kind: DocKind) {
  return ctx.db.query("docs").withIndex("by_board_card_kind", (q) =>
    q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", cardId).eq("kind", kind)).unique();
}

export function docPayload(row: Doc<"docs"> | null, cardId: string, kind: DocKind, path: string | null): PlanbanDocPayload {
  if (!row) return { cardId, kind, path, exists: false, markdown: "", mtimeMs: null };
  return { cardId, kind, path, exists: true, markdown: unpackText(row.markdown), mtimeMs: row.stamp };
}

export async function retiredIds(ctx: QueryCtx, at: BoardRows): Promise<Set<string>> {
  const rows = await ctx.db.query("retiredIds").withIndex("by_board_card", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).collect();
  return new Set(rows.map((row) => row.cardId));
}
