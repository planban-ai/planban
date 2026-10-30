// Merged pull requests from GitHub, for Online Boards worked on from several computers: a merge
// made anywhere counts, not just ones this checkout has fetched. Read with the GitHub CLI (`gh`)
// and whatever account it is signed in to; Planban stores no GitHub token. Best effort: when gh is
// missing, signed out or GitHub can't be reached, the last merges seen here are used with a note.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultPlanbanRoot } from "./paths";
import type { MergeRecord } from "./staleness";

const GIT_TIMEOUT_MS = 2_000;
const GH_TIMEOUT_MS = 2_000;
const REFRESH_AFTER_MS = 60_000;
const PER_PAGE = 100;
const MAX_PAGES = 5;
// A merge can land a moment before GitHub's list shows it; each read overlaps the last by this much.
const CURSOR_OVERLAP_MS = 10 * 60 * 1000;

export interface GitHubMerges {
  merges: MergeRecord[];
  /** Set when the merges could not be brought up to date, saying why in plain words. */
  note?: string | undefined;
}

interface MergeCache {
  version: 2;
  repo: string;
  /** Every merge updated between scannedFrom and cursor has been seen. */
  scannedFrom: string;
  cursor: string;
  /**
   * Where reading older history resumes, while scannedFrom is still newer than the oldest card
   * needs: the page of GitHub's list, newest first, that held scannedFrom.
   */
  resumePage: number;
  checkedAt: string;
  merges: MergeRecord[];
}

export type Run = (command: string, args: string[], options: { cwd?: string; timeout: number }) => Promise<string>;

