// Stale local copies (owner decision 14). When a board is taken online on one
// machine, another machine may still hold an older local copy. The next time
// that copy is used, Planban asks the online services this machine has signed
// in to whether the copy's history matches an Online Board. If it does, the
// copy is marked stale and refuses local writes, offering two ways out:
// attach this project to the online board, or keep the copy as a separate
// local board. Machines that never signed in make no network calls.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PlanbanConflictError, PlanbanValidationError } from "../boardOperations";
import { historyIndexPath } from "../paths";
import { atomicWriteFile } from "../persistence";
import { readBoardIdentity } from "../boardIdentity";
import { onlineRequest } from "./client";
import { readCredentials, type OnlineCredentials } from "./credentials";
import { boardAccount, recordBoardAccount } from "./boardLinks";
import { planbanCommand } from "../command";

export const STALE_MARKER = "STALE-COPY.json";
/**
 * Owner decision 19: the note Take Online leaves in the project's .planban
 * folder (meant to be committed). Any machine that has it knows the board
 * lives online without asking the internet.
 */
export const ONLINE_NOTE = "online-board.json";
export const INDEPENDENT_MARKER = "INDEPENDENT-COPY.json";
const FINGERPRINTS = 50;
const CHECK_TIMEOUT_MS = 2000;
/** A write re-asks the service when the last answer is older than this. */
const RECHECK_MS = 10 * 60 * 1000;

export interface UnsyncedChange {
  version: number;
  createdAt: string;
  summary: string;
}

export interface StaleCopy {
  url: string;
  boardId: string;
  title: string;
  onlineSince: string;
  detectedAt: string;
  /** Changes in this copy that never reached the online board. */
  unsyncedChanges: UnsyncedChange[];
  /** Learned from the project's online note: this machine has not signed in to that service yet. */
  signInNeeded?: boolean;
}

export interface OnlineNote {
  /** What a person reading the file sees first. */
  note: string;
  url: string;
  boardId: string;
  title: string;
  onlineSince: string;
}

export class PlanbanStaleCopyError extends PlanbanConflictError {
  constructor(readonly stale: StaleCopy, cwd: string, _repoId: string) {
    // Wording approved with the board page mockups (owner decision 15).
    const lines = [
      `Not saved. "${stale.title}" now lives online (${stale.boardId} at ${stale.url}); it was taken online on ${stale.onlineSince.slice(0, 10)}.`,
      "The copy on this machine is older and read-only. Nothing has been lost, and nothing was changed.",
      ...(stale.signInNeeded ? [`This machine is not signed in to it yet. Sign in first: ${planbanCommand()} online login ${stale.url}`] : []),
      "Choose one:",
      `  1. Use the online board (recommended): ${planbanCommand()} online attach ${stale.url} ${stale.boardId} --cwd ${cwd} --replace-stale-copy`,
      `  2. Keep this copy as a separate board (this project then uses the online board): ${planbanCommand()} online keep-local-copy --cwd ${cwd} --title "${stale.title} (copy from ${stale.onlineSince.slice(0, 10)})"`,
    ];
    if (stale.unsyncedChanges.length) {
      lines.push(`${stale.unsyncedChanges.length} change(s) on this machine never reached the online board. Both choices keep them:`);
      for (const change of stale.unsyncedChanges.slice(0, 10)) lines.push(`  - v${change.version} ${change.createdAt.slice(0, 16)}: ${change.summary}`);
    }
    lines.push("Agents: do not retry this change, and do not choose for the owner. Ask the owner whether to use the online board or keep this copy as a separate board.");
    super(lines.join("\n"));
    this.name = "PlanbanStaleCopyError";
  }
}

interface CheckResult {
  checkedAt: number;
  stale: StaleCopy | null;
}

const checked = new Map<string, CheckResult>();
const warned = new Set<string>();

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function readStaleMarker(planningRoot: string): Promise<StaleCopy | null> {
  return readJsonFile<StaleCopy>(join(planningRoot, STALE_MARKER));
}

/** Every account signed in here, on each service; none means no network calls. */
async function signedInServices(): Promise<Array<{ url: string; credentials: OnlineCredentials }>> {
  return Object.entries((await readCredentials()).accounts).flatMap(([url, entry]) => Object.values(entry.accounts).map((credentials) => ({ url, credentials })));
}

/** Whether a board can be opened from here: its linked account is signed in, or (unlinked) any account on its service. */
async function signedInFor(url: string, boardId: string) {
  const link = await boardAccount(url, boardId).catch(() => null);
  const entry = (await readCredentials()).accounts[url];
  return link ? !!entry?.accounts[link.person] : !!entry;
}

interface HistoryIndexEntry {
  version: number;
  createdAt: string;
  operation: string;
  summary: string;
}

async function localHistory(planningRoot: string): Promise<HistoryIndexEntry[]> {
  const index = await readJsonFile<{ entries?: HistoryIndexEntry[] }>(historyIndexPath(planningRoot));
  return [...(index?.entries ?? [])].sort((a, b) => b.version - a.version);
}

