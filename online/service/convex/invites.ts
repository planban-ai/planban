// Inviting people to a board (owner decisions 8 and 15): by link, which
// anyone may use for 7 days, or by email for one person. Each person still
// signs in with their own account; joining adds them with the invite's role.
// Only the owner's own sign-in can invite, see or cancel invites.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { boardAccess, liveConnection } from "./model/access";
import { fail } from "./model/errors";
import { chargeAdmin } from "./model/limits";

/** Bounds on sharing (security review): pending invitations per board, joins per link, emails to one address. */
export const MAX_PENDING_INVITES = 50;
export const MAX_LINK_JOINS = 100;
export const MAX_MEMBERS = 200;
export const MAX_EMAILS_PER_ADDRESS_PER_DAY = 3;
/** Invitations read per address for the waiting list; long-expired ones are removed daily, so this is never reached in practice. */
const MAX_SCANNED_PER_ADDRESS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Invite links last 7 days (owner decision 15). */
export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const inviteRole = v.union(v.literal("editor"), v.literal("viewer"));

function describe(invite: Doc<"invites">) {
  return {
    id: invite._id, role: invite.role, email: invite.email ?? null, createdAt: invite.createdAt, expiresAt: invite.expiresAt,
    joined: invite.joinedBy.length, revoked: !!invite.revokedAt,
  };
}

const usable = (invite: Doc<"invites">) => !invite.revokedAt && Date.parse(invite.expiresAt) > Date.now();

async function ownerAccess(ctx: Parameters<typeof boardAccess>[0], connectionId: Parameters<typeof boardAccess>[1], boardId: string) {
  const access = await boardAccess(ctx, connectionId, boardId);
  if (!access.canAdminister) fail("forbidden", "Inviting people is kept for the board owner's own sign-in.");
  return access;
}

export const create = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), tokenHash: v.string(), role: inviteRole, email: v.optional(v.string()) },
  handler: async (ctx, { connectionId, boardId, tokenHash, role, email }) => {
    const access = await ownerAccess(ctx, connectionId, boardId);
    if (access.board.authority !== "online" || access.board.localTransfer) fail("conflict", "People can only be invited while the board is online.");
    const address = email?.trim().toLowerCase();
    if (address !== undefined && (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) fail("validation", "That does not look like an email address.");
    const now = Date.now();
    const recent = await ctx.db.query("invites").withIndex("by_board", (q) => q.eq("boardId", boardId)).order("desc").take(500);
    if (recent.filter(usable).length >= MAX_PENDING_INVITES) fail("rate_limited", `This board has ${MAX_PENDING_INVITES} invitations waiting. Cancel some before inviting more.`);
    if (address) {
      if (recent.some((invite) => usable(invite) && invite.email === address)) fail("conflict", `${address} already has an invitation waiting for this board. Cancel it to send another.`);
      const toAddress = await ctx.db.query("invites").withIndex("by_email", (q) => q.eq("email", address)).order("desc").take(MAX_EMAILS_PER_ADDRESS_PER_DAY);
      if (toAddress.filter((invite) => now - Date.parse(invite.createdAt) < DAY_MS).length >= MAX_EMAILS_PER_ADDRESS_PER_DAY) {
        fail("rate_limited", `${address} has had as many Planban invitations as it can receive today. Share an invite link instead, or try tomorrow.`);
      }
    }
    await chargeAdmin(ctx, access.connection.userId, "invites");
    if (address) await chargeAdmin(ctx, access.connection.userId, "inviteEmails");
    const id = await ctx.db.insert("invites", {
      boardId, tokenHash, role, ...(address ? { email: address } : {}), createdBy: access.connection.userId,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + INVITE_LIFETIME_MS).toISOString(), joinedBy: [],
    });
    return { ...describe((await ctx.db.get(id))!), boardTitle: access.board.title };
  },
});

export const list = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => {
    await ownerAccess(ctx, connectionId, boardId);
    const invites = await ctx.db.query("invites").withIndex("by_board", (q) => q.eq("boardId", boardId)).order("desc").take(500);
    return { invites: invites.filter(usable).map(describe) };
  },
});

