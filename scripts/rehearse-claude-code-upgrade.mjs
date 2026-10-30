#!/usr/bin/env node
// Rehearse the Claude Code update path: install the previous public release from a
// local-folder marketplace, update the same checkout to the candidate, then prove the
// plugin, its MCP server, and an existing board all work through Claude Code.
// Runs in an isolated HOME and CLAUDE_CONFIG_DIR with no Claude credentials.
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platformInvocation } from "./platform-invocation.mjs";
import { isTransientInstallFailure, retryOnce } from "./rehearsal-retry.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const PLUGIN_ID = "planban@planban";
const MCP_SERVER_NAME = "plugin:planban:planban";

function parseArgs(argv) {
  const options = { fromVersion: null, expectedVersion: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from-version") options.fromVersion = argv[++index] ?? null;
    else if (arg === "--expected-version") options.expectedVersion = argv[++index] ?? null;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.fromVersion) throw new Error("--from-version is required");
  if (!options.expectedVersion) throw new Error("--expected-version is required");
  return options;
}

// Drop any Claude or Anthropic session state inherited from the caller, so the
// rehearsal proves the update path needs no sign-in and never touches the real profile.
function isolatedBaseEnv() {
  return Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(CLAUDE|ANTHROPIC)/iu.test(key)));
}

