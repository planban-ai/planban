import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runVerifierStage, stopRecordedVerifierServer, withVerifierCleanup } from "../scripts/verifier-process.mjs";

test("verifier stages deliver stdin EOF, retain both output streams and report original failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "verifier process "));
  const fixture = join(root, "fixture.mjs");
  try {
    await writeFile(fixture, 'let text="";process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>{console.log(text);console.error("diagnostic");});');
    const result = await runVerifierStage("EOF control", fixture, [], { input: "input", timeoutMs: 2000 });
    assert.equal(result.stdout, "input\n"); assert.equal(result.stderr, "diagnostic\n");
    await writeFile(fixture, 'console.log("partial response");console.error("actual failure");process.exitCode=7;');
    await assert.rejects(runVerifierStage("nonzero control", fixture), /nonzero control[\s\S]*exit=7[\s\S]*partial response[\s\S]*actual failure/);
    await assert.rejects(runVerifierStage("missing control", join(root, "absent.mjs")), /missing control[\s\S]*Cannot find module/);
    await assert.rejects(runVerifierStage("spawn control", fixture, [], { cwd: join(root, "absent") }), /spawn control[\s\S]*ENOENT/);
    await writeFile(fixture, 'console.log("x".repeat(10000));');
    await assert.rejects(runVerifierStage("output control", fixture, [], { maxBuffer: 100 }), /output control[\s\S]*Output exceeds/);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("failed launch recovers and terminates its recorded detached fixture server before directory cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "verifier server "));
  const file = join(root, "spawn.pid");
  const server = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
  const original = new Error("readiness failure");
  try {
    await writeFile(file, String(server.pid));
    await assert.rejects(withVerifierCleanup(async () => { throw original; }, [["recorded server", () => stopRecordedVerifierServer([file])]]), (error) => error === original);
    await closed;
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("verifier timeout terminates its live fixture tree and leaves an unrelated sentinel alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "verifier timeout "));
  const fixture = join(root, "fixture.mjs"), pidFile = join(root, "child.pid");
  const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  let ownedPid;
  try {
    await writeFile(fixture, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});writeFileSync(process.argv[2],String(c.pid));console.error('waiting fixture');setInterval(()=>{},1000);`);
    await assert.rejects(runVerifierStage("timeout control", fixture, [pidFile], { timeoutMs: 1000 }), /timeout control[\s\S]*Timed out after 1000ms[\s\S]*waiting fixture/);
    ownedPid = Number(await readFile(pidFile, "utf8"));
    assert.ok(sentinel.pid); assert.doesNotThrow(() => process.kill(sentinel.pid!, 0));
    assert.equal(sentinel.exitCode, null);
    // On POSIX an adopted killed child may briefly remain a zombie; closed
    // inherited pipes are the runner's observable tree-lifecycle assertion.
  } finally {
    if (ownedPid) { try { process.kill(ownedPid, "SIGKILL"); } catch {} }
    sentinel.kill("SIGKILL");
    await new Promise<void>((resolve) => sentinel.once("close", () => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("parent exit with descendant-held pipes stays bounded and is cleaned as an owned POSIX group", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "verifier pipes "));
  const fixture = join(root, "fixture.mjs");
  try {
    await writeFile(fixture, `import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log('parent exiting');setTimeout(()=>process.exit(0),50);`);
    await assert.rejects(runVerifierStage("held pipes", fixture, [], { timeoutMs: 500 }), /held pipes[\s\S]*Timed out[\s\S]*parent exiting/);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("every cleanup runs, primary failure is preserved, and cleanup-only failure cannot report success", async () => {
  const original = new Error("original stage failure");
  const calls: string[] = [];
  const cleanups: Array<[string, () => Promise<void>]> = [["failed", async () => { calls.push("failed"); throw new Error("cleanup refused"); }], ["remaining", async () => { calls.push("remaining"); }]];
  // The test's own refused cleanup is logged here, not to the run's output, where it read as a real failure.
  const logged: string[] = [];
  const log = (line: string) => { logged.push(line); };
  await assert.rejects(withVerifierCleanup(async () => { throw original; }, cleanups, log), (error) => error === original);
  assert.deepEqual(calls, ["failed", "remaining"]);
  await assert.rejects(withVerifierCleanup(async () => "success", cleanups, log), AggregateError);
  assert.equal(logged.length, 2);
  assert.match(logged[0], /cleanup failed: Error: cleanup refused/);
  assert.equal(await withVerifierCleanup(async () => "success", []), "success");
});

test("known parent failure survives a later descendant pipe-drain timeout", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "verifier exit status "));
  const fixture = join(root, "fixture.mjs");
  try {
    await writeFile(fixture, `import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.error('original diagnostic');setTimeout(()=>process.exit(7),50);`);
    await assert.rejects(runVerifierStage("failed parent", fixture, [], { timeoutMs: 500 }), (error: any) => {
      assert.match(error.message, /Parent exited with code 7/);
      assert.match(error.message, /exit=7 signal=none/);
      assert.match(error.message, /Output drain timed out after 500ms/);
      assert.match(error.message, /original diagnostic/);
      assert.equal(error.cause.message, "Parent exited with code 7, signal none");
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
