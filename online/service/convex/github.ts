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
//
// A link is confirmed only when a correctly signed ping names its repository
// and the webhook id the linking computer recorded. GitHub sends that ping
// when the webhook is added. Until then the link's merges are still recorded,
// but credited to the person who set it up rather than to GitHub, and hosted
// surfaces don't call its merges checked. Whoever links can already edit the
// board, so a link they forge gives them no new power over it; what
// confirmation protects is the claim that GitHub said so.
//
// Every delivery that writes anything, a ping included, counts against the
// link's hourly limit first.
import { v } from "convex/values";
import { isRepoName, planRecordMerge } from "../../../src/core/landings";
import { isActiveStatus, prKey } from "../../../src/core/staleness";
import { commit } from "./boards";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { boardAccess } from "./model/access";
import { boardLinks, linkedRepos } from "./model/githubLinks";
import { fail } from "./model/errors";
import { currentRoadmap, docRow, live } from "./model/rows";
import { unpackText } from "./model/codec";
import type { Doc } from "./_generated/dataModel";

/** Repositories one board may link. */
export const MAX_LINKS_PER_BOARD = 5;
/**
 * Deliveries one link may write in an hour: merges, pings and failure notes together. More are
 * refused without a write (one note an hour says so), and GitHub can redeliver them later.
 */
export const DELIVERY_WRITES_PER_HOUR = 120;
/** How long a delivery id is remembered. GitHub redelivers only recent deliveries. */
export const DELIVERY_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;
/** Delivery ids forgotten in one go; more are forgotten by the next batch, scheduled straight away. */
export const FORGET_BATCH = 200;
const HOUR_MS = 60 * 60 * 1000;

/** What anyone on the board may see of a link: never its secret or address. */
function publicLink(link: Doc<"githubLinks">, home: boolean) {
  return {
    repo: link.repo,
    home,
    linkedAt: link.createdAt,
    webhook: link.removing
      ? "being removed: GitHub hasn't confirmed the webhook is gone; run unlink again to finish"
      : link.hookId === undefined ? "not added yet: the computer that linked it didn't finish adding GitHub's webhook; run link again to finish" : "added",
    confirmed: link.confirmedAt !== undefined,
    ...(link.confirmedAt === undefined && !link.removing
      ? { confirmation: "GitHub's test delivery hasn't arrived yet. Until it does, merges are credited to the person who linked it, not to GitHub." }
      : {}),
    lastDelivery: link.lastDelivery ?? null,
  };
}

async function ownerAccess(ctx: QueryCtx, connectionId: Doc<"connections">["_id"], boardId: string) {
  const access = await boardAccess(ctx, connectionId, boardId);
  if (!access.canAdminister) fail("forbidden", "Only the board's owner can link or unlink GitHub repositories, from their own sign-in.");
  return access;
}

async function linkById(ctx: QueryCtx, linkId: string) {
  return ctx.db.query("githubLinks").withIndex("by_linkId", (q) => q.eq("linkId", linkId)).unique();
}

/** The board's links, with each one's last delivery. Anyone on the board may read it. */
export const links = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => {
    await boardAccess(ctx, connectionId, boardId);
    const rows = await boardLinks(ctx, boardId);
    const home = rows.find((link) => !link.removing);
    return { links: rows.map((link) => publicLink(link, link === home)) };
  },
});

/**
 * Makes a link with the secret the HTTP layer generated, returned once to the owner's own sign-in.
 * A link whose webhook was never recorded is picked up again, with this new secret, so linking
 * again after a failure finds and reuses the webhook it may have added instead of adding another.
 */
export const createLink = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), repo: v.string(), linkId: v.string(), secret: v.string() },
  handler: async (ctx, { connectionId, boardId, repo, linkId, secret }) => {
    const access = await ownerAccess(ctx, connectionId, boardId);
    if (access.board.authority !== "online") fail("conflict", "This board was taken back to Local Mode; link repositories to an Online Board.");
    if (!isRepoName(repo)) fail("validation", "Name the repository as owner/name, for example planban-ai/planban.");
    const existing = await boardLinks(ctx, boardId);
    const same = existing.find((link) => link.repoKey === repo.toLowerCase());
    const home = existing.find((link) => !link.removing);
    if (same?.removing) fail("conflict", `Unlinking ${same.repo} hasn't finished. Run planban online github unlink ${same.repo} to finish it, then link it again.`);
    if (same && same.hookId === undefined) {
      await ctx.db.patch(same._id, { secret });
      return { repo: same.repo, home: same === home, linkId: same.linkId, resumed: true };
    }
    if (same) fail("conflict", `${repo} is already linked to this board. Unlink it first to link it again.`);
    if (existing.length >= MAX_LINKS_PER_BOARD) fail("validation", `A board can link at most ${MAX_LINKS_PER_BOARD} repositories.`);
    await ctx.db.insert("githubLinks", {
      linkId, boardId, repo, repoKey: repo.toLowerCase(), secret, createdBy: access.connection.userId, createdAt: new Date().toISOString(),
    });
    return { repo, home: home === undefined, linkId, resumed: false };
  },
});

