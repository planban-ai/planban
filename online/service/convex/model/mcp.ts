// Remote Planban MCP over Streamable HTTP, served by a Convex HTTP action.
// Stateless and dual-era: modern clients (2026-07-28, per-request `_meta`)
// and legacy clients (an `initialize` handshake) are both served from the
// same endpoint. Tool names and arguments mirror the local Planban MCP
// server, with `boardId` in place of a local repository path. Every tool call
// goes through the same internal functions as the REST API, so the same
// access rules, base versions and idempotency apply.
import { ConvexError } from "convex/values";
import { sectionList } from "../../../../src/core/docSections";
import { PLANBAN_STATUSES, type PlanbanDocPayload, type PlanbanHistoryPayload, type PlanbanRoadmap } from "../../../../src/core/types";
import { largeDocNote } from "../../../../src/core/staleness";
import { cardAncestry } from "../../../../src/core/boardOperations";
import { queryWorkItems, type WorkItemQuery } from "../../../../src/core/workItemQuery";
import { internal } from "../_generated/api";
import { HOW_TO_REFER } from "../../../../src/core/contentRules";
import { emptyGoals, goalsBlock, goalsPageText, GOALS_GUIDANCE, type GoalsPage } from "../../../../src/core/goals";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { sha256Hex } from "./auth";
import { packJson, unpacked } from "./codec";
import type { ServiceErrorData } from "./errors";

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
// Title, icon and website let AI apps show Planban by its own name and mark (MCP Implementation fields).
const SERVER_INFO = {
  name: "Planban Online",
  title: "Planban",
  version: "0.2.0",
  websiteUrl: "https://planban.ai",
  // Filled squares, because apps draw their own tile behind the icon: black on white for light
  // interfaces, white on black for dark ones (MCP icon "theme" names the background it suits).
  icons: [
    { src: "https://app.planban.ai/brand/icon-light.png", mimeType: "image/png", sizes: ["512x512"], theme: "light" },
    { src: "https://app.planban.ai/brand/icon-dark.png", mimeType: "image/png", sizes: ["512x512"], theme: "dark" },
  ],
};
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** The protocol's Goals section, shortened (src/core/goals.ts). */
export { GOALS_GUIDANCE };

const INSTRUCTIONS = [
  "These tools read and edit Planban Online Boards shared across devices and people.",
  "Call planban_list_boards first to find the boardId.",
  "After board access changes, request tools/list again. This stateless endpoint sends no tool-list change notifications; if your client caches discovery, reconnect or reload its MCP connection. Expanded OAuth scopes require new explicit authorization.",
  "Card and board edits pass baseRevision, the board revision you last read. Spec and Plan writes pass expectedMtimeMs instead: that document's mtimeMs from planban_read_doc (null for a new document).",
  "An edit is refused only if a field it touches (or the document it writes) changed since you read it; edits elsewhere go through, and moves never clash. A refused edit is kept as an unresolved change on its card: planban_get_card shows a card's, and planban_unresolved_changes lists the board's. Settle one by saving a reconsidered version of the same fields, or drop it with planban_drop_change and a reason.",
  "To change one section of a Spec or Plan, use planban_write_doc_section with the section's heading and version from planban_read_doc: only that section is checked, so edits to other sections never clash.",
  "Reading or editing a card marks you as working on it for 15 minutes after your last activity; planban_get_card's workingOn says who else is. It is a heads-up, not a lock: avoid duplicating their work.",
  "If an edit is refused because someone changed things since you read them, the refusal says who and when, and includes what changed, the current card or document, and its new version. Read what changed. Decide whether your change is still needed, needs adjusting given theirs, or is already covered, and apply only what is still needed against the new version; for a document, write your change into the current text. If you drop or change your edit, tell the person. Never just resend it, and never give up silently.",
  "A pasted planban:<board>/<item> token is a Planban reference: <board> is the boardId and <item> is the cardId; any quoted title beside it is display context only.",
  "Pass an idempotencyKey with each edit: a fresh one per edit, and the same one only to resend that unchanged edit after a lost reply, so it is never applied twice. A revised edit, such as one merged after a conflict, gets a new key.",
  "Serialize writes: one mutation at a time per board.",
  "Complete is person-controlled: put a card in complete (by moving it or creating it complete) only when a person on the board explicitly asks, confirms it after review or testing, or clearly waives review, and set completionConfirmed true.",
  "A refusal says why: a viewer can't change the board; the person's agents may be limited to read or plan (they can change that in the board's People settings); this connection may reach only some boards; some steps are for the owner's own sign-in. Tell the person instead of working around it.",
  "Deleting cards and taking a board back to Local Mode are not available to agents.",
  `Planban is an index, not storage: boards hold text only (cards, Specs, Plans and history). Never put files, images or encoded data in a card or document. ${HOW_TO_REFER} Edits that embed files are refused.`,
  GOALS_GUIDANCE,
].join(" ");

