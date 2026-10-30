// Automatic local backup of Online Boards (owner decision 2). Every machine
// that uses an Online Board keeps a copy of its roadmap and documents under
// ~/.planban/online/backups/, refreshed after changes it sees (at most once a
// minute), with a daily copy kept for 30 days. The backup is never edited in
// place; `planban online restore-backup` turns it into a new local board.
//
// Refreshes are incremental: the history entries since the last backup say
// which documents changed, so only those are downloaded.
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PlanbanDocPayload, PlanbanHistoryPayload, PlanbanRoadmap } from "../types";
import { PlanbanConflictError, PlanbanNotFoundError } from "../boardOperations";
import { defaultPlanbanRoot } from "../paths";
import { atomicWriteFile, withBoardWriteLock } from "../persistence";
import { boardPath, onlineRequest } from "./client";
import { serviceUrl } from "./credentials";

const REFRESH_INTERVAL_MS = 60_000;
const DAILY_COPIES = 30;
const DOCS_PAGE = 100;

export interface BackupMeta {
  version: 1;
  url: string;
  boardId: string;
  revision: number;
  /** Newest history version whose document changes are in the backup. */
  historyVersion: number;
  savedAt: string;
}

export function backupRoot(url: string, boardId: string) {
  const service = createHash("sha256").update(serviceUrl(url)).digest("hex").slice(0, 16);
  return join(defaultPlanbanRoot(), "online", "backups", service, encodeURIComponent(boardId));
}

function docFile(folder: string, cardId: string, kind: "spec" | "plan") {
  return join(folder, "docs", `${encodeURIComponent(cardId)}.${kind}.md`);
}

/** A crash between the two renames of a refresh leaves the last good copy aside; put it back. */
async function recoverLatest(root: string) {
  if (await exists(join(root, "latest"))) return;
  const aside = (await readdir(root).catch(() => [] as string[])).filter((name) => name.startsWith("latest.previous-"));
  if (aside[0]) await rename(join(root, aside[0]), join(root, "latest"));
}

async function readMeta(root: string): Promise<BackupMeta | null> {
  try {
    return JSON.parse(await readFile(join(root, "latest", "backup.json"), "utf8")) as BackupMeta;
  } catch {
    return null;
  }
}

const lastAttempt = new Map<string, number>();

/**
 * Brings the backup up to date. Called after this machine reads or changes
 * the board; does nothing if it ran within the last minute. Never throws:
 * a failed backup must not fail the user's edit.
 */
export async function refreshBackup(url: string, boardId: string, options: { force?: boolean } = {}): Promise<BackupMeta | null> {
  const root = backupRoot(url, boardId);
  if (!options.force && Date.now() - (lastAttempt.get(root) ?? 0) < REFRESH_INTERVAL_MS) return null;
  lastAttempt.set(root, Date.now());
  // A board that changes while a full download is under way is downloaded again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await refreshOnce(url, boardId, root, options);
    } catch (error) {
      if (!(error instanceof PlanbanConflictError)) return null;
    }
  }
  return null;
}

