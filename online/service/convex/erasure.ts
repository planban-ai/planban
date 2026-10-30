// Deleting things for good (owner decisions, 15 October 2026).
//
// (a) A board taken back to a computer stays online as a read-only copy until
//     its owner deletes it: deleteBoardCopy, from Board settings on the web.
// (b) Deleting an account removes everything within 30 days: requestAccount,
//     run by the operator (see the release runbook) when someone emails
//     hello@planban.ai.
//
// Each deletion is a row in `erasures`, worked through by its own job in
// small steps that save their place, so no step reads much and one stuck
// deletion never holds up another. A daily sweep restarts any job that
// stopped. model/erasureGate.ts keeps an account being deleted from signing
// in or being added again, and keeps a deleted board's id from being reused
// until all its rows are gone, so every row under that id is the deleted
// board's, whatever its generation.
import { addStored } from "./model/limits";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { boardAccess } from "./model/access";
import { fail } from "./model/errors";

/** Rows per step: small, so a step stays far inside Convex's per-transaction limits. */
const STEP = 100;
/** Documents, history versions and board states can be large: fewer of them per step, and a byte budget for whole-table pages. */
const LARGE_STEP = 25;
const STEP_BYTES = 2_000_000;
/** What other people's boards show for changes made by an account that has been deleted. */
export const DELETED_ACCOUNT = "deleted-account";
/** A finished account deletion is kept this long, so a sign-in already under way is still refused. */
const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;

const BOARD_ROWS = [
  ["historyDocs", "by_board_version"], ["historyPayloads", "by_board_version"], ["history", "by_board_version"],
  ["docs", "by_board_card_kind"], ["retiredIds", "by_board_card"], ["boardFingerprints", "by_board_generation"],
  ["cardChanges", "by_board_generation_card"], ["boardSizes", "by_board_generation"], ["boardState", "by_board_generation"],
  ["presence", "by_board_card"], ["unresolvedChanges", "by_board_card"],
] as const;
const LARGE_TABLES = new Set(["historyDocs", "historyPayloads", "docs", "boardState"]);

type Step = (ctx: MutationCtx, erasure: Doc<"erasures">) => Promise<"more" | "next" | "wait">;

/**
 * A board disappears at once: its row goes and its id is reserved until the
 * rest (people, invitations, keys limited to it, stored rows) is removed.
 */
async function removeBoard(ctx: MutationCtx, board: Doc<"boards">, now: string) {
  await ctx.db.delete(board._id);
  const id = await ctx.db.insert("erasures", { kind: "board", boardId: board.boardId, stage: "members", cursor: null, requestedAt: now });
  await ctx.scheduler.runAfter(0, internal.erasure.work, { erasureId: id });
}

/** Deletes the read-only online copy of a board its owner took back to a computer. */
export const deleteBoardCopy = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), confirmTitle: v.string() },
  handler: async (ctx, { connectionId, boardId, confirmTitle }) => {
    const access = await boardAccess(ctx, connectionId, boardId);
    if (!access.canAdminister) fail("forbidden", "Only the board's owner can delete its online copy, from their own sign-in.");
    if (access.board.authority !== "returned-local") fail("conflict", "Only a board taken back to a computer has a read-only online copy to delete. Take it local first.");
    if (access.board.localTransfer) fail("conflict", "This board is still being taken back to a computer. Delete its online copy once that has finished.");
    if (confirmTitle.trim() !== access.board.title.trim()) fail("validation", "Type the board's name exactly to confirm.");
    await removeBoard(ctx, access.board, new Date().toISOString());
    return { deleted: true };
  },
});

/**
 * An account's deletion begins (operator only): from now on it can't sign in
 * or connect anything, its sign-ins, keys and app connections stop, and
 * invitations to its addresses go. The rest follows in `work`.
 */
