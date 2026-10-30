import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { platformInvocation, stopInvocation } from "../../scripts/platform-invocation.mjs";
import { updatePreflight, type PlanbanUpdatePreflight } from "./updatePreflight";
import type { PlanbanUpdateManifest } from "./version";

export type UpdateStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type UpdateRunStatus = "pending" | "running" | "succeeded" | "failed";

export interface UpdateCommandStep {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface UpdateRunStepSnapshot {
  id: string;
  label: string;
  status: UpdateStepStatus;
  command: string;
  cwd: string | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  error: string | null;
  durationMs: number | null;
}

export interface UpdateRunSnapshot {
  id: string;
  status: UpdateRunStatus;
  startedAt: string;
  completedAt: string | null;
  installShape: PlanbanUpdatePreflight["installShape"];
  targetVersion: string | null;
  targetRef: string | null;
  targetCommit: string | null;
  currentBoardUrl: string | null;
  restartRequired: boolean;
  message: string;
  error: string | null;
  transcriptPath: string | null;
  steps: UpdateRunStepSnapshot[];
}

interface UpdateStepTranscript extends UpdateRunStepSnapshot {
  stdoutTail: string | null;
  stderrTail: string | null;
}

interface UpdateRunTranscript {
  id: string;
  status: UpdateRunStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  runtimeRoot: string;
  codexHome: string | null;
  installShape: PlanbanUpdatePreflight["installShape"];
  currentBoardUrl: string | null;
  targetVersion: string | null;
  targetRef: string | null;
  targetCommit: string | null;
  message: string;
  error: string | null;
  preflight: {
    checkedAt: string;
    installShape: PlanbanUpdatePreflight["installShape"];
    runtimeRoot: string;
    codexHome: string;
    marketplace: PlanbanUpdatePreflight["marketplace"];
    git: PlanbanUpdatePreflight["git"];
    warnings: string[];
    blockedReasons: string[];
  };
  steps: UpdateStepTranscript[];
}

interface UpdateRunOptions {
  id?: string;
  runtimeRoot: string;
  codexHome?: string;
  latest?: PlanbanUpdateManifest | null;
  currentBoardUrl?: string | null;
  onSnapshot?: (snapshot: UpdateRunSnapshot) => void;
}

function isoNow() {
  return new Date().toISOString();
}

function publicStep(step: UpdateCommandStep): UpdateRunStepSnapshot {
  return {
    id: step.id,
    label: step.label,
    status: "pending",
    command: [step.command, ...step.args].join(" "),
    cwd: step.cwd ?? null,
    startedAt: null,
    completedAt: null,
    exitCode: null,
    error: null,
    durationMs: null,
  };
}

function marketplaceRoot(preflight: PlanbanUpdatePreflight) {
  return preflight.marketplace.root ? resolve(preflight.marketplace.root) : preflight.runtimeRoot;
}

function localRoot(preflight: PlanbanUpdatePreflight) {
  return preflight.git.root ? resolve(preflight.git.root) : preflight.runtimeRoot;
}

function generatedArtifactStep(root: string): UpdateCommandStep {
  return {
    id: "prepare-install-artifacts",
    label: "Prepare generated install artifacts",
    command: "node",
    args: ["scripts/prepare-local-update.mjs", root],
    cwd: root,
    timeoutMs: 30000,
  };
}

function verifyInstallStep(root: string, codexHome: string, targetVersion: string): UpdateCommandStep {
  return {
    id: "verify-install",
    label: "Verify updated Planban install",
    command: "node",
    args: [
      "--import",
      "tsx/esm",
      "scripts/verify-local-install.mjs",
      "--root",
      root,
      "--expected-version",
      targetVersion,
      "--codex-home",
      codexHome,
    ],
    cwd: root,
    env: { CODEX_HOME: codexHome },
    timeoutMs: 30000,
  };
}

export function buildUpdateCommandPlan(
  preflight: PlanbanUpdatePreflight,
  latest?: PlanbanUpdateManifest | null,
): UpdateCommandStep[] {
  if (!preflight.directUpdateAvailable) return [];

  const targetRef = latest?.targetRef?.trim() || "main";
  const targetCommit = latest?.targetCommit?.trim() || null;
  const targetVersion = latest?.version?.trim() || null;
  const codexEnv = { CODEX_HOME: preflight.codexHome };
  if (!targetVersion) return [];

  if (preflight.installShape === "git-marketplace") {
    const root = marketplaceRoot(preflight);
    const steps: UpdateCommandStep[] = [];
    if (preflight.git.generatedSafeDirtyFiles.length > 0) steps.push(generatedArtifactStep(root));
    return [
      ...steps,
      {
        id: "refresh-marketplace-runtime",
        label: "Refresh Planban marketplace runtime",
        command: "node",
        args: [
          "scripts/update-marketplace-runtime.mjs",
          "--root",
          root,
          "--codex-home",
          preflight.codexHome,
        ],
        cwd: root,
        env: codexEnv,
        timeoutMs: 300000,
      },
      {
        id: "configure-plugin",
        label: "Configure Planban MCP runtime",
        command: "node",
        args: ["scripts/configure-local-plugin.mjs", root],
        cwd: root,
        timeoutMs: 30000,
      },
      {
        id: "install-plugin",
        label: "Refresh Planban plugin install",
        command: "codex",
        args: ["plugin", "add", "planban@planban"],
        cwd: root,
        env: codexEnv,
        timeoutMs: 60000,
      },
      verifyInstallStep(root, preflight.codexHome, targetVersion),
    ];
  }

  if (preflight.installShape === "local-clone") {
    const root = localRoot(preflight);
    const steps: UpdateCommandStep[] = [];
    if (preflight.git.generatedSafeDirtyFiles.length > 0) steps.push(generatedArtifactStep(root));
    return [
      ...steps,
      {
        id: "fetch-update",
        label: "Fetch Planban update",
        command: "git",
        args: ["fetch", "origin", targetRef],
        cwd: root,
        timeoutMs: 120000,
      },
      {
        id: "fast-forward",
        label: "Fast-forward local Planban clone",
        command: "git",
        args: ["merge", "--ff-only", targetCommit ?? "FETCH_HEAD"],
        cwd: root,
        timeoutMs: 60000,
      },
      {
        id: "install-dependencies",
        label: "Install Planban dependencies",
        command: "npm",
        args: ["install"],
        cwd: root,
        timeoutMs: 180000,
      },
      {
        id: "configure-plugin",
        label: "Configure Planban MCP runtime",
        command: "node",
        args: ["scripts/configure-local-plugin.mjs", root],
        cwd: root,
        timeoutMs: 30000,
      },
      {
        id: "install-plugin",
        label: "Refresh Planban plugin install",
        command: "codex",
        args: ["plugin", "add", "planban@planban"],
        cwd: root,
        env: codexEnv,
        timeoutMs: 60000,
      },
      verifyInstallStep(root, preflight.codexHome, targetVersion),
    ];
  }

  return [];
}

function runStep(step: UpdateCommandStep) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    const invocation = platformInvocation(step.command, step.args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: step.cwd,
      env: step.env ? { ...process.env, ...step.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = step.timeoutMs
      ? setTimeout(() => {
        stopInvocation(child);
        rejectRun(new Error(`${step.label} timed out`));
      }, step.timeoutMs)
      : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
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

function failureMessage(step: UpdateCommandStep, stdout: string, stderr: string) {
  const detail = (stderr || stdout).trim().split(/\r?\n/u).slice(-4).join("\n").trim();
  return detail ? `${step.label} failed:\n${detail}` : `${step.label} failed`;
}

function transcriptPath(runtimeRoot: string, id: string) {
  return join(runtimeRoot, ".planban-update-runs", `${id}.json`);
}

function textTail(value: string, maxLength = 4000) {
  if (!value.trim()) return null;
  return value.length <= maxLength ? value : value.slice(value.length - maxLength);
}

async function writeTranscript(path: string, transcript: UpdateRunTranscript) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(transcript, null, 2) + "\n", "utf8");
}

function buildTranscript(
  snapshot: UpdateRunSnapshot,
  runtimeRoot: string,
  codexHome: string | null,
  preflight: PlanbanUpdatePreflight,
  stepOutputs: Map<string, { stdout: string; stderr: string }>,
): UpdateRunTranscript {
  const durationMs = snapshot.completedAt
    ? new Date(snapshot.completedAt).getTime() - new Date(snapshot.startedAt).getTime()
    : null;

  return {
    id: snapshot.id,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    durationMs,
    runtimeRoot,
    codexHome,
    installShape: snapshot.installShape,
    currentBoardUrl: snapshot.currentBoardUrl,
    targetVersion: snapshot.targetVersion,
    targetRef: snapshot.targetRef,
    targetCommit: snapshot.targetCommit,
    message: snapshot.message,
    error: snapshot.error,
    preflight: {
      checkedAt: preflight.checkedAt,
      installShape: preflight.installShape,
      runtimeRoot: preflight.runtimeRoot,
      codexHome: preflight.codexHome,
      marketplace: preflight.marketplace,
      git: preflight.git,
      warnings: preflight.warnings,
      blockedReasons: preflight.blockedReasons,
    },
    steps: snapshot.steps.map((step) => {
      const output = stepOutputs.get(step.id);
      return {
        ...step,
        stdoutTail: output ? textTail(output.stdout) : null,
        stderrTail: output ? textTail(output.stderr) : null,
      };
    }),
  };
}

export async function runPlanbanUpdate(options: UpdateRunOptions): Promise<UpdateRunSnapshot> {
  const preflightOptions = {
    runtimeRoot: options.runtimeRoot,
    ...(options.codexHome ? { codexHome: options.codexHome } : {}),
  };
  const preflight = await updatePreflight(preflightOptions);
  if (!preflight.directUpdateAvailable) {
    throw new Error(preflight.blockedReasons[0] ?? "This Planban install is not eligible for direct update.");
  }

  const steps = buildUpdateCommandPlan(preflight, options.latest);
  if (steps.length === 0) throw new Error("No direct update command plan is available for this install.");
  const id = options.id ?? randomUUID();
  const updateTranscriptPath = transcriptPath(options.runtimeRoot, id);
  const stepOutputs = new Map<string, { stdout: string; stderr: string }>();

  const snapshot: UpdateRunSnapshot = {
    id,
    status: "running",
    startedAt: isoNow(),
    completedAt: null,
    installShape: preflight.installShape,
    targetVersion: options.latest?.version ?? null,
    targetRef: options.latest?.targetRef ?? null,
    targetCommit: options.latest?.targetCommit ?? null,
    currentBoardUrl: options.currentBoardUrl ?? null,
    restartRequired: true,
    message: "Preparing Planban update...",
    error: null,
    transcriptPath: updateTranscriptPath,
    steps: steps.map(publicStep),
  };

  const emit = async () => {
    await writeTranscript(
      updateTranscriptPath,
      buildTranscript(snapshot, options.runtimeRoot, options.codexHome ?? null, preflight, stepOutputs),
    );
    options.onSnapshot?.({ ...snapshot, steps: snapshot.steps.map((step) => ({ ...step })) });
  };
  await emit();

  for (const step of steps) {
    const stepSnapshot = snapshot.steps.find((candidate) => candidate.id === step.id);
    if (!stepSnapshot) continue;
    stepSnapshot.status = "running";
    stepSnapshot.startedAt = isoNow();
    snapshot.message = step.label;
    await emit();

    try {
      const result = await runStep(step);
      stepOutputs.set(step.id, { stdout: result.stdout, stderr: result.stderr });
      stepSnapshot.exitCode = result.exitCode;
      stepSnapshot.completedAt = isoNow();
      stepSnapshot.durationMs = new Date(stepSnapshot.completedAt).getTime() - new Date(stepSnapshot.startedAt).getTime();
      if (result.exitCode !== 0) {
        stepSnapshot.status = "failed";
        stepSnapshot.error = failureMessage(step, result.stdout, result.stderr);
        snapshot.status = "failed";
        snapshot.completedAt = isoNow();
        snapshot.error = stepSnapshot.error;
        snapshot.message = "Planban update failed.";
        await emit();
        return snapshot;
      }
      stepSnapshot.status = "succeeded";
      snapshot.message = `${step.label} complete`;
      await emit();
    } catch (error) {
      stepSnapshot.status = "failed";
      stepSnapshot.completedAt = isoNow();
      stepSnapshot.durationMs = stepSnapshot.startedAt
        ? new Date(stepSnapshot.completedAt).getTime() - new Date(stepSnapshot.startedAt).getTime()
        : null;
      stepSnapshot.error = error instanceof Error ? error.message : `${step.label} failed`;
      snapshot.status = "failed";
      snapshot.completedAt = isoNow();
      snapshot.error = stepSnapshot.error;
      snapshot.message = "Planban update failed.";
      await emit();
      return snapshot;
    }
  }

  snapshot.status = "succeeded";
  snapshot.completedAt = isoNow();
  snapshot.message = "Planban update installed. Restart Planban, then reopen this board to load the updated app.";
  await emit();
  return snapshot;
}
