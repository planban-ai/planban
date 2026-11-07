// A starting total for boards stored before size accounting existed (see
// model/limits.ts). Run once after deploying the change to a backend that
// already holds boards:  npx convex run limits:backfillAll
// Each board's live generation is measured in small batches, then its total
// is replaced by what was measured, but only if nothing changed the board's
// total meanwhile (its epoch); otherwise the measurement starts again.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { sizeOf } from "./model/limits";
import { stateBytes } from "./model/roadmapStore";

const TABLES = ["boardState", "boardCards", "docs", "history", "historyPayloads", "historyDocs", "retiredIds"] as const;
const BATCH = 100;

export const backfillAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    let scheduled = 0;
    for await (const board of ctx.db.query("boards")) {
      await ctx.scheduler.runAfter(0, internal.limits.backfillBoard, { boardId: board.boardId, generation: board.generation, table: 0, cursor: null, total: 0, epoch: null });
      scheduled += 1;
    }
    return { scheduled };
  },
});

export const backfillBoard = internalMutation({
  args: { boardId: v.string(), generation: v.number(), table: v.number(), cursor: v.union(v.string(), v.null()), total: v.number(), epoch: v.union(v.number(), v.null()) },
  handler: async (ctx, { boardId, generation, table, cursor, total, epoch }) => {
    const row = await ctx.db.query("boardSizes").withIndex("by_board_generation", (q) => q.eq("boardId", boardId).eq("generation", generation)).unique();
    const current = row?.epoch ?? 0;
    // The epoch when measuring began: the first step records it.
    const started = epoch ?? current;
    if (current !== started) {
      // Overtaken by a change: measure again from the start.
      await ctx.scheduler.runAfter(0, internal.limits.backfillBoard, { boardId, generation, table: 0, cursor: null, total: 0, epoch: null });
      return;
    }
    const name = TABLES[table];
    if (!name) {
      // Same transaction as the epoch check above, so nothing can slip in between.
      if (row) await ctx.db.patch(row._id, { bytes: total, epoch: current + 1 });
      else await ctx.db.insert("boardSizes", { boardId, generation, bytes: total, epoch: 1 });
      return;
    }
    const index = name === "boardState" ? "by_board_generation" : name === "boardCards" ? "by_board_generation_chunk" : name === "docs" ? "by_board_card_kind" : name === "retiredIds" ? "by_board_card" : "by_board_version";
    const page = await (ctx.db.query(name) as any).withIndex(index, (q: any) => q.eq("boardId", boardId).eq("generation", generation)).paginate({ numItems: BATCH, cursor });
    let added = 0;
    for (const row of page.page as Array<Record<string, unknown>>) {
      if (name === "boardState") added += stateBytes(row as never);
      else if (name === "boardCards") added += sizeOf(row.cards);
      else if (name === "docs" || name === "historyDocs") added += sizeOf(row.markdown);
      else if (name === "history") added += sizeOf(row.entry);
      else if (name === "retiredIds") added += sizeOf(row.cardId);
      else added += sizeOf(row.snapshot ?? row.delta ?? new Uint8Array());
    }
    await ctx.scheduler.runAfter(0, internal.limits.backfillBoard, page.isDone
      ? { boardId, generation, table: table + 1, cursor: null, total: total + added, epoch: started }
      : { boardId, generation, table, cursor: page.continueCursor, total: total + added, epoch: started });
  },
});