type JsonSchema = Record<string, unknown>;

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

const statusEnum = { type: "string", enum: [...PLANBAN_STATUSES] };
const boardId = { type: "string", description: "Online Board id from planban_list_boards." };
const baseRevision = { type: "number", description: "Board revision you last read. Required: an edit based on an older revision is refused." };
const idempotencyKey = { type: "string", description: "A fresh random id for this edit (8 to 100 letters, digits, dashes or underscores). Reuse it only to retry the same edit." };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function object(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "planban_list_boards",
    title: "List Planban Online Boards",
    description: "List the Online Boards this connection can reach.",
    inputSchema: object({}),
    annotations: read,
  },
  {
    name: "planban_get_board",
    title: "Get Planban Board",
    description: "Load one Online Board, including its revision and every Work Item.",
    inputSchema: object({ boardId }, ["boardId"]),
    annotations: read,
  },
  {
    name: "planban_query_cards",
    title: "Query Planban Work Items",
    description: "Search and filter Work Items without changing the board.",
    inputSchema: object({
      boardId,
      search: { type: "string", description: "Search id, title, summary, next action, and tags." },
      projection: { type: "string", enum: ["main", "group", "flattened"] },
      groupId: { type: "string" },
      hierarchyScope: { type: "string", enum: ["projection", "root", "owned", "leaf", "selected-group"] },
      groupRole: { type: "string", enum: ["any", "group", "item-only"] },
      statuses: { type: "array", items: statusEnum },
      blocked: { type: "string", enum: ["any", "blocked", "unblocked"] },
      tags: { type: "array", items: { type: "string" } },
    }, ["boardId"]),
    annotations: read,
  },
  {
    name: "planban_get_card",
    title: "Get Planban Card",
    description: "Read one Work Item with its Group ancestry.",
    inputSchema: object({ boardId, cardId: { type: "string" } }, ["boardId", "cardId"]),
    annotations: read,
  },
  {
    name: "planban_read_doc",
    title: "Read Planban Document",
    description: "Read a card's Spec or Plan.",
    inputSchema: object({ boardId, cardId: { type: "string" }, kind: { type: "string", enum: ["spec", "plan"] } }, ["boardId", "cardId", "kind"]),
    annotations: read,
  },
  {
    name: "planban_unresolved_changes",
    title: "Planban Unresolved Changes",
    description: "List agents' edits on a board that were refused because something they touched changed since they read it, and are still waiting: each with its card, who, when, what it proposed and which fields clashed. Before editing a card, check its unresolved changes (planban_get_card includes them). Save a reconsidered version of the same fields to settle one, or drop it with planban_drop_change and a reason.",
    inputSchema: object({ boardId, cardId: { type: "string", description: "Only this card's unresolved changes." } }, ["boardId"]),
    annotations: read,
  },
  {
    name: "planban_drop_change",
    title: "Drop Planban Unresolved Change",
    description: "Drop an unresolved change that is no longer needed (already covered, or overtaken), with a short reason. The card's history records it. Tell the person too.",
    inputSchema: object({ boardId, changeId: { type: "string" }, reason: { type: "string", description: "Why it is dropped, in a sentence." }, baseRevision, idempotencyKey }, ["boardId", "changeId", "reason", "baseRevision"]),
    annotations: write,
  },
  {
    name: "planban_read_goals",
    title: "Read Planban Goals",
    description: "Only when a board read lists goals: the board's whole Goals page, its goals in order with their notes, the Context section, suggestions waiting for the person, suggestions dismissed in the last 30 days, and retired goals.",
    inputSchema: object({ boardId }, ["boardId"]),
    annotations: read,
  },
  {
    name: "planban_suggest_goal_change",
    title: "Suggest a Planban Goals Change",
    description: "Leave one suggested change to the board's goals, with the evidence, on the Goals page for a person to accept or dismiss. Ask the person in chat first and use this only if they agree, or if no person is in the conversation (an unattended run). Only people change goals; agents can't edit them. A dismissed suggestion isn't shown again for 30 days.",
    inputSchema: object({
      boardId,
      kind: { type: "string", enum: ["add", "reword", "reorder", "retire"] },
      goal: { type: "string", description: "reword, reorder, retire: the goal's number on the Goals page, or its id." },
      statement: { type: "string", description: "add, reword: the goal in one line." },
      notes: { type: "string", description: "add, reword: optional notes for the goal." },
      position: { type: "number", description: "add, reorder: where it goes, 1 for the top." },
      reason: { type: "string", description: "Why, with evidence the person can check, in a sentence or two." },
      idempotencyKey,
    }, ["boardId", "kind", "reason"]),
    annotations: write,
  },
  {
    name: "planban_history",
    title: "Planban Board History",
    description: "List recent changes to a board, with who made each one and from which app.",
    inputSchema: object({ boardId, limit: { type: "number", description: "Most recent entries to return. Defaults to 20." } }, ["boardId"]),
    annotations: read,
  },
  {
    name: "planban_create_card",
    title: "Create Planban Card",
    description: "Create a Work Item with optional placement, tags, metadata, and initial Spec or Plan markdown. Follow the Planban house style for owner-facing text. Text only: refer to files by link or labelled local path, never embed them.",
    inputSchema: object({
      boardId,
      title: { type: "string" },
      status: statusEnum,
      summary: { type: "string" },
      nextAction: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      metadata: { type: ["object", "null"] },
      specMarkdown: { type: "string" },
      planMarkdown: { type: "string" },
      position: { type: "string", enum: ["top", "bottom"] },
      afterId: { type: "string" },
      parentId: { type: "string", description: "Existing Group id; creates an owned Item." },
      baseRevision,
      idempotencyKey,
      completionConfirmed: { type: "boolean", description: "Required true when this would put a card in complete. Only when a person on the board explicitly asks, confirms it after review or testing, or clearly waives review." },
    }, ["boardId", "title", "baseRevision"]),
    annotations: write,
  },
  {
    name: "planban_create_cards",
    title: "Create Multiple Planban Cards",
    description: "Atomically create sibling Work Item skeletons, optionally inside a Group.",
    inputSchema: object({
      boardId,
      titles: { type: "array", items: { type: "string" } },
      status: statusEnum,
      parentId: { type: "string" },
      baseRevision,
      idempotencyKey,
      completionConfirmed: { type: "boolean", description: "Required true when this would put a card in complete. Only when a person on the board explicitly asks, confirms it after review or testing, or clearly waives review." },
    }, ["boardId", "titles", "baseRevision"]),
    annotations: write,
  },
  {
    name: "planban_create_group",
    title: "Create Planban Group",
    description: "Create a Group and place existing root Items inside it.",
    inputSchema: object({
      boardId,
      title: { type: "string" },
      summary: { type: "string" },
      nextAction: { type: "string" },
      status: statusEnum,
      itemIds: { type: "array", items: { type: "string" } },
      anchorId: { type: "string" },
      specMarkdown: { type: "string" },
      planMarkdown: { type: "string" },
      baseRevision,
      idempotencyKey,
      completionConfirmed: { type: "boolean", description: "Required true when this would put a card in complete. Only when a person on the board explicitly asks, confirms it after review or testing, or clearly waives review." },
    }, ["boardId", "title", "baseRevision"]),
    annotations: write,
  },
  {
    name: "planban_update_card",
    title: "Update Planban Card",
    description: "Update non-status card fields such as title, summary, next action, tags, blocked-by, or metadata. Text only: refer to files by link or labelled local path, never embed them. If refused because something changed since you read it, the refusal includes what changed, who changed it and the current version: apply only what is still needed, and tell the person if you drop or change your edit.",
    inputSchema: object({
      boardId,
      cardId: { type: "string" },
      title: { type: "string" },
      summary: { type: ["string", "null"] },
      nextAction: { type: ["string", "null"] },
      tags: { type: "array", items: { type: "string" } },
      blockedBy: { type: ["string", "null"] },
      metadata: { type: ["object", "null"], description: "Metadata keys to set; other keys are kept. A key set to null is removed; null clears all metadata." },
      baseRevision,
      idempotencyKey,
    }, ["boardId", "cardId", "baseRevision"]),
    annotations: write,
  },
  {
    name: "planban_move_card",
    title: "Place Planban Card",
    description: "Change an Item's status, Group, and/or sibling rank in one mutation. Use null afterId for first position. Use status complete only when a person on the board explicitly asks, confirms it after review or testing, or clearly waives review; set completionConfirmed true. If refused because something changed since you read it, the refusal includes what changed, who changed it and the current version: apply only what is still needed, and tell the person if you drop or change your edit.",
    inputSchema: object({
      boardId,
      cardId: { type: "string" },
      status: statusEnum,
      parentId: { type: ["string", "null"] },
      afterId: { type: ["string", "null"] },
      completionConfirmed: { type: "boolean" },
      baseRevision,
      idempotencyKey,
    }, ["boardId", "cardId", "baseRevision"]),
    annotations: write,
  },
  {
    name: "planban_write_doc",
    title: "Write Planban Document",
    description: "Write a card's Spec or Plan. Pass the mtimeMs from planban_read_doc as expectedMtimeMs so someone else's edit is never overwritten. Text only, up to 1 MB: refer to images and other files by GitHub link, web address or a local path labelled with its machine; embedded images and encoded data are refused. If refused because something changed since you read it, the refusal includes what changed, who changed it and the current version: apply only what is still needed, and tell the person if you drop or change your edit.",
    inputSchema: object({
      boardId,
      cardId: { type: "string" },
      kind: { type: "string", enum: ["spec", "plan"] },
      markdown: { type: "string" },
      expectedMtimeMs: { type: ["number", "null"], description: "The mtimeMs from planban_read_doc; null for a new document. Required." },
      idempotencyKey,
    }, ["boardId", "cardId", "kind", "markdown", "expectedMtimeMs"]),
    annotations: write,
  },
  {
    name: "planban_write_doc_section",
    title: "Write One Section of a Planban Document",
    description: "Replace one section of a card's Spec or Plan, by its heading, or add a new one. Pass the section's version from planban_read_doc (sections) as expectedSectionVersion, or null for a new section; only that section is checked, so edits to other sections never clash. markdown is the whole section, starting with its heading line. If refused because the section changed, the refusal includes the section as it is now and who changed the document: apply only what is still needed, and tell the person if you drop or change your edit.",
    inputSchema: object({
      boardId,
      cardId: { type: "string" },
      kind: { type: "string", enum: ["spec", "plan"] },
      heading: { type: "string", description: "The section's heading text, without the #s." },
      occurrence: { type: "number", description: "Which section with this heading (0 for the first), when headings repeat." },
      expectedSectionVersion: { type: ["string", "null"], description: "The section's version from planban_read_doc; null for a new section. Required." },
      markdown: { type: "string", description: "The whole section, starting with its heading line." },
      after: { type: "string", description: "For a new section: the heading to put it after (else it goes at the end)." },
      idempotencyKey,
    }, ["boardId", "cardId", "kind", "heading", "expectedSectionVersion", "markdown"]),
    annotations: write,
  },
  // ChatGPT's company-knowledge and deep-research surfaces look for these two read-only tools.
  {
    name: "search",
    title: "Search Planban",
    description: "Search Work Items across every Online Board this connection can reach.",
    inputSchema: object({ query: { type: "string" } }, ["query"]),
    annotations: read,
  },
  {
    name: "fetch",
    title: "Fetch Planban Work Item",
    description: "Fetch one Work Item and its Spec by the id returned from search.",
    inputSchema: object({ id: { type: "string" } }, ["id"]),
    annotations: read,
  },
];

