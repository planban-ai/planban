// Editing at the same time (owner decisions, Spec point 20, 15 October 2026).
// An edit states the board revision it read. When the board has moved on, the
// edit is checked field by field against what changed since then: edits that
// don't overlap go through as if made on the current board; a field the edit
// touches that someone else changed since is a clash, refused with the
// details. Positions never clash: a move is applied to the current board,
// after the same neighbour, or at the end of the column if that neighbour
// has moved or gone. Pure functions, shared by the service and local boards.
import { PlanbanValidationError } from "./boardOperations";
import type { PlanbanRoadmap, PlanbanRoadmapItem, PlanbanStatus } from "./types";

/** A card field an edit changes. "metadata.<key>" for one metadata key; "*" for the whole card (deleting or restoring it). */
export type TouchedField = { cardId: string; field: string };

export interface FieldClash {
  cardId: string;
  field: string;
  /** The value when the edit's author read the board. */
  read: unknown;
  /** The value now. */
  current: unknown;
  /** The value the refused edit wanted. */
  yours: unknown;
}

/** The fields people and agents edit; place-only fields (priority, ranks) and timestamps never clash. */
export const CARD_FIELDS = ["title", "summary", "nextAction", "tags", "blockedBy", "status", "parentId", "icon", "isGroup"] as const;

export function fieldValue(card: PlanbanRoadmapItem | undefined, field: string): unknown {
  if (!card) return undefined;
  if (field.startsWith("metadata.")) return card.metadata?.[field.slice("metadata.".length)];
  return (card as unknown as Record<string, unknown>)[field];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function wholeCardChanged(read: PlanbanRoadmapItem | undefined, current: PlanbanRoadmapItem | undefined) {
  if (!read || !current) return read !== current;
  return CARD_FIELDS.some((field) => !same(fieldValue(read, field), fieldValue(current, field))) || !same(read.metadata ?? {}, current.metadata ?? {});
}

type Input = Record<string, unknown>;

/** A metadata edit as a patch against what was read: null (clear all) removes each key that was read. */
function metadataPatch(metadata: unknown, read: Record<string, unknown>): Record<string, unknown> {
  if (metadata === null) return Object.fromEntries(Object.keys(read).map((key) => [key, null]));
  return (metadata ?? {}) as Record<string, unknown>;
}

/** The edit's intended values, by field, so a clash can say what it wanted and a same-value change isn't a clash. */
function intended(op: string, input: Input, read: PlanbanRoadmap): Array<TouchedField & { value: unknown }> | null {
  const cardId = typeof input.cardId === "string" ? input.cardId : "";
  const card = read.roadmapItems.find((item) => item.id === cardId);
  switch (op) {
    case "updateCard": {
      const out: Array<TouchedField & { value: unknown }> = [];
      const text = (value: unknown) => typeof value === "string" ? value.trim() || null : value ?? null;
      if (input.title !== undefined) out.push({ cardId, field: "title", value: typeof input.title === "string" ? input.title.trim() : input.title });
      if (input.summary !== undefined) out.push({ cardId, field: "summary", value: text(input.summary) });
      if (input.nextAction !== undefined) out.push({ cardId, field: "nextAction", value: text(input.nextAction) });
      if (input.tags !== undefined) out.push({ cardId, field: "tags", value: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()).filter(Boolean) : input.tags });
      if (input.blockedBy !== undefined) out.push({ cardId, field: "blockedBy", value: text(input.blockedBy) });
      if (input.metadata !== undefined) {
        // Metadata is a patch; only the keys it changes from what was read are touched.
        const before = card?.metadata ?? {};
        for (const [key, value] of Object.entries(metadataPatch(input.metadata, before))) {
          const after = value === null ? undefined : value;
          if (!same(before[key], after)) out.push({ cardId, field: `metadata.${key}`, value: after });
        }
      }
      return out;
    }
    case "moveCard":
    case "setCardParent": {
      const out: Array<TouchedField & { value: unknown }> = [];
      if (input.status !== undefined) out.push({ cardId, field: "status", value: input.status });
      if (input.parentId !== undefined) out.push({ cardId, field: "parentId", value: input.parentId === null ? null : String(input.parentId).trim() || null });
      return out;
    }
    case "reorderCards": {
      // Only the cards whose column the reorder changes; their order never clashes.
      const items = Array.isArray(input.items) ? input.items as Array<{ id: string; status: PlanbanStatus }> : [];
      const readStatus = new Map(read.roadmapItems.map((item) => [item.id, item.status]));
      return items.filter((item) => readStatus.get(item.id) !== item.status).map((item) => ({ cardId: item.id, field: "status", value: item.status }));
    }
    case "createCard":
    case "createCards":
      return [];
    case "createGroup": {
      // Putting existing cards into the new Group changes their place in the hierarchy.
      const ids = Array.isArray(input.itemIds) ? input.itemIds.map(String) : [];
      return ids.map((id) => ({ cardId: id, field: "parentId", value: "(new Group)" }));
    }
    case "deleteArchivedCard":
    case "restoreCard":
      return [{ cardId, field: "*", value: op === "deleteArchivedCard" ? "(deleted)" : "(restored)" }];
    default:
      // Whole-board operations (restoring the board) still need the current revision.
      return null;
  }
}

export type Rebased =
  | { ok: true; input: Input; touched: TouchedField[] }
  | { ok: false; clashes: FieldClash[]; touched: TouchedField[] }
  | { ok: false; boardWide: true };

/**
 * Checks an edit made against `read` (the board as its author read it) on the
 * `current` board. Returns the input to apply to the current board, or the
 * clashes. A field changed since to exactly the value this edit wants is not a
 * clash: the edit is already covered there.
 */
