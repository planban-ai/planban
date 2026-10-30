import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeRoadmap, PlanbanConflictError, PlanbanNotFoundError, PlanbanValidationError } from "../boardOperations";
import { listHistory } from "../history";
import { agentContextPath, defaultPlanbanRoot, hasLiveRoadmap, RETIRED_ROADMAP, defaultPlanningRoot, detachedBoardCwd, historyCarriedDocsPath, historyDocPath, historyIndexPath, historyRoadmapPath, isPathInsideRoot, manifestPath, resolveInsideRoot, slugify } from "../paths";
import { atomicWriteFile, isAtomicWriteTemp, LOCK_DIR, QUEUE_DIR, withBoardWriteLock } from "../persistence";
import { registerBoardFromState } from "../registry";
import { roadmapSchema } from "../schema";
import { loadState, pathExists, readDoc, readLocalGoals, readManifest, refreshAgentsBlock, resolveProjectCwd, resolvePlanningRoot, saveRoadmap } from "../storage";
import { normalizeGoals } from "../goals";
import type { PlanbanProjectManifest, PlanbanResolvedState } from "../types";
import { loadOnlineState, onlineState } from "./adapter";
import { boardAccount, recordBoardAccount, recordBoardAccountAs, withIdentity } from "./accounts";
import { boardCredentials, boardPath, onlineRequest, requireCredentials } from "./client";
import { markIndependent, readOnlineNote, readStaleMarker, removeOnlineNote, writeOnlineNote, type StaleCopy } from "./copyCheck";
import { readBackup, refreshBackup } from "./backup";
import { chosenAccount, serviceUrl, signedInAs, type OnlineCredentials } from "./credentials";
import { checkBoardIsIndex, machineName, type IndexReport } from "../indexCheck";
import { checkIndexCard, checkIndexDocument, checkIndexValue, embeddedFileIn, MAX_DETAILS_BYTES, withoutEmbeddedFiles, withoutEmbeddedValue } from "../contentRules";
import { buildAgentContext } from "../protocol";
import { ensureBoardIdentity, writeBoardIdentity } from "../boardIdentity";
import { planbanCommand } from "../command";

const historyEntrySchema = z.object({
  version: z.number().int().positive(), roadmapRevision: z.number().int().nonnegative(),
  createdAt: z.string(), actor: z.enum(["user", "agent", "import", "system"]),
  operation: z.string(), summary: z.string(), affectedCards: z.array(z.string()),
  affectedDocs: z.array(z.object({ cardId: z.string(), kind: z.enum(["spec", "plan"]), path: z.string().nullable() })),
}).passthrough();

export const bundleSchema = z.object({
  format: z.literal("planban-board-bundle"), version: z.literal(1), roadmap: roadmapSchema,
  docs: z.array(z.object({ cardId: z.string(), kind: z.enum(["spec", "plan"]), markdown: z.string() })),
  history: z.array(z.object({ entry: historyEntrySchema, roadmap: roadmapSchema })),
  historyDocs: z.array(z.object({ version: z.number().int().positive(), cardId: z.string(), kind: z.enum(["spec", "plan"]), markdown: z.string() })).optional(),
  retiredIds: z.array(z.string()).optional(),
  /** Local history retention settings, so Take Local restores them. */
  retention: z.record(z.string(), z.unknown()).optional(),
  /** The board's durable identity. */
  uid: z.string().optional(),
  /** The board's goals (goals.json), when it has any. */
  goals: z.unknown().optional(),
});
export type BoardBundle = z.infer<typeof bundleSchema>;

/**
 * Upload parts stay well inside one request and inside the service's one
 * second of work per request: every history version is a whole board, which
 * is checked, packed and stored there. Revival's versions are about 800 KB
 * each, so a 4 MB part (about five versions) ran out of time; at 1 MB a
 * version that size travels alone. Exported for the test that keeps it so.
 */
export const PART_BYTES = 1024 * 1024;
const HISTORY_PAGE = 8;
const DOCS_PAGE = 100;

/**
 * Test hook: the crash tests set PLANBAN_TEST_CRASH_AT to a step name to kill
 * this process at that exact point, the way a power cut would.
 */
function crashPoint(name: string) {
  if (process.env.PLANBAN_TEST_CRASH_AT !== name) return;
  // Windows has no kill signals: exit at once with the code a killed process would have.
  if (process.platform === "win32") process.exit(137);
  process.kill(process.pid, "SIGKILL");
}

const journalSchema = z.object({
  version: z.literal(1),
  direction: z.enum(["online", "local"]),
  transferId: z.string(),
  url: z.string(),
  boardId: z.string(),
  /** Take Online: the local revision the upload was built from. */
  localRevision: z.number().optional(),
  /** Take Local: the fresh folder the board is being written into. */
  root: z.string().optional(),
  /** Take Local: the generation the board was frozen at. */
  generation: z.number().optional(),
  /** Take Online, once committed: where the local roadmap is moved, and local changes the upload missed. */
  snapshot: z.string().optional(),
  unsyncedLocalChanges: z.array(z.object({ version: z.number(), createdAt: z.string(), summary: z.string() })).optional(),
  phase: z.enum(["uploading", "committed", "fencing", "fenced", "staged", "published"]),
  startedAt: z.string(),
  /** Take Online: the account that started the upload. Only it can see, finish or cancel that upload. */
  userId: z.string().optional(),
  /** The email of the account that started it, to name it if it has to sign in again. */
  email: z.string().optional(),
  /** Take Online: a fingerprint of everything the upload sends, so a resumed upload sends exactly the same. */
  textDigest: z.string().optional(),
});
type TransferJournal = z.infer<typeof journalSchema>;

/** The journal records an unfinished transfer so the next attempt resumes it safely. */
export function transferJournalPath(planningRoot: string) {
  return join(planningRoot, "online-transfer.json");
}

