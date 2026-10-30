// Merged pull requests from GitHub, for Online Boards worked on from several computers: a merge
// made anywhere counts, not just ones this checkout has fetched. Read with the GitHub CLI (`gh`)
// and whatever account it is signed in to; Planban stores no GitHub token.
//
// Planban asks about each pull request a card names, by repository and number, rather than paging
// through GitHub's lists, whose positions shift whenever a pull request changes. A merge never
// un-happens, so one seen merged is kept for good; others are asked about again later. What is
// learned, when each pull request was last asked about, and a lookup budget shared by every
// process on this computer live in one file, changed only under a file lock. Best effort: anything
// that stops a lookup leaves the merges already known and a note saying why, never an error.
import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultPlanbanRoot } from "./paths";
import { withBoardWriteLock } from "./persistence";

const GIT_TIMEOUT_MS = 2_000;
const GH_TIMEOUT_MS = 2_000;
const MINUTE = 60_000;
/** Lookups every process on this computer may make together, per minute. */
export const LOOKUPS_PER_MINUTE = 20;
const PARALLEL_LOOKUPS = 4;
/** An open pull request is asked about again after this long. */
const ASK_AGAIN_MS = MINUTE;
/** After failed lookups, wait 2, 4, 8 … minutes before the next try, up to an hour. */
const MAX_RETRY_WAIT_MS = 60 * MINUTE;
const RATE_LIMIT_PAUSE_MS = 15 * MINUTE;
/** How long a "can't see this repository" answer stands, and a "can see it" one. */
const HIDDEN_CHECK_MS = 60 * MINUTE;
const VISIBLE_CHECK_MS = 24 * 60 * MINUTE;

export interface GitHubRef {
  /** "owner/name". */
  repo: string;
  number: number;
}

export interface GitHubMerge extends GitHubRef {
  mergedAt: string;
}

export interface GitHubMerges {
  merges: GitHubMerge[];
  /** Why some merges may be missing, in plain words. */
  notes: string[];
}