class ToolError extends Error {
  constructor(message: string, readonly data?: ServiceErrorData) {
    super(message);
  }
}

/** A refusal's kind and details, in the shape the local tools use (structuredContent.error). */
function toolErrorReport(error: ToolError) {
  const data = error.data;
  if (!data) return { category: "validation", message: error.message.replace(/^[a-z_]+: /u, "") };
  const category = { conflict: "conflict", validation: "validation", not_found: "not_found", forbidden: "forbidden", unauthorized: "signed_out", rate_limited: "limit" }[data.code] ?? "error";
  const details = { ...(data.currentRevision !== undefined ? { currentRevision: data.currentRevision } : {}), ...(data.conflict ? { conflict: data.conflict } : {}) };
  return { category, message: data.message, ...(Object.keys(details).length ? { details } : {}) };
}

interface DiscoveryPermission { boardId: string; canWrite: boolean; canComplete: boolean }

/** Discovery is guidance; mutations retain their transactional access checks. */
export function discoverTools(permissions: DiscoveryPermission[]): ToolDefinition[] {
  const readable = [...new Set(permissions.map((access) => access.boardId))].sort();
  const writable = [...new Set(permissions.filter((access) => access.canWrite).map((access) => access.boardId))].sort();
  const complete = [...new Set(permissions.filter((access) => access.canWrite && access.canComplete).map((access) => access.boardId))].sort();
  return TOOLS.flatMap((definition) => {
    if (!definition.annotations.readOnlyHint && !writable.length) return [];
    const tool = structuredClone(definition);
    const properties = tool.inputSchema.properties as Record<string, JsonSchema>;
    const boards = tool.annotations.readOnlyHint ? readable : writable;
    if (properties.boardId) {
      if (!boards.length) return [];
      properties.boardId = { ...properties.boardId, enum: boards };
    }
    if (tool.name === "fetch" && !readable.length) return [];
    if (!tool.annotations.readOnlyHint && properties.status) {
      if (!complete.length) {
        properties.status = { ...properties.status, enum: PLANBAN_STATUSES.filter((status) => status !== "complete") };
        delete properties.completionConfirmed;
        tool.description += " Completing work is not permitted on these boards.";
      } else {
        // A connection can plan on one board and complete on another. Only
        // the latter board ids may be paired with the completion status.
        tool.inputSchema.allOf = [{
          if: { properties: { status: { const: "complete" } }, required: ["status"] },
          then: { properties: { boardId: { enum: complete }, completionConfirmed: { const: true } }, required: ["completionConfirmed"] },
        }];
      }
    }
    return [tool];
  });
}

