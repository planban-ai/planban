#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { auditReleasePolicy } from "./release-policy.mjs";
import { platformInvocation } from "./platform-invocation.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

function run(command, args) {
  const invocation = platformInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ? `: ${result.error.message}` : "";
    process.stderr.write(`\nRelease preflight failed while running: ${command} ${args.join(" ")}${detail}\n`);
    process.exit(result.status ?? 1);
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(repoRoot, relativePath), "utf8"));
}

const packageJson = await readJson("package.json");
const packageLock = await readJson("package-lock.json");
const releaseManifest = await readJson("release/latest.json");
const pluginManifest = await readJson("plugins/planban/.codex-plugin/plugin.json");
const claudePluginManifest = await readJson("plugins/planban/.claude-plugin/plugin.json");
const claudeMarketplace = await readJson(".claude-plugin/marketplace.json");
const versionSource = await readFile(join(repoRoot, "src/core/version.ts"), "utf8");
const workflowSources = Object.fromEntries(await Promise.all([
  ".github/workflows/ci.yml",
  ".github/workflows/release-readiness.yml",
].map(async (path) => [path, await readFile(join(repoRoot, path), "utf8")])));
const remoteResult = spawnSync("git", ["remote", "get-url", "origin"], {
  cwd: repoRoot,
  encoding: "utf8",
});
const findings = [];

if (packageJson.version !== releaseManifest.version) {
  findings.push(`package.json version ${packageJson.version} does not match release/latest.json ${releaseManifest.version}`);
}
if (packageLock.version !== releaseManifest.version || packageLock.packages?.[""]?.version !== releaseManifest.version) {
  findings.push(`package-lock.json root versions do not match release/latest.json ${releaseManifest.version}`);
}
if (pluginManifest.version !== releaseManifest.pluginVersion) {
  findings.push(`plugin manifest ${pluginManifest.version} does not match pluginVersion ${releaseManifest.pluginVersion}`);
}
if (claudePluginManifest.version !== releaseManifest.pluginVersion) {
  findings.push(`Claude Code plugin manifest ${claudePluginManifest.version} does not match pluginVersion ${releaseManifest.pluginVersion}`);
}
if (claudeMarketplace.metadata?.version !== releaseManifest.pluginVersion) {
  findings.push(`Claude Code marketplace version ${claudeMarketplace.metadata?.version} does not match pluginVersion ${releaseManifest.pluginVersion}`);
}
if (claudePluginManifest.name !== pluginManifest.name || claudeMarketplace.plugins?.[0]?.name !== pluginManifest.name) {
  findings.push("Codex and Claude Code plugin manifests must share the plugin name");
}
if (releaseManifest.version !== releaseManifest.pluginVersion || releaseManifest.version !== releaseManifest.mcpVersion) {
  findings.push("release version, pluginVersion, and mcpVersion must match");
}
if (!releaseManifest.releaseNotesUrl?.endsWith(`/v${releaseManifest.version}`)) {
  findings.push(`release notes URL does not end with /v${releaseManifest.version}`);
}
for (const [constantName, expectedVersion] of [
  ["PLANBAN_VERSION", releaseManifest.version],
  ["PLANBAN_PLUGIN_VERSION", releaseManifest.pluginVersion],
  ["PLANBAN_MCP_VERSION", releaseManifest.mcpVersion],
]) {
  const match = versionSource.match(new RegExp(`export const ${constantName} = "([^"]+)";`, "u"));
  if (match?.[1] !== expectedVersion) {
    findings.push(`src/core/version.ts ${constantName} ${match?.[1] ?? "missing"} does not match ${expectedVersion}`);
  }
}

findings.push(...auditReleasePolicy({
  remoteUrl: remoteResult.status === 0 ? remoteResult.stdout.trim() : "",
  workflows: workflowSources,
  packageJson,
  packageLock,
}));

if (findings.length > 0) {
  process.stderr.write(JSON.stringify({ ok: false, findings }, null, 2) + "\n");
  process.exit(1);
}

// First, as it takes seconds: a fresh build must leave the saved board page unchanged.
run("node", ["scripts/check-web-build.mjs"]);
run("npm", ["run", "typecheck"]);
run("npm", ["test"]);
run("npm", ["audit", "--audit-level=high"]);
run("npm", ["run", "smoke"]);
run("node", ["scripts/verify-planban-mcp.mjs"]);
run("node", ["scripts/verify-cold-install.mjs"]);
run("node", ["scripts/verify-cache-launcher.mjs", "--runtime-root", repoRoot]);

process.stdout.write(JSON.stringify({
  ok: true,
  version: releaseManifest.version,
  checked: [
    "version consistency",
    "remote-owner Linux runner policy",
    "Codex and Claude Code upgrade rehearsals required for release readiness",
    "lockfile dependency install-script allowlist",
    "build",
    "saved board page matches its source",
    "typecheck",
    "tests",
    "high-severity dependency audit",
    "HTTP smoke",
    "MCP verifier",
    "cold MCP, CLI, and board installation verifier",
    "cache launcher and stale-server repair verifier",
  ],
}, null, 2) + "\n");
