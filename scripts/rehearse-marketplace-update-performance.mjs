#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand, updateMarketplaceRuntime } from "./update-marketplace-runtime.mjs";
import { retargetMarketplace } from "./marketplace-rehearsal-config.mjs";
import { isTransientInstallFailure, retryOnce } from "./rehearsal-retry.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const options = {
    fromVersion: "1.1.6",
    fromRef: null,
    expectedVersion: null,
    sourceUrl: "https://github.com/planban-ai/planban.git",
    targetRef: "main",
    targetSourceUrl: null,
    expectedCommit: null,
    iterations: 3,
    mode: "both",
    keep: false,
    shardId: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--shard-id") options.shardId = argv[++index] ?? "";
    else if (arg === "--from-ref") options.fromRef = argv[++index] ?? "";
    else if (arg === "--from-version") options.fromVersion = argv[++index] ?? "";
    else if (arg === "--expected-version") options.expectedVersion = argv[++index] ?? "";
    else if (arg === "--target-source-url") options.targetSourceUrl = argv[++index] ?? "";
    else if (arg === "--source-url") options.sourceUrl = argv[++index] ?? "";
    else if (arg === "--target-ref") options.targetRef = argv[++index] ?? "";
    else if (arg === "--expected-commit") options.expectedCommit = argv[++index] ?? "";
    else if (arg === "--iterations") options.iterations = Number(argv[++index]);
    else if (arg === "--mode") options.mode = argv[++index] ?? "";
    else if (arg === "--keep") options.keep = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.fromVersion || !options.sourceUrl || !options.targetRef) {
    throw new Error("Source, ref, and version arguments cannot be empty");
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  if (!["baseline", "reuse", "both"].includes(options.mode)) {
    throw new Error("--mode must be baseline, reuse, or both");
  }
  return options;
}