/** The board operations a tool call may use, bound to the caller's connection. */
export class McpService {
  constructor(private ctx: ActionCtx, private connectionId: Id<"connections">) {}

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      const data = error.data as ServiceErrorData;
      const revision = data.currentRevision !== undefined && !data.conflict ? ` Current revision: ${data.currentRevision}.` : "";
      throw new ToolError(`${data.code}: ${data.message}${revision}`, data);
    }
  }

  listBoards() {
    return this.call(() => this.ctx.runQuery(internal.boards.listBoards, { connectionId: this.connectionId }));
  }

  async listTools() {
    // Let Convex authorization errors retain their type for the HTTP error
    // boundary if a credential is revoked after initial authentication.
    return discoverTools(await this.ctx.runQuery(internal.boards.mcpPermissions, { connectionId: this.connectionId }));
  }

  async getBoard(boardId: string): Promise<PlanbanRoadmap> {
    const board = unpacked(await this.call(() => this.ctx.runQuery(internal.boards.getBoard, { connectionId: this.connectionId, boardId })));
    return (board as { roadmap: PlanbanRoadmap }).roadmap;
  }

  readDoc(boardId: string, cardId: string, kind: "spec" | "plan"): Promise<PlanbanDocPayload> {
    return this.call(() => this.ctx.runQuery(internal.boards.readDoc, { connectionId: this.connectionId, boardId, cardId, kind }));
  }


  async goals(boardId: string): Promise<{ page: GoalsPage; revision: number }> {
    return unpacked(await this.call(() => this.ctx.runQuery(internal.boards.goals, { connectionId: this.connectionId, boardId })));
  }

  history(boardId: string): Promise<PlanbanHistoryPayload> {
    return this.call(() => this.ctx.runQuery(internal.boards.history, { connectionId: this.connectionId, boardId }));
  }

  /** This agent is working on the card: a heads-up for others, never a lock. Best effort. */
  async notePresence(boardId: string, cardId: string) {
    await this.ctx.runMutation(internal.boards.notePresence, { connectionId: this.connectionId, boardId, cardId }).catch(() => undefined);
  }

  working(boardId: string, cardId: string): Promise<{ working: Record<string, Array<{ who: string; note: string }>> }> {
    return this.call(() => this.ctx.runQuery(internal.boards.working, { connectionId: this.connectionId, boardId, cardId }));
  }

  async unresolved(boardId: string, cardId?: string): Promise<{ changes: unknown[] }> {
    return unpacked(await this.call(() => this.ctx.runQuery(internal.boards.unresolved, { connectionId: this.connectionId, boardId, ...(cardId ? { cardId } : {}) })));
  }

  async run(boardId: string, op: string, input: Record<string, unknown>, completionConfirmed: boolean, idempotencyKey?: string) {
    const requestHash = idempotencyKey ? await sha256Hex(`${boardId}\n${op}\n${JSON.stringify(input)}\n${completionConfirmed}`) : undefined;
    const ran = unpacked<{ roadmap: PlanbanRoadmap; result: unknown; replayed?: boolean; originalRevision?: number } | { refused: ServiceErrorData }>(await this.call(() => this.ctx.runMutation(internal.boards.run, {
      connectionId: this.connectionId, boardId, op, payload: packJson(input), completionConfirmed,
      ...(idempotencyKey ? { idempotencyKey, requestHash } : {}),
    })));
    // A refused agent edit, kept as an unresolved change, is a tool error like any conflict.
    if ("refused" in ran) throw new ToolError(`conflict: ${ran.refused.message}`, ran.refused);
    return ran;
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${key} is required.`);
  return value;
}

/** A whole board, with the fields every Planban surface shares: boardId, title, revision, roadmapItems. */
function compactBoard(roadmap: PlanbanRoadmap) {
  return {
    boardId: roadmap.project.id,
    title: roadmap.project.title,
    revision: roadmap.revision,
    updatedAt: roadmap.updatedAt,
    roadmapItems: roadmap.roadmapItems,
  };
}


function operationInput(args: Record<string, unknown>) {
  const { boardId: _boardId, completionConfirmed: _confirmed, idempotencyKey: _key, ...input } = args;
  return { ...input, actor: "agent" };
}

/** The link to give the person after an edit, in the local tools' shape. The web address is always reachable, so it needs no check. */
function handoff(origin: string, boardId: string, cardId?: string) {
  const boardUrl = `${origin}/boards/${encodeURIComponent(boardId)}`;
  const url = cardId ? cardUrl(origin, boardId, cardId) : boardUrl;
  return { boardUrl, boardUrlVerified: true, userReply: { urlRequired: true, url, markdown: `[Open the board](${url})` } };
}

/** A card on the web page: the board's address, opening the card. */
export function cardUrl(origin: string, boardId: string, cardId: string): string {
  return `${origin}/boards/${encodeURIComponent(boardId)}#card=${encodeURIComponent(cardId)}`;
}

