// Linking a GitHub repository to an Online Board, from the owner's computer, so the board records
// merged pull requests itself (online/service/convex/github.ts).
//
// The service makes the link and its secret. This computer hands the secret to GitHub once, when
// it adds the repository's webhook through the GitHub CLI (gh) signed in here: on gh's standard
// input, never in its arguments, on disk or in anything printed. Planban stores no GitHub token.
import { spawn } from "node:child_process";
import { PlanbanValidationError } from "../boardOperations";
import { isRepoName } from "../landings";
import { readManifest, resolveProjectCwd } from "../storage";
import { boardPath, onlineRequest } from "./client";

/** Runs gh with these arguments and this standard input; resolves with its standard output. */
export type GhRun = (args: string[], input?: string) => Promise<string>;

const GH_TIMEOUT_MS = 30_000;

export const runGh: GhRun = (args, input) => new Promise((resolveRun, rejectRun) => {
  const child = spawn("gh", args, { windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill(), GH_TIMEOUT_MS);
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", (error) => { clearTimeout(timer); rejectRun(error); });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code === 0) resolveRun(stdout);
    else rejectRun(Object.assign(new Error(`gh exited with ${code}`), { stderr }));
  });
  child.stdin.end(input ?? "");
});

let ghRun: GhRun = runGh;

/** Replaces how gh is run, for tests; no argument restores the real one. */
export function useGhRunner(run?: GhRun) {
  ghRun = run ?? runGh;
}

async function onlineBoard(cwdInput: string) {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled || manifest.storage?.kind !== "online") throw new PlanbanValidationError("This project does not point to an Online Board. GitHub repositories link to Online Boards only.");
  return { url: manifest.storage.url, boardId: manifest.storage.boardId };
}

/** Why gh failed, in plain words, without repeating anything it was sent. */
function ghProblem(error: unknown, repo: string): string {
  const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "the GitHub CLI (gh) isn't installed on this computer";
  if (/auth login|not logged|authentication/iu.test(stderr)) return "the GitHub CLI (gh) isn't signed in here; run gh auth login";
  if (/HTTP 404|Not Found/u.test(stderr)) return `GitHub says ${repo} doesn't exist, or the account gh is signed in as can't administer it`;
  if (/HTTP 403|admin|permission/iu.test(stderr)) return `the account gh is signed in as can't add webhooks to ${repo}; it needs admin access to the repository`;
  if (/HTTP 422/u.test(stderr)) return `GitHub refused the webhook for ${repo}`;
  return "GitHub couldn't be reached";
}

interface CreatedLink {
  repo: string;
  home: boolean;
  linkId: string;
  webhookUrl: string;
  secret: string;
}

/**
 * Links a repository: the service makes the link, gh adds the webhook on GitHub with its secret,
 * and the service records the webhook's id. If GitHub refuses, the link is removed again.
 */
export async function linkGitHubRepo(cwdInput: string, repo: string) {
  if (!isRepoName(repo)) throw new PlanbanValidationError("Name the repository as owner/name, for example planban-ai/planban.");
  const { url, boardId } = await onlineBoard(cwdInput);
  const created = await onlineRequest<CreatedLink>(url, boardPath(boardId, "/github/links"), { repo });
  let hookId: number;
  try {
    const hook = JSON.parse(await ghRun(["api", "--method", "POST", `repos/${repo}/hooks`, "--input", "-"], JSON.stringify({
      name: "web",
      active: true,
      events: ["pull_request"],
      config: { url: created.webhookUrl, content_type: "json", secret: created.secret, insecure_ssl: "0" },
    }))) as { id?: unknown };
    if (typeof hook.id !== "number") throw new Error("GitHub didn't say which webhook it added.");
    hookId = hook.id;
  } catch (error) {
    await onlineRequest(url, boardPath(boardId, "/github/unlink"), { repo }).catch(() => undefined);
    throw new PlanbanValidationError(`Not linked: ${ghProblem(error, repo)}.`);
  }
  await onlineRequest(url, boardPath(boardId, `/github/links/${encodeURIComponent(created.linkId)}/hook`), { hookId });
  return {
    linked: created.repo,
    home: created.home,
    note: `${created.home ? `Merged pull requests in ${created.repo} are now recorded on this board, and a bare #123 on a card means ${created.repo}#123.` : `Merged pull requests in ${created.repo} are now recorded on this board; name them on cards as ${created.repo}#123.`} GitHub sends a test delivery now; planban online github status shows whether it arrived.`,
  };
}

/** Unlinks a repository: the service forgets the link and its secret, and gh removes the webhook on GitHub. */
export async function unlinkGitHubRepo(cwdInput: string, repo: string) {
  if (!isRepoName(repo)) throw new PlanbanValidationError("Name the repository as owner/name, for example planban-ai/planban.");
  const { url, boardId } = await onlineBoard(cwdInput);
  const removed = await onlineRequest<{ repo: string; hookId?: number }>(url, boardPath(boardId, "/github/unlink"), { repo });
  if (removed.hookId === undefined) return { unlinked: removed.repo, note: "No webhook was recorded for it; if GitHub still has one, remove it under the repository's Settings, Webhooks." };
  try {
    await ghRun(["api", "--method", "DELETE", `repos/${removed.repo}/hooks/${removed.hookId}`]);
    return { unlinked: removed.repo, note: "Its webhook was removed from GitHub too." };
  } catch (error) {
    return { unlinked: removed.repo, note: `Planban no longer accepts its deliveries, but its webhook is still on GitHub (${ghProblem(error, removed.repo)}). Remove it under the repository's Settings, Webhooks.` };
  }
}

/** The repositories linked to this project's Online Board, and the last delivery from each. */
export async function gitHubLinkStatus(cwdInput: string) {
  const { url, boardId } = await onlineBoard(cwdInput);
  return onlineRequest<{ links: Array<Record<string, unknown>> }>(url, boardPath(boardId, "/github"));
}
