import assert from "node:assert/strict";
import test from "node:test";
import { auditReleasePolicy, expectedLinuxRunner } from "../scripts/release-policy.mjs";

const workflows = {
  ".github/workflows/ci.yml": "jobs:\n  release-preflight:\n    runs-on: ubuntu-24.04\n",
  ".github/workflows/release-readiness.yml": [
    "jobs:",
    "  updater-rehearsal:",
    "    uses: ./.github/workflows/updater-rehearsal.yml",
    "    with:",
    "      expected_commit: ${{ inputs.ref }}",
    "  exact-sha-preflight:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - run: npm install --global @openai/codex@0.150.1",
    "      - run: npm run release:upgrade-rehearsal -- --from-version \"$FROM_VERSION\" --expected-version \"$EXPECTED_VERSION\"",
    "      - run: npm install --global @anthropic-ai/claude-code@2.1.296",
    "      - run: npm run release:claude-upgrade-rehearsal -- --from-version \"$FROM_VERSION\" --expected-version \"$EXPECTED_VERSION\"",
    "",
  ].join("\n"),
};

test("selects Blacksmith only for pjk-hq GitHub remotes", () => {
  assert.equal(expectedLinuxRunner("git@github.com:pjk-hq/planban.git"), "blacksmith-2vcpu-ubuntu-2404");
  assert.equal(expectedLinuxRunner("https://github.com/planban-ai/planban.git"), "ubuntu-24.04");
});

test("rejects release workflows that use the wrong Linux runner for their remote owner", () => {
  assert.deepEqual(auditReleasePolicy({
    remoteUrl: "https://github.com/planban-ai/planban.git",
    workflows: {
      ...workflows,
      ".github/workflows/ci.yml": workflows[".github/workflows/ci.yml"].replace("ubuntu-24.04", "blacksmith-2vcpu-ubuntu-2404"),
    },
    packageJson: { allowScripts: {} },
    packageLock: { packages: {} },
  }), [".github/workflows/ci.yml must use runs-on: ubuntu-24.04 for GitHub remote owner planban-ai"]);
});

test("rejects dependency install scripts unless their exact locked versions were reviewed", () => {
  assert.deepEqual(auditReleasePolicy({
    remoteUrl: "https://github.com/planban-ai/planban.git",
    workflows,
    packageJson: { allowScripts: { "esbuild@0.28.0": true } },
    packageLock: {
      packages: {
        "node_modules/esbuild": { version: "0.28.1", hasInstallScript: true },
      },
    },
  }), [
    "unreviewed dependency install scripts: esbuild@0.28.1",
    "stale dependency install-script allowlist entries: esbuild@0.28.0",
  ]);
});

test("requires release readiness to rehearse Codex and Claude Code upgrades with pinned CLIs", () => {
  const readiness = workflows[".github/workflows/release-readiness.yml"];
  const audit = (source: string) => auditReleasePolicy({
    remoteUrl: "https://github.com/planban-ai/planban.git",
    workflows: { ...workflows, ".github/workflows/release-readiness.yml": source },
    packageJson: { allowScripts: {} },
    packageLock: { packages: {} },
  });
  const claudeInstallMissing = ".github/workflows/release-readiness.yml must install a pinned Claude Code CLI version in a required step";
  const claudeRunMissing = ".github/workflows/release-readiness.yml must run the Claude Code upgrade rehearsal (npm run release:claude-upgrade-rehearsal) in a required step after the pinned CLI install";
  const claudeRun = "      - run: npm run release:claude-upgrade-rehearsal -- --from-version \"$FROM_VERSION\" --expected-version \"$EXPECTED_VERSION\"";

  assert.deepEqual(audit(readiness), []);
  assert.deepEqual(audit(readiness.replace("@anthropic-ai/claude-code@2.1.296", "@anthropic-ai/claude-code@latest")), [claudeInstallMissing]);
  assert.deepEqual(audit(readiness.replace(claudeRun, "")), [claudeRunMissing]);
  assert.deepEqual(audit(readiness.replace(/^.*@openai\/codex.*$/mu, "")), [
    ".github/workflows/release-readiness.yml must install a pinned Codex CLI version in a required step",
  ]);
});

