import { parse as parseYaml } from "yaml";

export const BLACKSMITH_LINUX_RUNNER = "blacksmith-2vcpu-ubuntu-2404";
export const GITHUB_LINUX_RUNNER = "ubuntu-24.04";

export const RELEASE_READINESS_WORKFLOW = ".github/workflows/release-readiness.yml";

// Both supported hosts must rehearse the previous public release upgrade with a pinned CLI.
const REQUIRED_RELEASE_REHEARSALS = [
  { host: "Codex", install: /^npm install --global @openai\/codex@\d+\.\d+\.\d+$/u, script: "release:upgrade-rehearsal" },
  { host: "Claude Code", install: /^npm install --global @anthropic-ai\/claude-code@\d+\.\d+\.\d+$/u, script: "release:claude-upgrade-rehearsal" },
];

// Commands from workflow steps that always run and whose failure fails the job.
// Only steps whose run block is a single command in the default shell count, so a
// skipped, error-tolerant, or `set +e` step cannot satisfy the policy.
function requiredRunLines(source) {
  const workflow = parseYaml(source);
  const lines = [];
  for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
    if (!job || job.if !== undefined || (job["continue-on-error"] ?? false) !== false) continue;
    if (job.defaults?.run?.shell !== undefined || workflow.defaults?.run?.shell !== undefined) continue;
    (job.steps ?? []).forEach((step, stepIndex) => {
      if (!step || step.if !== undefined || (step["continue-on-error"] ?? false) !== false) return;
      if (typeof step.run !== "string" || step.shell !== undefined) return;
      const commands = step.run.split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry && !entry.startsWith("#"));
      if (commands.length === 1) lines.push({ jobId, stepIndex, line: commands[0] });
    });
  }
  return lines;
}

function auditReleaseRehearsals(source) {
  let lines;
  try {
    lines = requiredRunLines(source);
  } catch (error) {
    return [`${RELEASE_READINESS_WORKFLOW} is not valid YAML: ${error.message}`];
  }
  const findings = [];
  for (const rehearsal of REQUIRED_RELEASE_REHEARSALS) {
    const install = lines.find(({ line }) => rehearsal.install.test(line));
    if (!install) findings.push(`${RELEASE_READINESS_WORKFLOW} must install a pinned ${rehearsal.host} CLI version in a required step`);
    const runPattern = new RegExp(`^npm run ${rehearsal.script} -- [^|;&]*$`, "u");
    const run = lines.find(({ jobId, stepIndex, line }) => runPattern.test(line)
      && (!install || (jobId === install.jobId && stepIndex > install.stepIndex)));
    if (!run) {
      findings.push(`${RELEASE_READINESS_WORKFLOW} must run the ${rehearsal.host} upgrade rehearsal (npm run ${rehearsal.script}) in a required step after the pinned CLI install`);
    }
  }
  return findings;
}

const UPDATER_REHEARSAL_WORKFLOW = "./.github/workflows/updater-rehearsal.yml";

// Release readiness must run the full updater rehearsal on the exact commit it verifies:
// pull requests skip it after their first push.
function auditUpdaterRehearsal(source) {
  let workflow;
  try { workflow = parseYaml(source); } catch { return []; }
  const runsOnCommit = Object.values(workflow?.jobs ?? {}).some((job) => job
    && job.uses === UPDATER_REHEARSAL_WORKFLOW
    && job.if === undefined
    && (job["continue-on-error"] ?? false) === false
    && String(job.with?.expected_commit ?? "").replace(/\s+/gu, "") === "${{inputs.ref}}");
  return runsOnCommit ? [] : [`${RELEASE_READINESS_WORKFLOW} must run ${UPDATER_REHEARSAL_WORKFLOW} with expected_commit: \${{ inputs.ref }} in a job that always runs`];
}

export function githubRemoteOwner(remoteUrl) {
  const match = remoteUrl.trim().match(/github\.com(?::|\/)([^/]+)\//iu);
  return match?.[1]?.toLowerCase() ?? null;
}

export function expectedLinuxRunner(remoteUrl) {
  return githubRemoteOwner(remoteUrl) === "pjk-hq"
    ? BLACKSMITH_LINUX_RUNNER
    : GITHUB_LINUX_RUNNER;
}

function lockedInstallScripts(packageLock) {
  return Object.entries(packageLock.packages ?? {})
    .filter(([, entry]) => entry?.hasInstallScript === true)
    .map(([path, entry]) => {
      const marker = "node_modules/";
      const markerIndex = path.lastIndexOf(marker);
      const name = entry.name ?? (markerIndex >= 0 ? path.slice(markerIndex + marker.length) : path);
      return `${name}@${entry.version ?? "unknown"}`;
    })
    .sort();
}

export function auditReleasePolicy({ remoteUrl, workflows, packageJson, packageLock }) {
  const findings = [];
  const owner = githubRemoteOwner(remoteUrl);
  if (!owner) {
    findings.push(`origin is not a recognized GitHub remote: ${remoteUrl || "missing"}`);
  } else {
    const expectedRunner = expectedLinuxRunner(remoteUrl);
    for (const [path, source] of Object.entries(workflows)) {
      const runnerPattern = new RegExp(`^\\s*runs-on:\\s*${expectedRunner.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`, "mu");
      if (!runnerPattern.test(source)) {
        findings.push(`${path} must use runs-on: ${expectedRunner} for GitHub remote owner ${owner}`);
      }
    }
  }

  const readiness = workflows[RELEASE_READINESS_WORKFLOW];
  if (readiness === undefined) findings.push(`${RELEASE_READINESS_WORKFLOW} is missing`);
  else findings.push(...auditReleaseRehearsals(readiness), ...auditUpdaterRehearsal(readiness));

  const reviewed = Object.entries(packageJson.allowScripts ?? {})
    .filter(([, allowed]) => allowed === true)
    .map(([entry]) => entry)
    .sort();
  const locked = lockedInstallScripts(packageLock);
  const lockedSet = new Set(locked);
  const reviewedSet = new Set(reviewed);
  const unreviewed = locked.filter((entry) => !reviewedSet.has(entry));
  const stale = reviewed.filter((entry) => !lockedSet.has(entry));
  if (unreviewed.length > 0) findings.push(`unreviewed dependency install scripts: ${unreviewed.join(", ")}`);
  if (stale.length > 0) findings.push(`stale dependency install-script allowlist entries: ${stale.join(", ")}`);
  return findings;
}
