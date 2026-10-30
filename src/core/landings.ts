// Landing notes and the merge inbox: what an Online Board records by itself when a pull request
// merges in a GitHub repository linked to it (online/service/convex/github.ts receives GitHub's
// webhook and runs these). Pure and browser-safe.
//
// A merge that names a card lands on that card as a dated note, kept apart from the person's
// own text, and the card's freshness says "Landed: needs a wrap-up" until its summary or next
// action is rewritten or it is completed (src/core/staleness.ts). A merge that names no card
// waits in the board's inbox until an agent assigns it to a card or dismisses it.
import { keptProgress, PlanbanNotFoundError, PlanbanValidationError, type PlannedChange } from "./boardOperations";
import { cardPrRefs, prKey, prRefsInText, type PrRef } from "./staleness";
import type { PlanbanHistoryActor, PlanbanLanding, PlanbanRoadmap, PlanbanRoadmapItem } from "./types";

/** Landing notes kept on one card, newest first. */
export const MAX_CARD_LANDINGS = 10;
/** Merges kept in a board's inbox, newest first; the oldest drop off. */
export const MAX_INBOX = 50;
/** A pull request title is cut to this many characters. */
export const MAX_LANDING_TITLE = 200;

/** One merged pull request, as GitHub reports it. */
export interface MergeEvent {
  repo: string;
  number: number;
  title: string;
  mergedAt: string;
  url: string;
}

const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;

/** "owner/name", as a GitHub repository is named. */
export function isRepoName(value: unknown): value is string {
  return typeof value === "string" && REPO_NAME.test(value) && !value.split("/").some((part) => part === "." || part === "..");
}

export const landingKey = (landing: Pick<PlanbanLanding, "repo" | "number">) => prKey(landing.repo, landing.number);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function longDate(iso: string) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}` : iso;
}

/** The note as people and agents read it: "30 Oct 2026: pull request 1412 merged in owner/name: Fix the thing". */
export function landingNote(landing: Pick<PlanbanLanding, "repo" | "number" | "title" | "mergedAt">): string {
  return `${longDate(landing.mergedAt)}: pull request ${landing.number} merged in ${landing.repo}${landing.title ? `: ${landing.title}` : ""}`;
}

/** Whether these references name this merge. A bare `#123` is a pull request in the home repository. */
function namesMerge(refs: PrRef[], merge: Pick<MergeEvent, "repo" | "number">, homeRepo: string | null) {
  const repo = merge.repo.toLowerCase();
  return refs.some((ref) => ref.number === merge.number && (ref.repo ? ref.repo.toLowerCase() === repo : homeRepo?.toLowerCase() === repo));
}

/**
 * The cards that name a merged pull request, in their summary, next action, metadata `prs` list
 * or Spec (the service passes active cards' Specs): `owner/name#123`, its github.com address, or
 * a bare `#123` (or "PR 123") when the repository is the board's home repository. Archived cards
 * are left out.
 */
export function cardsNamingMerge(
  items: PlanbanRoadmapItem[],
  merge: Pick<MergeEvent, "repo" | "number">,
  options: { homeRepo: string | null; specs?: ReadonlyMap<string, string> | undefined },
): string[] {
  return items
    .filter((item) => item.status !== "archived")
    .filter((item) => namesMerge([...cardPrRefs(item), ...prRefsInText(options.specs?.get(item.id))], merge, options.homeRepo))
    .map((item) => item.id);
}

function cleanTitle(title: string) {
  const flat = title.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_LANDING_TITLE ? `${flat.slice(0, MAX_LANDING_TITLE - 1)}…` : flat;
}

/** A merge as stored: a clean title, and when Planban recorded it. */
export function toLanding(merge: MergeEvent, now: string): PlanbanLanding {
  return { repo: merge.repo, number: merge.number, title: cleanTitle(merge.title), mergedAt: merge.mergedAt, url: merge.url, recordedAt: now };
}

function withLanding(item: PlanbanRoadmapItem, landing: PlanbanLanding, now: string): PlanbanRoadmapItem {
  const others = (item.landings ?? []).filter((entry) => landingKey(entry) !== landingKey(landing));
  // The card changed, but noting a merge is not progress: only rewriting the card clears its warning.
  return { ...item, landings: [landing, ...others].slice(0, MAX_CARD_LANDINGS), updatedAt: now, ...keptProgress(item) };
}

const titleList = (items: PlanbanRoadmapItem[]) => items.map((item) => item.title).join(", ");