async function callTool(service: McpService, origin: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "planban_list_boards":
      return { boards: await service.listBoards() };
    case "planban_get_board": {
      const boardIdArg = stringArg(args, "boardId");
      const [roadmap, { page }] = await Promise.all([service.getBoard(boardIdArg), service.goals(boardIdArg)]);
      // The goal statements only, when the board has goals; planban_read_goals has the rest.
      const goals = goalsBlock({ ...emptyGoals(), goals: page.goals });
      const board = compactBoard(roadmap);
      const { roadmapItems, ...head } = board;
      return goals ? { ...head, goals, roadmapItems } : board;
    }
    case "planban_read_goals": {
      const { page, revision } = await service.goals(stringArg(args, "boardId"));
      return { revision, text: goalsPageText(page), ...page };
    }
    case "planban_suggest_goal_change": {
      const boardIdArg = stringArg(args, "boardId");
      const key = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
      const change = { kind: args.kind, goal: args.goal, statement: args.statement, notes: args.notes, position: args.position };
      const outcome = await service.run(boardIdArg, "suggestGoalChange", { change, reason: args.reason, actor: "agent" }, false, key);
      const result = outcome.result as { notAdded?: string; page: GoalsPage };
      if (result.notAdded) return { added: false, note: result.notAdded };
      return { added: true, suggestion: result.page.suggestions.at(-1), note: "It waits at the top of the Goals page for a person to accept or dismiss; tell them.", ...handoff(origin, boardIdArg) };
    }
    case "planban_query_cards": {
      const { boardId: _id, ...query } = args;
      const roadmap = await service.getBoard(stringArg(args, "boardId"));
      // The same shape as the local planban_query_cards: the matches at the top level.
      return { boardId: roadmap.project.id, revision: roadmap.revision, ...queryWorkItems(roadmap.roadmapItems, query as WorkItemQuery) };
    }
    case "planban_get_card": {
      const roadmap = await service.getBoard(stringArg(args, "boardId"));
      const cardId = stringArg(args, "cardId");
      const card = roadmap.roadmapItems.find((item) => item.id === cardId);
      if (!card) throw new ToolError(`not_found: Card not found: ${cardId}`);
      // Agents see edits to this card that were refused and are still waiting, and who else is working on it (Spec point 20).
      const boardId = stringArg(args, "boardId");
      await service.notePresence(boardId, cardId);
      const [{ changes }, { working }] = await Promise.all([service.unresolved(boardId, cardId), service.working(boardId, cardId)]);
      const others = working[cardId] ?? [];
      return {
        revision: roadmap.revision, card, ancestry: cardAncestry(roadmap, cardId),
        ...(others.length ? { workingOn: others } : {}), ...(changes.length ? { unresolvedChanges: changes } : {}),
      };
    }
    case "planban_unresolved_changes": {
      const cardId = typeof args.cardId === "string" ? args.cardId : undefined;
      return await service.unresolved(stringArg(args, "boardId"), cardId);
    }
    case "planban_drop_change": {
      const key = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
      const outcome = await service.run(stringArg(args, "boardId"), "dropChange", operationInput(args), false, key);
      return { revision: outcome.roadmap.revision, ...(outcome.result as Record<string, unknown>), ...handoff(origin, stringArg(args, "boardId")) };
    }
    case "planban_read_doc": {
      const doc = await service.readDoc(stringArg(args, "boardId"), stringArg(args, "cardId"), args.kind === "plan" ? "plan" : "spec");
      await service.notePresence(stringArg(args, "boardId"), stringArg(args, "cardId"));
      // Each section's own version, for planban_write_doc_section; and, past 100 KB, rewrite rather than append.
      const sizeNote = doc.exists ? largeDocNote(doc.kind, new TextEncoder().encode(doc.markdown).length) : null;
      return { ...doc, sections: sectionList(doc.markdown), ...(sizeNote ? { note: `${sizeNote}.` } : {}) };
    }
    case "planban_history": {
      const history = await service.history(stringArg(args, "boardId"));
      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 200) : 20;
      return { currentVersion: history.currentVersion, entries: history.entries.slice(0, limit) };
    }
    case "planban_move_card":
    case "planban_create_card":
    case "planban_create_cards":
    case "planban_create_group":
    case "planban_update_card":
    case "planban_write_doc_section":
    case "planban_write_doc": {
      const op = {
        planban_create_card: "createCard",
        planban_create_cards: "createCards",
        planban_create_group: "createGroup",
        planban_update_card: "updateCard",
        planban_move_card: "moveCard",
        planban_write_doc: "writeDoc",
        planban_write_doc_section: "writeDocSection",
      }[name]!;
      // Any tool whose effect completes a card needs explicit confirmation; the
      // board judges the effect, including status inherited by a new Group.
      const key = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
      const outcome = await service.run(stringArg(args, "boardId"), op, operationInput(args), args.completionConfirmed === true, key);
      // A retried edit says so, and which revision it originally produced.
      // Like the local tools, every edit returns the link to give the person.
      const boardIdArg = stringArg(args, "boardId");
      const changedCard = typeof args.cardId === "string" ? args.cardId
        : (outcome.result as { createdCard?: { id?: string }; createdGroup?: { id?: string } })?.createdCard?.id
          ?? (outcome.result as { createdGroup?: { id?: string } })?.createdGroup?.id;
      // What changed, under the local tools' names too (card, cards, group; a document's fields).
      const result = outcome.result as { createdCard?: unknown; createdCards?: unknown; createdGroup?: unknown; doc?: Record<string, unknown> };
      const card = result.createdCard ?? (typeof args.cardId === "string" && !result.doc ? outcome.roadmap.roadmapItems.find((item) => item.id === args.cardId) : undefined);
      return {
        revision: outcome.roadmap.revision, ...result,
        ...(card ? { card } : {}), ...(result.createdCards ? { cards: result.createdCards } : {}), ...(result.createdGroup ? { group: result.createdGroup } : {}),
        ...(result.doc ? { ...result.doc, doc: result.doc } : {}),
        ...(outcome.replayed ? { replayed: true, ...(outcome.originalRevision === undefined ? {} : { originalRevision: outcome.originalRevision }) } : {}),
        ...handoff(origin, boardIdArg, changedCard),
      };
    }
    case "search": {
      const query = stringArg(args, "query");
      // Each result links to its card on the web page, which opens it for a signed-in member
      // and shows the signed-out screen to anyone else.
      const results: Array<{ id: string; title: string; url: string }> = [];
      // Bounded work per call: the first boards listed, and a capped result count.
      for (const board of (await service.listBoards()).slice(0, SEARCH_MAX_BOARDS)) {
        const roadmap = await service.getBoard(board.boardId);
        const matches = queryWorkItems(roadmap.roadmapItems, { search: query, projection: "flattened" }).matches.slice(0, 10);
        for (const { item } of matches) {
          results.push({ id: `${board.boardId}/${item.id}`, title: `${item.title} (${board.title})`, url: cardUrl(origin, board.boardId, item.id) });
        }
        if (results.length >= SEARCH_MAX_RESULTS) break;
      }
      return { results: results.slice(0, SEARCH_MAX_RESULTS) };
    }
    case "fetch": {
      const [id, cardId] = stringArg(args, "id").split("/");
      if (!id || !cardId) throw new ToolError("validation: id must look like board/card.");
      const roadmap = await service.getBoard(id);
      const card = roadmap.roadmapItems.find((item) => item.id === cardId);
      if (!card) throw new ToolError(`not_found: Card not found: ${cardId}`);
      const spec = await service.readDoc(id, cardId, "spec");
      const text = [
        `# ${card.title}`,
        `Status: ${card.status}`,
        card.summary ? `Summary: ${card.summary}` : null,
        card.nextAction ? `Next action: ${card.nextAction}` : null,
        "",
        spec.markdown,
      ].filter((line) => line !== null).join("\n");
      return { id: `${id}/${cardId}`, title: card.title, text, url: cardUrl(origin, id, cardId), metadata: { boardId: id, status: card.status } };
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: JsonRpcRequest["id"], result: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    result: { resultType: "complete", ...result, _meta: { [META_SERVER_INFO]: SERVER_INFO } },
  };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