async function ask(planningRoot: string): Promise<{ stale: StaleCopy | null; unreachable: boolean }> {
  const services = await signedInServices();
  if (services.length === 0) return { stale: null, unreachable: false };
  const history = await localHistory(planningRoot);
  if (history.length === 0) return { stale: null, unreachable: false };
  const ignored = new Set((await readJsonFile<Array<{ url: string; boardId: string }>>(join(planningRoot, INDEPENDENT_MARKER)) ?? [])
    .map((entry) => `${entry.url} ${entry.boardId}`));
  // The newest and the oldest entries: edits made since a copy was taken push
  // shared entries out of the newest, but the oldest ones stay shared.
  const chosen = new Map<number, HistoryIndexEntry>();
  for (const entry of [...history.slice(0, FINGERPRINTS), ...history.slice(-FINGERPRINTS)]) chosen.set(entry.version, entry);
  const fingerprints = [...chosen.values()].map(({ version, createdAt, operation }) => ({ version, createdAt, operation }));
  const uid = await readBoardIdentity(planningRoot);
  let unreachable = false;
  // Asked as each account signed in here: a copy of any of their boards is found.
  for (const { url, credentials } of services) {
    let matches: Array<{ boardId: string; title: string; onlineSince: string; matchedVersions: number[] }>;
    try {
      ({ matches } = await onlineRequest<{ matches: typeof matches }>(url, "/api/v1/copy-check", { fingerprints, ...(uid ? { uid } : {}) }, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), credentials }));
    } catch {
      unreachable = true;
      continue;
    }
    const match = matches.find((candidate) => !ignored.has(`${url} ${candidate.boardId}`));
    if (!match) continue;
    // The account that can see the online board is the one this board uses from now on.
    // A damaged list of links is left for the board to report, never overwritten here.
    if (credentials.person && !(await boardAccount(url, match.boardId).catch(() => true))) {
      await recordBoardAccount(url, match.boardId, { person: credentials.person, ...(credentials.email ? { email: credentials.email } : {}) }).catch(() => undefined);
    }
    const shared = match.matchedVersions.length ? Math.max(...match.matchedVersions) : 0;
    return {
      unreachable,
      stale: {
        url, boardId: match.boardId, title: match.title, onlineSince: match.onlineSince, detectedAt: new Date().toISOString(),
        unsyncedChanges: history.filter((entry) => entry.version > shared).reverse()
          .map(({ version, createdAt, summary }) => ({ version, createdAt, summary })),
      },
    };
  }
  return { stale: null, unreachable };
}

async function refresh(planningRoot: string): Promise<{ stale: StaleCopy | null; unreachable: boolean }> {
  const result = await ask(planningRoot);
  if (result.stale) await atomicWriteFile(join(planningRoot, STALE_MARKER), JSON.stringify(result.stale, null, 2) + "\n");
  if (!result.unreachable) checked.set(planningRoot, { checkedAt: Date.now(), stale: result.stale });
  return result;
}

function noteFile(cwd: string) {
  return join(cwd, ".planban", ONLINE_NOTE);
}

