// Gathers the inputs for stale signals: the local git merge log, the history index, doc mtimes
// and files held in card folders. An Online Board uses its own history from the service and
// merges from GitHub, so a merge made on any computer counts.
// Every source is best effort: a failure yields no signals of that kind, never an error.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cardsHoldingFiles } from "./cardFiles";
import { clearGitHubMergeCache, githubMerges, githubRepoFor } from "./githubMerges";
import { boardPath, onlineRequest } from "./online/client";
import { defaultPlanningRoot, expandHome, historyIndexPath, resolveInsideRoot, roadmapPath } from "./paths";
import { cardPrNumbers, computeStaleness, parseMergeLog, type BoardStaleness, type DocMtime, type MergeRecord } from "./staleness";
import type { PlanbanHistoryEntry, PlanbanHistoryPayload, PlanbanProjectManifest, PlanbanRoadmap, PlanbanRoadmapItem } from "./types";

type Storage = PlanbanProjectManifest["storage"];
type OnlineStorage = Extract<NonNullable<Storage>, { kind: "online" }>;

const GIT_TIMEOUT_MS = 2_000;
const MERGE_LOG_TTL_MS = 30_000;
const MERGE_LOG_MAX_COUNT = 5_000;

type HistoryRows = Array<Pick<PlanbanHistoryEntry, "createdAt" | "affectedCards" | "affectedDocs">>;

const mergeLogCache = new Map<string, { at: number; merges: Promise<MergeRecord[]> }>();
const historyCache = new Map<string, { key: string; rows: HistoryRows }>();
const onlineHistoryCache = new Map<string, { version: number; rows: Map<number, HistoryRows[number]> }>();

export function clearStalenessCaches() {
  mergeLogCache.clear();
  historyCache.clear();
  onlineHistoryCache.clear();
  clearGitHubMergeCache();
}

/**
 * PR merges known to the local checkout: GitHub merge commits and squash-style `(#N)` subjects on
 * any remote-tracking branch. Planban never fetches. Non-git directories and timeouts yield [].
 */
export function readMergeLog(cwd: string): Promise<MergeRecord[]> {
  return new Promise((resolveLog) => {
    execFile(
      "git",
      ["log", "--remotes", `--max-count=${MERGE_LOG_MAX_COUNT}`, "--format=%cI%x09%s", "-E", "--grep=^Merge pull request #[0-9]+", "--grep=\\(#[0-9]+\\)$"],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout) => {
        if (error) return resolveLog([]);
        try {
          resolveLog(parseMergeLog(String(stdout)));
        } catch {
          resolveLog([]);
        }
      },
    );
  });
}

function cachedMergeLog(cwd: string, now = Date.now()): Promise<MergeRecord[]> {
  const cached = mergeLogCache.get(cwd);
  if (cached && now - cached.at < MERGE_LOG_TTL_MS) return cached.merges;
  const merges = readMergeLog(cwd);
  mergeLogCache.set(cwd, { at: now, merges });
  return merges;
}

async function readHistoryRows(planningRoot: string): Promise<HistoryRows> {
  const path = historyIndexPath(planningRoot);
  try {
    const info = await stat(path);
    const key = `${info.mtimeMs}:${info.size}`;
    const cached = historyCache.get(path);
    if (cached?.key === key) return cached.rows;
    const payload = JSON.parse(await readFile(path, "utf8")) as { entries?: unknown };
    const rows = (Array.isArray(payload.entries) ? payload.entries : []).map((entry: Partial<PlanbanHistoryEntry>) => ({
      createdAt: String(entry.createdAt ?? ""),
      affectedCards: Array.isArray(entry.affectedCards) ? entry.affectedCards : [],
      affectedDocs: Array.isArray(entry.affectedDocs) ? entry.affectedDocs : [],
    }));
    historyCache.set(path, { key, rows });
    return rows;
  } catch {
    return [];
  }
}

/** An Online Board's history from the service: only entries newer than the last read are fetched. */
async function readOnlineHistoryRows(storage: OnlineStorage): Promise<HistoryRows> {
  const key = `${storage.url}|${storage.boardId}`;
  const cached = onlineHistoryCache.get(key) ?? { version: 0, rows: new Map() };
  try {
    const payload = await onlineRequest<PlanbanHistoryPayload>(storage.url, boardPath(storage.boardId, `/history?after=${cached.version}`));
    const rows = new Map(cached.rows);
    for (const entry of payload.entries ?? []) {
      rows.set(entry.version, { createdAt: String(entry.createdAt ?? ""), affectedCards: entry.affectedCards ?? [], affectedDocs: entry.affectedDocs ?? [] });
    }
    const version = Math.max(cached.version, ...(payload.entries ?? []).map((entry) => entry.version));
    onlineHistoryCache.set(key, { version, rows });
    return [...rows.values()];
  } catch {
    return [...cached.rows.values()];
  }
}

/**
 * Merges for an Online Board: this checkout's git log plus GitHub, asked about each PR an active
 * card names that the log doesn't already show merged. No card naming a PR means no GitHub read.
 */
