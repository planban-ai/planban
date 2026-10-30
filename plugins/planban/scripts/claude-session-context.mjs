#!/usr/bin/env node
// Claude Code SessionStart hook: when the project uses Planban, add one short orientation line to the session context.
// Output goes to stdout, which Claude Code adds as context. Never fail the session: exit 0 on any error.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePlanbanProjectDir } from "./project-dir.mjs";
import { loadRuntimeTypescript } from "./runtime-dependencies.mjs";
import { resolvePlanbanRuntime } from "./runtime-root.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STALENESS_BUDGET_MS = 3_000;

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function planbanSessionContext({ projectDir: requestedDir, port = 4317 }) {
  const discovery = resolvePlanbanProjectDir(requestedDir);
  const projectDir = discovery.projectDir;
  const manifestPath = join(projectDir, ".planban/project.json");
  if (!existsSync(manifestPath)) return null;
  let repoId = null;
  let onlineUrl = null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    repoId = typeof manifest.repoId === "string" && manifest.repoId.trim() ? manifest.repoId.trim() : null;
    onlineUrl = manifest.storage?.kind === "online" && typeof manifest.storage.url === "string" ? manifest.storage.url : null;
  } catch {
    return null;
  }
  if (!repoId) return null;
  const boardUrl = `http://127.0.0.1:${port}/boards/${encodeURIComponent(repoId)}`;
  const where = discovery.via === "worktree"
    ? ` This session runs in a linked git worktree; the board belongs to the main checkout at ${projectDir}, and Planban resolves it automatically when you pass this worktree's path as \`cwd\`.`
    : "";
  return [
    `This project tracks its work in Planban (board \`${repoId}\`, usually ${boardUrl}).${where}`,
    `Read \`${join(projectDir, ".planban/agent-context.md")}\` before reading or changing roadmap state, and use the Planban MCP tools (\`planban_*\`) with this repo's absolute path as \`cwd\`.`,
    "After opening the board or finishing a batch of Planning changes, include the clickable verified board URL from the tool result in your reply.",
    ...(onlineUrl
      ? [`This board is online at ${onlineUrl}: read and edit it only through the Planban tools, never local files. If Planban says this computer isn't signed in, ask the person to sign in.`]
      : existsSync(join(projectDir, ".planban/online-board.json"))
        ? ["This project's board was taken online on another computer, so this copy is read-only. Ask the person to sign in and choose \"Use the online board\"."]
        : []),
  ].join("\n");
}

// The last line worked out for each project, so a check that runs out of time can still say what it last saw.
function lastLinePath(projectDir) {
  const root = process.env.PLANBAN_HOME ? resolve(process.env.PLANBAN_HOME) : join(homedir(), ".planban");
  return join(root, "session-lines", `${createHash("sha256").update(projectDir).digest("hex").slice(0, 24)}.json`);
}

function saveLastLine(projectDir, line) {
  try {
    const path = lastLinePath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify({ line, at: new Date().toISOString() }));
    renameSync(`${path}.${process.pid}.tmp`, path);
  } catch {
    // Best effort: the next session just has no earlier line to fall back on.
  }
}

function readLastLine(projectDir) {
  try {
    const saved = JSON.parse(readFileSync(lastLinePath(projectDir), "utf8"));
    return typeof saved.line === "string" && typeof saved.at === "string" ? saved : null;
  } catch {
    return null;
  }
}

async function computeLine(projectDir) {
  const runtimeRoot = resolvePlanbanRuntime(PLUGIN_ROOT);
  if (!existsSync(join(runtimeRoot, "node_modules/tsx"))) return null;
  await loadRuntimeTypescript(runtimeRoot);
  const { projectStaleness } = await import(pathToFileURL(join(runtimeRoot, "src/core/stalenessSources.ts")).href);
  const { stalenessAttention, stalenessLine } = await import(pathToFileURL(join(runtimeRoot, "src/core/staleness.ts")).href);
  // GitHub gets two seconds of the hook's three, so a slow answer still leaves a line with a note.
  const board = await projectStaleness(projectDir, { githubDeadlineMs: 2_000 });
  return board ? stalenessLine(stalenessAttention(board.staleness, board.items), "planban_status") : null;
}

// One line naming stale active cards, from the same core function as the MCP tools and the board chip.
// Returns null when the project has no board or nothing needs attention. If the check runs out of
// time (an Online Board or GitHub being slow), it says so, with the last warnings it saw if any.
export async function planbanStalenessLine({ projectDir: requestedDir, budgetMs = STALENESS_BUDGET_MS, compute = computeLine }) {
  const projectDir = resolvePlanbanProjectDir(requestedDir).projectDir;
  if (!existsSync(join(projectDir, ".planban/project.json"))) return null;
  const TIMED_OUT = Symbol("timed out");
  const line = compute(projectDir).then((value) => {
    saveLastLine(projectDir, value ?? null);
    return value ?? null;
  }, () => null);
  let timer;
  const timeout = new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(TIMED_OUT), budgetMs); });
  try {
    const result = await Promise.race([line, timeout]);
    if (result !== TIMED_OUT) return result;
    const last = readLastLine(projectDir);
    const lead = "Planban couldn't check which cards look stale in time";
    if (!last?.line) return `${lead}; check with planban_status.`;
    return `${lead}; at the last check (${last.at.slice(0, 10)} ${last.at.slice(11, 16)} UTC): ${last.line}`;
  } finally {
    clearTimeout(timer);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  try {
    const input = readStdinJson();
    const projectDir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
    const context = planbanSessionContext({ projectDir: resolve(projectDir) });
    if (context) {
      const stale = await planbanStalenessLine({ projectDir: resolve(projectDir) });
      process.stdout.write(`${stale ? `${context}\n${stale}` : context}\n`);
    }
  } catch {
    // Orientation is optional; never block the session.
  }
  process.exitCode = 0;
}