/** The project's online note, or null if it has none; a damaged or incomplete note is an error that says what to do. */
export async function readOnlineNote(cwd: string): Promise<OnlineNote | null> {
  const text = await readFile(noteFile(cwd), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return null;
  let note: Partial<OnlineNote> | null = null;
  try {
    note = JSON.parse(text) as Partial<OnlineNote>;
  } catch {
    note = null;
  }
  const valid = !!note && typeof note.url === "string" && /^https?:\/\/[^\s/]+/i.test(note.url)
    && typeof note.boardId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(note.boardId)
    && typeof note.title === "string" && note.title.length <= 200
    && typeof note.onlineSince === "string" && !Number.isNaN(Date.parse(note.onlineSince));
  if (!valid) {
    throw new PlanbanValidationError(`This project's note ${noteFile(cwd)} says its board lives online, but the note is damaged or incomplete. Restore it from version control, or remove it if the board is not online.`);
  }
  return { note: typeof note!.note === "string" ? note!.note : "", url: note!.url!, boardId: note!.boardId!, title: note!.title!, onlineSince: note!.onlineSince! };
}

/** Written by Take Online (and by switching a project to an online board), for committing alongside the project. */
export async function writeOnlineNote(cwd: string, board: Omit<OnlineNote, "note">) {
  // A title is only for people to recognise the board; it is kept short so the note always reads back.
  const title = board.title.length > 200 ? `${board.title.slice(0, 199)}…` : board.title;
  const note: OnlineNote = {
    note: `This project's Planban board "${title}" lives online at ${board.url} (board ${board.boardId}). Sign in with: ${planbanCommand()} online login ${board.url}`,
    ...board,
    title,
  };
  await atomicWriteFile(noteFile(cwd), JSON.stringify(note, null, 2) + "\n");
  return noteFile(cwd);
}

export async function removeOnlineNote(cwd: string) {
  await rm(noteFile(cwd), { force: true });
}

/**
 * The project's online note says this board lives online: this local copy is
 * older. Known from the file alone, with no network call (owner decision 19).
 */
async function staleFromNote(planningRoot: string, cwd: string, repoId: string): Promise<StaleCopy | null> {
  const note = await readOnlineNote(cwd);
  if (!note || note.boardId !== repoId) return null;
  // This machine's own Take Online is finishing: its copy is not an older one.
  if (await readJsonFile<{ direction?: string }>(join(planningRoot, "online-transfer.json")).then((journal) => journal?.direction === "online")) return null;
  const ignored = (await readJsonFile<Array<{ url: string; boardId: string }>>(join(planningRoot, INDEPENDENT_MARKER)) ?? [])
    .some((entry) => entry.url === note.url && entry.boardId === note.boardId);
  if (ignored) return null;
  const history = await localHistory(planningRoot);
  const stale: StaleCopy = {
    url: note.url, boardId: note.boardId, title: note.title, onlineSince: note.onlineSince, detectedAt: new Date().toISOString(),
    // Without asking the service, changes made here after the board went online are the ones it cannot have.
    unsyncedChanges: history.filter((entry) => entry.createdAt > note.onlineSince).reverse().map(({ version, createdAt, summary }) => ({ version, createdAt, summary })),
    signInNeeded: !(await signedInFor(note.url, note.boardId)),
  };
  await atomicWriteFile(join(planningRoot, STALE_MARKER), JSON.stringify(stale, null, 2) + "\n");
  return stale;
}

/** For showing a board: whether this copy is known to be older, from its marker or the project's online note. No network. */
export async function knownStaleCopy(planningRoot: string, cwd: string, repoId: string): Promise<StaleCopy | null> {
  const marker = await readStaleMarker(planningRoot);
  const stale = marker ?? await staleFromNote(planningRoot, cwd, repoId);
  return stale ? { ...stale, signInNeeded: !(await signedInFor(stale.url, stale.boardId)) } : null;
}

/**
 * Called before every local write. Refuses when this copy is known to be
 * stale (the marker survives going offline). Asks the service at most every
 * ten minutes per board; if it cannot be reached, the write goes ahead with
 * a warning, and any edits made meanwhile are reported once it answers.
 */
export async function assertNotStaleCopy(planningRoot: string, cwd: string, repoId: string): Promise<void> {
  const marker = await readStaleMarker(planningRoot);
  if (marker) {
    const signInNeeded = !(await signedInFor(marker.url, marker.boardId));
    throw new PlanbanStaleCopyError({ ...marker, signInNeeded }, cwd, repoId);
  }
  const noted = await staleFromNote(planningRoot, cwd, repoId);
  if (noted) throw new PlanbanStaleCopyError(noted, cwd, repoId);
  const previous = checked.get(planningRoot);
  if (previous && Date.now() - previous.checkedAt < RECHECK_MS) return;
  // One deadline for the whole check, sign-in refresh included. A check that
  // overruns finishes in the background and is used by the next write.
  const { stale, unreachable } = await Promise.race([
    refresh(planningRoot).catch(() => ({ stale: null, unreachable: true })),
    new Promise<{ stale: null; unreachable: true }>((resolve) => setTimeout(() => resolve({ stale: null, unreachable: true }), CHECK_TIMEOUT_MS).unref()),
  ]);
  if (stale) throw new PlanbanStaleCopyError(stale, cwd, repoId);
  if (unreachable && !warned.has(planningRoot)) {
    warned.add(planningRoot);
    process.stderr.write(`Planban could not reach the online service to check whether this board was taken online elsewhere. Editing the local copy at ${planningRoot}.\n`);
  }
}

/** Called on reads: starts a check in the background so a later write knows sooner. Never delays the read. */
export function checkInBackground(planningRoot: string) {
  if (checked.has(planningRoot)) return;
  checked.set(planningRoot, { checkedAt: 0, stale: null });
  void refresh(planningRoot).catch(() => undefined);
}

/** Checks a set of local boards now, for example right after signing in. */
export async function scanLocalCopies(boards: Array<{ planningRoot: string; repoId: string }>) {
  const found: Array<{ repoId: string; stale: StaleCopy }> = [];
  for (const board of boards) {
    if (await readStaleMarker(board.planningRoot)) continue;
    const { stale } = await refresh(board.planningRoot).catch(() => ({ stale: null }));
    if (stale) found.push({ repoId: board.repoId, stale });
  }
  return found;
}

/** Keep this copy as an independent board: never flag it against that online board again. */
export async function markIndependent(planningRoot: string, stale: StaleCopy) {
  const path = join(planningRoot, INDEPENDENT_MARKER);
  const existing = await readJsonFile<Array<{ url: string; boardId: string; at: string }>>(path) ?? [];
  existing.push({ url: stale.url, boardId: stale.boardId, at: new Date().toISOString() });
  await atomicWriteFile(path, JSON.stringify(existing, null, 2) + "\n");
  await rm(join(planningRoot, STALE_MARKER), { force: true });
  checked.delete(planningRoot);
}

/** For tests: forget cached answers. */
export function resetCopyChecks() {
  checked.clear();
  warned.clear();
}
