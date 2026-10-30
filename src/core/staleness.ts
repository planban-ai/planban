// Stale signals: derived hints that an active card may no longer match reality.
// Pure and browser-safe; the git, history and file inputs are gathered by stalenessSources.ts.
import type { PlanbanHistoryEntry, PlanbanRoadmapItem } from "./types";
import { planbanCommand } from "./command";

export type StalenessKind = "holds-files" | "merged" | "doc-edited" | "quiet" | "large-doc" | "awaiting-owner" | "group-behind";

export interface StalenessSignal {
  kind: StalenessKind;
  detail: string;
  /** ISO time the signal became true: the merge, the doc edit, the last update. */
  since: string;
}

export interface MergeRecord {
  pr: number;
  mergedAt: string;
  /** "owner/name" for another repository; absent for this project's own. */
  repo?: string | undefined;
}

/** A pull request a card names: in this project's own repository (repo null), or another one. */
export interface PrRef {
  repo: string | null;
  number: number;
}

/** One key per pull request, matching a card's reference to a merge. */
export function prKey(repo: string | null | undefined, number: number): string {
  return `${repo ? repo.toLowerCase() : ""}#${number}`;
}

const prName = (repo: string | null | undefined, number: number) => `${repo ?? ""}#${number}`;

export interface DocMtime {
  cardId: string;
  kind: "spec" | "plan";
  mtimeMs: number;
  /** Size on disk, when known, for the large-document warning. */
  bytes?: number | undefined;
}

export interface StalenessInput {
  items: PlanbanRoadmapItem[];
  history: Array<Pick<PlanbanHistoryEntry, "createdAt" | "affectedCards" | "affectedDocs">>;
  docMtimes: DocMtime[];
  merges: MergeRecord[];
  /** Files in each card folder other than its Spec and Plan, for cards that hold any. */
  cardFiles?: Record<string, string[]> | undefined;
  /** Why some signals may be missing, such as GitHub being out of reach. Passed through to readers. */
  notes?: string[] | undefined;
  now: number;
}

export interface BoardStaleness {
  /** Active cards with at least one signal, and any card holding files, most relevant signal first. */
  cards: Record<string, StalenessSignal[]>;
  /** Reported to agents only when In Progress Items exceed the threshold. */
  wip: { count: number; threshold: number } | null;
  /** Why some signals may be missing, such as GitHub being out of reach. */
  notes?: string[] | undefined;
}

export const QUIET_AFTER_DAYS = 5;
export const WIP_THRESHOLD = 12;
/** A Spec or Plan over this size has been appended to rather than rewritten. */
export const LARGE_DOC_BYTES = 100 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
// A Group summary is expected to trail its children a little; flag it only after a day.
const GROUP_BEHIND_SLACK_MS = DAY_MS;
// Tool doc writes land a moment before their history entry.
const DOC_WRITE_SLACK_MS = 2_000;
const ACTIVE_STATUSES = new Set(["in-progress", "up-next"]);
export const isActiveStatus = (status: string) => ACTIVE_STATUSES.has(status);
// Order used for the board chip and for sorting attention lists.
export const STALENESS_KIND_ORDER: StalenessKind[] = ["holds-files", "merged", "doc-edited", "quiet", "group-behind", "large-doc", "awaiting-owner"];
// Kinds an agent can fix by editing the card; awaiting-owner waits on the human instead, and
// holds-files blocks editing until the card's files are moved out.
export const STALE_KINDS = new Set<StalenessKind>(["merged", "doc-edited", "quiet", "group-behind", "large-doc"]);

// The next step is the owner's when Next action starts with "Owner:", the house-style convention.
const AWAITING_OWNER = [/^\s*Owner:/u];

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function keepMin(map: Map<string, number>, key: string, value: number) {
  const current = map.get(key);
  if (current === undefined || value < current) map.set(key, value);
}