export const revoke = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), inviteId: v.string() },
  handler: async (ctx, { connectionId, boardId, inviteId }) => {
    await ownerAccess(ctx, connectionId, boardId);
    const id = ctx.db.normalizeId("invites", inviteId);
    const invite = id ? await ctx.db.get(id) : null;
    if (!invite || invite.boardId !== boardId) fail("not_found", "Invite not found.");
    await ctx.db.patch(invite!._id, { revokedAt: new Date().toISOString() });
    return { revoked: true };
  },
});

/** What an invite link shows before joining: the board's name and the role. Reveals nothing for a bad or old link. */
export const preview = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const invite = await ctx.db.query("invites").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!invite || !usable(invite)) return null;
    const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", invite.boardId)).unique();
    if (!board || board.authority !== "online") return null;
    return { boardTitle: board.title, role: invite.role, expiresAt: invite.expiresAt, forEmail: !!invite.email, inviterName: await inviterName(ctx, invite) };
  },
});

/** The inviter's display name, as the board's people see it. */
async function inviterName(ctx: QueryCtx, invite: Doc<"invites">) {
  return (await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", invite.createdBy)).unique())?.name ?? "Someone";
}

/**
 * The web page's invitation preview: the board, role and inviter for a valid
 * invitation, and only the state for anything else, so an old or cancelled
 * link reveals nothing about the board.
 */
export const previewState = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const invite = await ctx.db.query("invites").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!invite) return { state: "unknown" as const };
    if (invite.revokedAt) return { state: invite.email && invite.joinedBy.length > 0 ? "used" as const : "cancelled" as const };
    if (Date.parse(invite.expiresAt) <= Date.now()) return { state: "expired" as const };
    const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", invite.boardId)).unique();
    if (!board || board.authority !== "online") return { state: "unavailable" as const };
    return { state: "valid" as const, boardTitle: board.title, role: invite.role, expiresAt: invite.expiresAt, forEmail: !!invite.email, inviterName: await inviterName(ctx, invite) };
  },
});

/**
 * Email invitations waiting for the signed-in person: only for addresses Clerk
 * verified for them just now, still usable, on online boards they aren't on.
 */
export const waitingFor = internalQuery({
  args: { connectionId: v.id("connections"), verifiedEmails: v.array(v.string()) },
  handler: async (ctx, { connectionId, verifiedEmails }) => {
    const connection = await liveConnection(ctx, connectionId);
    if (!connection.canAdminister) return { invitations: [] };
    const invitations = [];
    for (const email of new Set(verifiedEmails.map((address) => address.toLowerCase()).slice(0, 10))) {
      // Newest first, reading past old, used and cancelled invitations until enough usable ones are found.
      let scanned = 0;
      for await (const invite of ctx.db.query("invites").withIndex("by_email", (q) => q.eq("email", email)).order("desc")) {
        if (++scanned > MAX_SCANNED_PER_ADDRESS || invitations.length >= MAX_PENDING_INVITES) break;
        if (!usable(invite)) continue;
        const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", invite.boardId)).unique();
        if (!board || board.authority !== "online") continue;
        const member = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", board.boardId).eq("userId", connection.userId)).unique();
        if (member) continue;
        invitations.push({ id: invite._id, boardTitle: board.title, role: invite.role, inviterName: await inviterName(ctx, invite), expiresAt: invite.expiresAt });
      }
    }
    return { invitations };
  },
});

/**
 * Whether the signed-in person is already on the board an invitation is for.
 * Reads only, so the web page can say "You're already on this board" without
 * ever joining anyone; it reveals nothing to someone who isn't on the board.
 */
export const membership = internalQuery({
  args: { connectionId: v.id("connections"), tokenHash: v.string() },
  handler: async (ctx, { connectionId, tokenHash }) => {
    const connection = await liveConnection(ctx, connectionId);
    const invite = await ctx.db.query("invites").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!invite) return { member: false as const };
    const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", invite.boardId)).unique();
    if (!board || board.authority !== "online") return { member: false as const };
    const member = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", board.boardId).eq("userId", connection.userId)).unique();
    return member ? { member: true as const, boardId: board.boardId, title: board.title } : { member: false as const };
  },
});

/**
 * Joining from an invite, with the person's own sign-in. A link works for
 * anyone until it expires; an email invite only for the account with that
 * email. Someone already on the board keeps their role.
 */
