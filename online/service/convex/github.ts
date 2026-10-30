// GitHub repositories linked to Online Boards: merged pull requests recorded
// on the board by the service itself, whichever computer is on.
//
// The board's owner links a repository from their computer (`planban online
// github link owner/name`). The service makes the link and its secret; the
// owner's computer hands the secret to GitHub once, through its own signed-in
// GitHub CLI, when it adds the repository webhook. GitHub then signs every
// delivery with it (model/githubWebhook.ts). The secret is never shown again,
// and is never on the board, in its history or in an export.
//
// A merge lands as a note on every card that names it (src/core/landings.ts),
// or in the board's inbox if none does, as one board change credited to
// GitHub. Each delivery is handled once (by GitHub's delivery id), and each
// pull request is recorded once per board, so a repeat changes nothing.
import { v } from "convex/values";
import { isRepoName, planRecordMerge } from "../../../src/core/landings";
import { isActiveStatus, prKey } from "../../../src/core/staleness";
import { commit } from "./boards";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { boardAccess } from "./model/access";
import { boardLinks, linkedRepos } from "./model/githubLinks";
import { fail } from "./model/errors";
import { currentRoadmap, docRow, live } from "./model/rows";
import { unpackText } from "./model/codec";
import type { Doc } from "./_generated/dataModel";

/** Repositories one board may link. */
export const MAX_LINKS_PER_BOARD = 5;
/** Merges one link may record in an hour; more are refused, and GitHub can redeliver them later. */
export const MERGES_PER_HOUR = 120;
/** How long a delivery id is remembered. GitHub redelivers only recent deliveries. */
export const DELIVERY_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** What anyone on the board may see of a link: never its secret or address. */
function publicLink(link: Doc<"githubLinks">, home: boolean) {
  return {
    repo: link.repo,
    home,
    linkedAt: link.createdAt,
    webhook: link.hookId === undefined ? "not confirmed: the computer that linked it didn't finish adding GitHub's webhook; unlink and link again" : "added",
    lastDelivery: link.lastDelivery ?? null,
  };
}

async function ownerAccess(ctx: QueryCtx, connectionId: Doc<"connections">["_id"], boardId: string) {
  const access = await boardAccess(ctx, connectionId, boardId);
  if (!access.canAdminister) fail("forbidden", "Only the board's owner can link or unlink GitHub repositories, from their own sign-in.");
  return access;
}

/** The board's links, with each one's last delivery. Anyone on the board may read it. */
export const links = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => {
    await boardAccess(ctx, connectionId, boardId);
    const rows = await boardLinks(ctx, boardId);
    return { links: rows.map((link, index) => publicLink(link, index === 0)) };
  },
});

/** Makes a link with the secret the HTTP layer generated. Returned once to the owner's own sign-in. */
export const createLink = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), repo: v.string(), linkId: v.string(), secret: v.string() },
  handler: async (ctx, { connectionId, boardId, repo, linkId, secret }) => {
    const access = await ownerAccess(ctx, connectionId, boardId);
    if (access.board.authority !== "online") fail("conflict", "This board was taken back to Local Mode; link repositories to an Online Board.");
    if (!isRepoName(repo)) fail("validation", "Name the repository as owner/name, for example planban-ai/planban.");
    const existing = await boardLinks(ctx, boardId);
    if (existing.some((link) => link.repoKey === repo.toLowerCase())) fail("conflict", `${repo} is already linked to this board. Unlink it first to link it again.`);
    if (existing.length >= MAX_LINKS_PER_BOARD) fail("validation", `A board can link at most ${MAX_LINKS_PER_BOARD} repositories.`);
    await ctx.db.insert("githubLinks", {
      linkId, boardId, repo, repoKey: repo.toLowerCase(), secret, createdBy: access.connection.userId, createdAt: new Date().toISOString(),
    });
    return { repo, home: existing.length === 0 };
  },
});

/** Records the webhook id GitHub gave, so unlinking can remove it. */
export const setHook = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), linkId: v.string(), hookId: v.number() },
  handler: async (ctx, { connectionId, boardId, linkId, hookId }) => {
    await ownerAccess(ctx, connectionId, boardId);
    const link = await ctx.db.query("githubLinks").withIndex("by_linkId", (q) => q.eq("linkId", linkId)).unique();
    if (!link || link.boardId !== boardId) fail("not_found", "That link is gone.");
    if (!Number.isSafeInteger(hookId) || hookId < 1) fail("validation", "hookId must be GitHub's webhook id.");
    await ctx.db.patch(link!._id, { hookId });
    return { repo: link!.repo };
  },
});

/** Removes a link and its secret. Returns the webhook id so the owner's computer can remove it on GitHub too. */
export const removeLink = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), repo: v.string() },
  handler: async (ctx, { connectionId, boardId, repo }) => {
    await ownerAccess(ctx, connectionId, boardId);
    const link = (await boardLinks(ctx, boardId)).find((row) => row.repoKey === repo.toLowerCase());
    if (!link) fail("not_found", `${repo} isn't linked to this board.`);
    await ctx.db.delete(link!._id);
    return { repo: link!.repo, ...(link!.hookId === undefined ? {} : { hookId: link!.hookId }) };
  },
});

/** The link a delivery claims, for checking its signature. Internal: never reachable from a request. */
export const hookSecret = internalQuery({
  args: { linkId: v.string() },
  handler: async (ctx, { linkId }) => {
    const link = await ctx.db.query("githubLinks").withIndex("by_linkId", (q) => q.eq("linkId", linkId)).unique();
    return link ? { secret: link.secret, repo: link.repo } : null;
  },
});

