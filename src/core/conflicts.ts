// When an edit is refused because something changed underneath it, the answer
// carries what the agent needs to reconcile its intent rather than resend or
// give up (owner requirement, 15 October 2026): what changed since it read,
// who changed it and when, and the current card or document with its version.
// Shared by local boards and the online service.
import { PlanbanConflictError } from "./boardOperations";
import type { PlanbanDocPayload, PlanbanHistoryEntry, PlanbanRoadmap, PlanbanRoadmapItem } from "./types";
import type { FieldClash } from "./concurrent";

export interface ConflictChange {
  /** The history version and board revision of the change, when known. */
  version?: number;
  revision?: number;
  at: string;
  /** Who made it, as a person would say it: "Ana", "Ana's agent (Claude)", "an agent on this computer". */
  by: string;
  agent: boolean;
  summary: string;
  cards: string[];
  /** Only the card's last change is known (history no longer shows the field's): it may have been another field. */
  cardLevel?: true;
}

export interface ConflictDetails {
  /** The board revision now; card and board edits retry against it. */
  currentRevision: number;
  /** The revision the refused edit was based on, when it stated one. */
  yourRevision?: number;
  /** What changed since then, newest first (at most 20). */
  changes: ConflictChange[];
  /** The card the edit was about, as it is now (null: it no longer exists). */
  card?: PlanbanRoadmapItem | null;
  /** The fields this edit touches that changed since it read them: what it read, what they are now, and what it wanted. */
  clashes?: FieldClash[];
  /** For one section of a Spec or Plan: the section as it is now, with its version (null when it is gone). */
  section?: { heading: string; version: string | null; text: string };
  /** For a Spec or Plan: the document as it is now, with its version (mtimeMs). */
  document?: PlanbanDocPayload & { markdownOmitted?: true };
}

export const MAX_CONFLICT_CHANGES = 20;
/** Longer documents are left out of a conflict answer (markdownOmitted); the agent reads them with read_doc. */
export const MAX_CONFLICT_DOCUMENT_CHARS = 256 * 1024;

/** What to do with a refused edit, the same on every surface. */
export const RECONCILE = "Read what changed (included in this answer). Decide whether your change is still needed, needs adjusting given theirs, or is already covered, and apply only what is still needed against the new version. If you drop or change your edit, tell the person. Never just resend it, and never give up silently.";

export class PlanbanEditConflictError extends PlanbanConflictError {
  readonly currentRevision: number;
  constructor(message: string, readonly conflict: ConflictDetails) {
    super(message);
    this.name = "PlanbanEditConflictError";
    this.currentRevision = conflict.currentRevision;
  }
}

/** "Not saved: Ana changed card "Alpha" since you read it (Moved Alpha to In Progress, 2026-10-15T18:00:00Z). <what to do>" */
export function conflictMessage(subject: string, conflict: ConflictDetails, forAgent = true) {
  // Name who changed the thing this edit is about, never an unrelated change elsewhere on the board.
  const target = conflict.document?.cardId ?? conflict.clashes?.[0]?.cardId ?? conflict.card?.id;
  const latest = target ? conflict.changes.find((change) => change.cards.includes(target)) : conflict.changes[0];
  const said = latest?.cardLevel
    ? `Not saved: ${subject} changed since you read it (${latest.summary}, by ${latest.by}, ${latest.at}).`
    : latest || !conflict.changes.length
    ? `Not saved: ${latest ? latest.by : "someone"} changed ${subject} since you read it${latest ? ` (${latest.summary}, ${latest.at})` : ""}.`
    : `Not saved: the board changed since you read it (latest: ${conflict.changes[0]!.by}, ${conflict.changes[0]!.summary}, ${conflict.changes[0]!.at}), though not ${subject}.`;
  // A person on the board page sees the plain sentence; the page shows them what changed.
  if (!forAgent) return said;
  const version = conflict.document ? ` The document's version is now ${conflict.document.mtimeMs ?? "new"}.` : ` The board is now at revision ${conflict.currentRevision}.`;
  return `${said}${version} ${RECONCILE}`;
}

/** The history entries after `base`, newest first, as conflict changes. */
export function changesSince(entries: Array<PlanbanHistoryEntry & { by?: string }>, base: number | undefined, describe: (entry: PlanbanHistoryEntry) => string) {
  const newestFirst = [...entries].sort((a, b) => b.version - a.version);
  const after = base === undefined ? newestFirst.slice(0, 1) : newestFirst.filter((entry) => entry.roadmapRevision > base);
  return after.slice(0, MAX_CONFLICT_CHANGES).map((entry): ConflictChange => ({
    version: entry.version, revision: entry.roadmapRevision, at: entry.createdAt, by: describe(entry), agent: entry.actor === "agent",
    // Summaries can quote a long title; the answer stays small.
    summary: entry.summary.length > 200 ? `${entry.summary.slice(0, 199)}…` : entry.summary, cards: [...new Set([...entry.affectedCards, ...entry.affectedDocs.map((doc) => doc.cardId)])],
  }));
}

/** The latest change to one card's Spec or Plan, newest first. */
export function lastDocChange(entries: PlanbanHistoryEntry[], cardId: string, kind: string) {
  return [...entries].sort((a, b) => b.version - a.version).filter((entry) => entry.affectedDocs.some((doc) => doc.cardId === cardId && doc.kind === kind)).slice(0, 1);
}

/** How a card edit's subject reads: the card's title when known. */
export function cardSubject(roadmap: PlanbanRoadmap, cardId: string | undefined) {
  const card = cardId ? roadmap.roadmapItems.find((item) => item.id === cardId) : undefined;
  return card ? `card "${card.title}"` : "this board";
}

const FIELD_NAMES: Record<string, string> = { title: "title", summary: "summary", nextAction: "next action", tags: "tags", blockedBy: "blocked-by", status: "column", parentId: "Group", icon: "icon", isGroup: "kind" };

/** A field as people say it: "next action", "column", "metadata key owner". */
export function fieldName(field: string) {
  if (field.startsWith("metadata.")) return `metadata key ${field.slice("metadata.".length)}`;
  return FIELD_NAMES[field] ?? field;
}

/** 'the summary and next action of card "Alpha"', or the card itself when it was deleted or restored. */
export function clashSubject(roadmap: PlanbanRoadmap, cardId: string | undefined, clashes: FieldClash[] | undefined) {
  if (!clashes?.length) return cardSubject(roadmap, cardId);
  const first = clashes[0]!.cardId;
  const card = cardSubject(roadmap, first);
  const fields = clashes.filter((clash) => clash.cardId === first && clash.field !== "*").map((clash) => fieldName(clash.field));
  if (!fields.length) return card;
  const list = fields.length === 1 ? fields[0] : `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}`;
  return `the ${list} of ${card}`;
}
