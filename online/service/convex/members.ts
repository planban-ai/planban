// People on a board. The full invite design (link or email, viewer role,
// per-person agent levels) is owned by the shared-board-access card.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { boardAccess, memberAgentLevel } from "./model/access";
import { fail } from "./model/errors";
import { accountBeingDeleted } from "./model/erasureGate";

export const list = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => {
    await boardAccess(ctx, connectionId, boardId);
    const members = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId)).collect();
    return members.map((member) => ({ userId: member.userId, role: member.role, agentLevel: memberAgentLevel(member) }));
  },
});

export const add = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), userId: v.string(), role: v.union(v.literal("editor"), v.literal("viewer")) },
  handler: async (ctx, { connectionId, boardId, userId, role }) => {
    const access = await boardAccess(ctx, connectionId, boardId);
    if (!access.canAdminister) fail("forbidden", "Inviting people is kept for the board owner's own connection.");
    // A board on its way to, or back from, Local Mode takes nobody new: they would keep reading the retained copy.
    if (access.board.authority !== "online" || access.board.localTransfer) fail("conflict", "People can only be added while the board is online.");
    // Only someone who has used Planban (a profile or a sign-in) can be added: never an id of a deleted account.
    const known = (await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", userId)).take(1)).length
      || (await ctx.db.query("connections").withIndex("by_user", (q) => q.eq("userId", userId)).take(1)).length;
    if (!known || await accountBeingDeleted(ctx, userId)) fail("not_found", "That Planban account doesn't exist.");
    if (!userId.trim()) fail("validation", "userId is required.");
    const existing = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId).eq("userId", userId)).unique();
    if (existing?.role === "owner") fail("validation", "The owner's role cannot be changed here.");
    if (existing) await ctx.db.patch(existing._id, { role });
    else await ctx.db.insert("members", { boardId, userId, role });
    const members = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId)).collect();
    return members.map((member) => ({ userId: member.userId, role: member.role }));
  },
});

/** The owner changes someone's role, or removes them; their agents follow at once. */
export const update = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), userId: v.string(), role: v.optional(v.union(v.literal("editor"), v.literal("viewer"))), remove: v.optional(v.boolean()) },
  handler: async (ctx, { connectionId, boardId, userId, role, remove }) => {
    if (!remove && !role) fail("validation", "Choose a viewer/editor role or remove the person.");
    const access = await boardAccess(ctx, connectionId, boardId);
    if (!access.canAdminister) fail("forbidden", "Changing who is on the board is kept for the board owner's own sign-in.");
    const member = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId).eq("userId", userId)).unique();
    if (!member) fail("not_found", "That person is not on this board.");
    if (member!.role === "owner") fail("validation", "The owner stays on the board as owner.");
    if (remove) await ctx.db.delete(member!._id);
    else if (role) await ctx.db.patch(member!._id, { role, ...(role === "viewer" ? { agentLevel: "read" as const } : {}) });
    const members = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId)).collect();
    return members.map((entry) => ({ userId: entry.userId, role: entry.role, agentLevel: memberAgentLevel(entry) }));
  },
});
