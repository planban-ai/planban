import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureColdInstallDiagnostics, projectNpmTail, withColdInstallDiagnostics } from "../scripts/cold-install-diagnostics.mjs";
import { runVerifierStage, withVerifierCleanup } from "../scripts/verifier-process.mjs";

test("npm event projection retains diagnostic ordering without log text or credentials", () => {
  const events = projectNpmTail([
    "1 verbose argv --token private-argv-value",
    "2 http fetch GET 200 https://person:private-password@registry.example/package?token=private-query 12ms (cache hit)",
    "3 silly packumentCache https://private-host/private-path cache-miss",
    "4 timing private-env-path Completed in 34ms",
    "5 error Authorization: Bearer private-bearer",
    "6 warn npm_config_secret=private-setting",
  ].join("\n"));
  assert.deepEqual(events.map((event) => event.kind), ["other", "fetch", "package-cache", "timing", "error", "warning"]);
  assert.equal(events[1].status, 200);
  assert.equal(events[3].elapsedMs, 34);
  assert.doesNotMatch(JSON.stringify(events), /private-|registry|Authorization|token|person/u);
  assert.equal(projectNpmTail(Array.from({ length: 1000 }, (_, i) => `${i} error secret`).join("\n")).length, 32);
});

test("failure capture is bounded and ignores foreign files and symbolic links", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban diagnostic test "));
  try {
    const logs = join(root, "logs");
    const destination = join(root, "artifact");
    await mkdir(logs);
    for (let i = 0; i < 4; i++) {
      await writeFile(join(logs, `2026-10-12T22_00_00_00${i}Z-debug-0.log`), "foreign-secret\n".repeat(10000) + "1 error secret\n");
    }
    await writeFile(join(logs, "credentials.json"), "foreign-secret");
    if (process.platform !== "win32") await symlink(join(logs, "credentials.json"), join(logs, "2026-10-12T23_00_00_000Z-debug-0.log"));
    await captureColdInstallDiagnostics(logs, destination);
    const raw = await readFile(join(destination, "cold-install-npm-events.json"), "utf8");
    const result = JSON.parse(raw);
    assert.ok(result.logs.length > 0 && result.logs.length <= 3);
    assert.ok(result.logs.every((log: { tailBytes: number }) => log.tailBytes <= 65536));
    assert.doesNotMatch(raw, /secret|credentials|planban diagnostic|2026-/u);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("timed-out stage retains original failure and completes cleanup after capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban diagnostic stage "));
  const logs = join(root, "logs");
  const destination = join(root, "artifact");
  await mkdir(logs);
  const script = join(root, "stall.mjs");
  await writeFile(script, 'process.stderr.write("preparing\\n"); setInterval(() => {}, 1000);');
  await writeFile(join(logs, "2026-10-12T22_00_00_000Z-debug-0.log"), "1 silly fetch manifest public-package\n");
  let cleaned = false;
  try {
    await assert.rejects(withVerifierCleanup(
      () => withColdInstallDiagnostics(() => runVerifierStage("fixture stall", script, [], { timeoutMs: 250 }), logs, destination),
      [["fixture", async () => { cleaned = true; await rm(logs, { recursive: true }); }]],
    ), /fixture stall failed.*\nTimed out after 250ms/u);
    assert.equal(cleaned, true);
    assert.equal(JSON.parse(await readFile(join(destination, "cold-install-npm-events.json"), "utf8")).logs[0].events[0].kind, "manifest");
    const original = new Error("original failure");
    await assert.rejects(withColdInstallDiagnostics(async () => { throw original; }, logs, script), (error) => error === original);
    assert.equal(await withColdInstallDiagnostics(async () => 42, logs, destination), 42);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