/** Records the webhook id GitHub gave, so unlinking can remove it. A ping that already named it confirms the link. */
export const setHook = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), linkId: v.string(), hookId: v.number() },
  handler: async (ctx, { connectionId, boardId, linkId, hookId }) => {
    await ownerAccess(ctx, connectionId, boardId);
    const link = await linkById(ctx, linkId);
    if (!link || link.boardId !== boardId || link.removing) fail("not_found", "That link is gone.");
    if (!Number.isSafeInteger(hookId) || hookId < 1) fail("validation", "hookId must be GitHub's webhook id.");
    const confirmed = link!.pingHookId === hookId && link!.confirmedAt === undefined ? { confirmedAt: new Date().toISOString() } : {};
    await ctx.db.patch(link!._id, { hookId, ...(link!.hookId !== undefined && link!.hookId !== hookId ? { confirmedAt: undefined } : {}), ...confirmed });
    return { repo: link!.repo, confirmed: link!.pingHookId === hookId };
  },
});

/**
 * Starts unlinking: the secret goes at once, so no delivery is accepted after this. A link with a
 * webhook keeps its id, marked as being removed, until the owner's computer says GitHub removed it
 * (forgetLink); asked again, it returns the same id, so a failed removal can be retried.
 */
export const removeLink = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), repo: v.string() },
  handler: async (ctx, { connectionId, boardId, repo }) => {
    await ownerAccess(ctx, connectionId, boardId);
    const link = (await boardLinks(ctx, boardId)).find((row) => row.repoKey === repo.toLowerCase());
    if (!link) fail("not_found", `${repo} isn't linked to this board.`);
    if (link!.hookId === undefined) {
      await ctx.db.delete(link!._id);
      return { repo: link!.repo };
    }
    if (!link!.removing) await ctx.db.patch(link!._id, { removing: true, secret: undefined, confirmedAt: undefined, pingHookId: undefined });
    return { repo: link!.repo, hookId: link!.hookId! };
  },
});

/** Finishes unlinking once GitHub removed the webhook (or says it was already gone). */
export const forgetLink = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), repo: v.string() },
  handler: async (ctx, { connectionId, boardId, repo }) => {
    await ownerAccess(ctx, connectionId, boardId);
    const link = (await boardLinks(ctx, boardId)).find((row) => row.repoKey === repo.toLowerCase());
    if (!link) return { repo, forgotten: false };
    if (!link.removing) fail("conflict", `${link.repo} is still linked. Unlink it first.`);
    await ctx.db.delete(link._id);
    return { repo: link.repo, forgotten: true };
  },
});

/** The link a delivery claims, for checking its signature. Internal: never reachable from a request. */
export const hookSecret = internalQuery({
  args: { linkId: v.string() },
  handler: async (ctx, { linkId }) => {
    const link = await linkById(ctx, linkId);
    return link?.secret && !link.removing ? { secret: link.secret, repo: link.repo } : null;
  },
});

/**
 * Counts one write against the link's hourly limit. Null when the limit is reached: the caller
 * writes nothing, except that the first refusal in an hour notes it on the link.
 */
async function spend(ctx: MutationCtx, link: Doc<"githubLinks">, event: string) {
  const hour = Math.floor(Date.now() / HOUR_MS);
  const count = link.hour === hour ? link.hourCount ?? 0 : 0;
  if (count < DELIVERY_WRITES_PER_HOUR) return { hour, hourCount: count + 1 };
  if (link.limitedHour !== hour) {
    await ctx.db.patch(link._id, {
      limitedHour: hour,
      lastDelivery: { at: new Date().toISOString(), event, outcome: `Not recorded: over ${DELIVERY_WRITES_PER_HOUR} deliveries this hour. Redeliver them from GitHub later.` },
    });
  }
  return null;
}

const limited = { status: 429, body: { error: "rate_limited" } };

async function noteOn(ctx: MutationCtx, link: Doc<"githubLinks">, event: string, outcome: string, extra: Partial<Doc<"githubLinks">> = {}) {
  await ctx.db.patch(link._id, { lastDelivery: { at: new Date().toISOString(), event, outcome: outcome.slice(0, 300) }, ...extra });
}