async function readJournal(planningRoot: string): Promise<TransferJournal | null> {
  try {
    return journalSchema.parse(JSON.parse(await readFile(transferJournalPath(planningRoot), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PlanbanValidationError(`The unfinished transfer record at ${transferJournalPath(planningRoot)} is unreadable. Move it aside and retry.`);
  }
}

async function writeJournal(planningRoot: string, journal: TransferJournal) {
  await atomicWriteFile(transferJournalPath(planningRoot), JSON.stringify(journal, null, 2) + "\n");
}

async function writeJson(path: string, value: unknown) {
  await atomicWriteFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function publishManifest(cwd: string, manifest: PlanbanProjectManifest, state: PlanbanResolvedState) {
  await writeJson(manifestPath(cwd), manifest);
  await atomicWriteFile(agentContextPath(cwd), buildAgentContext({
    repoId: manifest.repoId, planningRoot: state.planningRoot, roadmapPath: state.roadmapPath, manifestPath: state.manifestPath,
    online: manifest.storage?.kind === "online" ? manifest.storage : undefined,
  }));
  // Older projects carry the 1.x wording ("live state lives on this device"); bring it up to date.
  await refreshAgentsBlock(cwd);
  await registerBoardFromState(state);
}

const carriedDocsSchema = z.object({ docs: z.array(z.object({ cardId: z.string(), kind: z.enum(["spec", "plan"]) })) });

async function readCarriedDocs(planningRoot: string, version: number) {
  let raw: string;
  try {
    raw = await readFile(historyCarriedDocsPath(planningRoot, version), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return carriedDocsSchema.parse(JSON.parse(raw)).docs;
}

export async function buildLocalBundle(cwd: string): Promise<BoardBundle> {
  const state = await loadState(cwd);
  if (state.manifest.storage?.kind === "online") throw new PlanbanValidationError("This board is already online. Use online export.");
  const docs: BoardBundle["docs"] = [];
  for (const card of state.roadmap.roadmapItems) {
    for (const kind of ["spec", "plan"] as const) {
      const doc = await readDoc({ cwd, cardId: card.id, kind });
      if (doc.exists) docs.push({ cardId: card.id, kind, markdown: doc.markdown });
    }
  }
  const history = await listHistory(state);
  const historyDocs: NonNullable<BoardBundle["historyDocs"]> = [];
  const versions = await Promise.all(history.entries.map(async (entry) => ({
    entry, roadmap: JSON.parse(await readFile(historyRoadmapPath(state.planningRoot, entry.version), "utf8")),
  })));
  for (const { entry } of versions) {
    // The version's named bodies, plus any that Take Local recorded as carried
    // onto it by online pruning (see historyCarriedDocsPath).
    const refs = new Map<string, { cardId: string; kind: "spec" | "plan" }>();
    for (const doc of [...entry.affectedDocs, ...await readCarriedDocs(state.planningRoot, entry.version)]) refs.set(`${doc.cardId}/${doc.kind}`, { cardId: doc.cardId, kind: doc.kind });
    for (const doc of refs.values()) {
      const path = historyDocPath(state.planningRoot, entry.version, doc.cardId, doc.kind);
      if (await pathExists(path)) historyDocs.push({ version: entry.version, cardId: doc.cardId, kind: doc.kind, markdown: await readFile(path, "utf8") });
    }
  }
  const goals = await readLocalGoals(state.planningRoot, state.roadmap.revision);
  return bundleSchema.parse({ format: "planban-board-bundle", version: 1, roadmap: state.roadmap, docs,
    historyDocs, retention: history.retention, history: versions, ...(goals ? { goals } : {}),
  });
}

interface UploadPart {
  docs?: BoardBundle["docs"];
  history?: BoardBundle["history"];
  historyDocs?: NonNullable<BoardBundle["historyDocs"]>;
}

/** Splits a bundle into parts of bounded size, in a stable order so a resumed upload sends the same parts. */
export function uploadParts(bundle: BoardBundle): UploadPart[] {
  const parts: UploadPart[] = [];
  let current: UploadPart = {};
  let size = 0;
  const add = <K extends keyof UploadPart>(key: K, value: NonNullable<UploadPart[K]>[number]) => {
    const bytes = JSON.stringify(value).length;
    if (size > 0 && size + bytes > PART_BYTES) {
      parts.push(current);
      current = {};
      size = 0;
    }
    ((current[key] ??= []) as unknown[]).push(value);
    size += bytes;
  };
  for (const doc of bundle.docs) add("docs", doc);
  // History versions go before the documents that belong to them.
  const sorted = [...bundle.history].sort((a, b) => a.entry.version - b.entry.version);
  const docsByVersion = new Map<number, NonNullable<BoardBundle["historyDocs"]>>();
  for (const doc of bundle.historyDocs ?? []) docsByVersion.set(doc.version, [...(docsByVersion.get(doc.version) ?? []), doc]);
  for (const version of sorted) {
    add("history", version);
    for (const doc of docsByVersion.get(version.entry.version) ?? []) add("historyDocs", doc);
  }
  if (size > 0 || parts.length === 0) parts.push(current);
  return parts;
}

function historyAfter(bundle: BoardBundle, revision: number) {
  return bundle.history
    .filter(({ entry }) => entry.roadmapRevision > revision)
    .map(({ entry }) => ({ version: entry.version, createdAt: entry.createdAt, summary: entry.summary }));
}

/** Local changes recorded after `revision`, from the board's history index. */
async function localChangesAfter(planningRoot: string, revision: number) {
  const index = await readFile(historyIndexPath(planningRoot), "utf8").then((text) => JSON.parse(text) as { entries?: Array<{ version: number; roadmapRevision: number; createdAt: string; summary: string }> }, () => null);
  return (index?.entries ?? []).filter((entry) => entry.roadmapRevision > revision).sort((a, b) => a.version - b.version)
    .map(({ version, createdAt, summary }) => ({ version, createdAt, summary }));
}

/** Where a move between this machine and the online service has got to, for the board page. */
export interface MoveProgress {
  step: "prepare" | "copy" | "switch" | "files" | "done";
  message: string;
  done?: number;
  total?: number;
}

export interface MoveOptions {
  onProgress?: (progress: MoveProgress) => void;
  /** Take Online as this signed-in account (email); the default account otherwise. */
  account?: string | undefined;
  /** Stops a Take Online before it commits; the board stays on this machine. */
  signal?: AbortSignal;
}

/**
 * Where a board stands after a move stopped part way, read from this
 * machine's files: which copy the project uses and what the unfinished move's
 * record says. The board page explains a failure from this, never assuming.
 */
export async function moveState(cwdInput: string): Promise<{
  location: "local" | "online";
  unfinished: { direction: "online" | "local"; phase: TransferJournal["phase"] } | null;
}> {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled) throw new PlanbanValidationError(`Planban is not initialized in ${cwd}`);
  const journal = await readJournal(resolvePlanningRoot(manifest)).catch(() => null);
  return {
    location: manifest.storage?.kind === "online" ? "online" : "local",
    unfinished: journal ? { direction: journal.direction, phase: journal.phase } : null,
  };
}

/** Whether this board is clean enough to go online, without moving anything. */
export async function previewTakeOnline(cwdInput: string) {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled) throw new PlanbanValidationError(`Planban is not initialized in ${cwd}`);
  if (manifest.storage?.kind === "online") throw new PlanbanValidationError("This board is already online.");
  return indexReport(await buildLocalBundle(cwd), resolvePlanningRoot(manifest));
}

function indexReport(bundle: BoardBundle, planningRoot: string) {
  const { roadmapItems, ...details } = bundle.roadmap;
  return checkBoardIsIndex({ planningRoot, cards: roadmapItems, docs: bundle.docs, details });
}

/** Take Online refused: the board holds files, or pictures stored on this machine, that must be tidied first. */
export class PlanbanNotReadyForOnline extends PlanbanValidationError {
  constructor(readonly report: IndexReport) {
    const lines = [`This board cannot go online yet; nothing has moved. ${report.files ? `${report.files} file(s)` : ""}${report.files && report.pictures ? " and " : ""}${report.pictures ? `${report.pictures} picture(s)` : ""}${report.files || report.pictures ? " are in the way" : "Some cards break the text-only rule"}:`];
    for (const problem of report.boardProblems) lines.push(`- The board itself: ${problem}`);
    for (const card of report.cards.slice(0, 20)) {
      const parts = [
        ...card.files.map((file) => `file ${file}`),
        ...card.pictures.map((picture) => `picture in the ${picture.kind === "plan" ? "Plan" : "Spec"}${picture.alt ? ` (${picture.alt})` : ""}, ${picture.where}`),
        ...card.problems,
      ];
      lines.push(`- ${card.title}: ${parts.slice(0, 8).join("; ")}${parts.length > 8 ? `; and ${parts.length - 8} more` : ""}`);
    }
    if (report.cards.length > 20) lines.push(`- and ${report.cards.length - 20} more card(s)`);
    lines.push("", report.howToTidy, "Then take the board online again.");
    super(lines.join("\n"));
    this.name = "PlanbanNotReadyForOnline";
  }
}

/**
 * History records what was and cannot be tidied: anything embedded in an old
 * version (documents, cards, board details, the entry itself) becomes a note
 * in the online copy. Whatever still would not pass is replaced, field by
 * field, by the note, so a tidy board is never held back by its past. The
 * copy on this machine keeps everything.
 */
function historyForOnline(bundle: BoardBundle): BoardBundle {
  const note = `[file kept in the copy of this board on ${machineName()}]`;
  const passes = (check: () => void) => {
    try {
      check();
      return true;
    } catch {
      return false;
    }
  };
  /** Every string becomes the note except the keys that identify things; lists of numbers and metadata go. */
  const bounded = <T,>(value: T, keep: Set<string>): T => {
    const walk = (entry: unknown, key: string | null): unknown => {
      if (typeof entry === "string") return key !== null && keep.has(key) && entry.length <= 200 && !embeddedFileIn(entry) ? entry : note;
      if (Array.isArray(entry)) return entry.every((item) => typeof item === "number") ? [] : entry.map((item) => walk(item, key));
      if (entry && typeof entry === "object") {
        return Object.fromEntries(Object.entries(entry).filter(([name]) => name !== "metadata" && !embeddedFileIn(name)).map(([name, item]) => [name, walk(item, name)]));
      }
      return entry;
    };
    return walk(value, null) as T;
  };
  const IDS = new Set(["id", "status", "parentId", "cardId", "kind", "path", "actor", "operation", "createdAt", "updatedAt", "completedAt", "affectedCards", "blockedBy", "specDoc", "planDoc"]);
  const seen = new Map<string, unknown>();
  const card = <T extends { id: string }>(item: T): T => {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      const cleaned = withoutEmbeddedValue(item, note);
      seen.set(key, passes(() => checkIndexCard(cleaned)) ? cleaned : bounded(item, IDS));
    }
    return seen.get(key) as T;
  };
  const roadmap = (value: BoardBundle["roadmap"]) => {
    const { roadmapItems, ...details } = value;
    const cleaned = withoutEmbeddedValue(details, note);
    const kept = passes(() => checkIndexValue(cleaned, "details", MAX_DETAILS_BYTES)) ? cleaned : bounded(details, new Set([...IDS, "version", "title"]));
    return { ...kept, roadmapItems: roadmapItems.map(card) } as BoardBundle["roadmap"];
  };
  const entry = (value: BoardBundle["history"][number]["entry"]) => {
    const cleaned = withoutEmbeddedValue(value, note);
    if (passes(() => checkIndexValue(cleaned, "entry", MAX_DETAILS_BYTES))) return cleaned;
    const kept = bounded(value, IDS);
    if (passes(() => checkIndexValue(kept, "entry", MAX_DETAILS_BYTES))) return kept;
    // A change to very many cards at once (1,000 created in one go): its lists keep as
    // many as fit, and the summary says how many more there were.
    const cards = kept.affectedCards ?? [];
    const docs = kept.affectedDocs ?? [];
    for (let room = Math.min(cards.length, 2_000); room >= 0; room = room > 100 ? Math.floor(room / 2) : room - 25) {
      const shown = cards.slice(0, Math.max(room, 0));
      const docsShown = docs.filter((doc) => shown.includes(doc.cardId));
      const left = cards.length - shown.length;
      const trimmed = { ...kept, affectedCards: shown, affectedDocs: docsShown, summary: `${String(kept.summary).slice(0, 200)}${left ? ` (and ${left} more cards)` : ""}` };
      if (passes(() => checkIndexValue(trimmed, "entry", MAX_DETAILS_BYTES))) return trimmed;
      if (room <= 0) break;
    }
    return { ...kept, affectedCards: [], affectedDocs: [], summary: `${String(kept.summary).slice(0, 200)} (${cards.length} cards)` };
  };
  const document = (markdown: string, cardId: string, kind: string) => {
    const cleaned = withoutEmbeddedFiles(markdown, note);
    return passes(() => checkIndexDocument(cleaned, cardId, kind)) ? cleaned : `${note}\n`;
  };
  return {
    ...bundle,
    historyDocs: (bundle.historyDocs ?? []).map((doc) => ({ ...doc, markdown: document(doc.markdown, doc.cardId, doc.kind) })),
    history: bundle.history.map((version) => ({ entry: entry(version.entry), roadmap: roadmap(version.roadmap) })),
  };
}

/** Thrown before anything changes when going ahead needs the person's say-so. Carries what they are agreeing to. */
export class PlanbanConfirmationNeeded extends PlanbanValidationError {
  constructor(message: string, readonly summary: unknown) {
    super(message);
    this.name = "PlanbanConfirmationNeeded";
  }
}

/**
 * Take Online. Survives being killed at any point: a journal in the board's
 * folder records the upload, every step is idempotent under one transfer id,
 * and the board only becomes live online at commit. Running it again resumes,
 * including after the upload committed but before this project switched.
 * While it runs, the board can still be read and its changes wait for the
 * board's write lock; once it switches, a change that was waiting goes to
 * the online board instead (againIfMoved), and Planban 1.x is shut out of
 * the copy left here (RETIRED_ROADMAP). If it fails before the online board is committed, the
 * half-copied online version is removed and the board stays on this machine
 * unchanged (owner decision 15).
 */
export async function takeOnline(urlInput: string, cwdInput: string, options: MoveOptions = {}) {
  const url = serviceUrl(urlInput);
  // The account this move runs as, for every request it makes; the board is linked to it.
  let pinned = await withIdentity(url, options.account ? await chosenAccount(url, options.account) : await requireCredentials(url));
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled) throw new PlanbanValidationError(`Planban is not initialized in ${cwd}`);
  if (manifest.storage?.kind === "online") throw new PlanbanValidationError("This board is already online.");
  const planningRoot = resolvePlanningRoot(manifest);
  const boardId = manifest.repoId;
  return withBoardWriteLock(planningRoot, async () => {
    // A Take Local that switched this project but could not tell the service yet.
    await finishLocalTransfer(planningRoot);
    let journal = await readJournal(planningRoot);
    if (journal && (journal.direction !== "online" || journal.url !== url || journal.boardId !== boardId)) {
      throw new PlanbanValidationError(`An unfinished transfer of this board to ${journal.url} is recorded at ${transferJournalPath(planningRoot)}. Finish it first.`);
    }
    if (journal?.phase !== "committed") {
      // Only a clean board goes online (owner decisions 18 and 20): nothing
      // moves until it is tidy, including when resuming an interrupted move.
      const report = await indexReport(await buildLocalBundle(cwd), planningRoot);
      if (!report.clean) throw new PlanbanNotReadyForOnline(report);
    }
    // Resuming continues as the account that started the upload, and only as it.
    if (journal?.userId && journal.userId !== pinned.person) {
      const starter = await signedInAs(url, journal.userId);
      if (!starter) throw new PlanbanValidationError(otherAccountMessage(journal));
      pinned = starter;
    }
    if (journal?.phase !== "committed") {
      try {
        journal = await uploadBoard(url, cwd, planningRoot, boardId, journal, { ...options, credentials: pinned });
      } catch (error) {
        throw await abandonUpload(url, planningRoot, error);
      }
    }
    options.onProgress?.({ step: "switch", message: "Switching this project to the online board" });
    const result = await finishTakeOnline(cwd, manifest, planningRoot, journal!, pinned);
    options.onProgress?.({ step: "done", message: "The board is online" });
    return result;
  });
}

/** A Take Online stopped on request before it committed. */
export class PlanbanTakeOnlineStopped extends PlanbanValidationError {
  constructor() {
    super("Take Online stopped. The board is on this machine, unchanged, and the partly copied online version was removed.");
    this.name = "PlanbanTakeOnlineStopped";
  }
}

type CancelOutcome = "removed" | "committed" | "other-account" | "uncertain";

/**
 * Cancels an unfinished upload on the service. "removed" only when the
 * service confirms the upload is gone (or never began) for the account that
 * started it; anything less certain keeps the journal for a later attempt.
 */
async function cancelUpload(url: string, journal: TransferJournal): Promise<CancelOutcome> {
  // One account for both questions: a sign-in in between must not change who asks.
  let credentials: Awaited<ReturnType<typeof requireCredentials>>;
  let me: { userId: string };
  try {
    // The account that started the upload, if it is signed in here; otherwise the default (which then can't cancel it).
    credentials = (await signedInAs(url, journal.userId)) ?? await requireCredentials(url);
    me = await onlineRequest<{ userId: string }>(url, "/api/v1/me", undefined, { credentials });
  } catch {
    return "uncertain";
  }
  if (journal.userId && journal.userId !== me.userId) return "other-account";
  return onlineRequest(url, `/api/v1/transfers/${encodeURIComponent(journal.transferId)}/abort`, {}, { credentials }).then(
    () => "removed" as const,
    (error) => error instanceof PlanbanConflictError ? "committed" as const
      // Not found means gone only when the same account asks: another account's upload is invisible to it.
      : error instanceof PlanbanNotFoundError && journal.userId ? "removed" as const
      : "uncertain" as const,
  );
}

const otherAccountMessage = (journal: TransferJournal) =>
  `This board's move online was started while signed in to ${journal.url} as ${journal.email ?? `another account (${journal.userId})`}, which isn't signed in here now. Sign in as that account to finish or stop it: ${planbanCommand()} online sign-in ${journal.url}. Nothing has been changed.`;

/**
 * After a failed upload: cancel it on the service, which removes the
 * half-copied online version, and forget it here, so the board stays on this
 * machine as it was. If that cannot be confirmed, the record is kept so the
 * next attempt (or stop-take-online) can finish the job.
 */
async function abandonUpload(url: string, planningRoot: string, error: unknown): Promise<Error> {
  const journal = await readJournal(planningRoot);
  const reason = error instanceof Error ? error.message : String(error);
  if (!journal || journal.direction !== "online" || journal.phase !== "uploading") return error instanceof Error ? error : new Error(reason);
  const outcome = await cancelUpload(url, journal);
  const stopped = error instanceof DOMException && error.name === "AbortError";
  if (outcome === "removed") {
    await rm(transferJournalPath(planningRoot), { force: true });
    if (stopped) return new PlanbanTakeOnlineStopped();
    return new PlanbanValidationError(`Taking the board online failed: ${reason}. The board is still on this machine, unchanged, and the partly copied online version was removed. Try again when ready.`);
  }
  if (outcome === "committed") return new PlanbanValidationError(`The board reached the online service before this error (${reason}). Run take-online again to finish switching this project to it.`);
  if (outcome === "other-account") return new PlanbanValidationError(otherAccountMessage(journal));
  return new PlanbanValidationError(`Taking the board online failed: ${reason}. The board is still on this machine, unchanged. The partly copied online version could not be removed yet; run take-online again to resume, or ${planbanCommand()} online stop-take-online to cancel it.`);
}

/**
 * Stops an unfinished Take Online: the partly copied online version is
 * removed and the board stays on this machine. A move that already reached
 * the service cannot be stopped; take-online finishes it.
 */
export async function stopTakeOnline(cwdInput: string) {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled) throw new PlanbanValidationError(`Planban is not initialized in ${cwd}`);
  if (manifest.storage?.kind === "online") throw new PlanbanValidationError("This board is already online. Use take-local to bring it back.");
  const planningRoot = resolvePlanningRoot(manifest);
  return withBoardWriteLock(planningRoot, async () => {
    const journal = await readJournal(planningRoot);
    if (!journal || journal.direction !== "online") return { stopped: false, message: "No Take Online is in progress for this board." };
    if (journal.phase !== "uploading") throw new PlanbanValidationError("This board already reached the online service. Run take-online again to finish switching to it.");
    const outcome = await cancelUpload(journal.url, journal);
    if (outcome === "committed") throw new PlanbanValidationError("This board already reached the online service. Run take-online again to finish switching to it.");
    if (outcome === "other-account") throw new PlanbanValidationError(otherAccountMessage(journal));
    if (outcome === "uncertain") throw new PlanbanValidationError("Planban could not confirm with the online service that the partly copied board was removed. Nothing has changed; try again when online.");
    await rm(transferJournalPath(planningRoot), { force: true });
    return { stopped: true, message: "Take Online stopped. The board is on this machine, unchanged, and the partly copied online version was removed." };
  });
}

/** Uploads the board under a transfer journal, ending committed. Resumable. */
async function uploadBoard(url: string, cwd: string, planningRoot: string, boardId: string, journal: TransferJournal | null, options: MoveOptions & { credentials: OnlineCredentials }): Promise<TransferJournal> {
  const as = { credentials: options.credentials };
  options.onProgress?.({ step: "prepare", message: "Preparing the board" });
  // History cannot be tidied, so anything embedded in an old version is noted instead.
  const bundle = historyForOnline(await buildLocalBundle(cwd));
  bundle.roadmap.project.id = boardId;
  // Resuming continues part by part, so it must send exactly the same upload:
  // the fingerprint covers what begins the upload and every part. Anything
  // different, or an older record without a fingerprint, starts it again.
  const textDigest = createHash("sha256").update(JSON.stringify({
    roadmap: bundle.roadmap, retiredIds: bundle.retiredIds ?? [], retention: bundle.retention ?? null, parts: uploadParts(bundle),
    ...(bundle.goals ? { goals: bundle.goals } : {}),
  })).digest("hex");
  if (journal?.phase === "uploading" && (journal.localRevision !== bundle.roadmap.revision || journal.textDigest !== textDigest)) {
    // The board changed locally since the interrupted upload: cancel it and
    // upload the current board. If the service says that upload already
    // finished, the board is online: finish switching and report the
    // local changes since then.
    // The journal is replaced only once the service confirms the old upload is gone.
    const outcome = await cancelUpload(url, journal);
    if (outcome === "removed") journal = null;
    else if (outcome === "other-account") throw new PlanbanValidationError(otherAccountMessage(journal));
    else if (outcome === "uncertain") throw new PlanbanValidationError("Planban could not reach the online service to replace an earlier unfinished upload of this board. Nothing has changed; try again when online.");
  }
  if (!journal) {
    const me = await onlineRequest<{ userId: string; person?: { email?: string } }>(url, "/api/v1/me", undefined, as);
    const email = me.person?.email ?? as.credentials?.email;
    journal = { version: 1, direction: "online", transferId: randomUUID(), url, boardId, localRevision: bundle.roadmap.revision, phase: "uploading", startedAt: new Date().toISOString(), userId: me.userId, ...(email ? { email } : {}), textDigest };
    await writeJournal(planningRoot, journal);
  }
  crashPoint("take-online:after-journal");
  const uid = await ensureBoardIdentity(planningRoot);
  const begun = await onlineRequest<{ state: string; receivedParts: number[] }>(url, "/api/v1/transfers", {
    transferId: journal.transferId, roadmap: bundle.roadmap, retiredIds: bundle.retiredIds ?? [], uid,
    ...(bundle.retention ? { retention: bundle.retention } : {}),
    ...(bundle.goals ? { goals: bundle.goals } : {}),
  }, as);
  if (begun.state !== "committed") {
    const parts = uploadParts(bundle);
    const received = new Set(begun.receivedParts);
    const copying = (done: number) => options.onProgress?.({ step: "copy", message: `Copying cards, documents and history (${bundle.roadmap.roadmapItems.length} cards, ${bundle.history.length} versions)`, done, total: parts.length });
    copying(received.size);
    for (const [seq, part] of parts.entries()) {
      if (received.has(seq)) continue;
      options.signal?.throwIfAborted();
      await onlineRequest(url, `/api/v1/transfers/${encodeURIComponent(journal.transferId)}/parts`, { seq, ...part }, as);
      crashPoint("take-online:after-part");
      received.add(seq);
      copying(received.size);
    }
    options.signal?.throwIfAborted();
    await onlineRequest(url, `/api/v1/transfers/${encodeURIComponent(journal.transferId)}/commit`, { partCount: parts.length }, as);
  }
  crashPoint("take-online:after-commit");
  journal = {
    ...journal, phase: "committed",
    snapshot: join(planningRoot, `roadmap.local-before-online-${Date.now()}.json`),
    // Edits made locally after an upload that had already committed are not online.
    unsyncedLocalChanges: journal.localRevision === undefined ? [] : historyAfter(bundle, journal.localRevision),
  };
  await writeJournal(planningRoot, journal);
  return journal;
}

/** Switches the project to the online board once the upload has committed. Safe to repeat. */
async function finishTakeOnline(cwd: string, manifest: PlanbanProjectManifest, planningRoot: string, journal: TransferJournal, pinned: OnlineCredentials) {
  const { url, boardId } = journal;
  const snapshot = journal.snapshot!;
  let unsyncedLocalChanges = journal.unsyncedLocalChanges ?? [];
  const live = join(planningRoot, "roadmap.json");
  // On a retry the marker below may already be there; it is never mistaken for the board.
  if (await hasLiveRoadmap(planningRoot)) {
    // Still here after a crash: count any local edits made since the upload.
    if (journal.localRevision !== undefined) unsyncedLocalChanges = await localChangesAfter(planningRoot, journal.localRevision);
    // Retain every local byte, but remove the live filename so other checkouts
    // with an old local manifest cannot continue editing the uploaded board.
    await rename(live, snapshot);
  }
  crashPoint("take-online:after-rename");
  await atomicWriteFile(join(planningRoot, "ONLINE-BOARD.txt"), `Authority moved to ${url}, board ${boardId}.\nThe roadmap snapshot, documents and history here are recovery evidence. Do not edit them.\n`);
  // Agents still running Planban 1.x read and write roadmap.json directly, and
  // its `init` would put a fresh, empty board where none is. This marker makes
  // each of them fail, saying to restart for Planban 2.0, and Planban 2.0 in
  // another checkout still pointing here says the board moved online.
  await atomicWriteFile(live, RETIRED_ROADMAP);
  crashPoint("take-online:after-retire");
  // Linked first, so every request for the board (this one included) uses the account that took it online.
  await recordBoardAccountAs(url, boardId, pinned).catch(() => undefined);
  const roadmap = (await onlineRequest<{ roadmap: PlanbanResolvedState["roadmap"] }>(url, boardPath(boardId), undefined, { credentials: pinned })).roadmap;
  const onlineManifest: PlanbanProjectManifest = { ...manifest, storage: { kind: "online", url, boardId } };
  // The note is written before the project switches, while the record of the
  // move still exists, so a retry after any crash writes it again.
  const onlineNote = await leaveOnlineNote(cwd, { url, boardId, title: roadmap.project.title, onlineSince: new Date().toISOString() });
  crashPoint("take-online:after-note");
  await publishManifest(cwd, onlineManifest, onlineState(cwd, onlineManifest, roadmap));
  crashPoint("take-online:after-publish");
  await rm(transferJournalPath(planningRoot), { force: true });
  await refreshBackup(url, boardId, { force: true });
  // Which account this board went online under, kept on this computer only.
  await recordBoardAccountAs(url, boardId, pinned).catch(() => undefined);
  return { boardId, url, localSnapshot: snapshot, onlineNote, ...(unsyncedLocalChanges.length ? { unsyncedLocalChanges } : {}) };
}

/** The project folder's git repository, if it has one. */
async function gitRoot(cwd: string): Promise<string | null> {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (await pathExists(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Owner decision 19: a note in the project's .planban folder that the board
 * lives online. Planban never commits it; it says how, so the person can.
 */
async function leaveOnlineNote(cwd: string, board: { url: string; boardId: string; title: string; onlineSince: string }) {
  const path = await writeOnlineNote(cwd, board);
  const repo = await gitRoot(cwd);
  const file = repo ? relative(repo, path).split(sep).join("/") : path;
  return {
    path,
    commit: repo
      ? `Commit ${file} so your other machines know this board is online, even before they sign in: git -C "${repo}" add "${file}" && git -C "${repo}" commit -m "Planban board is now online"`
      : null,
  };
}

async function requireOnline(cwdInput: string) {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled || manifest.storage?.kind !== "online") throw new PlanbanValidationError("This project does not point to an Online Board.");
  return { cwd, manifest, storage: manifest.storage };
}

/** Downloads a board page by page; large boards do not fit in one response. */
export async function exportOnline(cwd: string, out?: string, transferId?: string): Promise<BoardBundle> {
  const { storage } = await requireOnline(cwd);
  const base = boardPath(storage.boardId, "/export");
  // During Take Local, every page must come from the generation that was frozen.
  const bound = transferId ? `&transferId=${encodeURIComponent(transferId)}` : "";
  const meta = await onlineRequest<{ roadmap: unknown; retiredIds: string[]; retention?: Record<string, unknown>; uid?: string; goals?: unknown }>(storage.url, `${base}/meta${transferId ? `?transferId=${encodeURIComponent(transferId)}` : ""}`);
  const docs: BoardBundle["docs"] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page: { docs: BoardBundle["docs"]; nextOffset: number | null } = await onlineRequest(storage.url, `${base}/docs?offset=${offset}&limit=${DOCS_PAGE}${bound}`);
    docs.push(...page.docs);
    offset = page.nextOffset;
  }
  const history: BoardBundle["history"] = [];
  const historyDocs: NonNullable<BoardBundle["historyDocs"]> = [];
  type HistoryPage = { history: BoardBundle["history"]; historyDocs: NonNullable<BoardBundle["historyDocs"]>; moreDocs?: { version: number; cursor: string } };
  for (let after = 0; ;) {
    const page: HistoryPage = await onlineRequest(storage.url, `${base}/history?after=${after}&limit=${HISTORY_PAGE}${bound}`);
    if (page.history.length === 0) break;
    history.push(...page.history);
    historyDocs.push(...page.historyDocs);
    // A version with more documents than one response holds continues on its own pages.
    for (let more = page.moreDocs; more;) {
      const cursor = more.cursor ? `&docsCursor=${encodeURIComponent(more.cursor)}` : "";
      const rest: HistoryPage = await onlineRequest(storage.url, `${base}/history?after=${after}&limit=${HISTORY_PAGE}&docsOf=${more.version}${cursor}${bound}`);
      historyDocs.push(...rest.historyDocs);
      more = rest.moreDocs;
    }
    after = page.history.at(-1)!.entry.version;
    crashPoint("take-local:mid-download");
  }
  const bundle = bundleSchema.parse({
    format: "planban-board-bundle", version: 1, roadmap: meta.roadmap, docs, history, historyDocs, retiredIds: meta.retiredIds,
    ...(meta.retention ? { retention: meta.retention } : {}), ...(meta.uid ? { uid: meta.uid } : {}),
    ...(meta.goals ? { goals: meta.goals } : {}),
  });
  if (out) await writeJson(resolve(out), bundle);
  return bundle;
}

async function stageBundle(root: string, bundle: BoardBundle) {
  const roadmap = normalizeRoadmap(bundle.roadmap);
  const docKeys = new Set<string>();
  const paths = new Set<string>();
  for (const doc of bundle.docs) {
    const item = roadmap.roadmapItems.find((item) => item.id === doc.cardId);
    if (!item) throw new PlanbanValidationError(`Export contains a document for an unknown card: ${doc.cardId}`);
    const key = `${doc.cardId}/${doc.kind}`;
    if (docKeys.has(key)) throw new PlanbanValidationError(`Export contains a duplicate document: ${key}`);
    docKeys.add(key);
    const configured = doc.kind === "spec" ? item.specDoc : item.planDoc;
    if (!configured) throw new PlanbanValidationError(`Export document has no roadmap reference: ${key}`);
    const destination = resolveInsideRoot(root, configured);
    const protectedPaths = [join(root, "roadmap.json"), join(root, "goals.json"), join(root, "goals.next.json"), join(root, "history"), join(root, ".planban-write.lock"), join(root, ".planban-write.queue")];
    if (protectedPaths.some((path) => destination === path || destination.startsWith(path + sep)) || paths.has(destination)) {
      throw new PlanbanValidationError(`Export contains a conflicting document path: ${configured}`);
    }
    paths.add(destination);
    await atomicWriteFile(destination, doc.markdown);
  }
  const versions = new Set<number>();
  for (const version of bundle.history) {
    if (versions.has(version.entry.version)) throw new PlanbanValidationError("Export contains duplicate history versions.");
    versions.add(version.entry.version);
    await writeJson(historyRoadmapPath(root, version.entry.version), version.roadmap);
  }
  const historyPaths = new Set<string>();
  const named = new Set(bundle.history.flatMap(({ entry }) => entry.affectedDocs.map((ref) => `${entry.version}/${ref.cardId}/${ref.kind}`)));
  const carried = new Map<number, Array<{ cardId: string; kind: "spec" | "plan" }>>();
  for (const doc of bundle.historyDocs ?? []) {
    if (!versions.has(doc.version)) throw new PlanbanValidationError("Export contains a document for an unknown history version.");
    const path = historyDocPath(root, doc.version, doc.cardId, doc.kind);
    if (historyPaths.has(path)) throw new PlanbanValidationError("Export contains conflicting historical document paths.");
    historyPaths.add(path);
    await atomicWriteFile(path, doc.markdown);
    if (!named.has(`${doc.version}/${doc.cardId}/${doc.kind}`)) carried.set(doc.version, [...(carried.get(doc.version) ?? []), { cardId: doc.cardId, kind: doc.kind }]);
  }
  // Bodies online pruning carried onto a version without naming them keep
  // their identity, so a later Take Online sends them back.
  for (const [version, docs] of carried) await writeJson(historyCarriedDocsPath(root, version), { docs });
  await writeJson(historyIndexPath(root), { version: 1, latestVersion: Math.max(0, ...versions),
    retention: { boardVersions: 100, cardVersions: 25, documentVersions: 25, hourlyDays: 2, maxAgeDays: 90, ...(bundle.retention ?? {}) },
    entries: bundle.history.map(({ entry }) => entry).sort((a, b) => a.version - b.version),
  });
  if (bundle.uid) await writeBoardIdentity(root, bundle.uid);
  if (bundle.goals) await writeJson(join(root, "goals.json"), normalizeGoals(bundle.goals));
  await writeJson(join(root, "roadmap.json"), roadmap);
  return roadmap;
}

/**
 * After Take Local switched a project to its new local folder, tells the
 * service the transfer finished so the board may be taken online again.
 * Safe to repeat; a no-op when nothing is pending.
 */
export async function finishLocalTransfer(planningRoot: string) {
  const journal = await readJournal(planningRoot);
  if (!journal || journal.direction !== "local" || journal.phase !== "published") return;
  await onlineRequest(journal.url, boardPath(journal.boardId, "/take-local/finish"), { transferId: journal.transferId });
  await rm(transferJournalPath(planningRoot), { force: true });
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && b.every((id) => a.includes(id));

function confirmRemoving(others: Array<{ userId: string; role: string }>) {
  return new PlanbanConfirmationNeeded(
    `Taking this board back to this machine removes access for ${others.length} other person(s), and their agents: ${others.map((member) => `${member.userId} (${member.role})`).join(", ")}. `
    + "The online copy is kept, read-only. Nothing has changed yet. Run again with --remove-others to go ahead.",
    { removes: others },
  );
}

/** Everyone on an Online Board except the caller (the board's own account here): who would lose access if it were taken local. */
export async function othersOnBoard(url: string, boardId: string) {
  const credentials = await boardCredentials(url, boardId);
  const [{ members }, me] = await Promise.all([
    onlineRequest<{ members: Array<{ userId: string; role: string }> }>(url, boardPath(boardId, "/members"), undefined, { credentials }),
    onlineRequest<{ userId: string }>(url, "/api/v1/me", undefined, { credentials }),
  ]);
  return members.filter((member) => member.userId !== me.userId);
}

/**
 * Take Local. The online board is frozen first, for this transfer only, so
 * no edit can land after the download and every page comes from the frozen
 * board. The board is written into a fresh local folder, the service is told
 * the transfer finished, and only then does the project switch to the local
 * copy. Killed at any point, running it again resumes from the journal; the
 * online board stays intact and read-only meanwhile.
 */
export async function takeLocal(cwdInput: string, options: {
  /** Confirms removing everyone else on the board now (command line). */
  removeOthers?: boolean;
  /** Confirms removing exactly these people (the board page); anyone else on the board asks again. */
  expectedOthers?: string[];
} & Pick<MoveOptions, "onProgress"> = {}) {
  const { cwd, manifest, storage } = await requireOnline(cwdInput);
  const lockRoot = resolvePlanningRoot(manifest);
  await mkdir(lockRoot, { recursive: true });
  return withBoardWriteLock(lockRoot, async () => {
    const current = await requireOnline(cwd);
    if (current.storage.url !== storage.url || current.storage.boardId !== storage.boardId) {
      throw new PlanbanValidationError("Board authority changed while waiting. Reload before taking it local.");
    }
    let journal = await readJournal(lockRoot);
    if (journal && (journal.direction !== "local" || journal.url !== storage.url || journal.boardId !== storage.boardId)) {
      throw new PlanbanValidationError(`An unfinished transfer is recorded at ${transferJournalPath(lockRoot)}. Finish it first.`);
    }
    if (!journal) {
      journal = { version: 1, direction: "local", transferId: randomUUID(), url: storage.url, boardId: storage.boardId,
        root: join(defaultPlanbanRoot(), "repos", `online-return-${randomUUID()}`), phase: "fencing", startedAt: new Date().toISOString() };
    }
    const root = journal.root!;
    const step = async (next: TransferJournal) => {
      journal = next;
      await writeJournal(lockRoot, next);
    };
    let acknowledgedOthers: string[] = [];
    if (journal.phase === "fencing") {
      // Owner decision 15: taking a shared board back to this machine removes
      // everyone else's access, and their agents'. Say who first; the freeze
      // itself refuses if the people on the board are not exactly those.
      const others = await othersOnBoard(storage.url, storage.boardId);
      acknowledgedOthers = options.expectedOthers ?? (options.removeOthers ? others.map((member) => member.userId) : []);
      if (!sameSet(acknowledgedOthers, others.map((member) => member.userId))) throw confirmRemoving(others);
      await writeJournal(lockRoot, journal);
    }
    crashPoint("take-local:before-fence");
    if (journal.phase === "fencing" || journal.phase === "fenced") {
      const fenced = await onlineRequest<{ generation: number }>(storage.url, boardPath(storage.boardId, "/take-local/fence"), {
        transferId: journal.transferId, acknowledgedOthers, ...(journal.generation === undefined ? {} : { expectedGeneration: journal.generation }),
      }).catch(async (error) => {
        // Someone joined or left between asking and freezing: nothing was frozen; ask again.
        if (error instanceof PlanbanConflictError && /people on this board changed/i.test(error.message)) {
          await rm(transferJournalPath(lockRoot), { force: true });
          throw confirmRemoving(await othersOnBoard(storage.url, storage.boardId));
        }
        throw error;
      });
      if (journal.phase === "fencing") await step({ ...journal, phase: "fenced", generation: fenced.generation });
      crashPoint("take-local:after-fence");
      options.onProgress?.({ step: "copy", message: "Copying the online board, its documents and history to this machine" });
      const bundle = await exportOnline(cwd, undefined, journal.transferId);
      // The folder is this transfer's own; a partial earlier attempt is replaced.
      await rm(root, { recursive: true, force: true });
      await stageBundle(root, bundle);
      await step({ ...journal, phase: "staged" });
    }
    crashPoint("take-local:after-stage");
    // Still frozen for this transfer? A freeze that lapsed while this machine
    // was away may have let the board be taken online again; then the staged
    // copy must not become a second authority.
    await onlineRequest(storage.url, boardPath(storage.boardId, "/take-local/fence"), { transferId: journal.transferId, expectedGeneration: journal.generation })
      .catch((error) => {
        if (error instanceof PlanbanConflictError) {
          throw new PlanbanConflictError(`This board was taken online again elsewhere while this Take Local was unfinished. The downloaded copy is kept at ${root} but was not used; this project still uses the online board.`);
        }
        throw error;
      });
    options.onProgress?.({ step: "switch", message: "Switching this project to the copy on this machine" });
    const roadmap = normalizeRoadmap(JSON.parse(await readFile(join(root, "roadmap.json"), "utf8")));
    const localManifest: PlanbanProjectManifest = { ...manifest, storage: { kind: "local", root } };
    const state: PlanbanResolvedState = { cwd, manifest: localManifest, manifestPath: manifestPath(cwd),
      agentContextPath: agentContextPath(cwd), planningRoot: root, roadmapPath: join(root, "roadmap.json"), roadmap };
    // The journal moves with the board: the new local folder records that the
    // service still has to be told, so the next attempt to take it online finishes it.
    await writeJournal(root, { ...journal, phase: "published" });
    // The board no longer lives online: its note goes before the project switches, so a retry removes it again.
    const hadNote = await readOnlineNote(cwd).then((note) => !!note, () => true);
    await removeOnlineNote(cwd);
    await publishManifest(cwd, localManifest, state);
    await rm(transferJournalPath(lockRoot), { force: true });
    crashPoint("take-local:after-publish");
    // Only now that this project is local is the online freeze lifted.
    await finishLocalTransfer(root).catch(() => undefined);
    const repo = hadNote ? await gitRoot(cwd) : null;
    options.onProgress?.({ step: "done", message: "The board is on this machine" });
    return {
      boardId: storage.boardId, planningRoot: root,
      ...(repo ? { onlineNote: { removed: true, commit: `Commit the removal of .planban/online-board.json so your other machines know: git -C "${repo}" commit -am "Planban board is back in Local Mode"` } } : {}),
    };
  });
}

export async function attachOnline(urlInput: string, boardId: string, cwdInput: string, options: { replaceStaleCopy?: boolean; account?: string | undefined } = {}) {
  const url = serviceUrl(urlInput);
  const cwd = resolve(cwdInput);
  const existing = await readManifest(cwd);
  if (!boardId.trim()) throw new PlanbanValidationError("boardId is required.");
  // A folder holding another board is refused before anything changes, the board's account link included.
  const replacing = !!existing && (existing.storage?.kind !== "online" || existing.storage.url !== url || existing.storage.boardId !== boardId);
  const planningRoot = replacing && existing.storage?.kind !== "online" ? resolvePlanningRoot(existing) : null;
  const marker = planningRoot ? await readStaleMarker(planningRoot) : null;
  if (replacing && (!options.replaceStaleCopy || !marker || marker.url !== url || marker.boardId !== boardId)) {
    throw new PlanbanValidationError("This directory already has a different board. Use an empty directory or its existing board transfer command.");
  }
  // The account this attach uses: the one named, or the board's own if it is
  // already linked here (it keeps it), or else the default, linked before the board is read.
  const earlierLink = await boardAccount(url, boardId);
  const relink = !!options.account || !earlierLink;
  const chosen = options.account ? await chosenAccount(url, options.account) : earlierLink ? null : await requireCredentials(url).catch(() => null);
  const pinned = chosen ? await withIdentity(url, chosen) : null;
  if (relink && pinned) await recordBoardAccountAs(url, boardId, pinned);
  const undoLink = () => relink ? recordBoardAccount(url, boardId, earlierLink).catch(() => undefined) : Promise.resolve();
  let staleCopy: { snapshot: string; report: string; unsyncedChanges: StaleCopy["unsyncedChanges"] } | undefined;
  if (replacing) {
    // Check the online board is reachable before setting the local copy aside.
    await loadOnlineState(cwd, { version: 1, enabled: true, repoId: boardId, storage: { kind: "online", url, boardId } }).catch(async (error: unknown) => { await undoLink(); throw error; });
    staleCopy = await setStaleCopyAside(planningRoot!, marker!);
  }
  const manifest: PlanbanProjectManifest = { version: 1, enabled: true, repoId: boardId, storage: { kind: "online", url, boardId } };
  const state = await loadOnlineState(cwd, manifest).catch(async (error: unknown) => { await undoLink(); throw error; });
  await mkdir(dirname(manifestPath(cwd)), { recursive: true });
  await publishManifest(cwd, manifest, state);
  const onlineNote = await leaveOnlineNote(cwd, { url, boardId, title: state.roadmap.project.title, onlineSince: new Date().toISOString() });
  if (relink && pinned) await recordBoardAccountAs(url, boardId, pinned).catch(() => undefined);
  await refreshBackup(url, boardId, { force: true });
  return { boardId, url, cwd, onlineNote, ...(staleCopy ? { staleCopy } : {}) };
}

/**
 * The stale copy stays on disk as recovery evidence, with a report of the
 * changes that never reached the online board; its live roadmap file is
 * renamed so nothing edits it by accident.
 */
async function setStaleCopyAside(planningRoot: string, marker: StaleCopy) {
  return withBoardWriteLock(planningRoot, async () => {
    const stamp = Date.now();
    const snapshot = join(planningRoot, `roadmap.stale-copy-${stamp}.json`);
    if (await hasLiveRoadmap(planningRoot)) await rename(join(planningRoot, "roadmap.json"), snapshot);
    const report = join(planningRoot, `STALE-COPY-REPORT-${stamp}.md`);
    await atomicWriteFile(report, [
      "# Stale local copy set aside",
      "",
      `This board was taken online as "${marker.title}" (${marker.boardId} at ${marker.url}). This machine's local copy was set aside on ${new Date(stamp).toISOString()}.`,
      `The roadmap as it was is in ${snapshot}; its documents and history are in this folder.`,
      "",
      marker.unsyncedChanges.length
        ? "Changes made here that never reached the online board (re-apply any you still want):"
        : "Every change in this copy had already reached the online board.",
      ...marker.unsyncedChanges.map((change) => `- v${change.version}, ${change.createdAt}: ${change.summary}`),
      "",
    ].join("\n"));
    await atomicWriteFile(join(planningRoot, "ONLINE-BOARD.txt"), `Authority moved to ${marker.url}, board ${marker.boardId}.\nThe files here are recovery evidence. Do not edit them.\n`);
    return { snapshot, report, unsyncedChanges: marker.unsyncedChanges };
  });
}

/**
 * Keep a stale copy as its own local board, under a new id, never flagged
 * against that online board again. Its changes stay where they are.
 */
export async function keepLocalCopy(cwdInput: string, newId: string, title?: string) {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled || manifest.storage?.kind === "online") throw new PlanbanValidationError("This project does not hold a local board.");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(newId) || newId === manifest.repoId) throw new PlanbanValidationError("Choose a new board id: lowercase letters, digits and dashes.");
  const planningRoot = resolvePlanningRoot(manifest);
  // The whole conversion holds the board, taken before its first write, so
  // no other writer can come between its steps.
  return withBoardWriteLock(planningRoot, async () => {
    const marker = await readStaleMarker(planningRoot);
    if (!marker) throw new PlanbanValidationError("This board is not marked as a stale copy of an Online Board.");
    await markIndependent(planningRoot, marker);
    // A separate board is a different board: it gets its own identity.
    await writeBoardIdentity(planningRoot);
    const localManifest: PlanbanProjectManifest = { ...manifest, repoId: newId, storage: { kind: "local", root: planningRoot } };
    await writeJson(manifestPath(cwd), localManifest);
    const state = await loadState(cwd);
    const roadmap = { ...state.roadmap, project: { ...state.roadmap.project, id: newId, title: title ?? `${state.roadmap.project.title} (local copy)` } };
    const saved = await saveRoadmap(state, roadmap, { actor: "user", operation: "board.keep-local-copy", summary: `Kept as a separate local board after ${marker.boardId} went online`, affectedCards: [] });
    await publishManifest(cwd, localManifest, { ...state, roadmap: saved });
    return { repoId: newId, planningRoot, unsyncedChanges: marker.unsyncedChanges };
  });
}

/**
 * "Keep as a separate board" (owner decision 15): the older copy becomes its
 * own local board, with a new name, id and identity, in its own folder, never
 * linked to the online board; this project then uses the online board, so its
 * agents follow it. The original copy is kept as recovery evidence, as with
 * "Use the online board".
 */
export async function keepSeparateBoard(cwdInput: string, options: { title?: string; newId?: string } = {}) {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled || manifest.storage?.kind === "online") throw new PlanbanValidationError("This project does not hold a local board.");
  const planningRoot = resolvePlanningRoot(manifest);
  const marker = await readStaleMarker(planningRoot);
  if (!marker) throw new PlanbanValidationError("This board is not marked as an older copy of an Online Board.");
  // A record of this conversion in the older copy, so running it again
  // finishes the same separate board instead of making another.
  const recordPath = join(planningRoot, "KEEP-SEPARATE.json");
  const recorded = await readFile(recordPath, "utf8").then((text) => JSON.parse(text) as { newId: string; title: string; phase: "copying" | "converted" }, () => null);
  const state = await loadState(cwd);
  const day = marker.onlineSince.slice(0, 10);
  const title = recorded?.title ?? (options.title?.trim() || `${state.roadmap.project.title} (copy from ${day})`);
  let newId: string;
  if (recorded) {
    newId = recorded.newId;
  } else if (options.newId) {
    if (!BOARD_ID.test(options.newId) || options.newId === manifest.repoId) throw new PlanbanValidationError("Choose a new board id: up to 64 lowercase letters, digits and dashes.");
    newId = options.newId;
    if (await pathExists(defaultPlanningRoot(newId)) || await pathExists(detachedBoardCwd(newId))) throw new PlanbanValidationError(`A board called ${newId} already exists. Choose another id.`);
  } else {
    const base = slugify(`${manifest.repoId}-copy-${day}`).slice(0, 56).replace(/-+$/, "");
    newId = base;
    for (let suffix = 2; await pathExists(defaultPlanningRoot(newId)) || await pathExists(detachedBoardCwd(newId)); suffix += 1) newId = `${base}-${suffix}`;
  }
  const newRoot = defaultPlanningRoot(newId);
  const newCwd = detachedBoardCwd(newId);
  if (!BOARD_ID.test(newId) || !isPathInsideRoot(join(defaultPlanbanRoot(), "repos"), newRoot)) throw new PlanbanValidationError("Choose a new board id: up to 64 lowercase letters, digits and dashes.");
  if (recorded?.phase !== "converted") {
    // A copy cut short last time is this conversion's own; start it again.
    if (recorded) {
      await rm(newRoot, { recursive: true, force: true });
      await rm(newCwd, { recursive: true, force: true });
    }
    await atomicWriteFile(recordPath, JSON.stringify({ newId, title, phase: "copying" }, null, 2) + "\n");
    // Copy the board as it is now, holding it so nothing changes mid-copy.
    await withBoardWriteLock(planningRoot, async () => {
      await cp(planningRoot, newRoot, {
        recursive: true, errorOnExist: true,
        // Also skip another writer's half-finished atomic write (".<name>.<pid>.<time>.<id>.tmp"),
        // which can vanish mid-copy: the stale-copy check writes its marker without this lock.
        filter: (source) => ![LOCK_DIR, QUEUE_DIR, "online-transfer.json", "KEEP-SEPARATE.json"].includes(basename(source)) && !isAtomicWriteTemp(basename(source)),
      });
    });
    await mkdir(dirname(manifestPath(newCwd)), { recursive: true });
    await writeJson(manifestPath(newCwd), { ...manifest, storage: { kind: "local", root: newRoot } });
    // The copy carries the older-copy marker, so the usual conversion applies:
    // a new id and identity, never checked against that online board again.
    await keepLocalCopy(newCwd, newId, title);
    await atomicWriteFile(recordPath, JSON.stringify({ newId, title, phase: "converted" }, null, 2) + "\n");
  }
  // Then this project switches to the online board.
  const attached = await attachOnline(marker.url, marker.boardId, cwd, { replaceStaleCopy: true }).catch((error: unknown) => {
    throw new PlanbanValidationError(`The separate board "${title}" was made (${newId}), but this project could not switch to the online board yet: ${error instanceof Error ? error.message : String(error)}. Run this again to finish; it will not make another copy.`);
  });
  await rm(recordPath, { force: true });
  return { separateBoard: { repoId: newId, title, cwd: newCwd, planningRoot: newRoot }, project: attached };
}