export const beginAccount = internalMutation({
  args: { userId: v.string(), emails: v.array(v.string()) },
  handler: async (ctx, { userId, emails }) => {
    if (!/^user_[A-Za-z0-9]+$/.test(userId)) fail("validation", "A Clerk user id is required.");
    const now = new Date().toISOString();
    let erasure = await ctx.db.query("erasures").withIndex("by_user", (q) => q.eq("userId", userId)).first();
    if (!erasure) {
      const id = await ctx.db.insert("erasures", { kind: "account", userId, ownedBoards: [], clerkDeleted: false, stage: "revoke", cursor: null, requestedAt: now });
      erasure = (await ctx.db.get(id))!;
    }
    let invitesRemoved = 0;
    for (const email of new Set(emails.map((address) => address.trim().toLowerCase()).filter(Boolean))) {
      for (const invite of await ctx.db.query("invites").withIndex("by_email", (q) => q.eq("email", email)).take(STEP)) {
        await ctx.db.delete(invite._id);
        invitesRemoved += 1;
      }
    }
    // Sign-ins stop now; anything beyond one step's worth is revoked by the first step of `work`.
    for (const connection of await ctx.db.query("connections").withIndex("by_user_revoked", (q) => q.eq("userId", userId).eq("revokedAt", undefined)).take(STEP)) {
      await ctx.db.patch(connection._id, { revokedAt: now });
    }
    await ctx.scheduler.runAfter(0, internal.erasure.work, { erasureId: erasure._id });
    return { invitesRemoved };
  },
});

/** The sign-in account (Clerk) is gone; the deletion is reported finished once the rest is. */
export const noteClerkDeleted = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const erasure = await ctx.db.query("erasures").withIndex("by_user", (q) => q.eq("userId", userId)).first();
    if (erasure) await ctx.db.patch(erasure._id, { clerkDeleted: true });
  },
});

/** Deletes the person's Clerk user. Already gone counts as done; anything else is reported, never assumed. */
async function deleteClerkUser(userId: string): Promise<string | null> {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) return "This deployment has no sign-in service key, so the sign-in account can't be deleted.";
  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response) return "The sign-in service didn't answer.";
  if (!response.ok && response.status !== 404) return `The sign-in service answered ${response.status}.`;
  return null;
}

/** The daily sweep's retry when Clerk couldn't be reached. */
export const retrySignInAccount = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    if (await deleteClerkUser(userId)) return;
    await ctx.runMutation(internal.erasure.noteClerkDeleted, { userId });
  },
});

/**
 * The operator's command (release runbook). Finds the account for an email
 * address in Clerk, or in Planban if Clerk no longer has it; refuses if the
 * address matches more than one. Blocks the account, deletes its sign-in
 * account so it can never sign in again, and starts removing the rest.
 */