test("does not let a disabled Claude Code rehearsal satisfy release readiness", () => {
  const readiness = workflows[".github/workflows/release-readiness.yml"];
  const audit = (source: string) => auditReleasePolicy({
    remoteUrl: "https://github.com/planban-ai/planban.git",
    workflows: { ...workflows, ".github/workflows/release-readiness.yml": source },
    packageJson: { allowScripts: {} },
    packageLock: { packages: {} },
  });
  const claudeRunMissing = ".github/workflows/release-readiness.yml must run the Claude Code upgrade rehearsal (npm run release:claude-upgrade-rehearsal) in a required step after the pinned CLI install";
  const claudeRun = "      - run: npm run release:claude-upgrade-rehearsal -- --from-version \"$FROM_VERSION\" --expected-version \"$EXPECTED_VERSION\"";
  const disabled = (replacement: string) => audit(readiness.replace(claudeRun, replacement));

  assert.deepEqual(disabled(`      # ${claudeRun.trim()}`), [claudeRunMissing]);
  assert.deepEqual(disabled(`      - if: false\n  ${claudeRun.replace("- ", "")}`), [claudeRunMissing]);
  assert.deepEqual(disabled(`      - continue-on-error: true\n  ${claudeRun.replace("- ", "")}`), [claudeRunMissing]);
  assert.deepEqual(disabled(`      - run: |\n          # npm run release:claude-upgrade-rehearsal -- --from-version 1.1.6\n          echo skipped`), [claudeRunMissing]);
  assert.deepEqual(disabled(`${claudeRun.slice(0, -1)} || true"`), [claudeRunMissing]);
  assert.deepEqual(disabled(`      - run: |\n          set +e\n          ${claudeRun.replace("      - run: ", "")}\n          echo done`), [claudeRunMissing]);
  assert.deepEqual(disabled(`      - shell: bash {0}\n  ${claudeRun.replace("- ", "")}`), [claudeRunMissing]);
  assert.deepEqual(audit(readiness.replace("    runs-on: ubuntu-24.04", "    runs-on: ubuntu-24.04\n    continue-on-error: true")), [
    ".github/workflows/release-readiness.yml must install a pinned Codex CLI version in a required step",
    ".github/workflows/release-readiness.yml must run the Codex upgrade rehearsal (npm run release:upgrade-rehearsal) in a required step after the pinned CLI install",
    ".github/workflows/release-readiness.yml must install a pinned Claude Code CLI version in a required step",
    claudeRunMissing,
  ]);
  const installAfterRun = readiness.split("\n");
  const installIndex = installAfterRun.findIndex((line) => line.includes("@anthropic-ai/claude-code"));
  const [installLine] = installAfterRun.splice(installIndex, 1);
  installAfterRun.splice(installAfterRun.length - 1, 0, installLine);
  assert.deepEqual(audit(installAfterRun.join("\n")), [claudeRunMissing]);
});

test("requires release readiness to run the full updater rehearsal on the exact commit", () => {
  const readiness = workflows[".github/workflows/release-readiness.yml"];
  const audit = (source: string) => auditReleasePolicy({
    remoteUrl: "https://github.com/planban-ai/planban.git",
    workflows: { ...workflows, ".github/workflows/release-readiness.yml": source },
    packageJson: { allowScripts: {} },
    packageLock: { packages: {} },
  });
  const missing = [".github/workflows/release-readiness.yml must run ./.github/workflows/updater-rehearsal.yml with expected_commit: ${{ inputs.ref }} in a job that always runs"];
  assert.deepEqual(audit(readiness), []);
  assert.deepEqual(audit(readiness.replace(/  updater-rehearsal:\n(    .*\n|      .*\n)*/u, "")), missing);
  assert.deepEqual(audit(readiness.replace("${{ inputs.ref }}", "${{ inputs.target_ref }}")), missing);
  assert.deepEqual(audit(readiness.replace("    uses: ./.github", "    if: false\n    uses: ./.github")), missing);
});
