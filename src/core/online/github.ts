// Linking a GitHub repository to an Online Board, from the owner's computer, so the board records
// merged pull requests itself (online/service/convex/github.ts).
//
// The service makes the link and its secret. This computer hands the secret to GitHub once, when
// it adds the repository's webhook through the GitHub CLI (gh) signed in here: on gh's standard
// input, never in its arguments, on disk or in anything printed. Planban stores no GitHub token.
// Linking needs admin access to the repository, which gh checks first.
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
  /** An unfinished link picked up again: its webhook may already be on GitHub. */
  resumed: boolean;
}

/** Whether the account gh is signed in as administers the repository. Linking needs it, to add the webhook. */
async function checkAdmin(repo: string) {
  let permissions: { admin?: unknown } | undefined;
  try {
    permissions = (JSON.parse(await ghRun(["api", `repos/${repo}`])) as { permissions?: { admin?: unknown } }).permissions;
  } catch (error) {
    throw new PlanbanValidationError(`Not linked: ${ghProblem(error, repo)}.`);
  }
  if (permissions?.admin !== true) {
    throw new PlanbanValidationError(`Not linked: the account gh is signed in as doesn't administer ${repo}. Linking needs admin access to the repository, to add its webhook.`);
  }
}

/** The webhook already on GitHub at this link's address, from an earlier attempt that didn't finish. */
async function existingHook(repo: string, webhookUrl: string): Promise<number | null> {
  const pages = JSON.parse(await ghRun(["api", "--paginate", "--slurp", `repos/${repo}/hooks`])) as Array<Array<{ id?: unknown; config?: { url?: unknown } }>>;
  const hook = pages.flat().find((entry) => entry?.config?.url === webhookUrl && typeof entry.id === "number");
  return hook ? hook.id as number : null;
}

/**
 * Links a repository: gh checks the account it is signed in as administers the repository, the
 * service makes the link, gh adds the webhook on GitHub with its secret, and the service records
 * the webhook's id. A link that didn't finish is picked up again: its webhook, found on GitHub by
 * its address, gets the new secret instead of a second webhook being added. If GitHub refuses a
 * new link, the link is removed again.
 */
export async function linkGitHubRepo(cwdInput: string, repo: string) {
  if (!isRepoName(repo)) throw new PlanbanValidationError("Name the repository as owner/name, for example planban-ai/planban.");
  const { url, boardId } = await onlineBoard(cwdInput);
  await checkAdmin(repo);
  const created = await onlineRequest<CreatedLink>(url, boardPath(boardId, "/github/links"), { repo });
  const config = { url: created.webhookUrl, content_type: "json", secret: created.secret, insecure_ssl: "0" };
  let hookId: number;
  let reused = false;
  try {
    const found = created.resumed ? await existingHook(created.repo, created.webhookUrl) : null;
    if (found !== null) {
      await ghRun(["api", "--method", "PATCH", `repos/${created.repo}/hooks/${found}`, "--input", "-"], JSON.stringify({ active: true, events: ["pull_request"], config }));
      hookId = found;
      reused = true;
    } else {
      const hook = JSON.parse(await ghRun(["api", "--method", "POST", `repos/${created.repo}/hooks`, "--input", "-"], JSON.stringify({
        name: "web", active: true, events: ["pull_request"], config,
      }))) as { id?: unknown };
      if (typeof hook.id !== "number") throw new Error("GitHub didn't say which webhook it added.");
      hookId = hook.id;
    }
  } catch (error) {
    // The link goes only if GitHub's own list of webhooks shows none at its address. Otherwise one may
    // be there, so the link stays unfinished and linking or unlinking again can find it by its address.
    if (await verifiedAbsent(created.repo, created.webhookUrl)) {
      await onlineRequest(url, boardPath(boardId, "/github/unlink"), { repo })
        .then(() => onlineRequest(url, boardPath(boardId, "/github/unlink/done"), { repo }))
        .catch(() => undefined);
      throw new PlanbanValidationError(`Not linked: ${ghProblem(error, repo)}.`);
    }
    throw new PlanbanValidationError(`Not linked yet: ${ghProblem(error, repo)}, and Planban couldn't check whether GitHub has a webhook at ${created.webhookUrl}. Run planban online github link ${created.repo} again once you have access, to finish it without adding a second webhook, or planban online github unlink ${created.repo} to remove it.`);
  }
  try {
    await onlineRequest(url, boardPath(boardId, `/github/links/${encodeURIComponent(created.linkId)}/hook`), { hookId });
  } catch {
    throw new PlanbanValidationError(`The webhook was added on GitHub, but Planban couldn't record it. Run planban online github link ${created.repo} again: it finds that webhook and finishes, without adding another.`);
  }
  // GitHub pings a new webhook by itself; an existing one is asked to, so the link can be confirmed.
  if (reused) await ghRun(["api", "--method", "POST", `repos/${created.repo}/hooks/${hookId}/pings`]).catch(() => undefined);
  return {
    linked: created.repo,
    home: created.home,
    note: `${created.home ? `Merged pull requests in ${created.repo} are now recorded on this board, and a bare #123 on a card means ${created.repo}#123.` : `Merged pull requests in ${created.repo} are now recorded on this board; name them on cards as ${created.repo}#123.`} GitHub sends a test delivery now, which confirms the link; until it arrives, merges are credited to you rather than to GitHub. planban online github status shows whether it arrived.`,
  };
}