const CAPABILITIES = { tools: { listChanged: false } };

async function handleMessage(message: JsonRpcRequest, service: McpService, origin: string, headerVersion: string | null) {
  const meta = (message.params?._meta ?? {}) as Record<string, unknown>;
  const requested = (meta[META_VERSION] as string | undefined) ?? headerVersion ?? undefined;
  if (message.method !== "initialize" && requested && !SUPPORTED_VERSIONS.includes(requested)) {
    return rpcError(message.id, -32022, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested });
  }

  switch (message.method) {
    case "initialize": {
      const asked = String(message.params?.protocolVersion ?? "");
      const protocolVersion = LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0];
      return rpcResult(message.id, { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case "server/discover":
      return rpcResult(message.id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: "public",
      });
    case "ping":
      return rpcResult(message.id, {});
    case "tools/list":
      return rpcResult(message.id, { tools: await service.listTools(), ttlMs: 0, cacheScope: "private" });
    case "tools/call": {
      const name = String(message.params?.name ?? "");
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const structured = await callTool(service, origin, name, args);
        return rpcResult(message.id, {
          content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
          isError: false,
        });
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        return rpcResult(message.id, { content: [{ type: "text", text: error.message }], structuredContent: { error: toolErrorReport(error) }, isError: true });
      }
    }
    default:
      return rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

/** Most messages one MCP request may carry, and how much a search call reads. */
export const MAX_BATCH = 10;
export const SEARCH_MAX_BOARDS = 25;
export const SEARCH_MAX_RESULTS = 50;

export async function handleMcp(request: Request, service: McpService, origin: string): Promise<Response> {
  if (request.method !== "POST") {
    // Modern clients never GET; legacy clients may try to open a stream. This server sends none.
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error"), 400);
  }
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  // Current MCP doesn't batch; older clients may. A large batch is refused
  // whole, before any of it runs, so one request can't do unbounded work.
  if (Array.isArray(payload) && (payload.length === 0 || payload.length > MAX_BATCH)) {
    return jsonResponse(rpcError(null, -32600, `Invalid request: send at most ${MAX_BATCH} messages at once.`), 400);
  }
  const messages = Array.isArray(payload) ? payload as JsonRpcRequest[] : [payload as JsonRpcRequest];
  const responses = [];
  for (const message of messages) {
    if (!message || typeof message.method !== "string") {
      responses.push(rpcError(null, -32600, "Invalid request"));
      continue;
    }
    if (message.id === undefined || message.id === null) continue; // notifications need no reply
    responses.push(await handleMessage(message, service, origin, headerVersion));
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return jsonResponse(Array.isArray(payload) ? responses : responses[0]);
}
