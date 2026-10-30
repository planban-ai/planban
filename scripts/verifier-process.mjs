import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execute = promisify(execFile);

/** Only processes launched by this verifier are passed here. POSIX stages
 * own a process group; Windows uses the live child PID, never an image name. */
export async function stopOwnedTree(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    await execute("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
  } else {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

export async function stopRecordedVerifierServer(files, knownPid = null) {
  let pid = knownPid;
  if (!pid) {
    for (const file of files) {
      let text;
      try { text = await readFile(file, "utf8"); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("Invalid fixture server PID record");
      pid = Number(text); break;
    }
  }
  if (pid) await stopOwnedTree(pid);
}

export async function runVerifierStage(stage, script, args = [], options = {}) {
  const { input = "", timeoutMs = 180_000, maxBuffer = 10 * 1024 * 1024, ...spawnOptions } = options;
  const started = Date.now();
  process.stderr.write(`[cold install] ${stage}: starting\n`);
  const child = spawn(process.execPath, [script, ...args], {
    ...spawnOptions, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", bytes = 0, failure, observedExit;
  let finish;
  const closed = new Promise((resolve) => { finish = resolve; });
  child.once("error", (error) => { failure = error; });
  // exit records the parent's status; close also requires descendant-held
  // pipes to drain. A later drain deadline must not erase a known failure.
  child.once("exit", (code, signal) => { observedExit = { code, signal }; });
  child.once("close", (code, signal) => finish({ code, signal }));
  const capture = (stream, target) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (target === "stdout") stdout += chunk; else stderr += chunk;
      if (bytes > maxBuffer && !failure) failure = new Error(`Output exceeds ${maxBuffer} bytes`);
      if (bytes > maxBuffer) { stdout = stdout.slice(-8000); stderr = stderr.slice(-8000); exceeded(); }
    });
  };
  let exceeded;
  const overflow = new Promise((resolve) => { exceeded = () => resolve({ overflow: true }); });
  capture(child.stdout, "stdout"); capture(child.stderr, "stderr");
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") failure ??= error; });
  child.stdin.end(input);
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), timeoutMs); });
  const result = await Promise.race([closed, timedOut, overflow]);
  clearTimeout(timer);
  const status = observedExit ?? result;
  const cleanupErrors = [];
  if (result.timeout || result.overflow) {
    if (result.timeout && observedExit && (observedExit.code !== 0 || observedExit.signal)) {
      failure ??= new Error(`Parent exited with code ${observedExit.code ?? "unknown"}, signal ${observedExit.signal ?? "none"}`);
      cleanupErrors.push(new Error(`Output drain timed out after ${timeoutMs}ms`));
    } else failure ??= new Error(result.timeout ? `Timed out after ${timeoutMs}ms` : "Output limit exceeded");
    try { await stopOwnedTree(child.pid); } catch (error) { cleanupErrors.push(error); }
    let cleanupTimer;
    const settled = await Promise.race([closed.then(() => true), new Promise((resolve) => { cleanupTimer = setTimeout(() => resolve(false), 5000); })]);
    clearTimeout(cleanupTimer);
    if (!settled) {
      cleanupErrors.push(new Error("Owned child streams did not close after tree termination"));
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
    }
  }
  if (failure || result.code !== 0) {
    const detail = [failure?.message, `exit=${status.code ?? "unknown"} signal=${status.signal ?? "none"}`, ...cleanupErrors.map((error) => `cleanup: ${error.message}`), `stdout:\n${stdout.slice(-8000)}`, `stderr:\n${stderr.slice(-8000)}`].filter(Boolean).join("\n");
    throw new Error(`[cold install] ${stage} failed after ${Date.now() - started}ms\n${detail}`, { cause: failure });
  }
  process.stderr.write(`[cold install] ${stage}: passed (${Date.now() - started}ms)\n`);
  return { stdout, stderr };
}

/** Every cleanup is attempted. A cleanup error must not replace the original
 * verification failure or permit an otherwise failing check to report success. */
export async function withVerifierCleanup(work, cleanups, log = (line) => process.stderr.write(line)) {
  let result, primary;
  try { result = await work(); } catch (error) { primary = error; }
  const errors = [];
  for (const [label, cleanup] of cleanups) {
    try { await cleanup(); } catch (error) {
      errors.push(error);
      log(`[cold install] cleanup ${label}: ${error.stack ?? error}\n`);
    }
  }
  if (primary) throw primary;
  if (errors.length) throw new AggregateError(errors, "Cold-install cleanup failed");
  return result;
}
