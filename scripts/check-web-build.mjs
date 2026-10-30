#!/usr/bin/env node
// The board page ships pre-built in dist/web (the plugin installs from git), so a
// saved copy older than its source ships old screens. This rebuilds it and fails
// if the build changes the saved copy. It takes seconds, so the release preflight
// runs it first, on the checkout as it is.
//
// With --hook (from .githooks/pre-push), it checks each commit being pushed instead,
// in a temporary checkout of that commit, so uncommitted work and the branch you
// happen to be on don't affect the answer and nothing in your checkout changes.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platformInvocation } from "./platform-invocation.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const NO_COMMIT = /^0+$/u;

// A hook runs with git's own settings for this repository (GIT_DIR, GIT_INDEX_FILE and
// the rest), which would make git in the temporary checkout read this one instead.
const localGitVariables = spawnSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).stdout?.split(/\s+/u).filter(Boolean) ?? [];
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !localGitVariables.includes(name)));

function git(args, cwd = repoRoot) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env });
}

/** Builds in `cwd`; returns a reason it failed, or null. */
function build(cwd) {
  const invocation = platformInvocation("npm", ["run", "build", "--silent"]);
  const result = spawnSync(invocation.command, invocation.args, { cwd, encoding: "utf8", env });
  if (result.error || result.status !== 0) return `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`.trim() || `exit ${result.status}`;
  return null;
}

/** The saved dist/web files a build in `cwd` changed, or an error. */
function changedBuild(cwd) {
  const saved = git(["status", "--porcelain", "--", "dist/web"], cwd);
  if (saved.error || saved.status !== 0) return { error: `${saved.stderr ?? ""}${saved.error?.message ?? ""}`.trim() };
  return { changed: saved.stdout.trim() };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function checkCommit(commit) {
  const checkout = await mkdtemp(join(tmpdir(), "planban-web-check-"));
  try {
    const added = git(["worktree", "add", "--detach", "--quiet", checkout, commit]);
    if (added.status !== 0) return `couldn't check out ${commit.slice(0, 12)}: ${added.stderr.trim()}`;
    if (!existsSync(join(checkout, "dist", "web"))) return null; // Commits from before the saved board page.
    await symlink(join(repoRoot, "node_modules"), join(checkout, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const failure = build(checkout);
    if (failure) return `the board page didn't build at ${commit.slice(0, 12)}:\n${failure}`;
    const { changed, error } = changedBuild(checkout);
    if (error) return `couldn't compare dist/web at ${commit.slice(0, 12)}: ${error}`;
    return changed ? `dist/web in ${commit.slice(0, 12)} does not match its source. Run npm run build, commit dist/web, then push again.\n${changed}` : null;
  } finally {
    git(["worktree", "remove", "--force", checkout]);
    await rm(checkout, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv.includes("--hook")) {
  if (!existsSync(join(repoRoot, "node_modules", "vite"))) {
    fail("Planban pre-push: can't check the board page because dependencies aren't installed. Run npm ci, then push again.");
  }
  // git passes one "<local ref> <local commit> <remote ref> <remote commit>" line per ref pushed.
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const commits = [...new Set(input.split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u)[1])
    .filter((commit) => commit && !NO_COMMIT.test(commit)))];
  for (const commit of commits) {
    const problem = await checkCommit(commit);
    if (problem) fail(`Planban pre-push: ${problem}`);
  }
} else {
  const failure = build(repoRoot);
  if (failure) fail(`${failure}\nThe board page didn't build.`);
  const { changed, error } = changedBuild(repoRoot);
  if (error || changed) fail(`dist/web does not match the source. The build has updated it: commit dist/web.\n${error ?? changed}`);
}
