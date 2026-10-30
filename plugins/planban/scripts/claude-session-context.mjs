#!/usr/bin/env node
// Claude Code SessionStart hook: when the project uses Planban, add one short orientation line to the session context.
// Output goes to stdout, which Claude Code adds as context. Never fail the session: exit 0 on any error.
import { existsSync, readFileSync } from "node:fs";
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

// One line naming stale active cards, from the same core function as the MCP tools and the board chip.
// Best effort: returns null when the runtime, board or git is unavailable, or when it runs out of time.
export async function planbanStalenessLine({ projectDir: requestedDir }) {
  const line = (async () => {
    const projectDir = resolvePlanbanProjectDir(requestedDir).projectDir;
    if (!existsSync(join(projectDir, ".planban/project.json"))) return null;
    const runtimeRoot = resolvePlanbanRuntime(PLUGIN_ROOT);
    if (!existsSync(join(runtimeRoot, "node_modules/tsx"))) return null;
    await loadRuntimeTypescript(runtimeRoot);
    const { projectStaleness } = await import(pathToFileURL(join(runtimeRoot, "src/core/stalenessSources.ts")).href);
    const { stalenessAttention, stalenessLine } = await import(pathToFileURL(join(runtimeRoot, "src/core/staleness.ts")).href);
    const board = await projectStaleness(projectDir);
    return board ? stalenessLine(stalenessAttention(board.staleness, board.items), "planban_status") : null;
  })().catch(() => null);
  let timer;
  const timeout = new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(null), STALENESS_BUDGET_MS); });
  try {
    return await Promise.race([line, timeout]);
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
