// Merged pull requests from GitHub, for Online Boards worked on from several computers: a merge
// made anywhere counts, not just ones this checkout has fetched. Read with the GitHub CLI (`gh`)
// and whatever account it is signed in to; Planban stores no GitHub token. Best effort: when gh is
// missing, signed out or GitHub can't be reached, the merges already seen here are used with a note.
//
// Planban asks about the pull requests cards name, one by number, rather than paging through
// GitHub's lists: positions in a list shift whenever a pull request changes, but a number doesn't,
// and a merge never un-happens. A pull request seen merged is kept for good; one still open, or a
// number that isn't a pull request, is asked about again on later checks.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultPlanbanRoot } from "./paths";
import type { MergeRecord } from "./staleness";

const GIT_TIMEOUT_MS = 2_000;
const GH_TIMEOUT_MS = 2_000;
const REFRESH_AFTER_MS = 60_000;
/** Pull requests asked about in one check; more are asked about on the next, oldest-asked first. */
export const LOOKUPS_PER_CHECK = 20;
const PARALLEL_LOOKUPS = 4;

export interface GitHubMerges {
  merges: MergeRecord[];
  /** Set when the merges could not be brought fully up to date, saying why in plain words. */
  note?: string | undefined;
}

interface MergeCache {
  version: 3;
  repo: string;
  /** Pull requests seen merged, by number. Permanent: a merge never un-happens. */
  merges: MergeRecord[];
  /** When each other named number was last asked about (still open, or not a pull request). */
  askedAt: Record<string, string>;
  checkedAt: string;
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
    return cache.version === 3 && cache.repo === repo && Array.isArray(cache.merges) && typeof cache.askedAt === "object" ? cache : null;
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

function why(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
  if (code === "ENOENT") return "the GitHub CLI (gh) isn't installed here";
  if (/auth login|not logged|authentication/iu.test(stderr)) return "the GitHub CLI (gh) isn't signed in here";
  if ((error as { killed?: boolean })?.killed) return "GitHub took too long to answer";
  return "GitHub couldn't be reached";
}

/** GitHub's answer for a number that isn't a pull request in this repository. */
const notFound = (error: unknown) => /HTTP 404|Not Found/u.test(String((error as { stderr?: unknown })?.stderr ?? ""));

/** One pull request's merge time, or null when it isn't merged or isn't a pull request. */
async function lookUp(repo: string, pr: number, exec: Run): Promise<string | null> {
  try {
    const text = await exec("gh", ["api", "--method", "GET", `repos/${repo}/pulls/${pr}`, "--jq", "{number, merged_at}"], { timeout: GH_TIMEOUT_MS });
    const row = JSON.parse(text) as { number?: unknown; merged_at?: unknown };
    return typeof row.merged_at === "string" && Number.isFinite(Date.parse(row.merged_at)) ? row.merged_at : null;
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

const memory = new Map<string, { at: number; key: string; result: Promise<GitHubMerges> }>();

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
 * Which of the pull requests `prs` (the numbers active cards name) have merged, with when. Asks
 * GitHub only about numbers not already seen merged, at most LOOKUPS_PER_CHECK a check, those
 * never asked about first and then the longest since asked. Refreshes at most once a minute per
 * process; what was learned persists between processes, so a short-lived hook can still answer
 * when GitHub can't.
 */
export function githubMerges(repo: string, prs: number[], options: { now?: number; exec?: Run } = {}): Promise<GitHubMerges> {
  const now = options.now ?? Date.now();
  const named = [...new Set(prs.filter((pr) => Number.isInteger(pr) && pr > 0))];
  const key = named.sort((a, b) => a - b).join(",");
  const cached = memory.get(repo);
  if (cached && cached.key === key && now - cached.at < REFRESH_AFTER_MS) return cached.result;
  const result = (async (): Promise<GitHubMerges> => {
    const saved = await readCache(repo);
    const exec = options.exec ?? ghRunner;
    const merged = new Map((saved?.merges ?? []).map((merge) => [merge.pr, merge]));
    const askedAt: Record<string, string> = { ...(saved?.askedAt ?? {}) };
    const known = () => named.flatMap((pr) => merged.get(pr) ?? []);
    const open = named.filter((pr) => !merged.has(pr));
    const order = (pr: number) => askedAt[pr] ? Date.parse(askedAt[pr]!) : -Infinity;
    const batch = [...open].sort((a, b) => order(a) - order(b)).slice(0, LOOKUPS_PER_CHECK);
    try {
      for (let start = 0; start < batch.length; start += PARALLEL_LOOKUPS) {
        const group = batch.slice(start, start + PARALLEL_LOOKUPS);
        const answers = await Promise.all(group.map((pr) => lookUp(repo, pr, exec)));
        group.forEach((pr, index) => {
          const mergedAt = answers[index];
          if (mergedAt) {
            merged.set(pr, { pr, mergedAt });
            delete askedAt[pr];
          } else askedAt[pr] = new Date(now).toISOString();
        });
      }
    } catch (error) {
      const seen = saved ? ` since ${saved.checkedAt.slice(0, 10)}` : "";
      return { merges: known(), note: `Merged-PR warnings may be missing merges${seen}: ${why(error)}. Only merges this computer already knows about are shown.` };
    }
    const at = new Date(now).toISOString();
    await writeCache({ version: 3, repo, merges: [...merged.values()], askedAt, checkedAt: at }).catch(() => undefined);
    const neverAsked = open.filter((pr) => !merged.has(pr) && !askedAt[pr]).length;
    if (!neverAsked) return { merges: known() };
    return {
      merges: known(),
      note: `Merged-PR warnings asked GitHub about ${named.length - neverAsked} of the ${named.length} pull requests cards name so far; the rest are asked about on the next checks.`,
    };
  })();
  memory.set(repo, { at: now, key, result });
  return result;
}