async function onlineMerges(cwd: string, items: PlanbanRoadmapItem[], now: number): Promise<{ merges: MergeRecord[]; notes: string[] }> {
  const named = [...new Set(items
    .filter((item) => item.status === "in-progress" || item.status === "up-next")
    .flatMap((item) => cardPrNumbers(item)))];
  const local = await cachedMergeLog(cwd, now);
  if (!named.length) return { merges: local, notes: [] };
  const repo = await githubRepoFor(cwd);
  if (!repo) {
    return { merges: local, notes: ["Merged-PR warnings use only this computer's git history: this project has no GitHub origin remote."] };
  }
  const seenHere = new Set(local.map((merge) => merge.pr));
  const github = await githubMerges(repo, named.filter((pr) => !seenHere.has(pr)), { now });
  const byPr = new Map(local.map((merge) => [merge.pr, merge]));
  for (const merge of github.merges) byPr.set(merge.pr, merge);
  return { merges: [...byPr.values()], notes: github.note ? [github.note] : [] };
}

async function readDocMtimes(planningRoot: string, items: PlanbanRoadmapItem[]): Promise<DocMtime[]> {
  const docs = items
    .filter((item) => item.status === "in-progress" || item.status === "up-next")
    .flatMap((item) => (["spec", "plan"] as const).map((kind) => ({ cardId: item.id, kind, path: kind === "spec" ? item.specDoc : item.planDoc })))
    .filter((doc): doc is { cardId: string; kind: "spec" | "plan"; path: string } => typeof doc.path === "string" && doc.path.length > 0);
  const mtimes = await Promise.all(docs.map(async (doc): Promise<DocMtime | null> => {
    try {
      const info = await stat(resolveInsideRoot(planningRoot, doc.path));
      return { cardId: doc.cardId, kind: doc.kind, mtimeMs: info.mtimeMs, bytes: info.size };
    } catch {
      return null;
    }
  }));
  return mtimes.filter((entry): entry is DocMtime => entry !== null);
}

export async function collectStaleness(input: {
  cwd: string;
  planningRoot: string;
  items: PlanbanRoadmapItem[];
  /** The board's storage, from its manifest; an Online Board reads its own history and GitHub. */
  storage?: Storage | undefined;
  now?: number | undefined;
}): Promise<BoardStaleness> {
  const now = input.now ?? Date.now();
  const storage = input.storage;
  if (storage?.kind === "online") {
    try {
      // Online documents change only through Planban, so none is "edited outside Planban", and the
      // board holds no files. Document sizes are checked when a document is read or written.
      const [history, { merges, notes }] = await Promise.all([readOnlineHistoryRows(storage), onlineMerges(input.cwd, input.items, now)]);
      return computeStaleness({ items: input.items, history, docMtimes: [], merges, notes, now });
    } catch {
      return { cards: {}, wip: null };
    }
  }
  try {
    const [merges, history, docMtimes, cardFiles] = await Promise.all([
      cachedMergeLog(input.cwd, now),
      readHistoryRows(input.planningRoot),
      readDocMtimes(input.planningRoot, input.items),
      cardsHoldingFiles(input.planningRoot, input.items.map((item) => item.id)).catch(() => ({})),
    ]);
    return computeStaleness({ items: input.items, history, docMtimes, merges, cardFiles, now });
  } catch {
    return { cards: {}, wip: null };
  }
}

/**
 * Read-only staleness for a project directory, for callers that must not load or migrate the board
 * (the session-start hook). Returns null when the project has no readable Planban board.
 */
export async function projectStaleness(projectDir: string): Promise<{ items: PlanbanRoadmapItem[]; staleness: BoardStaleness } | null> {
  try {
    const manifest = JSON.parse(await readFile(join(projectDir, ".planban/project.json"), "utf8")) as {
      repoId?: unknown;
      enabled?: unknown;
      storage?: { root?: unknown };
    };
    if (typeof manifest.repoId !== "string" || manifest.enabled === false) return null;
    const storage = (manifest.storage as Storage | undefined);
    if (storage?.kind === "online" && typeof storage.url === "string" && typeof storage.boardId === "string") {
      // The board as the service has it, read without the backup and account-linking a full load does.
      const read = await onlineRequest<{ roadmap: PlanbanRoadmap }>(storage.url, boardPath(storage.boardId)).catch(() => null);
      // Out of reach (offline, signed out): say so rather than reporting a board with nothing stale.
      if (!read) return { items: [], staleness: { cards: {}, wip: null, notes: ["Planban couldn't reach the Online Board to check which cards look stale."] } };
      const { roadmap } = read;
      const items = roadmap.roadmapItems;
      return { items, staleness: await collectStaleness({ cwd: projectDir, planningRoot: projectDir, items, storage }) };
    }
    const planningRoot = typeof manifest.storage?.root === "string" && manifest.storage.root
      ? resolve(expandHome(manifest.storage.root))
      : defaultPlanningRoot(manifest.repoId);
    const roadmap = JSON.parse(await readFile(roadmapPath(planningRoot), "utf8")) as { roadmapItems?: unknown };
    if (!Array.isArray(roadmap.roadmapItems)) return null;
    const items = roadmap.roadmapItems as PlanbanRoadmapItem[];
    return { items, staleness: await collectStaleness({ cwd: projectDir, planningRoot, items }) };
  } catch {
    return null;
  }
}