export const requestAccount = internalAction({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<{ userId: string; invitesRemoved: number; signInAccountDeleted: boolean; note: string | null }> => {
    const address = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(address)) fail("validation", "Give the account's email address.");
    const secret = process.env.CLERK_SECRET_KEY;
    if (!secret) fail("conflict", "This deployment has no sign-in service key, so accounts can't be looked up or deleted here.");
    const found = new Map<string, Set<string>>();
    const response = await fetch(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(address)}`, {
      headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) fail("conflict", `The sign-in service answered ${response.status}; try again.`);
    for (const user of await response.json() as Array<{ id: string; email_addresses?: Array<{ email_address: string }> }>) {
      found.set(user.id, new Set([address, ...(user.email_addresses ?? []).map((entry) => entry.email_address.toLowerCase())]));
    }
    for (const userId of await ctx.runQuery(internal.erasure.peopleByEmail, { email: address })) {
      if (!found.has(userId)) found.set(userId, new Set([address]));
    }
    if (found.size === 0) fail("not_found", `No account uses ${address}.`);
    if (found.size > 1) fail("conflict", `${address} matches ${found.size} accounts: ${[...found.keys()].join(", ")}. Ask which one to delete.`);
    const [[userId, emails]] = [...found.entries()];
    const begun = await ctx.runMutation(internal.erasure.beginAccount, { userId: userId!, emails: [...emails!] });
    const problem = await deleteClerkUser(userId!);
    if (!problem) await ctx.runMutation(internal.erasure.noteClerkDeleted, { userId: userId! });
    return { userId: userId!, invitesRemoved: begun.invitesRemoved, signInAccountDeleted: !problem, note: problem };
  },
});

export const peopleByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => (await ctx.db.query("people").withIndex("by_email", (q) => q.eq("email", email)).take(10)).map((row) => row.userId),
});

/** One step of one deletion; schedules its next step while any remain. */
export const work = internalMutation({
  args: { erasureId: v.id("erasures") },
  handler: async (ctx, { erasureId }) => {
    const erasure = await ctx.db.get(erasureId);
    if (!erasure || erasure.stage === "done") return;
    const steps = erasure.kind === "board" ? BOARD_STEPS : ACCOUNT_STEPS;
    const index = steps.findIndex(([name]) => name === erasure.stage);
    if (index < 0) fail("conflict", `Unknown deletion step ${erasure.stage}.`);
    const outcome = await steps[index]![1](ctx, erasure);
    // Waiting for something else (a board's own deletion); that job finishing, or the daily sweep, comes back.
    if (outcome === "wait") return;
    if (outcome === "next") {
      const following = steps[index + 1];
      if (!following) {
        if (erasure.kind === "board") {
          await ctx.db.delete(erasure._id);
          await resumeOwners(ctx, erasure.boardId!);
        } else {
          await ctx.db.patch(erasure._id, { stage: "done", cursor: null, doneAt: new Date().toISOString() });
        }
        return;
      }
      await ctx.db.patch(erasure._id, { stage: following[0], cursor: null });
    }
    await ctx.scheduler.runAfter(0, internal.erasure.work, { erasureId });
  },
});

/** An account deletion waiting on this board's deletion carries on. */
async function resumeOwners(ctx: MutationCtx, boardId: string) {
  for (const erasure of await ctx.db.query("erasures").withIndex("by_kind", (q) => q.eq("kind", "account")).take(STEP)) {
    if (erasure.stage === "boards" && (erasure.ownedBoards ?? []).includes(boardId)) await ctx.scheduler.runAfter(0, internal.erasure.work, { erasureId: erasure._id });
  }
}

/**
 * The daily sweep: restarts every deletion's job, asks Clerk again where it
 * failed, and forgets account deletions finished more than a day ago.
 */
export const sweep = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("erasures").paginate({ numItems: STEP, cursor: cursor ?? null });
    for (const erasure of page.page) {
      if (erasure.kind === "account" && !erasure.clerkDeleted) await ctx.scheduler.runAfter(0, internal.erasure.retrySignInAccount, { userId: erasure.userId! });
      if (erasure.stage !== "done") await ctx.scheduler.runAfter(0, internal.erasure.work, { erasureId: erasure._id });
      else if (erasure.clerkDeleted && Date.now() - Date.parse(erasure.doneAt!) > KEEP_FINISHED_MS) await ctx.db.delete(erasure._id);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.erasure.sweep, { cursor: page.continueCursor });
  },
});

// --- a board -------------------------------------------------------------------

const BOARD_STEPS: Array<[string, Step]> = [
  // Its people leave, and keys limited to this board stop reaching it.
  ["members", async (ctx, erasure) => {
    const members = await ctx.db.query("members").withIndex("by_board", (q) => q.eq("boardId", erasure.boardId!)).take(10);
    const now = new Date().toISOString();
    for (const member of members) {
      for (const connection of await ctx.db.query("connections").withIndex("by_user", (q) => q.eq("userId", member.userId)).take(STEP)) {
        if (connection.boards === "all" || !connection.boards.includes(erasure.boardId!)) continue;
        const boards = connection.boards.filter((boardId) => boardId !== erasure.boardId);
        await ctx.db.patch(connection._id, boards.length ? { boards } : { boards, revokedAt: connection.revokedAt ?? now });
      }
      await ctx.db.delete(member._id);
    }
    return members.length ? "more" : "next";
  }],
  ["invites", async (ctx, erasure) => {
    const invites = await ctx.db.query("invites").withIndex("by_board", (q) => q.eq("boardId", erasure.boardId!)).take(STEP);
    for (const invite of invites) await ctx.db.delete(invite._id);
    return invites.length ? "more" : "next";
  }],
  // Every stored row under the id, in every generation (the id is reserved, so all are the deleted board's).
  ["rows", async (ctx, erasure) => {
    for (const [table, index] of BOARD_ROWS) {
      const query = () => (ctx.db.query(table) as any).withIndex(index, (q: any) => q.eq("boardId", erasure.boardId!));
      if (!(await query().take(1)).length) continue;
      // One table per step, at most STEP rows and STEP_BYTES read.
      const page = await query().paginate({ numItems: LARGE_TABLES.has(table) ? LARGE_STEP : STEP, cursor: null, maximumBytesRead: STEP_BYTES });
      for (const row of page.page) await ctx.db.delete(row._id);
      return "more";
    }
    return "next";
  }],
  ["transfers", async (ctx, erasure) => {
    const transfer = (await ctx.db.query("transfers").withIndex("by_board_state", (q) => q.eq("boardId", erasure.boardId!)).take(1))[0];
    if (!transfer) return "next";
    const parts = await ctx.db.query("transferParts").withIndex("by_transfer_seq", (q) => q.eq("transferId", transfer.transferId)).take(STEP);
    for (const part of parts) await ctx.db.delete(part._id);
    if (parts.length < STEP) await ctx.db.delete(transfer._id);
    return "more";
  }],
];

// --- an account ----------------------------------------------------------------

/** A step over a whole table (for fields no index reaches), page by page, saving its place. */
function scan(table: "history" | "invites", fix: (ctx: MutationCtx, row: any, userId: string) => Promise<void>): Step {
  return async (ctx, erasure) => {
    const page = await ctx.db.query(table).paginate({ numItems: STEP, cursor: erasure.cursor ?? null, maximumBytesRead: STEP_BYTES } as any);
    for (const row of page.page) await fix(ctx, row, erasure.userId!);
    if (page.isDone) return "next";
    await ctx.db.patch(erasure._id, { cursor: page.continueCursor });
    return "more";
  };
}

/** A step deleting this person's rows in one table, found by an index on their id. */
function byUser(take: (ctx: MutationCtx, userId: string) => Promise<Array<{ _id: any }>>): Step {
  return async (ctx, erasure) => {
    const rows = await take(ctx, erasure.userId!);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length ? "more" : "next";
  };
}

const ACCOUNT_STEPS: Array<[string, Step]> = [
  // Any sign-in beginAccount didn't reach (more than one step's worth).
  ["revoke", async (ctx, erasure) => {
    const open = await ctx.db.query("connections").withIndex("by_user_revoked", (q) => q.eq("userId", erasure.userId!).eq("revokedAt", undefined)).take(STEP);
    const now = new Date().toISOString();
    for (const connection of open) await ctx.db.patch(connection._id, { revokedAt: now });
    return open.length ? "more" : "next";
  }],
  // Boards they own are deleted for everyone; they leave everyone else's.
  ["memberships", async (ctx, erasure) => {
    const now = new Date().toISOString();
    const owned: string[] = [];
    const members = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", erasure.userId!)).take(10);
    for (const member of members) {
      const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", member.boardId)).unique();
      if (board && board.ownerId === erasure.userId) {
        owned.push(board.boardId);
        await removeBoard(ctx, board, now);
      }
      await ctx.db.delete(member._id);
    }
    // Boards of theirs without a member row (an upload that never finished).
    for (const board of await ctx.db.query("boards").withIndex("by_owner", (q) => q.eq("ownerId", erasure.userId!)).take(10)) {
      owned.push(board.boardId);
      await removeBoard(ctx, board, now);
    }
    if (owned.length) await ctx.db.patch(erasure._id, { ownedBoards: [...new Set([...(erasure.ownedBoards ?? []), ...owned])] });
    return members.length || owned.length ? "more" : "next";
  }],
  // Their changes on other people's boards stay, credited to a deleted account,
  // on every board (including ones they had already left).
  ["history", scan("history", async (ctx, row, userId) => {
    if (row.entry?.attribution?.userId === userId) await ctx.db.patch(row._id, { entry: { ...row.entry, attribution: { ...row.entry.attribution, userId: DELETED_ACCOUNT } } });
  })],
  ["cardChanges", async (ctx, erasure) => {
    const rows = await ctx.db.query("cardChanges").withIndex("by_user", (q) => q.eq("userId", erasure.userId!)).take(STEP);
    for (const row of rows) await ctx.db.patch(row._id, { userId: DELETED_ACCOUNT });
    return rows.length ? "more" : "next";
  }],
  // Who is working on a card, and their refused edits waiting on other people's boards: theirs, so gone.
  ["presence", async (ctx, erasure) => {
    const rows = await ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", erasure.userId!)).take(STEP);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length ? "more" : "next";
  }],
  ["unresolvedChanges", async (ctx, erasure) => {
    const rows = await ctx.db.query("unresolvedChanges").withIndex("by_user", (q) => q.eq("userId", erasure.userId!)).take(STEP);
    for (const row of rows) {
      await ctx.db.delete(row._id);
      await addStored(ctx, { boardId: row.boardId, generation: row.generation }, -(row.bytes ?? 0));
    }
    return rows.length ? "more" : "next";
  }],
  ["docs", async (ctx, erasure) => {
    // Documents can be large: at most STEP_BYTES read. Each one patched leaves the index range.
    const page = await ctx.db.query("docs").withIndex("by_updatedBy", (q) => q.eq("updatedBy", erasure.userId!))
      .paginate({ numItems: LARGE_STEP, cursor: null, maximumBytesRead: STEP_BYTES } as any);
    for (const row of page.page) await ctx.db.patch(row._id, { updatedBy: DELETED_ACCOUNT });
    return page.page.length ? "more" : "next";
  }],
  ["invites", scan("invites", async (ctx, row: Doc<"invites">, userId) => {
    if (row.createdBy === userId) await ctx.db.delete(row._id);
    else if (row.joinedBy.includes(userId)) await ctx.db.patch(row._id, { joinedBy: row.joinedBy.filter((id) => id !== userId) });
  })],
  // Their own records.
  ["connections", async (ctx, erasure) => {
    const connections = await ctx.db.query("connections").withIndex("by_user", (q) => q.eq("userId", erasure.userId!)).take(20);
    for (const connection of connections) {
      // A connection goes only once everything found through it is gone (spent refresh tokens can be many).
      const refreshes = await ctx.db.query("oauthRefresh").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).take(STEP);
      for (const refresh of refreshes) await ctx.db.delete(refresh._id);
      const barriers = connection.clerkSessionId
        ? await ctx.db.query("webSessionBarriers").withIndex("by_clerkSession", (q) => q.eq("clerkSessionId", connection.clerkSessionId!)).take(STEP)
        : [];
      for (const barrier of barriers) await ctx.db.delete(barrier._id);
      if (refreshes.length === STEP || barriers.length === STEP) return "more";
      await ctx.db.delete(connection._id);
    }
    return connections.length ? "more" : "next";
  }],
  ["oauthRequests", byUser((ctx, userId) => ctx.db.query("oauthRequests").withIndex("by_user", (q) => q.eq("userId", userId)).take(STEP))],
  ["oauthRegistrations", byUser((ctx, userId) => ctx.db.query("oauthRegistrations").withIndex("by_user", (q) => q.eq("userId", userId)).take(STEP))],
  ["signInApprovals", byUser((ctx, userId) => ctx.db.query("signInApprovals").withIndex("by_user_hour", (q) => q.eq("userId", userId)).take(STEP))],
  ["usage", byUser((ctx, userId) => ctx.db.query("usage").withIndex("by_user_day", (q) => q.eq("userId", userId)).take(STEP))],
  ["operations", byUser(async (ctx, userId) => (await ctx.db.query("operations").withIndex("by_user_key", (q) => q.eq("userId", userId))
    .paginate({ numItems: LARGE_STEP, cursor: null, maximumBytesRead: STEP_BYTES } as any)).page)],
  ["transfers", async (ctx, erasure) => {
    const transfers = await ctx.db.query("transfers").withIndex("by_user", (q) => q.eq("userId", erasure.userId!)).take(10);
    for (const transfer of transfers) {
      const parts = await ctx.db.query("transferParts").withIndex("by_transfer_seq", (q) => q.eq("transferId", transfer.transferId)).take(STEP);
      for (const part of parts) await ctx.db.delete(part._id);
      if (parts.length < STEP) await ctx.db.delete(transfer._id);
    }
    return transfers.length ? "more" : "next";
  }],
  ["people", byUser((ctx, userId) => ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", userId)).take(STEP))],
  // Last: the boards they owned must have finished their own deletion.
  ["boards", async (ctx, erasure) => {
    for (const boardId of erasure.ownedBoards ?? []) {
      if (await ctx.db.query("erasures").withIndex("by_board", (q) => q.eq("boardId", boardId)).first()) return "wait";
    }
    return "next";
  }],
];

/** What is left of an account. Finished once every step is done and its sign-in account is deleted. */
export const accountStatus = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const erasure = await ctx.db.query("erasures").withIndex("by_user", (q) => q.eq("userId", userId)).first();
    const count = async (query: { take(n: number): Promise<unknown[]> }) => (await query.take(STEP)).length;
    const boardsBeingRemoved = await Promise.all((erasure?.ownedBoards ?? []).map((boardId) => ctx.db.query("erasures").withIndex("by_board", (q) => q.eq("boardId", boardId)).first()));
    const left = {
      memberships: await count(ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId))),
      boardsOwned: await count(ctx.db.query("boards").withIndex("by_owner", (q) => q.eq("ownerId", userId))),
      ownedBoardsStillBeingRemoved: boardsBeingRemoved.filter(Boolean).length,
      connections: await count(ctx.db.query("connections").withIndex("by_user", (q) => q.eq("userId", userId))),
      appRegistrations: await count(ctx.db.query("oauthRegistrations").withIndex("by_user", (q) => q.eq("userId", userId))),
      signInRequests: await count(ctx.db.query("oauthRequests").withIndex("by_user", (q) => q.eq("userId", userId))),
      cardFaces: await count(ctx.db.query("cardChanges").withIndex("by_user", (q) => q.eq("userId", userId))),
      workingOn: await count(ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", userId))),
      unresolvedChanges: await count(ctx.db.query("unresolvedChanges").withIndex("by_user", (q) => q.eq("userId", userId))),
      documents: await count(ctx.db.query("docs").withIndex("by_updatedBy", (q) => q.eq("updatedBy", userId))),
      transfers: await count(ctx.db.query("transfers").withIndex("by_user", (q) => q.eq("userId", userId))),
      profile: await count(ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", userId))),
      usage: await count(ctx.db.query("usage").withIndex("by_user_day", (q) => q.eq("userId", userId))),
      retries: await count(ctx.db.query("operations").withIndex("by_user_key", (q) => q.eq("userId", userId))),
    };
    // A finished deletion's record is cleared after a day; then nothing left at all means finished.
    const finished = Object.values(left).every((n) => n === 0) && (!erasure || (erasure.stage === "done" && !!erasure.clerkDeleted));
    return { started: !!erasure, finished, stage: erasure?.stage ?? null, signInAccountDeleted: !!erasure?.clerkDeleted, requestedAt: erasure?.requestedAt ?? null, left };
  },
});
