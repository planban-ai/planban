// How people appear on shared boards (owner decision 15): a face on every
// card showing who last changed it, with a small robot when their agent did,
// and the people list with what each person's agents may do. Names and
// pictures come from the person's sign-in account at Clerk.
import { packed } from "./model/codec";
import { workingOn } from "./model/presence";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { agentLevel } from "./schema";
import { boardAccess, memberAgentLevel, roleLevel } from "./model/access";
import { fail } from "./model/errors";
import type { CardChange } from "./model/cardChanges";
import { accountBeingDeleted } from "./model/erasureGate";

/** Fetches a person's name and picture from Clerk. Development sign-ins have none. */
export const refresh = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const secret = process.env.CLERK_SECRET_KEY;
    if (!secret || !/^user_[A-Za-z0-9]+$/.test(userId)) return;
    const response = await fetch(`https://api.clerk.com/v1/users/${userId}`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const user = await response.json() as {
      first_name?: string | null; last_name?: string | null; username?: string | null; image_url?: string | null; has_image?: boolean;
      primary_email_address_id?: string | null; email_addresses?: Array<{ id: string; email_address: string }>;
    };
    const email = user.email_addresses?.find((address) => address.id === user.primary_email_address_id)?.email_address;
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || email?.split("@")[0] || userId;
    await ctx.runMutation(internal.people.store, {
      userId, name,
      ...(user.has_image && user.image_url ? { imageUrl: user.image_url } : {}),
      ...(email ? { email } : {}),
    });
  },
});

export const store = internalMutation({
  args: { userId: v.string(), name: v.string(), imageUrl: v.optional(v.string()), email: v.optional(v.string()) },
  handler: async (ctx, profile) => {
    // A profile is never written back for an account being deleted.
    if (await accountBeingDeleted(ctx, profile.userId)) return;
    const existing = await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", profile.userId)).unique();
    const row = { ...profile, imageUrl: profile.imageUrl, email: profile.email?.toLowerCase(), updatedAt: new Date().toISOString() };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("people", row);
  },
});

/**
 * The people on a board, what each one's agents may do, and who last changed
 * each card. Everyone on the board sees all of it (owner decision 15).
 */
export const forBoard = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => {
    const access = await boardAccess(ctx, connectionId, boardId);
    const members = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId)).collect();
    const profiles = new Map<string, Doc<"people">>();
    for (const member of members) {
      const profile = await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", member.userId)).unique();
      if (profile) profiles.set(member.userId, profile);
    }
    const people = members.map((member) => {
      const profile = profiles.get(member.userId);
      return {
        userId: member.userId,
        name: profile?.name ?? member.userId,
        imageUrl: profile?.imageUrl ?? null,
        role: member.role,
        agentLevel: memberAgentLevel(member),
        you: member.userId === access.connection.userId,
      };
    });
    // Each card's latest change, kept beside the board.
    const cards: Record<string, CardChange> = {};
    for (const row of await ctx.db.query("cardChanges").withIndex("by_board_generation_card", (q) => q.eq("boardId", boardId).eq("generation", access.board.generation)).collect()) {
      cards[row.cardId] = { userId: row.userId, agent: row.agent, clientName: row.clientName, at: row.at, summary: row.summary };
    }
    // Agents working on each card now: a quiet sign for people (Spec point 20).
    const working: Record<string, Array<{ userId: string; app: string; startedAt: string }>> = {};
    for (const [cardId, entries] of Object.entries(await workingOn(ctx, { boardId, generation: access.board.generation }))) {
      working[cardId] = entries.map(({ userId, app, startedAt }) => ({ userId, app, startedAt }));
    }
    // Keyed by card: a board can have more than Convex's 1,024 fields per object, so it travels packed.
    return packed({ shared: members.length > 1, people, cards, working });
  },
});

/** A person chooses what their own agents may do on a board, up to what their role allows. */
export const setAgentLevel = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), level: agentLevel },
  handler: async (ctx, { connectionId, boardId, level }) => {
    const access = await boardAccess(ctx, connectionId, boardId);
    if (!access.connection.canAdminister) fail("forbidden", "Change what your agents may do from your own sign-in, not from an agent.");
    const allowed = roleLevel(access.role);
    if (level === "complete" && allowed !== "complete" || level !== "read" && allowed === "read") fail("forbidden", "Your agents cannot do more than you can on this board.");
    const member = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId).eq("userId", access.connection.userId)).unique();
    await ctx.db.patch(member!._id, { agentLevel: level });
    return { agentLevel: level };
  },
});