/** The email an invite is for, if any, so its acceptance can be checked against the account first. */
export const emailOf = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => (await ctx.db.query("invites").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique())?.email ?? null,
});

export const accept = internalMutation({
  args: { connectionId: v.id("connections"), tokenHash: v.string(), verifiedEmails: v.optional(v.array(v.string())) },
  handler: async (ctx, { connectionId, tokenHash, verifiedEmails }) => {
    const invite = await ctx.db.query("invites").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    return join(ctx, connectionId, invite, verifiedEmails);
  },
});

/**
 * Joining from the dashboard's waiting invitations, by invitation id. Only an
 * email invitation can be accepted this way, and its address is checked
 * against the person's verified emails at this moment; a link invitation
 * needs its link.
 */
export const acceptById = internalMutation({
  args: { connectionId: v.id("connections"), inviteId: v.string(), verifiedEmails: v.array(v.string()) },
  handler: async (ctx, { connectionId, inviteId, verifiedEmails }) => {
    const id = ctx.db.normalizeId("invites", inviteId);
    const invite = id ? await ctx.db.get(id) : null;
    if (invite && !invite.email) fail("forbidden", "Open the invitation link to join this board.");
    return join(ctx, connectionId, invite, verifiedEmails);
  },
});

/** "sam@example.com" becomes "s•••@example.com". */
export function maskedEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at <= 0 ? "•••" : `${email[0]}•••${email.slice(at)}`;
}

async function join(ctx: MutationCtx, connectionId: Doc<"connections">["_id"], invite: Doc<"invites"> | null, verifiedEmails: string[] | undefined) {
  const connection = await liveConnection(ctx, connectionId);
  if (!connection.canAdminister) fail("forbidden", "Join a board from your own sign-in, not from an agent or key.");
  if (!invite) fail("not_found", "This invite has expired or was cancelled. Ask the board owner for a new one.");
  const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", invite!.boardId)).unique();
  // Someone already on the board is told so, whatever state the invitation is in.
  const existing = board ? await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", board.boardId).eq("userId", connection.userId)).unique() : null;
  if (existing && board!.authority === "online") return { boardId: board!.boardId, title: board!.title, role: existing.role, alreadyMember: true };
  if (!usable(invite!)) {
    const expired = Date.parse(invite!.expiresAt) <= Date.now();
    fail("not_found", "This invite has expired or was cancelled. Ask the board owner for a new one.", { reason: expired ? "expired" : "cancelled" });
  }
  if (!board || board.authority !== "online" || board.localTransfer) fail("conflict", "This board is not online at the moment. Ask the board owner.", { reason: "unavailable" });
  // An email invite needs the account's current, verified addresses, read from Clerk just now.
  if (invite!.email && !(verifiedEmails ?? []).map((email) => email.toLowerCase()).includes(invite!.email)) {
    // Whoever opened the link sees only enough of the address to recognise it.
    const sentTo = maskedEmail(invite!.email);
    fail("forbidden", `This invite is for ${sentTo}. Sign in with an account whose verified email is that address to join.`, { reason: "wrong_email", sentTo });
  }
  const members = await ctx.db.query("members").withIndex("by_board", (q) => q.eq("boardId", board!.boardId)).take(MAX_MEMBERS);
  if (members.length >= MAX_MEMBERS) fail("rate_limited", `This board already has ${MAX_MEMBERS} people. Ask the board owner.`);
  if (!invite!.joinedBy.includes(connection.userId) && invite!.joinedBy.length >= MAX_LINK_JOINS) {
    fail("rate_limited", `This invite link has been used ${MAX_LINK_JOINS} times. Ask the board owner for a new one.`);
  }
  await ctx.db.insert("members", { boardId: board!.boardId, userId: connection.userId, role: invite!.role });
  if (!invite!.joinedBy.includes(connection.userId)) {
    await ctx.db.patch(invite!._id, {
      joinedBy: [...invite!.joinedBy, connection.userId],
      // An email invite is for one person: used once.
      ...(invite!.email ? { revokedAt: new Date().toISOString() } : {}),
    });
  }
  return { boardId: board!.boardId, title: board!.title, role: invite!.role, alreadyMember: false };
}