async function refreshOnce(url: string, boardId: string, root: string, options: { force?: boolean }): Promise<BackupMeta | null> {
  {
    return await withBoardWriteLock(root, async () => {
      await recoverLatest(root);
      const previous = await readMeta(root);
      if (!options.force && previous && Date.now() - Date.parse(previous.savedAt) < REFRESH_INTERVAL_MS) return previous;
      const board = await onlineRequest<{ roadmap?: PlanbanRoadmap; unchanged?: boolean; revision?: number }>(
        url, boardPath(boardId, previous ? `?since=${previous.revision}` : ""));
      if (board.unchanged && previous) {
        const meta = { ...previous, savedAt: new Date().toISOString() };
        await atomicWriteFile(join(root, "latest", "backup.json"), JSON.stringify(meta, null, 2) + "\n");
        await keepDailyCopy(root);
        return meta;
      }
      const roadmap = board.roadmap!;
      // History is read after the roadmap, so it may include later changes.
      // Only changes up to the roadmap's revision are applied now and the
      // cursor never moves past them; later ones are picked up next time.
      const history = await onlineRequest<PlanbanHistoryPayload>(url, boardPath(boardId, `/history?after=${previous?.historyVersion ?? 0}`));
      const covered = history.entries.filter((entry) => entry.roadmapRevision <= roadmap.revision);
      const live = new Set(roadmap.roadmapItems.map((item) => item.id));
      // If versions since the last backup were pruned, or the board was taken
      // online again, the change list is incomplete: download every document.
      const oldest = Math.min(...history.entries.map((entry) => entry.version));
      const complete = previous && (history.entries.length === 0 || oldest === previous.historyVersion + 1)
        && !history.entries.some((entry) => entry.operation === "board.take-online");
      // The new copy is built beside the current one and swapped in only when
      // complete, so a failed refresh never damages the last good backup.
      const staging = join(root, `latest.staging-${randomUUID()}`);
      try {
        if (complete) await cp(join(root, "latest"), staging, { recursive: true });
        else await mkdir(join(staging, "docs"), { recursive: true });
        if (!complete) {
          for (let offset: number | null = 0; offset !== null;) {
            const page: { docs: Array<{ cardId: string; kind: "spec" | "plan"; markdown: string }>; nextOffset: number | null } =
              await onlineRequest(url, boardPath(boardId, `/export/docs?offset=${offset}&limit=${DOCS_PAGE}&revision=${roadmap.revision}`));
            for (const doc of page.docs) if (live.has(doc.cardId)) await atomicWriteFile(docFile(staging, doc.cardId, doc.kind), doc.markdown);
            offset = page.nextOffset;
          }
        } else {
          const changed = new Map<string, { cardId: string; kind: "spec" | "plan" }>();
          for (const entry of covered) for (const doc of entry.affectedDocs) changed.set(`${doc.cardId}/${doc.kind}`, doc);
          for (const { cardId, kind } of changed.values()) {
            if (!live.has(cardId)) continue;
            const doc = await onlineRequest<PlanbanDocPayload>(url, boardPath(boardId, `/docs/${encodeURIComponent(cardId)}/${kind}`));
            if (doc.exists) await atomicWriteFile(docFile(staging, cardId, kind), doc.markdown);
            else await rm(docFile(staging, cardId, kind), { force: true });
          }
          // Documents of cards that are gone.
          for (const name of await readdir(join(staging, "docs")).catch(() => [] as string[])) {
            const match = /^(.*)\.(spec|plan)\.md$/.exec(name);
            if (match && !live.has(decodeURIComponent(match[1]!))) await rm(join(staging, "docs", name), { force: true });
          }
          // Those documents were read as they are now. If the board moved past
          // this roadmap meanwhile, a body could be newer than the roadmap it is
          // saved with, so start again rather than save a mixed copy.
          const after = await onlineRequest<{ unchanged?: boolean }>(url, boardPath(boardId, `?since=${roadmap.revision}`));
          if (!after.unchanged) throw new PlanbanConflictError("The board changed while it was being backed up.");
        }
        await atomicWriteFile(join(staging, "roadmap.json"), JSON.stringify(roadmap, null, 2) + "\n");
        // The goals as they are now (they're small, and every change to them is a new revision).
        // If they can't be read, this refresh fails and the next one tries again: a backup is
        // never saved at this revision without them. A service from before goals has none.
        const read = await onlineRequest<{ goals?: unknown; revision?: number }>(url, boardPath(boardId, "/goals")).catch((error: unknown) => {
          if (error instanceof PlanbanNotFoundError) return {} as { goals?: unknown; revision?: number };
          throw error;
        });
        // Read after the roadmap: if the board moved on meanwhile, start again rather than save goals from a later revision.
        if (read.revision !== undefined && read.revision !== roadmap.revision) throw new PlanbanConflictError("The board changed while it was being backed up.");
        if (read.goals) await atomicWriteFile(join(staging, "goals.json"), JSON.stringify(read.goals, null, 2) + "\n");
        else await rm(join(staging, "goals.json"), { force: true });
        const meta: BackupMeta = {
          version: 1, url: serviceUrl(url), boardId, revision: roadmap.revision,
          historyVersion: Math.max(complete ? previous!.historyVersion : 0, ...covered.map((entry) => entry.version)),
          savedAt: new Date().toISOString(),
        };
        await atomicWriteFile(join(staging, "backup.json"), JSON.stringify(meta, null, 2) + "\n");
        const retired = join(root, `latest.previous-${randomUUID()}`);
        if (await exists(join(root, "latest"))) await rename(join(root, "latest"), retired);
        await rename(staging, join(root, "latest"));
        await rm(retired, { recursive: true, force: true });
        await keepDailyCopy(root);
        return meta;
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }
}

async function exists(path: string) {
  return stat(path).then(() => true, () => false);
}

async function keepDailyCopy(root: string) {
  const today = new Date().toISOString().slice(0, 10);
  const daily = join(root, "daily");
  await mkdir(daily, { recursive: true });
  const days = (await readdir(daily)).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
  if (!days.includes(today)) {
    await cp(join(root, "latest"), join(daily, today), { recursive: true });
    days.push(today);
  }
  for (const day of days.slice(0, Math.max(0, days.length - DAILY_COPIES))) await rm(join(daily, day), { recursive: true, force: true });
}

/** Reads a backup (its latest copy, or one day's) as a board bundle without history. */
export async function readBackup(folder: string) {
  const roadmap = JSON.parse(await readFile(join(folder, "roadmap.json"), "utf8")) as PlanbanRoadmap;
  const docs: Array<{ cardId: string; kind: "spec" | "plan"; markdown: string }> = [];
  const names = await readdir(join(folder, "docs")).catch(() => [] as string[]);
  for (const name of names) {
    const match = /^(.*)\.(spec|plan)\.md$/.exec(name);
    if (!match) continue;
    docs.push({ cardId: decodeURIComponent(match[1]!), kind: match[2] as "spec" | "plan", markdown: await readFile(join(folder, "docs", name), "utf8") });
  }
  const goals = await readFile(join(folder, "goals.json"), "utf8").then((raw) => JSON.parse(raw) as unknown, () => null);
  return { roadmap, docs, goals };
}