/** Whether GitHub's list of the repository's webhooks was read and has none at this address. Any failure is not proof. */
async function verifiedAbsent(repo: string, webhookUrl: string): Promise<boolean> {
  try {
    return await existingHook(repo, webhookUrl) === null;
  } catch {
    return false;
  }
}

/** Whether deleting a known webhook failed because GitHub no longer has it. Only a delete's 404 means that. */
const alreadyGone = (error: unknown) => /HTTP 404/u.test(String((error as { stderr?: unknown })?.stderr ?? ""));

/**
 * Unlinks a repository: the service stops accepting its deliveries and forgets the secret at once,
 * gh removes the webhook on GitHub, and then the service forgets the link. A webhook whose id was
 * never recorded is found by its address. The link is forgotten only once GitHub showed the webhook
 * is gone: a successful delete, a 404 deleting the known webhook, or a list of webhooks without its
 * address. Anything else keeps it as "being removed", so running this again finishes.
 */
export async function unlinkGitHubRepo(cwdInput: string, repo: string) {
  if (!isRepoName(repo)) throw new PlanbanValidationError("Name the repository as owner/name, for example planban-ai/planban.");
  const { url, boardId } = await onlineBoard(cwdInput);
  const removed = await onlineRequest<{ repo: string; hookId?: number; webhookUrl: string }>(url, boardPath(boardId, "/github/unlink"), { repo });
  const unfinished = (error: unknown) => ({
    unlinked: removed.repo,
    finished: false,
    note: `Planban no longer accepts its deliveries, but couldn't reach the webhook on GitHub (${ghProblem(error, removed.repo)}). Its address is ${removed.webhookUrl}. Run planban online github unlink ${removed.repo} again once you have access, to finish.`,
  });
  let hookId = removed.hookId ?? null;
  if (hookId === null) {
    try {
      hookId = await existingHook(removed.repo, removed.webhookUrl);
    } catch (error) {
      // Even a 404 here may only mean access was lost, so it isn't proof the webhook is gone.
      return unfinished(error);
    }
  }
  if (hookId !== null) {
    try {
      await ghRun(["api", "--method", "DELETE", `repos/${removed.repo}/hooks/${hookId}`]);
    } catch (error) {
      if (!alreadyGone(error)) return unfinished(error);
    }
  }
  await onlineRequest(url, boardPath(boardId, "/github/unlink/done"), { repo: removed.repo });
  return { unlinked: removed.repo, finished: true, note: "Its webhook was removed from GitHub too." };
}

/** The repositories linked to this project's Online Board, and the last delivery from each. */
export async function gitHubLinkStatus(cwdInput: string) {
  const { url, boardId } = await onlineBoard(cwdInput);
  return onlineRequest<{ links: Array<Record<string, unknown>> }>(url, boardPath(boardId, "/github"));
}
