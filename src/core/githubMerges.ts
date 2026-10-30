// Merged pull requests from GitHub, for Online Boards worked on from several computers: a merge
// made anywhere counts, not just ones this checkout has fetched. Read with the GitHub CLI (`gh`)
// and whatever account it is signed in to; Planban stores no GitHub token.
//
// Planban asks about each pull request a card names, by repository and number, rather than paging
// through GitHub's lists, whose positions shift whenever a pull request changes. A merge never
// un-happens, so one seen merged is remembered; others are asked about again later. The memory is a
// file used only to save requests: it is read, the lookups are made, and the latest copy is read
// again and merged with the answers before an atomic rename. No lock: a lost update costs one
// extra lookup. Every call has a deadline and a request limit, and anything it couldn't check is
// said in a note, never an error.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultPlanbanRoot } from "./paths";

const GIT_TIMEOUT_MS = 2_000;
const MINUTE = 60_000;
/** Requests one call may make. */
export const REQUESTS_PER_CALL = 20;
/** How long one call may take, all requests together, unless the caller says otherwise. */
export const DEFAULT_DEADLINE_MS = 5_000;
const PARALLEL_REQUESTS = 4;
/** An open pull request is asked about again after this long. */
const ASK_AGAIN_MS = MINUTE;
/** After failed lookups, wait 2, 4, 8 … minutes before the next try, up to an hour. */
const MAX_RETRY_WAIT_MS = 60 * MINUTE;
const RATE_LIMIT_PAUSE_MS = 15 * MINUTE;

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

interface Remembered {
  /** When this pull request was last asked about. The newest answer wins when copies are merged. */
  askedAt: string;
  mergedAt?: string | undefined;
  /** Failed lookups in a row, and why the last one failed. */
  failures: number;
  failure?: string | undefined;
}

interface Memory {
  version: 5;
  /** By "owner/name#123", lower-cased. */
  prs: Record<string, Remembered>;
  /** Per repository, lower-cased: no requests before this time, after GitHub's rate limit answered. */
  retryAfter: Record<string, string>;
}

export type Run = (command: string, args: string[], options: { cwd?: string; timeout: number; signal?: AbortSignal }) => Promise<string>;

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

const memoryPath = () => join(defaultPlanbanRoot(), "online", "github", "merges.json");
const keyOf = (ref: GitHubRef) => `${ref.repo.toLowerCase()}#${ref.number}`;
const time = (iso: string | undefined) => iso ? Date.parse(iso) : -Infinity;

async function readMemory(): Promise<Memory> {
  try {
    const saved = JSON.parse(await readFile(memoryPath(), "utf8")) as Memory;
    if (saved.version === 5 && saved.prs && saved.retryAfter) return saved;
  } catch {
    // Nothing saved yet, or unreadable: start again.
  }
  return { version: 5, prs: {}, retryAfter: {} };
}

/** Merges two copies: a merge is kept for good; otherwise the newest answer about each pull request wins. */
function mergeMemory(a: Memory, b: Memory): Memory {
  const prs = { ...a.prs };
  for (const [key, entry] of Object.entries(b.prs)) {
    const other = prs[key];
    if (!other || (!other.mergedAt && (entry.mergedAt || time(entry.askedAt) > time(other.askedAt)))) prs[key] = entry;
  }
  const retryAfter = { ...a.retryAfter };
  for (const [repo, at] of Object.entries(b.retryAfter)) if (time(at) > time(retryAfter[repo])) retryAfter[repo] = at;
  return { version: 5, prs, retryAfter };
}