function keepMax(map: Map<string, number>, key: string, value: number) {
  const current = map.get(key);
  if (current === undefined || value > current) map.set(key, value);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function kilobytes(bytes: number) {
  return `${Math.round(bytes / 1024)} KB`;
}

/** The warning for a Spec or Plan over LARGE_DOC_BYTES, or null. Also shown when a document is read or written. */
export function largeDocNote(kind: "spec" | "plan", bytes: number): string | null {
  if (bytes <= LARGE_DOC_BYTES) return null;
  return `${kind === "spec" ? "Spec" : "Plan"} is ${kilobytes(bytes)}; rewrite it to the current state, don't append`;
}

// Another repository, named in full: `owner/name#123` or a github.com pull request address.
const QUALIFIED_ADDRESS = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,6})\b/giu;
const QUALIFIED_SHORT = /(?<![\w./-])([\w.-]+\/[\w.-]+)#(\d{1,6})\b/gu;

/**
 * Pull requests named in text. `owner/name#123` and github.com addresses name that repository;
 * `#123`, `PR 123`, `PRs 1, 2 and 3`, `PRs 386–388` and other `/pull/123` addresses name this
 * project's own.
 */
export function prRefsInText(text: string | null | undefined): PrRef[] {
  if (!text) return [];
  const found = new Map<string, PrRef>();
  const add = (repo: string | null, number: number) => found.set(prKey(repo, number), { repo, number });
  let rest = text;
  for (const pattern of [QUALIFIED_ADDRESS, QUALIFIED_SHORT]) {
    for (const match of rest.matchAll(pattern)) add(match[1]!, Number(match[2]));
    rest = rest.replace(pattern, " ");
  }
  for (const match of rest.matchAll(/(?<![\w&])#(\d{1,6})\b/gu)) add(null, Number(match[1]));
  for (const match of rest.matchAll(/\/pull\/(\d{1,6})\b/gu)) add(null, Number(match[1]));
  const list = /\bPRs?\s*#?(\d{1,6})((?:\s*(?:,|\/|&|\+|and|or|–|-|to)\s*#?\d{1,6})*)/giu;
  for (const match of rest.matchAll(list)) {
    let previous = Number(match[1]);
    add(null, previous);
    for (const next of (match[2] ?? "").matchAll(/(–|-|to)?\s*#?(\d{1,6})/gu)) {
      const value = Number(next[2]);
      // Expand short ranges such as "PRs 386–388".
      if (next[1] && value > previous && value - previous <= 50) {
        for (let between = previous + 1; between < value; between += 1) add(null, between);
      }
      add(null, value);
      previous = value;
    }
  }
  return [...found.values()];
}

/** The PR numbers named in text, whichever repository. */
export function prNumbersInText(text: string | null | undefined): number[] {
  return [...new Set(prRefsInText(text).map((ref) => ref.number))];
}

function prRefsInMetadata(metadata: Record<string, unknown> | undefined): PrRef[] {
  const prs = metadata?.prs;
  if (!Array.isArray(prs)) return [];
  return prs.flatMap((entry): PrRef[] => {
    if (typeof entry === "number" && Number.isInteger(entry)) return [{ repo: null, number: entry }];
    if (typeof entry === "string") return /^\d+$/u.test(entry.trim()) ? [{ repo: null, number: Number(entry) }] : prRefsInText(entry);
    return [];
  });
}

/** Every PR a card names, in its summary, next action or metadata `prs` list. */
export function cardPrRefs(item: Pick<PlanbanRoadmapItem, "summary" | "nextAction" | "metadata">): PrRef[] {
  const refs = [...prRefsInText(item.summary), ...prRefsInText(item.nextAction), ...prRefsInMetadata(item.metadata)];
  return [...new Map(refs.map((ref) => [prKey(ref.repo, ref.number), ref])).values()];
}

/** When a card last noted progress; a merge after this is flagged. */
export function progressFloor(item: Pick<PlanbanRoadmapItem, "progressNotedAt" | "updatedAt">): number | null {
  return time(item.progressNotedAt) ?? time(item.updatedAt);
}

/** Parses `git log --format=%cI%x09%s` lines into the earliest merge time per PR. */
export function parseMergeLog(text: string): MergeRecord[] {
  const earliest = new Map<number, number>();
  for (const line of text.split(/\r?\n/u)) {
    const [date, ...rest] = line.split("\t");
    const subject = rest.join("\t");
    const at = time(date?.trim());
    if (at === null || !subject) continue;
    const match = /^Merge pull request #(\d+)\b/u.exec(subject) ?? /\(#(\d+)\)\s*$/u.exec(subject);
    if (!match) continue;
    const pr = Number(match[1]);
    const previous = earliest.get(pr);
    if (previous === undefined || at < previous) earliest.set(pr, at);
  }
  return [...earliest].map(([pr, at]) => ({ pr, mergedAt: new Date(at).toISOString() }));
}

/** The command that tidies a card holding files. */
export function moveFilesOutCommand(cardId: string) {
  return `${planbanCommand()} move-files-out ${cardId} --to <folder>`;
}

// Planban is an index, not storage: a card whose folder holds files refuses changes until they are moved out.
function holdsFilesSignal(item: PlanbanRoadmapItem, files: string[], now: number): StalenessSignal {
  const shown = files.slice(0, 3).join(", ") + (files.length > 3 ? ` and ${files.length - 3} more` : "");
  return {
    kind: "holds-files",
    detail: `Holds ${files.length} file${files.length === 1 ? "" : "s"} in its folder (${shown}); changes are refused until they are moved out with \`${moveFilesOutCommand(item.id)}\``,
    since: item.updatedAt ?? new Date(now).toISOString(),
  };
}

export function computeStaleness(input: StalenessInput): BoardStaleness {
  const mergedAt = new Map(input.merges.map((merge) => [prKey(merge.repo, merge.pr), time(merge.mergedAt)]));
  const firstSeen = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  const lastDocWrite = new Map<string, number>();
  for (const entry of input.history) {
    const at = time(entry.createdAt);
    if (at === null) continue;
    for (const id of entry.affectedCards ?? []) {
      keepMin(firstSeen, id, at);
      keepMax(lastSeen, id, at);
    }
    for (const doc of entry.affectedDocs ?? []) {
      keepMax(lastDocWrite, `${doc.cardId}:${doc.kind}`, at);
    }
  }
  const latestChildUpdate = new Map<string, number>();
  for (const item of input.items) {
    const at = time(item.updatedAt);
    if (!item.parentId || item.status === "archived" || at === null) continue;
    keepMax(latestChildUpdate, item.parentId, at);
  }

  const cards: Record<string, StalenessSignal[]> = {};
  for (const item of input.items) {
    const files = input.cardFiles?.[item.id];
    if (!ACTIVE_STATUSES.has(item.status)) {
      // Any card, whatever its status, refuses changes while it holds files.
      if (files?.length) cards[item.id] = [holdsFilesSignal(item, files, input.now)];
      continue;
    }
    const updatedAt = time(item.updatedAt);
    const signals: StalenessSignal[] = [];
    if (files?.length) signals.push(holdsFilesSignal(item, files, input.now));

    // A referenced PR merged after the card last noted progress (and after it existed). Only a change
    // to its summary or next action, or completing it, notes progress; a touch or a metadata edit doesn't.
    const floor = Math.max(progressFloor(item) ?? -Infinity, firstSeen.get(item.id) ?? -Infinity);
    if (floor > -Infinity) {
      const merged = cardPrRefs(item)
        .map((ref) => ({ ref, at: mergedAt.get(prKey(ref.repo, ref.number)) ?? null }))
        .filter((entry): entry is { ref: PrRef; at: number } => entry.at !== null && entry.at > floor && entry.at <= input.now)
        .sort((left, right) => right.at - left.at);
      if (merged.length) {
        const names = merged.slice(0, 3).map((entry) => prName(entry.ref.repo, entry.ref.number)).join(", ");
        const latest = merged[0]!.at;
        signals.push({ kind: "merged", detail: `${names} merged ${shortDate(latest)}`, since: new Date(latest).toISOString() });
      }
    }

    // Spec or Plan changed on disk after the last Planban write of that document, and the card has
    // not been updated since. Tool doc writes never trigger it; updating the card clears it.
    for (const doc of input.docMtimes) {
      if (doc.cardId !== item.id) continue;
      const lastWrite = lastDocWrite.get(`${doc.cardId}:${doc.kind}`);
      if (lastWrite === undefined || doc.mtimeMs <= lastWrite + DOC_WRITE_SLACK_MS || doc.mtimeMs > input.now) continue;
      if (updatedAt !== null && doc.mtimeMs <= updatedAt) continue;
      signals.push({ kind: "doc-edited", detail: `${doc.kind === "spec" ? "Spec" : "Plan"} edited outside Planban ${shortDate(doc.mtimeMs)}`, since: new Date(doc.mtimeMs).toISOString() });
      break;
    }

    // In Progress with no recorded activity for days.
    const lastActivity = Math.max(updatedAt ?? -Infinity, lastSeen.get(item.id) ?? -Infinity);
    if (item.status === "in-progress" && !item.isGroup && lastActivity > -Infinity && input.now - lastActivity > QUIET_AFTER_DAYS * DAY_MS) {
      const days = Math.floor((input.now - lastActivity) / DAY_MS);
      signals.push({ kind: "quiet", detail: `No update for ${days}d`, since: new Date(lastActivity).toISOString() });
    }

    for (const doc of input.docMtimes) {
      if (doc.cardId !== item.id || doc.bytes === undefined) continue;
      const note = largeDocNote(doc.kind, doc.bytes);
      if (note) signals.push({ kind: "large-doc", detail: note, since: new Date(doc.mtimeMs).toISOString() });
    }

    const childAt = latestChildUpdate.get(item.id);
    if (item.isGroup && childAt !== undefined && updatedAt !== null && childAt - updatedAt > GROUP_BEHIND_SLACK_MS) {
      signals.push({ kind: "group-behind", detail: `Child cards changed after this Group (${shortDate(childAt)})`, since: new Date(childAt).toISOString() });
    }

    if (AWAITING_OWNER.some((pattern) => pattern.test(item.nextAction ?? ""))) {
      signals.push({ kind: "awaiting-owner", detail: "Next action waits on the owner", since: item.updatedAt ?? new Date(input.now).toISOString() });
    }

    if (signals.length) {
      cards[item.id] = signals.sort((left, right) => STALENESS_KIND_ORDER.indexOf(left.kind) - STALENESS_KIND_ORDER.indexOf(right.kind));
    }
  }

  const inProgress = input.items.filter((item) => item.status === "in-progress" && !item.isGroup).length;
  return {
    cards,
    wip: inProgress > WIP_THRESHOLD ? { count: inProgress, threshold: WIP_THRESHOLD } : null,
    ...(input.notes?.length ? { notes: input.notes } : {}),
  };
}

/** Said wherever merged-PR warnings can't be worked out, so their absence is never read as "nothing merged". */
export const MERGES_NOT_CHECKED_NOTE = "Merged-PR warnings aren't checked here, because this view can't see GitHub. Planban on a computer with the GitHub CLI (gh) signed in checks them, for example planban_status or planban_get_board from a coding agent.";

/**
 * Freshness from the board alone, for the hosted web page and the hosted MCP tools, which have no
 * git or GitHub: every signal but "merged" (and "edited outside Planban", which can't happen online),
 * with a note when an active card names a PR.
 */
export function boardOnlyStaleness(items: PlanbanRoadmapItem[], now: number, history: StalenessInput["history"] = []): BoardStaleness {
  const namesPr = items.some((item) => ACTIVE_STATUSES.has(item.status) && cardPrRefs(item).length > 0);
  return computeStaleness({ items, history, docMtimes: [], merges: [], now, notes: namesPr ? [MERGES_NOT_CHECKED_NOTE] : [] });
}

export interface StalenessAttention {
  /** Every active card an agent could fix, most stale first. */
  cards: Array<{ id: string; title: string; status: string; signals: StalenessSignal[] }>;
  total: number;
  awaitingOwner: number;
  /** Cards whose folders hold files, so Planban refuses changes to them until tidied. */
  holdingFiles: { ids: string[]; total: number };
  wip: BoardStaleness["wip"];
  notes?: string[] | undefined;
}

/** How many card ids a one-line summary names before "+N more". */
export const SUMMARY_IDS = 5;

export function stalenessAttention(staleness: BoardStaleness, items: PlanbanRoadmapItem[]): StalenessAttention {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rank = (signals: StalenessSignal[]) => STALENESS_KIND_ORDER.indexOf(signals[0]!.kind);
  const stale = Object.entries(staleness.cards)
    .map(([id, signals]) => ({ id, signals: signals.filter((signal) => STALE_KINDS.has(signal.kind)) }))
    .filter((entry) => entry.signals.length > 0 && byId.has(entry.id))
    .sort((left, right) => rank(left.signals) - rank(right.signals) || left.signals[0]!.since.localeCompare(right.signals[0]!.since));
  return {
    cards: stale.map(({ id, signals }) => {
      const item = byId.get(id)!;
      return { id, title: item.title, status: item.status, signals };
    }),
    total: stale.length,
    awaitingOwner: Object.values(staleness.cards).filter((signals) => signals.some((signal) => signal.kind === "awaiting-owner")).length,
    holdingFiles: (() => {
      const ids = Object.entries(staleness.cards)
        .filter(([id, signals]) => byId.has(id) && signals.some((signal) => signal.kind === "holds-files"))
        .map(([id]) => id);
      return { ids, total: ids.length };
    })(),
    wip: staleness.wip,
    ...(staleness.notes?.length ? { notes: staleness.notes } : {}),
  };
}

/**
 * One short line for agents, or null when nothing needs attention. It names the first few cards;
 * `allListedBy` says where to see every one, such as "planban_get_board".
 */
export function stalenessLine(attention: StalenessAttention, allListedBy?: string): string | null {
  const parts: string[] = [];
  const holding = attention.holdingFiles;
  const more = (total: number) => total > SUMMARY_IDS ? `, +${total - SUMMARY_IDS} more${allListedBy ? `; ${allListedBy} lists them all` : ""}` : "";
  if (holding?.total) {
    const ids = holding.ids.slice(0, SUMMARY_IDS).join(", ");
    parts.push(`${holding.total} card${holding.total === 1 ? " holds" : "s hold"} files in ${holding.total === 1 ? "its folder" : "their folders"} (${ids}${more(holding.total)}). Planban is an index, not file storage, so it refuses changes to ${holding.total === 1 ? "that card" : "those cards"} until the files are moved out with \`${moveFilesOutCommand("<card>")}\`.`);
  }
  if (attention.total > 0) {
    const ids = attention.cards.slice(0, SUMMARY_IDS).map((card) => card.id).join(", ");
    parts.push(`${attention.total} active card${attention.total === 1 ? "" : "s"} look${attention.total === 1 ? "s" : ""} stale (${ids}${more(attention.total)}); fix any you touch.`);
  }
  if (attention.wip) parts.push(`${attention.wip.count} Items are In Progress (over ${attention.wip.threshold}).`);
  // A note only matters beside a warning or a quiet board an agent would otherwise trust.
  for (const note of attention.notes ?? []) parts.push(note);
  return parts.length ? parts.join(" ") : null;
}

/** Short note shown under a card's title on the board. Only signals that need the owner are shown there. */
export function stalenessChipLabel(signal: StalenessSignal): string | null {
  if (signal.kind === "holds-files") return "Holds files";
  return signal.kind === "awaiting-owner" ? "Needs you" : null;
}
