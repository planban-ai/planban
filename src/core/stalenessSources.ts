// Gathers the inputs for stale signals: the local git merge log, the history index, doc mtimes
// and files held in card folders.
// Every source is best effort: a failure yields no signals of that kind, never an error.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cardsHoldingFiles } from "./cardFiles";
import { defaultPlanningRoot, expandHome, historyIndexPath, resolveInsideRoot, roadmapPath } from "./paths";
import { computeStaleness, parseMergeLog, type BoardStaleness, type DocMtime, type MergeRecord } from "./staleness";
import type { PlanbanHistoryEntry, PlanbanRoadmapItem } from "./types";

const GIT_TIMEOUT_MS = 2_000;
const MERGE_LOG_TTL_MS = 30_000;
const MERGE_LOG_MAX_COUNT = 5_000;

type HistoryRows = Array<Pick<PlanbanHistoryEntry, "createdAt" | "affectedCards" | "affectedDocs">>;

const mergeLogCache = new Map<string, { at: number; merges: Promise<MergeRecord[]> }>();
const historyCache = new Map<string, { key: string; rows: HistoryRows }>();

export function clearStalenessCaches() {
  mergeLogCache.clear();
  historyCache.clear();
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
  now?: number | undefined;
}): Promise<BoardStaleness> {
  const now = input.now ?? Date.now();
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