export function rebaseEdit(op: string, input: Input, read: PlanbanRoadmap, current: PlanbanRoadmap): Rebased {
  const wants = intended(op, input, read);
  if (wants === null) return { ok: false, boardWide: true };
  const readCards = new Map(read.roadmapItems.map((item) => [item.id, item]));
  const currentCards = new Map(current.roadmapItems.map((item) => [item.id, item]));
  const clashes: FieldClash[] = [];
  for (const want of wants) {
    const was = readCards.get(want.cardId);
    const now = currentCards.get(want.cardId);
    if (want.field === "*") {
      if (wholeCardChanged(was, now)) clashes.push({ cardId: want.cardId, field: "*", read: was ?? null, current: now ?? null, yours: want.value });
      continue;
    }
    if (was && !now) {
      clashes.push({ cardId: want.cardId, field: want.field, read: fieldValue(was, want.field) ?? null, current: "(card removed)", yours: want.value ?? null });
      continue;
    }
    const before = fieldValue(was, want.field);
    const after = fieldValue(now, want.field);
    if (!same(before, after) && !same(after, want.value)) clashes.push({ cardId: want.cardId, field: want.field, read: before ?? null, current: after ?? null, yours: want.value ?? null });
  }
  const touched = wants.map(({ cardId, field }) => ({ cardId, field }));
  if (clashes.length) return { ok: false, clashes, touched };
  return { ok: true, input: adaptToCurrent(op, input, read, current), touched };
}

/** The same intent, expressed against the current board. */
function adaptToCurrent(op: string, input: Input, read: PlanbanRoadmap, current: PlanbanRoadmap): Input {
  if (op === "updateCard" && input.metadata !== undefined) {
    // Apply only the keys this edit changed from what was read, onto the metadata as it is now;
    // clearing it (null) removes only the keys that were read, never ones added since.
    const card = read.roadmapItems.find((item) => item.id === input.cardId);
    const before = card?.metadata ?? {};
    const patch = Object.fromEntries(Object.entries(metadataPatch(input.metadata, before))
      .filter(([key, value]) => !same(before[key], value === null ? undefined : value)));
    return { ...input, metadata: patch };
  }
  if (op === "moveCard" || op === "setCardParent") return placeAfterNeighbour(input, current);
  if (op === "reorderCards") return { ...input, items: reorderOnto(input.items as Array<{ id: string; status: PlanbanStatus }>, read, current) };
  return input;
}

/** After the same neighbour if it is still in the target column and Group; otherwise at the end of the column. */
function placeAfterNeighbour(input: Input, current: PlanbanRoadmap): Input {
  if (typeof input.afterId !== "string") return input;
  const card = current.roadmapItems.find((item) => item.id === input.cardId);
  if (!card) return input;
  const status = (input.status as PlanbanStatus | undefined) ?? card.status;
  const parentId = input.parentId === undefined ? card.parentId : input.parentId as string | null;
  const after = current.roadmapItems.find((item) => item.id === input.afterId);
  if (after && after.id !== card.id && after.status === status && after.parentId === parentId) return input;
  const { afterId: _gone, ...rest } = input;
  // No neighbour: the end of the column (a status the card already has places it last).
  return { ...rest, status };
}

/**
 * A reorder lists the whole board in the order its author saw. On the
 * current board: the listed cards keep that order and their columns, cards
 * added since go to the end of their column, and cards removed since are left out.
 */
function reorderOnto(items: Array<{ id: string; status: PlanbanStatus }>, read: PlanbanRoadmap, current: PlanbanRoadmap) {
  if (!Array.isArray(items)) throw new PlanbanValidationError("items must be a list of cards.");
  const readStatus = new Map(read.roadmapItems.map((item) => [item.id, item.status]));
  const currentStatus = new Map(current.roadmapItems.map((item) => [item.id, item.status]));
  // A card whose column this reorder didn't change keeps the column it has now (someone may have moved it since).
  const listed = items.filter((item) => currentStatus.has(item.id))
    .map((item) => readStatus.get(item.id) === item.status ? { id: item.id, status: currentStatus.get(item.id)! } : item);
  const seen = new Set(listed.map((item) => item.id));
  const added = current.roadmapItems.filter((item) => !seen.has(item.id)).map((item) => ({ id: item.id, status: item.status }));
  return [...listed, ...added];
}

/** The card fields an edit touches, read against `roadmap` (null for whole-board operations). */
export function touchedFields(op: string, input: Record<string, unknown>, roadmap: PlanbanRoadmap): TouchedField[] | null {
  return intended(op, input, roadmap)?.map(({ cardId, field }) => ({ cardId, field })) ?? null;
}

/**
 * The fields an edit saves, for settling unresolved changes: like
 * touchedFields, but every metadata key it states counts, even one it sets
 * to the value it already has (a reconsidered "keep theirs").
 */
export function settlingFields(op: string, input: Record<string, unknown>, roadmap: PlanbanRoadmap): TouchedField[] | null {
  const touched = touchedFields(op, input, roadmap);
  if (!touched || op !== "updateCard" || input.metadata === undefined) return touched;
  const cardId = String(input.cardId ?? "");
  const card = roadmap.roadmapItems.find((item) => item.id === cardId);
  const keys = Object.keys(metadataPatch(input.metadata, card?.metadata ?? {}));
  const stated = keys.map((key) => ({ cardId, field: `metadata.${key}` }));
  const seen = new Set(touched.map((entry) => entry.field));
  return [...touched, ...stated.filter((entry) => !seen.has(entry.field))];
}
