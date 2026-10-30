import assert from "node:assert/strict";
import test from "node:test";
import { isTransientInstallFailure, retryOnce } from "../scripts/rehearsal-retry.mjs";

test("rehearsal setup retries only a dropped download or a locked file under node_modules", () => {
  // From a Windows rehearsal on 15 October: npm's cleanup hit locked folders after the download dropped.
  assert.equal(isTransientInstallFailure(new Error("npm install --no-audit --no-fund failed:\nnpm error code ECONNRESET\nnpm error network aborted")), true);
  assert.equal(isTransientInstallFailure(new Error("npm warn cleanup [Error: EPERM: operation not permitted, rmdir 'C:\\Temp\\codex-home\\.tmp\\marketplaces\\planban\\node_modules\\@types\\node\\ts5.6']")), true);
  assert.equal(isTransientInstallFailure(new Error("npm error code ERESOLVE\nnpm error could not resolve dependency")), false);
  assert.equal(isTransientInstallFailure(new Error("EPERM: operation not permitted, open 'C:\\Users\\planban\\board.json'")), false);
});

test("retryOnce tries a failed step exactly once more, and only when allowed", async () => {
  let calls = 0;
  let cleaned = 0;
  const flaky = () => { calls += 1; if (calls === 1) throw new Error("ECONNRESET"); return "installed"; };
  assert.equal(await retryOnce("step", flaky, { beforeRetry: async () => { cleaned += 1; } }), "installed");
  assert.deepEqual([calls, cleaned], [2, 1]);

  calls = 0;
  await assert.rejects(retryOnce("step", () => { calls += 1; throw new Error(`failure ${calls}`); }), /failure 2/);
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(retryOnce("step", () => { calls += 1; throw new Error("ERESOLVE"); }, { shouldRetry: isTransientInstallFailure }), /ERESOLVE/);
  assert.equal(calls, 1);
});
