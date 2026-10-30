// While something is being deleted (erasure.ts), nothing may bring it back.
// An account being deleted can't sign in, connect an app, be given a profile
// or be added to a board. Its deletion record is kept a day after it
// finishes; by then its Clerk user is gone, so it can never sign in again,
// and members.add only takes people who have used Planban. A deleted board's
// id stays reserved until its rows are gone.
import type { QueryCtx } from "../_generated/server";
import { fail } from "./errors";

export async function accountBeingDeleted(ctx: QueryCtx, userId: string) {
  return (await ctx.db.query("erasures").withIndex("by_user", (q) => q.eq("userId", userId)).take(1)).length > 0;
}

export async function refuseDeletedAccount(ctx: QueryCtx, userId: string) {
  if (await accountBeingDeleted(ctx, userId)) fail("unauthorized", "This Planban account has been deleted.");
}

export async function boardIdReserved(ctx: QueryCtx, boardId: string) {
  return (await ctx.db.query("erasures").withIndex("by_board", (q) => q.eq("boardId", boardId)).take(1)).length > 0;
}