async function saveMemory(answers: Memory) {
  const latest = mergeMemory(await readMemory(), answers);
  await mkdir(join(memoryPath(), ".."), { recursive: true });
  const temp = `${memoryPath()}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(latest));
  await rename(temp, memoryPath());
}

const stderrOf = (error: unknown) => String((error as { stderr?: unknown })?.stderr ?? "");
const isNotFound = (error: unknown) => /HTTP 404|Not Found/u.test(stderrOf(error));
const isRateLimited = (error: unknown) => /rate limit|HTTP 429/iu.test(stderrOf(error));

function why(error: unknown): string {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "the GitHub CLI (gh) isn't installed here";
  if (/auth login|not logged|authentication/iu.test(stderrOf(error))) return "the GitHub CLI (gh) isn't signed in here";
  if ((error as { killed?: boolean })?.killed || (error as { name?: string })?.name === "AbortError") return "GitHub took too long to answer";
  return "GitHub couldn't be reached";
}

const TIMED_OUT = Symbol("timed out");

/**
 * Which of the pull requests `refs` names have merged, with when. Asks GitHub about those due a
 * check, at most REQUESTS_PER_CALL requests, taking each repository in turn so none starves
 * another, and stops at the deadline. Merges already known are always returned.
 */
export async function githubMerges(refs: GitHubRef[], options: { now?: number; exec?: Run; deadlineMs?: number } = {}): Promise<GitHubMerges> {
  const now = options.now ?? Date.now();
  const exec = options.exec ?? ghRunner;
  const budgetMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const deadline = Date.now() + budgetMs;
  // One request gets at most a third of the call's time, so a hung repository can't use it all.
  const requestMs = Math.max(1, Math.floor(budgetMs / 3));
  const wanted = [...new Map(refs.map((ref) => [keyOf(ref), ref])).values()];
  const memory = await readMemory();
  const answers: Memory = { version: 5, prs: {}, retryAfter: {} };
  const notes: string[] = [];
  const at = new Date(now).toISOString();

  // Due: not known merged, not paused by a rate limit, and not asked about too recently.
  const paused = (repo: string) => time(memory.retryAfter[repo.toLowerCase()]) > now;
  const due = wanted.filter((ref) => {
    const known = memory.prs[keyOf(ref)];
    if (known?.mergedAt || paused(ref.repo)) return false;
    if (!known) return true;
    const wait = known.failures ? Math.min(2 ** known.failures * MINUTE, MAX_RETRY_WAIT_MS) : ASK_AGAIN_MS;
    return now - time(known.askedAt) >= wait;
  });
  // Each repository in turn, the one whose oldest due check has waited longest first, and the
  // longest since asked first within each: across calls, every repository gets its turn.
  const askedAt = (ref: GitHubRef) => time(memory.prs[keyOf(ref)]?.askedAt);
  const byRepo = new Map<string, GitHubRef[]>();
  for (const ref of due) byRepo.set(ref.repo.toLowerCase(), [...(byRepo.get(ref.repo.toLowerCase()) ?? []), ref]);
  for (const list of byRepo.values()) list.sort((a, b) => askedAt(a) - askedAt(b));
  const repos = [...byRepo.values()].sort((a, b) => askedAt(a[0]!) - askedAt(b[0]!));
  const queue: GitHubRef[] = [];
  for (let round = 0; queue.length < due.length; round += 1) for (const list of repos) if (list[round]) queue.push(list[round]!);

  // One request, counted against the call's limit (access checks included): stops at its own
  // timeout or the call's deadline, whichever is first, even if gh hangs. TIMED_OUT also means
  // the limit left no room for it; either way, what it was for is deferred.
  let requests = 0;
  const ask = async (args: string[]): Promise<string | typeof TIMED_OUT> => {
    const left = Math.min(deadline - Date.now(), requestMs);
    if (left <= 0 || requests >= REQUESTS_PER_CALL) return TIMED_OUT;
    requests += 1;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolveTimeout) => { timer = setTimeout(() => { controller.abort(); resolveTimeout(TIMED_OUT); }, left); });
    try {
      return await Promise.race([exec("gh", ["api", "--method", "GET", ...args], { timeout: left, signal: controller.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  // A 404 means "no such pull request" only if the repository can be seen, checked in this call.
  const visible = new Map<string, Promise<boolean | typeof TIMED_OUT>>();
  const canSee = (repo: string) => {
    const key = repo.toLowerCase();
    if (!visible.has(key)) {
      visible.set(key, (async () => {
        try {
          return (await ask([`repos/${repo}`, "--jq", ".full_name"])) === TIMED_OUT ? TIMED_OUT : true;
        } catch (error) {
          if (isNotFound(error)) return false;
          throw error;
        }
      })());
    }
    return visible.get(key)!;
  };

  const unchecked: GitHubRef[] = [];
  const hidden = new Set<string>();
  let failure: string | null = null;
  const lookUp = async (ref: GitHubRef) => {
    const key = keyOf(ref);
    if (paused(ref.repo) || time(answers.retryAfter[ref.repo.toLowerCase()]) > now) return void unchecked.push(ref);
    try {
      const answer = await ask([`repos/${ref.repo}/pulls/${ref.number}`, "--jq", "{number, merged_at}"]);
      if (answer === TIMED_OUT) return void unchecked.push(ref);
      const row = JSON.parse(answer) as { merged_at?: unknown };
      const mergedAt = typeof row.merged_at === "string" && Number.isFinite(Date.parse(row.merged_at)) ? row.merged_at : undefined;
      answers.prs[key] = { askedAt: at, mergedAt, failures: 0 };
    } catch (error) {
      if (isRateLimited(error)) {
        answers.retryAfter[ref.repo.toLowerCase()] = new Date(now + RATE_LIMIT_PAUSE_MS).toISOString();
        return void unchecked.push(ref);
      }
      if (isNotFound(error)) {
        const seen = await canSee(ref.repo).catch((reason: unknown) => ({ reason }));
        if (seen === true) return void (answers.prs[key] = { askedAt: at, failures: 0 });
        if (seen === false) return void hidden.add(ref.repo);
        if (seen === TIMED_OUT) return void unchecked.push(ref);
        error = seen.reason;
      }
      failure = why(error);
      const failures = (memory.prs[key]?.failures ?? 0) + 1;
      answers.prs[key] = { askedAt: at, failures, failure };
    }
  };
  let next = 0;
  while (next < queue.length && requests < REQUESTS_PER_CALL && Date.now() < deadline) {
    const group = queue.slice(next, next + Math.min(PARALLEL_REQUESTS, REQUESTS_PER_CALL - requests));
    next += group.length;
    await Promise.all(group.map(lookUp));
  }
  const deferred = unchecked.length + (queue.length - next);
  await saveMemory(answers).catch(() => undefined);

  const known = mergeMemory(memory, answers);
  const merges = wanted.flatMap((ref) => known.prs[keyOf(ref)]?.mergedAt ? [{ ...ref, mergedAt: known.prs[keyOf(ref)]!.mergedAt! }] : []);
  const failed = wanted.find((ref) => !known.prs[keyOf(ref)]?.mergedAt && known.prs[keyOf(ref)]?.failures);
  if (failed) notes.push(`Merged-PR warnings may be missing merges: ${failure ?? known.prs[keyOf(failed)]!.failure ?? "GitHub couldn't be reached"}. Only merges this computer already knows about are shown.`);
  for (const repo of hidden) notes.push(`Merged-PR warnings can't see ${repo}: the GitHub CLI (gh) account here has no access to it.`);
  for (const repo of new Set(wanted.map((ref) => ref.repo).filter((repo) => time(known.retryAfter[repo.toLowerCase()]) > now))) {
    notes.push(`GitHub's rate limit was reached for ${repo}, so its merge checks pause until ${known.retryAfter[repo.toLowerCase()]!.slice(11, 16)} UTC.`);
  }
  if (deferred) notes.push(`${deferred} merge check${deferred === 1 ? " was" : "s were"} deferred to a later check (each check asks GitHub at most ${REQUESTS_PER_CALL} times, within a time limit), so some merges may not show yet.`);
  return { merges, notes };
}
