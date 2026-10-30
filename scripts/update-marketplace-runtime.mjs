#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { platformInvocation, stopInvocation } from "./platform-invocation.mjs";

const REQUIRED_RUNTIME_SPECIFIERS = ["tsx/esm", "express", "iconv-lite/encodings"];
const CACHE_DIRECTORY = "planban-marketplace-dependencies";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function dependencyFingerprint(lockfileText) {
  const lockfile = JSON.parse(lockfileText);
  delete lockfile.name;
  delete lockfile.version;
  if (lockfile.packages?.[""] && typeof lockfile.packages[""] === "object") {
    delete lockfile.packages[""].name;
    delete lockfile.packages[""].version;
  }
  return createHash("sha256").update(stableJson(lockfile)).digest("hex");
}

export function runtimeCompatibilityMarker() {
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: process.versions.node.split(".")[0] ?? process.versions.node,
    nodeModulesAbi: process.versions.modules ?? null,
  };
}

function sameMarker(left, right) {
  return Boolean(
    left
    && right
    && left.platform === right.platform
    && left.architecture === right.architecture
    && left.nodeMajor === right.nodeMajor
    && left.nodeModulesAbi === right.nodeModulesAbi,
  );
}

function parseArgs(argv) {
  const options = {
    root: null,
    codexHome: process.env.CODEX_HOME ?? null,
    disableReuse: process.env.PLANBAN_DISABLE_DEPENDENCY_REUSE === "1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = resolve(argv[++index] ?? "");
    else if (arg === "--codex-home") options.codexHome = resolve(argv[++index] ?? "");
    else if (arg === "--disable-reuse") options.disableReuse = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.root) throw new Error("--root is required");
  if (!options.codexHome) throw new Error("--codex-home or CODEX_HOME is required");
  return options;
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

async function readFingerprint(root) {
  const lockfilePath = join(root, "package-lock.json");
  const text = await readFile(lockfilePath, "utf8");
  return dependencyFingerprint(text);
}

async function runtimeModulesResolve(root) {
  try {
    const requireFromRoot = createRequire(join(root, "package.json"));
    for (const specifier of REQUIRED_RUNTIME_SPECIFIERS) requireFromRoot.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

function commandFailure(command, args, result) {
  const detail = (result.stderr || result.stdout).trim().split(/\r?\n/u).slice(-6).join("\n");
  return new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const invocation = platformInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        stopInvocation(child);
        rejectRun(new Error(`${command} ${args.join(" ")} timed out`));
      }, options.timeoutMs)
      : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolveRun({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function cachePaths(root, codexHome) {
  const resolvedCodexHome = resolve(codexHome);
  if (dirname(resolvedCodexHome) === resolvedCodexHome) {
    throw new Error("Codex home cannot be a filesystem root");
  }
  const cacheRoot = resolve(resolvedCodexHome, ".planban-update-cache", CACHE_DIRECTORY);
  const resolvedRoot = resolve(root);
  if (cacheRoot === resolvedRoot || cacheRoot.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("Dependency preservation must stay outside the marketplace root");
  }
  return {
    cacheRoot,
    cachedNodeModules: join(cacheRoot, "node_modules"),
    metadataPath: join(cacheRoot, "metadata.json"),
    rootNodeModules: join(resolvedRoot, "node_modules"),
  };
}

async function readMetadata(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function restorePreservedDirectory(paths) {
  if (!await exists(paths.cachedNodeModules) || await exists(paths.rootNodeModules)) return false;
  await mkdir(dirname(paths.rootNodeModules), { recursive: true });
  await rename(paths.cachedNodeModules, paths.rootNodeModules);
  return true;
}

async function recoverInterruptedPreservation(root, paths, marker) {
  const metadata = await readMetadata(paths.metadataPath);
  if (!metadata || !await exists(paths.cachedNodeModules)) {
    await rm(paths.cacheRoot, { recursive: true, force: true });
    return null;
  }

  const currentFingerprint = await readFingerprint(root).catch(() => null);
  if (
    metadata.root === resolve(root)
    && metadata.fingerprint === currentFingerprint
    && sameMarker(metadata.runtime, marker)
    && !await exists(paths.rootNodeModules)
  ) {
    await restorePreservedDirectory(paths);
    await rm(paths.cacheRoot, { recursive: true, force: true });
    return "restored-interrupted-source";
  }

  await rm(paths.cacheRoot, { recursive: true, force: true });
  return "discarded-stale-cache";
}

async function preserveDependencies(root, paths, marker, disableReuse) {
  if (disableReuse) return { preserved: false, reason: "reuse-disabled" };
  if (!await exists(paths.rootNodeModules)) return { preserved: false, reason: "node-modules-missing" };
  if (!await runtimeModulesResolve(root)) return { preserved: false, reason: "runtime-modules-missing" };

  const fingerprint = await readFingerprint(root).catch(() => null);
  if (!fingerprint) return { preserved: false, reason: "lockfile-unavailable" };

  await rm(paths.cacheRoot, { recursive: true, force: true });
  await mkdir(paths.cacheRoot, { recursive: true });
  const metadata = {
    schemaVersion: 1,
    root: resolve(root),
    fingerprint,
    runtime: marker,
    createdAt: new Date().toISOString(),
  };
  await writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  try {
    await rename(paths.rootNodeModules, paths.cachedNodeModules);
    return { preserved: true, fingerprint, metadata };
  } catch (error) {
    await rm(paths.cacheRoot, { recursive: true, force: true });
    return {
      preserved: false,
      reason: "preservation-unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function installDependencies(root, execute) {
  // Windows runners and slower machines take up to about two minutes here; this
  // leaves room inside the update step's five minutes (updateRunner.ts).
  const result = await execute("npm", ["install"], { cwd: root, timeoutMs: 240000 });
  if (result.exitCode !== 0) throw commandFailure("npm", ["install"], result);
  return result;
}

async function restoreOrInstall(root, paths, marker, preservation, execute) {
  if (!preservation.preserved) {
    const install = await installDependencies(root, execute);
    return { mode: "clean-install", reason: preservation.reason, install };
  }

  const newFingerprint = await readFingerprint(root).catch(() => null);
  const metadata = await readMetadata(paths.metadataPath);
  const eligible = Boolean(
    newFingerprint
    && metadata
    && newFingerprint === preservation.fingerprint
    && metadata.root === resolve(root)
    && sameMarker(metadata.runtime, marker),
  );

  if (eligible && !await exists(paths.rootNodeModules)) {
    try {
      await rename(paths.cachedNodeModules, paths.rootNodeModules);
      const modulesResolve = await runtimeModulesResolve(root);
      const npmList = modulesResolve
        ? await execute("npm", ["ls", "--omit=dev", "--depth=0"], { cwd: root, timeoutMs: 30000 })
        : { exitCode: 1, stdout: "", stderr: "Required runtime modules did not resolve" };
      if (modulesResolve && npmList.exitCode === 0) {
        await rm(paths.cacheRoot, { recursive: true, force: true });
        return { mode: "reused", reason: "dependency-fingerprint-matched", verification: npmList };
      }
      await rm(paths.rootNodeModules, { recursive: true, force: true });
    } catch {
      await rm(paths.rootNodeModules, { recursive: true, force: true });
    }
  }

  await rm(paths.cacheRoot, { recursive: true, force: true });
  const install = await installDependencies(root, execute);
  return {
    mode: "clean-install",
    reason: eligible ? "reuse-verification-failed" : "dependency-fingerprint-or-runtime-changed",
    install,
  };
}

export async function updateMarketplaceRuntime(options) {
  const root = resolve(options.root);
  const codexHome = resolve(options.codexHome);
  const execute = options.runCommand ?? runCommand;
  const marker = options.runtimeMarker ?? runtimeCompatibilityMarker();
  const paths = cachePaths(root, codexHome);
  const startedAt = Date.now();
  const recovery = await recoverInterruptedPreservation(root, paths, marker);

  const preserveStartedAt = Date.now();
  const preservation = await preserveDependencies(root, paths, marker, Boolean(options.disableReuse));
  const preserveDurationMs = Date.now() - preserveStartedAt;

  const refreshStartedAt = Date.now();
  let refresh;
  try {
    refresh = await execute("codex", ["plugin", "marketplace", "upgrade", "planban"], {
      env: { CODEX_HOME: codexHome },
      timeoutMs: 120000,
    });
  } catch (error) {
    const restored = preservation.preserved
      ? await restorePreservedDirectory(paths).catch(() => false)
      : false;
    if (restored) await rm(paths.cacheRoot, { recursive: true, force: true });
    throw error;
  }
  const refreshDurationMs = Date.now() - refreshStartedAt;
  if (refresh.exitCode !== 0) {
    const restored = preservation.preserved
      ? await restorePreservedDirectory(paths).catch(() => false)
      : false;
    if (restored) await rm(paths.cacheRoot, { recursive: true, force: true });
    throw commandFailure("codex", ["plugin", "marketplace", "upgrade", "planban"], refresh);
  }

  const dependenciesStartedAt = Date.now();
  const dependencies = await restoreOrInstall(root, paths, marker, preservation, execute);
  const dependenciesDurationMs = Date.now() - dependenciesStartedAt;

  return {
    ok: true,
    root,
    recovery,
    dependencyMode: dependencies.mode,
    dependencyReason: dependencies.reason,
    durationMs: Date.now() - startedAt,
    steps: {
      preserveDependenciesMs: preserveDurationMs,
      refreshMarketplaceMs: refreshDurationMs,
      restoreOrInstallDependenciesMs: dependenciesDurationMs,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await updateMarketplaceRuntime(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] && isAbsolute(process.argv[1]) ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