interface LookupState {
  version: 4;
  /** Merge times by "owner/name#123", lower-cased. Permanent. */
  merged: Record<string, string>;
  /** Pull requests asked about and not merged (or not found): when, and failures in a row. */
  asked: Record<string, { at: string; failures: number }>;
  /** Whether the gh account here can see each repository, and when that was checked. */
  access: Record<string, { visible: boolean; at: string }>;
  /** Lookups made in the current minute, by every process. */
  budget: { from: string; used: number };
  /** Set after GitHub's rate limit answered: no lookups until then. */
  pausedUntil?: string | undefined;
  /** Why the last failed lookup failed, said while any pull request waits to be tried again. */
  lastFailure?: string | undefined;
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

// gh is run directly, never through a shell: every Windows install of it is gh.exe, and its
// --jq argument holds characters cmd.exe would read as commands.
let ghRunner: Run = runCommand;

/** Replaces how gh is run, for tests; no argument restores the real one. */
export function useGitHubRunner(exec?: Run) {
  ghRunner = exec ?? runCommand;
}

const stateRoot = () => join(defaultPlanbanRoot(), "online", "github");
const statePath = () => join(stateRoot(), "lookups.json");
const keyOf = (ref: GitHubRef) => `${ref.repo.toLowerCase()}#${ref.number}`;
const emptyState = (now: number): LookupState => ({ version: 4, merged: {}, asked: {}, access: {}, budget: { from: new Date(now).toISOString(), used: 0 } });

/** Reads, changes and saves the state as one step that no other process can interleave with. */
function withState<T>(now: number, change: (state: LookupState) => T): Promise<T> {
  return withBoardWriteLock(stateRoot(), async () => {
    let state = emptyState(now);
    try {
      const saved = JSON.parse(await readFile(statePath(), "utf8")) as LookupState;
      if (saved.version === 4) state = saved;
    } catch {
      // Nothing saved yet, or unreadable: start again.
    }
    const result = change(state);
    const temp = `${statePath()}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(state));
    await rename(temp, statePath());
    return result;
  });
}

const stderrOf = (error: unknown) => String((error as { stderr?: unknown })?.stderr ?? "");
const isNotFound = (error: unknown) => /HTTP 404|Not Found/u.test(stderrOf(error));
const isRateLimited = (error: unknown) => /rate limit|HTTP 429/iu.test(stderrOf(error));

function why(error: unknown): string {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "the GitHub CLI (gh) isn't installed here";
  if (/auth login|not logged|authentication/iu.test(stderrOf(error))) return "the GitHub CLI (gh) isn't signed in here";
  if ((error as { killed?: boolean })?.killed) return "GitHub took too long to answer";
  return "GitHub couldn't be reached";
}

type Outcome = { kind: "merged"; at: string } | { kind: "open" } | { kind: "not-found" } | { kind: "failed"; error: unknown };

async function lookUp(ref: GitHubRef, exec: Run): Promise<Outcome> {
  try {
    const row = JSON.parse(await exec("gh", ["api", "--method", "GET", `repos/${ref.repo}/pulls/${ref.number}`, "--jq", "{number, merged_at}"], { timeout: GH_TIMEOUT_MS })) as { merged_at?: unknown };
    return typeof row.merged_at === "string" && Number.isFinite(Date.parse(row.merged_at)) ? { kind: "merged", at: row.merged_at } : { kind: "open" };
  } catch (error) {
    return isNotFound(error) ? { kind: "not-found" } : { kind: "failed", error };
  }
}

/** Whether the gh account here can see `repo`: GitHub answers 404 for a private one it can't. */
async function canSee(repo: string, exec: Run): Promise<boolean | { error: unknown }> {
  try {
    await exec("gh", ["api", "--method", "GET", `repos/${repo}`, "--jq", ".full_name"], { timeout: GH_TIMEOUT_MS });
    return true;
  } catch (error) {
    return isNotFound(error) ? false : { error };
  }
}

const retryWait = (failures: number) => Math.min(2 ** failures * MINUTE, MAX_RETRY_WAIT_MS);
const time = (iso: string | undefined) => iso ? Date.parse(iso) : -Infinity;

/**
 * Which of the pull requests `refs` names have merged, with when. Asks GitHub about those not
 * already seen merged, within the shared budget: never-asked ones first, then the longest since
 * asked. Merges already known are always returned, whatever else happens.
 */
export async function githubMerges(refs: GitHubRef[], options: { now?: number; exec?: Run } = {}): Promise<GitHubMerges> {
  const now = options.now ?? Date.now();
  const exec = options.exec ?? ghRunner;
  const wanted = [...new Map(refs.map((ref) => [keyOf(ref), ref])).values()];
  const notes: string[] = [];
  const answer = (state: LookupState): GitHubMerges => {
    const merges = wanted.flatMap((ref) => state.merged[keyOf(ref)] ? [{ ...ref, mergedAt: state.merged[keyOf(ref)]! }] : []);
    const visible = (ref: GitHubRef) => state.access[ref.repo.toLowerCase()]?.visible !== false;
    const unasked = wanted.filter((ref) => visible(ref) && !state.merged[keyOf(ref)] && !state.asked[keyOf(ref)]).length;
    if (unasked) notes.push(`Merged-PR warnings asked GitHub about ${wanted.length - unasked} of the ${wanted.length} pull requests cards name so far; the rest are asked about on the next checks.`);
    for (const repo of new Set(wanted.map((ref) => ref.repo).filter((repo) => state.access[repo.toLowerCase()]?.visible === false))) {
      notes.push(`Merged-PR warnings can't see ${repo}: the GitHub CLI (gh) account here has no access to it.`);
    }
    if (wanted.some((ref) => !state.merged[keyOf(ref)] && (state.asked[keyOf(ref)]?.failures ?? 0) > 0)) {
      notes.push(`Merged-PR warnings may be missing merges: ${state.lastFailure ?? "GitHub couldn't be reached"}. Only merges this computer already knows about are shown.`);
    }
    if (time(state.pausedUntil) > now) notes.push(`GitHub's rate limit was reached, so merged-PR checks pause until ${state.pausedUntil!.slice(11, 16)} UTC.`);
    return { merges, notes: [...new Set(notes)] };
  };
  try {
    // 1. Claim what to ask about, under the lock, so processes running at once share the budget
    //    and don't ask about the same pull request twice.
    const previous = new Map<string, LookupState["asked"][string] | undefined>();
    const knownVisible = new Set<string>();
    const batch = await withState(now, (state) => {
      if (now - time(state.budget.from) >= MINUTE) state.budget = { from: new Date(now).toISOString(), used: 0 };
      if (time(state.pausedUntil) > now) return [];
      const due = wanted.filter((ref) => {
        const key = keyOf(ref);
        if (state.merged[key]) return false;
        const access = state.access[ref.repo.toLowerCase()];
        if (access && !access.visible && now - time(access.at) < HIDDEN_CHECK_MS) return false;
        const asked = state.asked[key];
        return !asked || now - time(asked.at) >= (asked.failures ? retryWait(asked.failures) : ASK_AGAIN_MS);
      }).sort((a, b) => time(state.asked[keyOf(a)]?.at) - time(state.asked[keyOf(b)]?.at));
      const claimed = due.slice(0, Math.max(0, LOOKUPS_PER_MINUTE - state.budget.used));
      for (const [repo, access] of Object.entries(state.access)) if (access.visible && now - time(access.at) < VISIBLE_CHECK_MS) knownVisible.add(repo);
      state.budget.used += claimed.length;
      for (const ref of claimed) {
        previous.set(keyOf(ref), state.asked[keyOf(ref)]);
        state.asked[keyOf(ref)] = { at: new Date(now).toISOString(), failures: state.asked[keyOf(ref)]?.failures ?? 0 };
      }
      return claimed;
    });

    // 2. Ask, outside the lock. Each answer stands on its own: one failure doesn't lose the others.
    const outcomes = new Map<string, Outcome>();
    let rateLimited = false;
    for (let start = 0; start < batch.length && !rateLimited; start += PARALLEL_LOOKUPS) {
      const group = batch.slice(start, start + PARALLEL_LOOKUPS);
      const settled = await Promise.all(group.map((ref) => lookUp(ref, exec)));
      group.forEach((ref, index) => outcomes.set(keyOf(ref), settled[index]!));
      rateLimited = settled.some((outcome) => outcome.kind === "failed" && isRateLimited(outcome.error));
    }
    // A 404 means "no such pull request" only when the repository itself can be seen.
    const access = new Map<string, boolean>();
    const notFoundRepos = new Set(batch.filter((ref) => outcomes.get(keyOf(ref))?.kind === "not-found").map((ref) => ref.repo.toLowerCase()).filter((repo) => !knownVisible.has(repo)));
    for (const repo of notFoundRepos) {
      const seen = await canSee(repo, exec);
      if (typeof seen === "boolean") access.set(repo, seen);
      for (const ref of batch) {
        if (ref.repo.toLowerCase() !== repo || outcomes.get(keyOf(ref))?.kind !== "not-found" || seen === true) continue;
        // Can't see the repository (or couldn't tell): not an answer about the pull request.
        if (seen === false) outcomes.delete(keyOf(ref));
        else outcomes.set(keyOf(ref), { kind: "failed", error: seen.error });
      }
    }
    const failure = [...outcomes.values()].find((outcome): outcome is Extract<Outcome, { kind: "failed" }> => outcome.kind === "failed" && !isRateLimited(outcome.error));

    // 3. Record the answers into the latest saved state, under the lock.
    return await withState(now, (state) => {
      const at = new Date(now).toISOString();
      for (const [repo, visible] of access) state.access[repo] = { visible, at };
      for (const ref of batch) {
        const key = keyOf(ref);
        const outcome = outcomes.get(key);
        if (!outcome) {
          // Not asked (stopped by the rate limit) or in a repository that can't be seen: as it was.
          const before = previous.get(key);
          if (before) state.asked[key] = before;
          else delete state.asked[key];
          continue;
        }
        if (outcome.kind === "merged") {
          state.merged[key] = outcome.at;
          delete state.asked[key];
        } else {
          state.asked[key] = { at, failures: outcome.kind === "failed" ? (state.asked[key]?.failures ?? 0) + 1 : 0 };
        }
      }
      if (rateLimited) state.pausedUntil = new Date(now + RATE_LIMIT_PAUSE_MS).toISOString();
      if (failure) state.lastFailure = why(failure.error);
      return answer(state);
    });
  } catch (error) {
    // The saved state itself couldn't be used: say so; the local git log still counts.
    return { merges: [], notes: [`Merged-PR warnings couldn't use what this computer learned from GitHub: ${(error as Error).message}.`] };
  }
}
