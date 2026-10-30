// Who may do what. Every request names a connection; it is re-read inside the
// same transaction as the work, so a revoked connection stops at once.
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { fail } from "./errors";
import { registeredClientId } from "./oauthClient";

export const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A machine's sign-in lasts until it signs out or goes this long unused (owner decision 6). */
export const IDLE_SIGN_OUT_MS = 90 * 24 * 60 * 60 * 1000;

export function connectionIsUsable(connection: Doc<"connections"> | null): connection is Doc<"connections"> {
  if (!connection || connection.revokedAt || connection.oauthPending) return false;
  if (connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now()) return false;
  if ((connection.kind === "machine" || connection.kind === "dev") && Date.now() - Date.parse(connection.lastUsedAt) > IDLE_SIGN_OUT_MS) return false;
  return true;
}

/** A claude.ai registration's own revocation ends everything made through it at once. */
export async function registrationLive(ctx: QueryCtx, connection: Doc<"connections">): Promise<boolean> {
  if (!connection.oauthClientId || !registeredClientId(connection.oauthClientId)) return true;
  const registration = await ctx.db.query("oauthRegistrations").withIndex("by_clientId", (q) => q.eq("clientId", connection.oauthClientId!)).unique();
  return !!registration && registration.userId === connection.userId;
}

export async function resolvedConnection(ctx: QueryCtx, connectionId: Id<"connections">): Promise<Doc<"connections"> | null> {
  const connection = await ctx.db.get(connectionId);
  if (!connectionIsUsable(connection)) return null;
  if (!await registrationLive(ctx, connection)) return null;
  if (!connection.oauthConnectionId) return connection;
  const grant = await ctx.db.get(connection.oauthConnectionId);
  if (!connectionIsUsable(grant) || grant.kind !== "oauth" || grant.authorizationVersion !== 2 || grant.oauthConnectionId
    || grant.userId !== connection.userId || grant.oauthClientId !== connection.oauthClientId || grant.oauthResource !== connection.oauthResource) return null;
  return { ...grant, level: lowest(grant.level, connection.level), boards: grant.boards === "all" ? connection.boards : connection.boards === "all" ? grant.boards : grant.boards.filter((board) => connection.boards.includes(board)) };
}

export async function liveConnection(ctx: QueryCtx, connectionId: Id<"connections">): Promise<Doc<"connections">> {
  const connection = await resolvedConnection(ctx, connectionId);
  if (!connection) fail("unauthorized", "This Planban connection was signed out, revoked or unused for 90 days. Sign in again.");
  return connection!;
}

export function reaches(connection: Doc<"connections">, boardId: string) {
  return connection.boards === "all" || connection.boards.includes(boardId);
}

export type AgentLevel = Doc<"connections">["level"];
const RANK: Record<AgentLevel, number> = { read: 0, plan: 1, complete: 2 };
const lowest = (...levels: AgentLevel[]) => levels.reduce((low, level) => RANK[level] < RANK[low] ? level : low);

/** What a role may do itself (owner decision 8, roles from the approved mockups): viewers read; editors and owners also complete. */
export function roleLevel(role: Doc<"members">["role"]): AgentLevel {
  return role === "viewer" ? "read" : "complete";
}

/** What a person's agents may do on a board: their own choice, never more than the person. Owners default to everything, others to planning. */
export function memberAgentLevel(member: Pick<Doc<"members">, "role" | "agentLevel">): AgentLevel {
  return lowest(member.agentLevel ?? (member.role === "owner" ? "complete" : "plan"), roleLevel(member.role));
}

export interface BoardAccess {
  connection: Doc<"connections">;
  board: Doc<"boards">;
  role: Doc<"members">["role"];
  /** What this connection may do on this board. */
  level: AgentLevel;
  canWrite: boolean;
  /** The owner's own connection: deleting, moving authority and inviting. */
  canAdminister: boolean;
  canComplete: boolean;
  /** What the person lets their agents do here, within this connection's level. */
  agentLevel: AgentLevel;
  /** What this connection itself was given (a key or app connection); "complete" for the person's own sign-in. */
  connectionLevel: AgentLevel;
  /** The person's own setting for their agents on this board. */
  personAgentLevel: AgentLevel;
}

/**
 * Why this access can't reach `need`, said for the limit that applies and with
 * its remedy: the person's role, the connection's own scope, or the person's
 * setting for their agents.
 */
export function refusalFor(access: BoardAccess, need: "plan" | "complete"): string {
  const doing = need === "plan" ? "change this board" : "mark cards complete on this board";
  if (access.role === "viewer") return "You can only view this board, so you and your agents can't change it. Ask its owner to make you an editor.";
  if (RANK[access.connectionLevel] < RANK[need]) {
    return `This connection (an app or access key) was given ${access.connectionLevel === "read" ? "read-only" : "plan-only"} access, so it can't ${doing}. The person can make a new connection with more access from Connections.`;
  }
  return `Your agents may ${access.personAgentLevel === "read" ? "only read" : "plan but not complete"} on this board, so they can't ${doing}. The person can change what their agents may do in the board's People settings, or do it themselves.`;
}

/**
 * The same access, limited to what the person lets their agents do: for an
 * edit an agent makes through the person's own computer sign-in, so local
 * agents follow the same setting as remote ones.
 */
export function asAgent(access: BoardAccess): BoardAccess {
  const level = lowest(access.level, access.agentLevel);
  return { ...access, level, canWrite: level !== "read", canComplete: level === "complete", canAdminister: false };
}

/** The caller's access to a board, or a not-found error that does not reveal whether the board exists. */
export async function boardAccess(ctx: QueryCtx, connectionId: Id<"connections">, boardId: string): Promise<BoardAccess> {
  const connection = await liveConnection(ctx, connectionId);
  const missing = () => fail("not_found", `Online Board not found: ${boardId}`);
  if (!BOARD_ID_PATTERN.test(boardId) || !reaches(connection, boardId)) missing();
  const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", boardId)).unique();
  if (!board) missing();
  const member = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId).eq("userId", connection.userId)).unique();
  if (!member) missing();
  // A person's own sign-in acts with their role; an agent or key also within
  // its own level and the person's choice for their agents.
  const level = connection.canAdminister
    ? roleLevel(member!.role)
    : lowest(connection.level, memberAgentLevel(member!));
  return {
    connection,
    board: board!,
    role: member!.role,
    level,
    canWrite: level !== "read",
    canAdminister: member!.role === "owner" && connection.canAdminister,
    canComplete: level === "complete",
    agentLevel: lowest(level, memberAgentLevel(member!)),
    connectionLevel: connection.canAdminister ? "complete" : connection.level,
    personAgentLevel: memberAgentLevel(member!),
  };
}