export const runCommand: Run = (command, args, options) => new Promise((resolveRun, rejectRun) => {
  execFile(command, args, { ...options, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
    (error, stdout, stderr) => error ? rejectRun(Object.assign(error, { stderr: String(stderr) })) : resolveRun(String(stdout)));
});

/** "owner/name" for a GitHub remote address in any of git's forms, or null. */
export function githubRepoFromRemote(remote: string): string | null {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The GitHub repository a project folder's origin remote points at, or null. */
export async function githubRepoFor(cwd: string, exec: Run = runCommand): Promise<string | null> {
  try {
    return githubRepoFromRemote(await exec("git", ["remote", "get-url", "origin"], { cwd, timeout: GIT_TIMEOUT_MS }));
  } catch {
    return null;
  }
}

function cachePath(repo: string) {
  return join(defaultPlanbanRoot(), "online", "github", `${repo.replace("/", "__")}.json`);
}

async function readCache(repo: string): Promise<MergeCache | null> {
  try {
    const cache = JSON.parse(await readFile(cachePath(repo), "utf8")) as MergeCache;
    return cache.version === 2 && cache.repo === repo && Array.isArray(cache.merges) ? cache : null;
  } catch {
    return null;
  }
}

async function writeCache(cache: MergeCache) {
  const path = cachePath(cache.repo);
  await mkdir(join(path, ".."), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(cache));
  await rename(temp, path);
}

interface PullRow { number: number; merged_at: string | null; updated_at: string }

interface PageScan {
  merges: MergeRecord[];
  /** Whether the scan got back to the time it was asked for, or to the end of the list. */
  reached: boolean;
  /** The oldest update time read. */
  oldest: number;
  /** The page holding `oldest`, where a later scan resumes. */
  lastPage: number;
}

function readPage(repo: string, page: number, exec: Run): Promise<PullRow[]> {
  return exec("gh", ["api", "--method", "GET", `repos/${repo}/pulls`, "-f", "state=closed", "-f", "sort=updated", "-f", "direction=desc",
    "-f", `per_page=${PER_PAGE}`, "-f", `page=${page}`, "--jq", "[.[] | {number, merged_at, updated_at}]"], { timeout: GH_TIMEOUT_MS })
    .then((text) => JSON.parse(text) as PullRow[]);
}

/**
 * Reads GitHub's closed pull requests, newest update first, from `startPage` until updates pass
 * `stopAt`, reading at most MAX_PAGES pages. A PR's last update is never before its merge, so once
 * updates pass a time, so have merges.
 *
 * Resuming older history (`continueFrom` set) starts one page back and checks that page still
 * holds something updated at or after that time: pull requests updated since move to the top and
 * shift the rest up, so this proves no row slipped past between the two reads.
 */
async function scanPages(repo: string, exec: Run, startPage: number, stopAt: number, continueFrom?: number): Promise<PageScan> {
  const merges: MergeRecord[] = [];
  let page = continueFrom === undefined ? startPage : Math.max(1, startPage - 1);
  let oldest = Infinity;
  let checking = continueFrom !== undefined;
  for (let read = 0; read < MAX_PAGES; read += 1) {
    const rows = await readPage(repo, page, exec);
    if (checking && page > 1 && !rows.some((row) => Date.parse(row.updated_at) >= continueFrom!)) {
      page -= 1;
      continue;
    }
    checking = false;
    for (const row of rows) if (row.merged_at) merges.push({ pr: row.number, mergedAt: row.merged_at });
    const last = rows.at(-1);
    if (last) oldest = Math.min(oldest, Date.parse(last.updated_at));
    if (rows.length < PER_PAGE || oldest < stopAt) return { merges, reached: true, oldest, lastPage: page };
    page += 1;
  }
  return { merges, reached: false, oldest, lastPage: page - 1 };
}

function why(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
  if (code === "ENOENT") return "the GitHub CLI (gh) isn't installed here";
  if (/auth login|not logged|authentication/iu.test(stderr)) return "the GitHub CLI (gh) isn't signed in here";
  if ((error as { killed?: boolean })?.killed) return "GitHub took too long to answer";
  return "GitHub couldn't be reached";
}

const memory = new Map<string, { at: number; result: Promise<GitHubMerges> }>();

export function clearGitHubMergeCache() {
  memory.clear();
}

// gh is run directly, never through a shell: every Windows install of it is gh.exe, and its
// --jq argument holds characters cmd.exe would read as commands.
let ghRunner: Run = runCommand;

/** Replaces how gh is run, for tests; no argument restores the real one. */
export function useGitHubRunner(exec?: Run) {
  ghRunner = exec ?? runCommand;
  memory.clear();
}

/**
 * Merged PRs for `repo` from `since` on, merged with what earlier reads saw. Each check reads what
 * changed since the last one, then, while older history is still unread, continues it from where
 * the last check stopped: a busy repository is covered over a few checks, never skipped. Refreshes
 * at most once a minute per process; the position and merges persist between processes, so a
 * short-lived hook can still answer when GitHub can't.
 */
export function githubMerges(repo: string, since: number, options: { now?: number; exec?: Run } = {}): Promise<GitHubMerges> {
  const now = options.now ?? Date.now();
  const cached = memory.get(repo);
  if (cached && now - cached.at < REFRESH_AFTER_MS) return cached.result;
  const result = (async (): Promise<GitHubMerges> => {
    const saved = await readCache(repo);
    const exec = options.exec ?? ghRunner;
    try {
      const byPr = new Map((saved?.merges ?? []).map((merge) => [merge.pr, merge]));
      const keep = (scan: PageScan) => { for (const merge of scan.merges) byPr.set(merge.pr, merge); };
      // A first check reads from the top; later ones resume older history where the last stopped.
      let scannedFrom: number | null = null;
      let resumePage = 1;
      if (saved) {
        // What changed since the last check.
        const recent = await scanPages(repo, exec, 1, Date.parse(saved.cursor) - CURSOR_OVERLAP_MS);
        keep(recent);
        if (recent.reached) {
          scannedFrom = Date.parse(saved.scannedFrom);
          resumePage = saved.resumePage;
        } else {
          // More changed than one read holds: what was read before is no longer joined up to now.
          scannedFrom = recent.oldest;
          resumePage = recent.lastPage;
        }
      }
      if (scannedFrom === null || scannedFrom > since) {
        const older = scannedFrom === null
          ? await scanPages(repo, exec, 1, since)
          : await scanPages(repo, exec, resumePage, since, scannedFrom);
        keep(older);
        scannedFrom = older.reached ? Math.min(since, older.oldest) : older.oldest;
        resumePage = older.lastPage;
      }
      const merges = [...byPr.values()];
      const at = new Date(now).toISOString();
      await writeCache({ version: 2, repo, scannedFrom: new Date(scannedFrom).toISOString(), cursor: at, resumePage, checkedAt: at, merges }).catch(() => undefined);
      if (scannedFrom <= since) return { merges };
      return {
        merges,
        note: `Merged-PR warnings checked GitHub only back to ${new Date(scannedFrom).toISOString().slice(0, 10)} so far, as more pull requests changed than one check reads; later checks continue further back. Older merges may be missing.`,
      };
    } catch (error) {
      const seen = saved ? ` since ${saved.checkedAt.slice(0, 10)}` : "";
      return {
        merges: saved?.merges ?? [],
        note: `Merged-PR warnings may be missing merges${seen}: ${why(error)}. Only merges this computer already knows about are shown.`,
      };
    }
  })();
  memory.set(repo, { at: now, result });
  return result;
}