/**
 * Records a merge: a landing note on every card that names it, or, if none does, an item in the
 * board's inbox. Null when the board already has it, so a repeated delivery changes nothing.
 */
export function planRecordMerge(
  roadmap: PlanbanRoadmap,
  merge: MergeEvent,
  options: { homeRepo: string | null; specs?: ReadonlyMap<string, string> | undefined; now: string },
): PlannedChange | null {
  const landing = toLanding(merge, options.now);
  const key = landingKey(landing);
  const recorded = roadmap.roadmapItems.some((item) => item.landings?.some((entry) => landingKey(entry) === key))
    || roadmap.landingInbox?.some((entry) => landingKey(entry) === key);
  if (recorded) return null;
  const said = `pull request ${landing.number} merged in ${landing.repo}${landing.title ? ` ("${landing.title}")` : ""}`;
  const ids = new Set(cardsNamingMerge(roadmap.roadmapItems, merge, options));
  if (ids.size) {
    const items = roadmap.roadmapItems.map((item) => (ids.has(item.id) ? withLanding(item, landing, options.now) : item));
    return {
      roadmap: { ...roadmap, roadmapItems: items },
      history: { actor: "system", operation: "github.merge.landed", summary: `GitHub: ${said}; noted on ${titleList(items.filter((item) => ids.has(item.id)))}`, affectedCards: [...ids] },
      docWrites: [],
    };
  }
  return {
    roadmap: { ...roadmap, landingInbox: [landing, ...(roadmap.landingInbox ?? [])].slice(0, MAX_INBOX) },
    history: { actor: "system", operation: "github.merge.inbox", summary: `GitHub: ${said}; no card names it, so it waits in the inbox`, affectedCards: [] },
    docWrites: [],
  };
}

export interface ClearLandingInput {
  repo: string;
  number: number;
  /** The card the merge finished: it gets the landing note. Without one, the merge is dismissed. */
  cardId?: string | null | undefined;
  /** Why it is dismissed, in a sentence; optional. */
  reason?: string | undefined;
  actor?: PlanbanHistoryActor | undefined;
}

/** Parses "owner/name#123" (or a github.com pull request address) into a repository and number. */
export function parseLandingRef(value: string): { repo: string; number: number } | null {
  const [ref] = prRefsInText(value.trim());
  return ref?.repo && isRepoName(ref.repo) ? { repo: ref.repo, number: ref.number } : null;
}

/** Takes one merge out of the inbox: onto a card as its landing note, or dismissed. */
export function planClearLanding(roadmap: PlanbanRoadmap, input: ClearLandingInput, ctx: { now: string }): PlannedChange {
  if (!isRepoName(input.repo) || !Number.isInteger(input.number) || input.number < 1) {
    throw new PlanbanValidationError("Name the merge as its repository (owner/name) and pull request number.");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length > 300) throw new PlanbanValidationError("Keep the reason under 300 characters.");
  const key = prKey(input.repo, input.number);
  const landing = roadmap.landingInbox?.find((entry) => landingKey(entry) === key);
  if (!landing) throw new PlanbanNotFoundError(`${input.repo}#${input.number} is not in the inbox; it may already have been assigned or dismissed.`);
  const landingInbox = roadmap.landingInbox!.filter((entry) => entry !== landing);
  const actor = input.actor ?? "agent";
  const said = `pull request ${landing.number} merged in ${landing.repo}`;
  if (input.cardId) {
    const card = roadmap.roadmapItems.find((item) => item.id === input.cardId);
    if (!card) throw new PlanbanNotFoundError(`Card not found: ${input.cardId}`);
    return {
      roadmap: { ...roadmap, landingInbox, roadmapItems: roadmap.roadmapItems.map((item) => (item === card ? withLanding(item, landing, ctx.now) : item)) },
      history: { actor, operation: "github.inbox.assigned", summary: `Assigned ${said} to ${card.title}`, affectedCards: [card.id] },
      docWrites: [],
    };
  }
  return {
    roadmap: { ...roadmap, landingInbox },
    history: { actor, operation: "github.inbox.dismissed", summary: `Dismissed ${said} from the inbox${reason ? `: ${reason}` : ""}`, affectedCards: [] },
    docWrites: [],
  };
}

/** The inbox as agents see it: each merge with its note and the reference to clear it by. */
export function inboxForAgents(inbox: PlanbanLanding[] | undefined) {
  return (inbox ?? []).map((landing) => ({ ref: `${landing.repo}#${landing.number}`, note: landingNote(landing), ...landing }));
}
