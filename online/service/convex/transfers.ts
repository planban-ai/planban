// Take Online in parts, and removal of board generations that are no longer
// live (replaced by a later upload, or a cancelled upload).
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { liveConnection } from "./model/access";
import { fail } from "./model/errors";
import { abortTransfer, beginTransfer, commitTransfer, createOnlineBoard, putPart, requireOwnConnection, type BeginInput, type PartInput } from "./model/transfer";
import { packed, unpackJson } from "./model/codec";

const CLEANUP_BATCH = 25;

const attributionOf = (connection: { _id: string; userId: string; clientName: string }) =>
  ({ userId: connection.userId, clientName: connection.clientName, actor: "user" as const, connectionId: connection._id });

/** New board on the web (Planban 2.0): an empty online board owned by the signed-in person. */
export const createBoard = internalMutation({
  args: { connectionId: v.id("connections"), title: v.string() },
  handler: async (ctx, { connectionId, title }) => {
    const connection = await liveConnection(ctx, connectionId);
    return createOnlineBoard(ctx, connection, { title }, attributionOf(connection));
  },
});

/** The board's content arrives packed (see http.ts): Convex values limit how data may be shaped, the board doesn't. */
export const begin = internalMutation({
  args: { connectionId: v.id("connections"), transferId: v.string(), payload: v.bytes() },
  handler: async (ctx, { connectionId, transferId, payload }) =>
    beginTransfer(ctx, await liveConnection(ctx, connectionId), { ...unpackJson<Omit<BeginInput, "transferId">>(payload), transferId }),
});

export const part = internalMutation({
  args: { connectionId: v.id("connections"), transferId: v.string(), seq: v.number(), payload: v.bytes() },
  handler: async (ctx, { connectionId, transferId, seq, payload }) =>
    putPart(ctx, await liveConnection(ctx, connectionId), { ...unpackJson<Omit<PartInput, "transferId" | "seq">>(payload), transferId, seq }),
});

export const commit = internalMutation({
  args: { connectionId: v.id("connections"), transferId: v.string(), partCount: v.number() },
  handler: async (ctx, { connectionId, ...input }) => packed(await (async () => {
    const connection = await liveConnection(ctx, connectionId);
    return commitTransfer(ctx, connection, input, attributionOf(connection));
  })()),
});

export const abort = internalMutation({
  args: { connectionId: v.id("connections"), transferId: v.string() },
  handler: async (ctx, { connectionId, transferId }) => {
    const connection = await liveConnection(ctx, connectionId);
    requireOwnConnection(connection);
    const transfer = await ctx.db.query("transfers").withIndex("by_transferId", (q) => q.eq("transferId", transferId)).unique();
    if (!transfer || transfer.userId !== connection.userId) fail("not_found", "Upload not found.");
    if (transfer!.state === "committed") fail("conflict", "This upload already finished; the board is online.");
    await abortTransfer(ctx, transfer!);
    return { state: "aborted" as const };
  },
});

/** Small boards: begin, one part and commit in a single transaction. */
export const importBundle = internalMutation({
  args: { connectionId: v.id("connections"), transferId: v.string(), payload: v.bytes() },
  handler: async (ctx, { connectionId, transferId, payload }) => packed(await (async () => {
    const bundle = unpackJson<Record<string, any>>(payload);
    const connection = await liveConnection(ctx, connectionId);
    if (bundle?.format !== "planban-board-bundle" || bundle.version !== 1) fail("validation", "Expected a planban-board-bundle, version 1.");
    await beginTransfer(ctx, connection, { transferId, roadmap: bundle.roadmap, retention: bundle.retention, retiredIds: bundle.retiredIds, uid: bundle.uid, goals: bundle.goals });
    await putPart(ctx, connection, { transferId, seq: 0, docs: bundle.docs, history: bundle.history, historyDocs: bundle.historyDocs });
    return commitTransfer(ctx, connection, { transferId, partCount: 1 }, attributionOf(connection));
  })()),
});

async function deleteSome(ctx: MutationCtx, table: "boardState" | "docs" | "history" | "historyPayloads" | "historyDocs" | "retiredIds" | "boardFingerprints" | "cardChanges" | "boardSizes" | "presence" | "unresolvedChanges", boardId: string, generation: number) {
  const index = table === "boardState" || table === "boardFingerprints" || table === "boardSizes" ? "by_board_generation" : table === "docs" ? "by_board_card_kind" : table === "retiredIds" || table === "presence" || table === "unresolvedChanges" ? "by_board_card" : table === "cardChanges" ? "by_board_generation_card" : "by_board_version";
  const rows = await (ctx.db.query(table) as any).withIndex(index, (q: any) => q.eq("boardId", boardId).eq("generation", generation)).take(CLEANUP_BATCH);
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

export const cleanupGeneration = internalMutation({
  args: { boardId: v.string(), generation: v.number() },
  handler: async (ctx, { boardId, generation }) => {
    const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", boardId)).unique();
    if (board && board.generation === generation) return; // never remove the live board
    let removed = 0;
    for (const table of ["historyDocs", "historyPayloads", "history", "docs", "retiredIds", "boardFingerprints", "cardChanges", "presence", "unresolvedChanges", "boardSizes", "boardState"] as const) {
      removed += await deleteSome(ctx, table, boardId, generation);
      if (removed >= CLEANUP_BATCH) break;
    }
    if (removed > 0) {
      await ctx.scheduler.runAfter(0, internal.transfers.cleanupGeneration, { boardId, generation });
      return;
    }
    // A board whose only upload was cancelled is removed entirely.
    const open = await ctx.db.query("transfers").withIndex("by_board_state", (q) => q.eq("boardId", boardId).eq("state", "open")).first();
    if (board && board.authority === "importing" && board.generation === 0 && !open) {
      for (const member of await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId)).collect()) await ctx.db.delete(member._id);
      await ctx.db.delete(board._id);
    }
  },
});