const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Turns a backup folder (its latest copy, or one day's) into a new local board. */
export async function restoreBackup(folder: string, cwdInput: string, repoId: string) {
  const cwd = resolve(cwdInput);
  if (await readManifest(cwd)) throw new PlanbanValidationError("This directory already has a board. Restore into an empty directory.");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(repoId)) throw new PlanbanValidationError("Choose a board id: lowercase letters, digits and dashes.");
  const { roadmap, docs, goals } = await readBackup(folder);
  // A restored board is a separate copy, never the online board itself
  // (owner request, 15 October 2026): it takes a new id, so taking it online
  // makes a second board, and its name says where it came from.
  if (repoId === roadmap.project.id) throw new PlanbanValidationError(`The restored copy needs its own id, not ${repoId}, the id of the online board it was backed up from. Choose another id.`);
  const root = join(defaultPlanbanRoot(), "repos", repoId);
  if (await pathExists(root)) throw new PlanbanValidationError(`A local board folder already exists at ${root}. Choose another id.`);
  const savedAt = await readFile(join(folder, "backup.json"), "utf8").then((text) => String(JSON.parse(text).savedAt ?? ""), () => "");
  const day = /^\d{4}-\d{2}-\d{2}/.exec(savedAt)?.[0] ?? /^\d{4}-\d{2}-\d{2}$/.exec(basename(resolve(folder)))?.[0];
  const title = `${roadmap.project.title} (copy restored from a backup${day ? ` of ${day}` : ""})`;
  const restored = await stageBundle(root, bundleSchema.parse({
    format: "planban-board-bundle", version: 1, roadmap: { ...roadmap, project: { ...roadmap.project, id: repoId, title } }, docs, history: [],
    ...(goals ? { goals } : {}),
  }));
  const manifest: PlanbanProjectManifest = { version: 1, enabled: true, repoId, storage: { kind: "local", root } };
  await mkdir(dirname(manifestPath(cwd)), { recursive: true });
  await publishManifest(cwd, manifest, { cwd, manifest, manifestPath: manifestPath(cwd), agentContextPath: agentContextPath(cwd), planningRoot: root, roadmapPath: join(root, "roadmap.json"), roadmap: restored });
  return {
    repoId, title, planningRoot: root, cards: restored.roadmapItems.length, docs: docs.length,
    message: `Made "${title}", a separate local board (${repoId}) copied from a backup of the online board ${roadmap.project.id}. It is not linked to that board; taking it online makes a second, separate board.`,
  };
}