/** Records what happened to a delivery that couldn't be recorded (see githubWebhookResponse), within the hourly limit. */
export const noteDelivery = internalMutation({
  args: { linkId: v.string(), event: v.string(), outcome: v.string() },
  handler: async (ctx, { linkId, event, outcome }) => {
    const link = await linkById(ctx, linkId);
    if (!link || link.removing) return;
    const counted = await spend(ctx, link, event);
    if (counted) await noteOn(ctx, link, event, outcome, counted);
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

/** The name of the person who set up a link, for crediting an unconfirmed link's merges to them. */
async function linkerName(ctx: QueryCtx, userId: string) {
  const person = await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", userId)).unique();
  return person?.name?.trim() || "the board's owner";
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * One verified delivery: GitHub's ping, or a merged pull request. A ping only updates the link's
 * status (and confirms it when it names the recorded webhook), so it leaves no row behind. A merge
 * is handled once per delivery id, and each pull request is recorded once per board.
 */
export const receive = internalMutation({
  args: {
    linkId: v.string(),
    deliveryId: v.string(),
    ping: v.optional(v.object({ hookId: v.number() })),
    merge: v.optional(v.object({ repo: v.string(), number: v.number(), title: v.string(), mergedAt: v.string(), url: v.string() })),
  },
  handler: async (ctx, { linkId, deliveryId, ping, merge }): Promise<{ status: number; body: Record<string, unknown> }> => {
    const link = await linkById(ctx, linkId);
    // Unlinked between the signature check and now.
    if (!link || link.removing) return { status: 401, body: { error: "unauthorized" } };
    if (!merge) {
      const counted = await spend(ctx, link, "ping");
      if (!counted) return limited;
      const hookId = ping?.hookId;
      const confirms = hookId !== undefined && link.hookId === hookId;
      await noteOn(ctx, link, "ping", confirms || link.confirmedAt ? "GitHub reached Planban." : "GitHub reached Planban; the link is confirmed once this computer records the webhook.", {
        ...counted,
        ...(hookId !== undefined && link.hookId === undefined ? { pingHookId: hookId } : {}),
        ...(confirms && link.confirmedAt === undefined ? { confirmedAt: new Date().toISOString() } : {}),
      });
      return { status: 200, body: { ok: true } };
    }
    const seen = await ctx.db.query("githubDeliveries").withIndex("by_delivery", (q) => q.eq("deliveryId", deliveryId)).unique();
    if (seen) return { status: 200, body: { duplicate: true } };
    const event = "pull_request";
    const counted = await spend(ctx, link, event);
    // Not remembered, so GitHub can redeliver it once the hour has passed.
    if (!counted) return limited;
    const now = new Date().toISOString();
    await ctx.db.insert("githubDeliveries", { deliveryId, linkId, at: now });
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
    const reportedThrough = link.confirmedAt ? null : await linkerName(ctx, link.createdBy);
    const change = planRecordMerge(roadmap, merge, { homeRepo, specs: await openSpecs(ctx, board, roadmap.roadmapItems), now, reportedThrough });
    await ctx.db.insert("githubMerges", { boardId: board.boardId, key, at: now });
    if (!change) {
      await noteOn(ctx, link, event, `Pull request ${merge.number} was already on the board.`, counted);
      return { status: 200, body: { duplicate: true } };
    }
    const clientName = reportedThrough ? `GitHub link set up by ${reportedThrough} (not confirmed by GitHub)` : "GitHub";
    await commit(ctx, board, roadmap, change, { userId: link.createdBy, clientName, actor: "system", connectionId: "" }, now);
    const cards = change.history.affectedCards;
    await noteOn(ctx, link, event, cards.length
      ? `Pull request ${merge.number} noted on ${plural(cards.length, "card")}.`
      : `Pull request ${merge.number} named no card; it waits in the inbox.`, counted);
    return { status: 200, body: cards.length ? { recorded: "cards", cards } : { recorded: "inbox" } };
  },
});

/** Forgets delivery ids older than a week, a batch at a time, until none is left. */
export const forgetDeliveries = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = new Date(Date.now() - DELIVERY_MEMORY_MS).toISOString();
    const old = await ctx.db.query("githubDeliveries").withIndex("by_at", (q) => q.lt("at", cutoff)).take(FORGET_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === FORGET_BATCH) await ctx.scheduler.runAfter(0, internal.github.forgetDeliveries, {});
    return { forgotten: old.length };
  },
});
