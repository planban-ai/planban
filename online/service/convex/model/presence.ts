// Working on a card (Spec point 20): a heads-up, not a lock. When an agent
// reads or edits a card it is marked as working on it, until 15 minutes after
// its last activity. Other agents see "Claude (Sam) is working on this card,
// started 4 minutes ago"; people see a small, quiet sign on the card. Nothing
// is checked out or claimed.
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { BoardRows } from "./history";

export const PRESENCE_MS = 15 * 60 * 1000;
const MAX_LIVE_PER_CONNECTION = 50;
/** Rows quiet longer than this are removed by the hourly sweep. */
export const PRESENCE_KEEP_MS = 24 * 60 * 60 * 1000;

/** An app name as people say it, from what an MCP client calls itself ("claude-code" is "Claude"). */
export { appName } from "../../../../src/core/agentNames";

/** Within this long, another touch by the same agent writes nothing: reads stay cheap and don't contend. */
const TOUCH_EVERY_MS = 60 * 1000;

/**
 * One row per agent (its sign-in and app) per card: two apps on one
 * computer's sign-in are two agents. Only the agent's own row is read and
 * written, and at most once a minute.
 */
export async function touchPresence(ctx: MutationCtx, at: BoardRows, entry: { cardId: string; connectionId: Id<"connections">; userId: string; app: string }, now = Date.now()) {
  const mine = await ctx.db.query("presence").withIndex("by_agent", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", entry.cardId).eq("connectionId", entry.connectionId).eq("app", entry.app)).first();
  if (mine && now - mine.lastActiveAt < TOUCH_EVERY_MS) return;
  // A gap longer than the heads-up lasts starts a new stretch of work.
  const fresh = !mine || now - mine.lastActiveAt > PRESENCE_MS;
  if (fresh) await makeRoom(ctx, entry.connectionId, now);
  if (!mine) await ctx.db.insert("presence", { ...at, ...entry, startedAt: now, lastActiveAt: now });
  else await ctx.db.patch(mine._id, { lastActiveAt: now, ...(fresh ? { startedAt: now } : {}) });
}

/**
 * One connection shows as working on at most this many cards at once, so
 * invented card ids or app names can't pile up. The current card always
 * shows: the connection's least recent one makes way.
 */
async function makeRoom(ctx: MutationCtx, connectionId: Id<"connections">, now: number) {
  const live = await ctx.db.query("presence").withIndex("by_connection_active", (q) => q.eq("connectionId", connectionId).gte("lastActiveAt", now - PRESENCE_MS)).take(MAX_LIVE_PER_CONNECTION);
  if (live.length < MAX_LIVE_PER_CONNECTION) return;
  for (const row of live.slice(0, live.length - MAX_LIVE_PER_CONNECTION + 1)) await ctx.db.patch(row._id, { lastActiveAt: now - PRESENCE_MS - 1 });
}

export interface Working {
  userId: string;
  app: string;
  startedAt: string;
  lastActiveAt: string;
  connectionId: string;
}

/** Who is working on each card now (or on one card), leaving out `except` (the asker). */
export async function workingOn(ctx: QueryCtx, at: BoardRows, options: { cardId?: string; except?: { connectionId: string; app: string } } = {}, now = Date.now()) {
  // One card: its own rows (a few per agent at most). The whole board: only rows active in the last
  // 15 minutes, newest first, however many old ones remain.
  const rows = options.cardId
    ? await ctx.db.query("presence").withIndex("by_card_active", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", options.cardId!).gte("lastActiveAt", now - PRESENCE_MS)).order("desc").take(200)
    : await ctx.db.query("presence").withIndex("by_board_active", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).gte("lastActiveAt", now - PRESENCE_MS)).order("desc").take(500);
  const byCard: Record<string, Working[]> = {};
  for (const row of rows) {
    if (now - row.lastActiveAt > PRESENCE_MS || (row.connectionId === options.except?.connectionId && row.app === options.except.app)) continue;
    (byCard[row.cardId] ??= []).push({ userId: row.userId, app: row.app, startedAt: new Date(row.startedAt).toISOString(), lastActiveAt: new Date(row.lastActiveAt).toISOString(), connectionId: row.connectionId });
  }
  return byCard;
}

/** "Claude (Sam) is working on this card, started 4 minutes ago." */
export function workingSentence(who: string, startedAt: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(startedAt)) / 60000));
  const ago = minutes === 0 ? "just now" : minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  return `${who} is working on this card, started ${ago}.`;
}