function run(command, args, options = {}) {
  const invocation = platformInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...isolatedBaseEnv(), ...options.env },
    input: options.input,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout ?? 300_000,
  });
  if (result.error || result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const detail = output || result.error?.message || `exited with code ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function installedPlugin(env) {
  const plugins = JSON.parse(run("claude", ["plugin", "list", "--json"], { env, cwd: env.HOME }));
  const plugin = plugins.find((entry) => entry.id === PLUGIN_ID);
  if (!plugin) throw new Error(`Claude Code does not list ${PLUGIN_ID} as installed`);
  return plugin;
}

// Start the MCP server exactly as the installed plugin manifest declares it, then
// list tools and read and write the board created by the previous release.
function exerciseMcpServer(plugin, env, projectRoot) {
  const server = plugin.mcpServers?.planban;
  if (!server?.command) throw new Error("installed Claude Code plugin does not declare the planban MCP server");
  const pluginRoot = plugin.readFromFolder ?? plugin.installPath;
  const expand = (value) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code-upgrade-rehearsal", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "planban_status", arguments: { cwd: projectRoot } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "planban_get_card", arguments: { cwd: projectRoot, cardId: "upgrade-proof" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "planban_update_card", arguments: { cwd: projectRoot, cardId: "upgrade-proof", summary: "Updated through Claude Code after upgrade" } } },
  ];
  const stdout = run(expand(server.command), (server.args ?? []).map(expand), {
    cwd: projectRoot,
    env: { ...env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    timeout: 120_000,
  });
  const responses = new Map(stdout.split(/\r?\n/u)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((message) => message.id !== undefined)
    .map((message) => [message.id, message]));
  const result = (id) => {
    const response = responses.get(id);
    if (!response) throw new Error(`MCP server did not answer request ${id}`);
    if (response.error || response.result?.isError) {
      throw new Error(`MCP request ${id} failed: ${JSON.stringify(response.error ?? response.result.content)}`);
    }
    return response.result;
  };
  return {
    toolNames: (result(2).tools ?? []).map((tool) => tool.name),
    status: result(3).structuredContent,
    card: result(4).structuredContent?.card,
    updatedCard: result(5).structuredContent?.card,
  };
}

const options = parseArgs(process.argv.slice(2));
const candidateSha = run("git", ["rev-parse", "HEAD"]);
const sourceUrl = run("git", ["remote", "get-url", "origin"]);
const claudeVersion = run("claude", ["--version"]);
const rehearsalRoot = await mkdtemp(join(tmpdir(), "planban-claude-upgrade-"));

try {
  const checkout = join(rehearsalRoot, "planban");
  const candidateRemote = join(rehearsalRoot, "candidate.git");
  const home = join(rehearsalRoot, "home");
  const claudeConfig = join(rehearsalRoot, "claude-config");
  const planbanHome = join(rehearsalRoot, "planban-home");
  const projectRoot = join(rehearsalRoot, "project");
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeConfig, PLANBAN_HOME: planbanHome };
  const planban = (args) => run("node", ["--import", "tsx/esm", "src/cli.ts", ...args], { cwd: checkout, env });

  await Promise.all([home, claudeConfig, planbanHome, projectRoot].map((path) => mkdir(path)));

  // Install the previous public release the way a Claude Code user does.
  // Setup gets one retry for a failed clone or a dropped download; the checks below don't.
  const removeCheckout = () => rm(checkout, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  await retryOnce("Cloning the previous public release", () => run("git", ["clone", "--quiet", "--branch", `v${options.fromVersion}`, sourceUrl, checkout]), { beforeRetry: removeCheckout });
  const installDependencies = () => retryOnce("Installing dependencies", () => run("npm", ["install", "--no-audit", "--no-fund"], { cwd: checkout }), {
    shouldRetry: isTransientInstallFailure,
    beforeRetry: () => rm(join(checkout, "node_modules"), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }),
  });
  await installDependencies();
  run("claude", ["plugin", "marketplace", "add", checkout], { env, cwd: home });
  run("claude", ["plugin", "install", PLUGIN_ID], { env, cwd: home });
  const before = installedPlugin(env);
  if (before.version !== options.fromVersion) {
    throw new Error(`installed plugin version ${before.version} does not match previous release ${options.fromVersion}`);
  }
  planban(["init", "--cwd", projectRoot, "--repo-id", "claude-upgrade-rehearsal",
    "--title", "Claude Code upgrade rehearsal", "--no-agents"]);
  planban(["create-card", "Upgrade proof", "--status", "pending", "--cwd", projectRoot, "--output", "json"]);

  // Update the same checkout to the candidate, then refresh the marketplace and plugin.
  run("git", ["clone", "--quiet", "--bare", repoRoot, candidateRemote]);
  run("git", ["update-ref", "refs/heads/release-candidate", candidateSha], { cwd: candidateRemote });
  run("git", ["remote", "set-url", "origin", candidateRemote], { cwd: checkout });
  run("git", ["fetch", "--quiet", "origin", "release-candidate"], { cwd: checkout });
  run("git", ["checkout", "--quiet", "--detach", candidateSha], { cwd: checkout });
  await installDependencies();
  run("claude", ["plugin", "marketplace", "add", checkout], { env, cwd: home });
  run("claude", ["plugin", "update", PLUGIN_ID], { env, cwd: home });

  const after = installedPlugin(env);
  if (after.version !== options.expectedVersion) {
    throw new Error(`Claude Code plugin version ${after.version} does not match candidate ${options.expectedVersion}`);
  }
  if (after.enabled !== true) throw new Error("Claude Code plugin is not enabled after the update");

  const mcpList = run("claude", ["mcp", "list"], { env, cwd: home, timeout: 180_000 });
  const serverLine = mcpList.split(/\r?\n/u).find((line) => line.startsWith(`${MCP_SERVER_NAME}:`));
  if (!serverLine || !/Connected/u.test(serverLine)) {
    throw new Error(`Claude Code does not report the Planban MCP server as connected:\n${mcpList}`);
  }

  const mcp = exerciseMcpServer(after, env, projectRoot);
  for (const tool of ["planban_status", "planban_get_card", "planban_update_card"]) {
    if (!mcp.toolNames.includes(tool)) throw new Error(`MCP tools list is missing ${tool}`);
  }
  if (!mcp.status?.initialized || mcp.status.repoId !== "claude-upgrade-rehearsal") {
    throw new Error("board created by the previous release is not visible through the updated MCP server");
  }
  if (mcp.status.version?.version !== options.expectedVersion) {
    throw new Error(`MCP server reports version ${mcp.status.version?.version ?? "missing"}, expected ${options.expectedVersion}`);
  }
  if (mcp.card?.id !== "upgrade-proof" || mcp.card.title !== "Upgrade proof") {
    throw new Error("updated MCP server could not read the board created by the previous release");
  }
  if (mcp.updatedCard?.summary !== "Updated through Claude Code after upgrade") {
    throw new Error("updated MCP server did not apply a write to the board created by the previous release");
  }
  const reread = JSON.parse(planban(["get-card", "upgrade-proof", "--cwd", projectRoot, "--output", "json"]));
  if (reread.summary !== "Updated through Claude Code after upgrade") {
    throw new Error("write made through the updated MCP server did not persist on the board");
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    claudeCodeVersion: claudeVersion,
    fromVersion: options.fromVersion,
    expectedVersion: options.expectedVersion,
    candidateSha,
    pluginVersion: after.version,
    mcpServerConnected: true,
    mcpToolsListed: mcp.toolNames.length,
    boardPreserved: true,
    boardReadable: true,
    boardWritable: true,
  }, null, 2) + "\n");
} finally {
  await rm(rehearsalRoot, { recursive: true, force: true });
}
