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
  version: 1;
  repo: string;
  /** Every merge between these two times has been seen. */
  coveredFrom: string;
  cursor: string;
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
    return cache.version === 1 && cache.repo === repo && Array.isArray(cache.merges) ? cache : null;
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

interface MergeScan {
  merges: MergeRecord[];
  /**
   * The oldest update time the scan reached. It reached `since` unless more pull requests changed
   * than MAX_PAGES pages hold; then only scannedFrom → now is covered.
   */
  scannedFrom: number;
}

/** Merged PRs updated since `since`, newest first, from GitHub's pull request list. */
async function fetchMergedSince(repo: string, since: number, exec: Run): Promise<MergeScan> {
  const merges: MergeRecord[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const text = await exec("gh", ["api", "--method", "GET", `repos/${repo}/pulls`, "-f", "state=closed", "-f", "sort=updated", "-f", "direction=desc",
      "-f", `per_page=${PER_PAGE}`, "-f", `page=${page}`, "--jq", "[.[] | {number, merged_at, updated_at}]"], { timeout: GH_TIMEOUT_MS });
    const rows = JSON.parse(text) as PullRow[];
    for (const row of rows) if (row.merged_at) merges.push({ pr: row.number, mergedAt: row.merged_at });
    // A PR's last update is never before its merge, so once updates pass the cursor, so have merges.
    const oldest = rows.at(-1);
    if (rows.length < PER_PAGE || !oldest || Date.parse(oldest.updated_at) < since) return { merges, scannedFrom: since };
    if (page === MAX_PAGES) return { merges, scannedFrom: Date.parse(oldest.updated_at) };
  }
  return { merges, scannedFrom: since };
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
 * Merged PRs for `repo` from `since` on: only what is new since the last read is fetched, and
 * merged with what earlier reads saw. Refreshes at most once a minute per process; the cursor and
 * merges persist between processes, so a short-lived hook can still answer when GitHub can't.
 */
export function githubMerges(repo: string, since: number, options: { now?: number; exec?: Run } = {}): Promise<GitHubMerges> {
  const now = options.now ?? Date.now();
  const cached = memory.get(repo);
  if (cached && now - cached.at < REFRESH_AFTER_MS) return cached.result;
  const result = (async (): Promise<GitHubMerges> => {
    const saved = await readCache(repo);
    // Earlier reads cover since → cursor: fetch only what is newer. Otherwise read back to `since`.
    const covered = saved && Date.parse(saved.coveredFrom) <= since;
    const from = covered ? Date.parse(saved.cursor) - CURSOR_OVERLAP_MS : since;
    try {
      const scan = await fetchMergedSince(repo, from, options.exec ?? ghRunner);
      const byPr = new Map((saved?.merges ?? []).map((merge) => [merge.pr, merge]));
      for (const merge of scan.merges) byPr.set(merge.pr, merge);
      const merges = [...byPr.values()];
      const at = new Date(now).toISOString();
      // Only history actually scanned counts as covered. A scan stopped by the page limit covers
      // scannedFrom → now alone, so the next read goes back over the rest rather than skipping it.
      const complete = scan.scannedFrom <= from;
      const coveredFrom = complete ? (covered ? saved.coveredFrom : new Date(since).toISOString()) : new Date(scan.scannedFrom).toISOString();
      await writeCache({ version: 1, repo, coveredFrom, cursor: at, checkedAt: at, merges }).catch(() => undefined);
      if (complete) return { merges };
      return {
        merges,
        note: `Merged-PR warnings checked GitHub only back to ${new Date(scan.scannedFrom).toISOString().slice(0, 10)}: more pull requests changed than one check reads. Older merges may be missing.`,
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