async function run(command, args, options = {}) {
  const startedAt = performance.now();
  process.stderr.write(`  Starting ${command} ${args.join(" ")}\n`);
  try {
    const result = await runCommand(command, args, {
      ...options,
      cwd: options.cwd ?? repoRoot,
      timeoutMs: options.timeoutMs ?? 180000,
    });
    if (result.exitCode !== 0 && !options.allowFailure) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
    }
    return { ...result, durationMs: performance.now() - startedAt };
  } finally {
    process.stderr.write(`  Finished ${command} after ${Math.round(performance.now() - startedAt)}ms\n`);
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function marketplaceRoot(codexHome, env) {
  const listed = await run("codex", ["plugin", "marketplace", "list", "--json"], { env });
  const parsed = JSON.parse(listed.stdout);
  const marketplace = parsed.marketplaces?.find(({ name }) => name === "planban");
  if (!marketplace?.root) throw new Error(`Planban marketplace root missing in ${codexHome}`);
  return marketplace.root;
}

async function pointMarketplaceAtTarget(codexHome, sourceUrl, targetRef) {
  const configPath = join(codexHome, "config.toml");
  const config = await readFile(configPath, "utf8");
  await writeFile(configPath, retargetMarketplace(config, sourceUrl, targetRef), "utf8");
}

async function runSample(options, mode, sampleNumber, sharedNpmCache) {
  const sampleRoot = await mkdtemp(join(tmpdir(), `planban-update-${mode}-`));
  const codexHome = join(sampleRoot, "codex-home");
  const planbanHome = join(sampleRoot, "planban-home");
  const projectRoot = join(sampleRoot, "project");
  const env = {
    CODEX_HOME: codexHome,
    PLANBAN_HOME: planbanHome,
    npm_config_cache: sharedNpmCache,
  };
  const setupStartedAt = performance.now();

  try {
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(planbanHome, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
    ]);
    await run("codex", ["plugin", "marketplace", "add", options.sourceUrl,
      "--ref", options.fromRef ?? `v${options.fromVersion}`], { env });
    const root = await marketplaceRoot(codexHome, env);
    // Setup, not measured: a dropped download or a Windows file lock gets one retry.
    await retryOnce("Installing the previous release's dependencies", () => run("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, env, timeoutMs: 300000 }), {
      shouldRetry: isTransientInstallFailure,
      beforeRetry: () => rm(join(root, "node_modules"), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }),
    });
    await run("node", ["--import", "tsx/esm", "src/cli.ts", "init", "--cwd", projectRoot,
      "--repo-id", "update-performance-rehearsal", "--title", "Update performance rehearsal", "--no-agents"], {
      cwd: root,
      env,
    });
    await run("node", ["--import", "tsx/esm", "src/cli.ts", "create-card", "Update proof",
      "--status", "pending", "--cwd", projectRoot, "--output", "json"], { cwd: root, env });
    await pointMarketplaceAtTarget(codexHome, options.targetSourceUrl ?? options.sourceUrl, options.targetRef);
    const setupDurationMs = performance.now() - setupStartedAt;

    const updateStartedAt = performance.now();
    const runtime = await updateMarketplaceRuntime({
      root,
      codexHome,
      disableReuse: mode === "baseline",
      // Keep measured installs on the same cache and isolated homes as setup.
      runCommand: (command, args, commandOptions = {}) => run(command, args, {
        ...commandOptions,
        env: { ...env, ...commandOptions.env },
        allowFailure: true,
      }),
    });
    const updatedCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: root, env })).stdout.trim();
    if (options.expectedCommit && updatedCommit !== options.expectedCommit) {
      throw new Error(`Updated marketplace commit ${updatedCommit} does not match ${options.expectedCommit}`);
    }
    const configure = await run("node", ["scripts/configure-local-plugin.mjs", root], { cwd: root, env });
    const plugin = await run("codex", ["plugin", "add", "planban@planban"], { cwd: root, env });
    const verify = await run("node", ["--import", "tsx/esm", "scripts/verify-local-install.mjs",
      "--root", root, "--expected-version", options.expectedVersion, "--codex-home", codexHome], {
      cwd: root,
      env,
    });
    const status = await run("node", ["--import", "tsx/esm", "src/cli.ts", "status", "--cwd", projectRoot], {
      cwd: root,
      env,
    });
    const card = await run("node", ["--import", "tsx/esm", "src/cli.ts", "get-card", "update-proof",
      "--cwd", projectRoot, "--output", "json"], { cwd: root, env });
    const endToEndDurationMs = performance.now() - updateStartedAt;
    const parsedStatus = JSON.parse(status.stdout);
    const parsedCard = JSON.parse(card.stdout);
    if (parsedStatus.version?.version !== options.expectedVersion || parsedCard.id !== "update-proof") {
      throw new Error("Updated runtime failed the persisted Board readiness check");
    }

    return {
      mode,
      sample: sampleNumber,
      setupDurationMs: Math.round(setupDurationMs),
      runtime,
      updatedCommit,
      postRefreshMs: {
        configure: Math.round(configure.durationMs),
        plugin: Math.round(plugin.durationMs),
        verify: Math.round(verify.durationMs),
        boardReadiness: Math.round(status.durationMs + card.durationMs),
      },
      endToEndDurationMs: Math.round(endToEndDurationMs),
      boardPreserved: true,
    };
  } finally {
    if (!options.keep) {
      const cleanupStartedAt = performance.now();
      process.stderr.write("  Removing sample fixture...\n");
      // Retries ride out Windows releasing files late; a fixture that still can't be
      // removed is reported, never allowed to hide why the sample itself failed.
      try {
        await rm(sampleRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        process.stderr.write(`  Removed sample fixture in ${Math.round(performance.now() - cleanupStartedAt)}ms\n`);
      } catch (error) {
        process.stderr.write(`  Couldn't remove sample fixture: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    } else process.stderr.write(`Preserved rehearsal at ${sampleRoot}\n`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.expectedVersion) {
    options.expectedVersion = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")).version;
  }
  const benchmarkRoot = await mkdtemp(join(tmpdir(), "planban-update-benchmark-"));
  const sharedNpmCache = join(benchmarkRoot, "npm-cache");
  const modes = options.mode === "both" ? ["baseline", "reuse"] : [options.mode];
  const samples = [];
  try {
    await mkdir(sharedNpmCache, { recursive: true });
    for (const mode of modes) {
      for (let sample = 1; sample <= options.iterations; sample += 1) {
        process.stderr.write(`Running ${mode} sample ${sample}/${options.iterations}...\n`);
        const result = await runSample(options, mode, sample, sharedNpmCache);
        samples.push(result);
        process.stderr.write(`  ${result.endToEndDurationMs}ms (${result.runtime.dependencyMode})\n`);
      }
    }
    const summary = Object.fromEntries(modes.map((mode) => {
      const modeSamples = samples.filter((sample) => sample.mode === mode);
      return [mode, {
        samples: modeSamples.length,
        medianRuntimeMs: Math.round(median(modeSamples.map((sample) => sample.runtime.durationMs))),
        medianEndToEndMs: Math.round(median(modeSamples.map((sample) => sample.endToEndDurationMs))),
        minEndToEndMs: Math.min(...modeSamples.map((sample) => sample.endToEndDurationMs)),
        maxEndToEndMs: Math.max(...modeSamples.map((sample) => sample.endToEndDurationMs)),
      }];
    }));
    process.stdout.write(`${JSON.stringify({
      ok: true,
      shardId: options.shardId,
      fromVersion: options.fromVersion,
      fromRef: options.fromRef ?? `v${options.fromVersion}`,
      expectedVersion: options.expectedVersion,
      sourceUrl: options.sourceUrl,
      targetRef: options.targetRef,
      targetSourceUrl: options.targetSourceUrl ?? options.sourceUrl,
      expectedCommit: options.expectedCommit,
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        sharedNpmCacheAcrossSamples: true,
        isolatedCodexHomePerSample: true,
        isolatedPlanbanHomePerSample: true,
      },
      summary,
      samples,
    }, null, 2)}\n`);
  } finally {
    if (!options.keep) await rm(benchmarkRoot, { recursive: true, force: true });
    else process.stderr.write(`Preserved benchmark cache at ${benchmarkRoot}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