async function noteOn(ctx: MutationCtx, link: Doc<"githubLinks">, event: string, outcome: string, extra: Partial<Doc<"githubLinks">> = {}) {
  await ctx.db.patch(link._id, { lastDelivery: { at: new Date().toISOString(), event, outcome: outcome.slice(0, 300) }, ...extra });
}

/** Records what happened to a delivery that couldn't be recorded (see githubWebhookResponse). */
export const noteDelivery = internalMutation({
  args: { linkId: v.string(), event: v.string(), outcome: v.string() },
  handler: async (ctx, { linkId, event, outcome }) => {
    const link = await ctx.db.query("githubLinks").withIndex("by_linkId", (q) => q.eq("linkId", linkId)).unique();
    if (link) await noteOn(ctx, link, event, outcome);
  },
});

/** Specs of the active cards (In Progress and Up Next), which a merge may name; other cards' Specs aren't read, to bound the work. */
async function openSpecs(ctx: QueryCtx, board: Doc<"boards">, items: Array<{ id: string; status: string; specDoc: string | null }>) {
  const specs = new Map<string, string>();
  for (const item of items) {
    if (!item.specDoc || !isActiveStatus(item.status)) continue;
    const row = await docRow(ctx, live(board), item.id, "spec");
    if (row) specs.set(item.id, unpackText(row.markdown));
  }
  return specs;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * One verified delivery: GitHub's ping, or a merged pull request. Handled once per delivery id,
 * and each pull request is recorded once per board.
 */
export const receive = internalMutation({
  args: {
    linkId: v.string(),
    deliveryId: v.string(),
    merge: v.optional(v.object({ repo: v.string(), number: v.number(), title: v.string(), mergedAt: v.string(), url: v.string() })),
  },
  handler: async (ctx, { linkId, deliveryId, merge }): Promise<{ status: number; body: Record<string, unknown> }> => {
    const link = await ctx.db.query("githubLinks").withIndex("by_linkId", (q) => q.eq("linkId", linkId)).unique();
    // Unlinked between the signature check and now.
    if (!link) return { status: 401, body: { error: "unauthorized" } };
    const event = merge ? "pull_request" : "ping";
    const seen = await ctx.db.query("githubDeliveries").withIndex("by_delivery", (q) => q.eq("deliveryId", deliveryId)).unique();
    if (seen) return { status: 200, body: { duplicate: true } };
    const now = new Date().toISOString();
    if (!merge) {
      await ctx.db.insert("githubDeliveries", { deliveryId, linkId, at: now });
      await noteOn(ctx, link, event, "GitHub reached Planban.");
      return { status: 200, body: { ok: true } };
    }
    const hour = Math.floor(Date.now() / HOUR_MS);
    const count = link.hour === hour ? link.hourCount ?? 0 : 0;
    if (count >= MERGES_PER_HOUR) {
      // Not remembered, so GitHub can redeliver it once the hour has passed.
      await noteOn(ctx, link, event, `Not recorded: over ${MERGES_PER_HOUR} merges this hour. Redeliver it from GitHub later.`);
      return { status: 429, body: { error: "rate_limited" } };
    }
    await ctx.db.insert("githubDeliveries", { deliveryId, linkId, at: now });
    const counted = { hour, hourCount: count + 1 };
    const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", link.boardId)).unique();
    if (!board || board.authority !== "online") {
      await noteOn(ctx, link, event, "Not recorded: the board isn't online.", counted);
      return { status: 202, body: { ignored: "The board isn't online." } };
    }
    const key = prKey(merge.repo, merge.number);
    const recorded = await ctx.db.query("githubMerges").withIndex("by_board_key", (q) => q.eq("boardId", board.boardId).eq("key", key)).unique();
    if (recorded) {
      await noteOn(ctx, link, event, `Pull request ${merge.number} was already recorded.`, counted);
      return { status: 200, body: { duplicate: true } };
    }
    const roadmap = await currentRoadmap(ctx, live(board));
    const homeRepo = (await linkedRepos(ctx, board.boardId))[0] ?? null;
    const change = planRecordMerge(roadmap, merge, { homeRepo, specs: await openSpecs(ctx, board, roadmap.roadmapItems), now });
    await ctx.db.insert("githubMerges", { boardId: board.boardId, key, at: now });
    if (!change) {
      await noteOn(ctx, link, event, `Pull request ${merge.number} was already on the board.`, counted);
      return { status: 200, body: { duplicate: true } };
    }
    await commit(ctx, board, roadmap, change, { userId: link.createdBy, clientName: "GitHub", actor: "system", connectionId: "" }, now);
    const cards = change.history.affectedCards;
    await noteOn(ctx, link, event, cards.length
      ? `Pull request ${merge.number} noted on ${plural(cards.length, "card")}.`
      : `Pull request ${merge.number} named no card; it waits in the inbox.`, counted);
    return { status: 200, body: cards.length ? { recorded: "cards", cards } : { recorded: "inbox" } };
  },
});

/** Forgets delivery ids older than a week, in batches. */
export const forgetDeliveries = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = new Date(Date.now() - DELIVERY_MEMORY_MS).toISOString();
    const old = await ctx.db.query("githubDeliveries").withIndex("by_at", (q) => q.lt("at", cutoff)).take(200);
    for (const row of old) await ctx.db.delete(row._id);
  },
});
