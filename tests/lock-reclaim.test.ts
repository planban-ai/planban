import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";

const execFileAsync = promisify(execFile);

/** Waits for a helper process to say it holds the board; fails instead of hanging if it never does. */
function started(child: import("node:child_process").ChildProcess) {
  return new Promise<void>((resolveStarted, rejectStarted) => {
    let errors = "";
    child.stderr?.on("data", (chunk) => { errors += chunk; });
    const timer = setTimeout(() => rejectStarted(new Error(`helper did not start: ${errors}`)), 20_000);
    child.stdout?.once("data", () => { clearTimeout(timer); resolveStarted(); });
    child.once("exit", (code) => { clearTimeout(timer); rejectStarted(new Error(`helper exited (${code}): ${errors}`)); });
  });
}

test("processes that find a killed process's lock at the same time never hold it together", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-lock-"));
  try {
    const planningRoot = join(root, "board");
    // A lock left by a process that has since exited.
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((resolveExit) => dead.once("exit", resolveExit));
    await mkdir(join(planningRoot, ".planban-write.lock"), { recursive: true });
    await writeFile(join(planningRoot, ".planban-write.lock", "owner.json"), JSON.stringify({ pid: dead.pid, token: "dead", queue: true, createdAt: new Date().toISOString() }));
    // And the queue entries of a process killed while waiting and while holding.
    await mkdir(join(planningRoot, ".planban-write.queue"), { recursive: true });
    await writeFile(join(planningRoot, ".planban-write.queue", "choosing-00000000-0000-4000-8000-000000000001.json"), JSON.stringify({ pid: dead.pid }));
    await writeFile(join(planningRoot, ".planban-write.queue", "ticket-000000000001-00000000-0000-4000-8000-000000000002.json"), JSON.stringify({ pid: dead.pid }));
    const log = join(root, "log.txt");
    const script = join(root, "hold.mjs");
    await writeFile(script, `
      import { appendFile } from "node:fs/promises";
      const { withBoardWriteLock } = await import(${JSON.stringify(pathToFileURL(resolve("src/core/persistence.ts")).href)});
      await withBoardWriteLock(${JSON.stringify(planningRoot)}, async () => {
        await appendFile(${JSON.stringify(log)}, "enter\\n");
        await new Promise((r) => setTimeout(r, 150));
        await appendFile(${JSON.stringify(log)}, "exit\\n");
      });
    `);
    await Promise.all(Array.from({ length: 4 }, () => execFileAsync(process.execPath, ["--import", "tsx/esm", script])));
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    assert.equal(lines.length, 8);
    for (let index = 0; index < lines.length; index += 2) assert.deepEqual(lines.slice(index, index + 2), ["enter", "exit"], `overlap in ${lines.join(",")}`);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("an old lock whose holder is still alive is never taken away", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-lock-"));
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  try {
    const planningRoot = join(root, "board");
    const lock = join(planningRoot, ".planban-write.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: holder.pid, token: "alive", queue: true, createdAt: new Date(0).toISOString() }));
    await mkdir(join(planningRoot, ".planban-write.queue"), { recursive: true });
    await writeFile(join(planningRoot, ".planban-write.queue", "ticket-000000000001-00000000-0000-4000-8000-000000000003.json"), JSON.stringify({ pid: holder.pid }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lock, old, old);
    const { withBoardWriteLock } = await import("../src/core/persistence");
    let entered = false;
    const waiting = withBoardWriteLock(planningRoot, async () => { entered = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    assert.equal(entered, false, "the live holder's lock was taken");
    holder.kill("SIGKILL");
    await new Promise((resolveExit) => holder.once("exit", resolveExit));
    await waiting;
    assert.equal(entered, true);
    // The lock an older Planban version would hold, recently refreshed, is respected too.
    const legacy = join(root, "legacy-board");
    await mkdir(join(legacy, ".planban-write.lock"), { recursive: true });
    await writeFile(join(legacy, ".planban-write.lock", "owner.json"), JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() }));
    let enteredLegacy = false;
    const legacyWaiting = withBoardWriteLock(legacy, async () => { enteredLegacy = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    assert.equal(enteredLegacy, false, "an older version's fresh lock was taken");
    await rm(join(legacy, ".planban-write.lock"), { recursive: true, force: true });
    await legacyWaiting;
    assert.equal(enteredLegacy, true);
    assert.equal(entered, true);
  } finally {
    holder.kill("SIGKILL");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("many processes taking turns on one board never overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-lock-"));
  try {
    const planningRoot = join(root, "board");
    const log = join(root, "log.txt");
    const script = join(root, "turns.mjs");
    await writeFile(script, `
      import { appendFile } from "node:fs/promises";
      const { withBoardWriteLock } = await import(${JSON.stringify(pathToFileURL(resolve("src/core/persistence.ts")).href)});
      for (let turn = 0; turn < 3; turn += 1) {
        await withBoardWriteLock(${JSON.stringify(planningRoot)}, async () => {
          await appendFile(${JSON.stringify(log)}, "enter\\n");
          await new Promise((r) => setTimeout(r, 20));
          await appendFile(${JSON.stringify(log)}, "exit\\n");
        });
      }
    `);
    await Promise.all(Array.from({ length: 8 }, () => execFileAsync(process.execPath, ["--import", "tsx/esm", script])));
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    assert.equal(lines.length, 48);
    for (let index = 0; index < lines.length; index += 2) assert.deepEqual(lines.slice(index, index + 2), ["enter", "exit"], `overlap at ${index}`);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a write blocked by a stuck process says which process holds the board and how to free it", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-lock-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const env = { ...process.env, PLANBAN_HOME: home, PLANBAN_LOCK_WAIT_MS: "1500" };
  const cli = (args: string[]) => execFileAsync(process.execPath, ["--import", "tsx/esm", resolve("src/cli.ts"), ...args], { env });
  try {
    await cli(["init", "--cwd", project, "--repo-id", "stuck-board", "--no-agents", "-o", "json"]);
    const planningRoot = join(home, "repos", "stuck-board");
    // A process that takes the board and then hangs.
    const script = join(root, "hang.mjs");
    await writeFile(script, `
      const { withBoardWriteLock } = await import(${JSON.stringify(pathToFileURL(resolve("src/core/persistence.ts")).href)});
      await withBoardWriteLock(${JSON.stringify(planningRoot)}, async () => { console.log("holding"); await new Promise(() => { setInterval(() => {}, 1000); }); });
    `);
    const holder = spawn(process.execPath, ["--import", "tsx/esm", script, "hung-agent-marker"], { env });
    await started(holder);
    try {
      const started = Date.now();
      const failure = await cli(["create-card", "Blocked", "--cwd", project, "-o", "json"]).then(() => null, (error) => error);
      assert.ok(failure, "the write should give up");
      assert.match(failure.stderr, new RegExp(`held by process ${holder.pid}`));
      assert.match(failure.stderr, /hung-agent-marker/);
      assert.match(failure.stderr, new RegExp(process.platform === "win32" ? `taskkill /PID ${holder.pid}` : `kill ${holder.pid}`));
      assert.match(failure.stderr, /nothing was changed/);
      assert.ok(Date.now() - started < 4000, "a short limit is honoured without waiting for the notice");
      // An agent going through the local MCP server gets the same explanation.
      const mcp = spawn(process.execPath, ["plugins/planban/scripts/start-planban-mcp.mjs"], {
        env: { ...env, PLANBAN_REPO_ROOT: resolve("."), PLANBAN_ACTIVITY_URL: "http://127.0.0.1:9" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      mcp.stdout.on("data", (chunk) => { output += chunk; });
      const done = new Promise<void>((resolveDone) => mcp.once("exit", () => resolveDone()));
      mcp.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "planban_create_card", arguments: { cwd: project, title: "From an agent" } } }) + "\n");
      await done;
      assert.match(output, new RegExp(`held by process ${holder.pid}`));
      assert.match(output, new RegExp(process.platform === "win32" ? `taskkill /PID ${holder.pid}` : `kill ${holder.pid}`));
    } finally {
      const exited = holder.exitCode !== null || holder.signalCode !== null ? Promise.resolve() : new Promise((resolveExit) => holder.once("exit", resolveExit));
      holder.kill("SIGKILL");
      await exited;
    }
    const created = JSON.parse((await cli(["create-card", "Unblocked", "--cwd", project, "-o", "json"])).stdout);
    assert.ok(JSON.stringify(created).includes("Unblocked"));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function hang(root: string, lockedFolder: string, env: NodeJS.ProcessEnv, legacyOnly = false) {
  const script = join(root, `hang-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(script, legacyOnly
    // An older Planban version: only the original lock directory, no queue.
    ? `import { mkdirSync, writeFileSync } from "node:fs";
       mkdirSync(${JSON.stringify(join(lockedFolder, ".planban-write.lock"))}, { recursive: true });
       writeFileSync(${JSON.stringify(join(lockedFolder, ".planban-write.lock", "owner.json"))}, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
       console.log("holding"); setInterval(() => {}, 1000);`
    : `const { withBoardWriteLock } = await import(${JSON.stringify(pathToFileURL(resolve("src/core/persistence.ts")).href)});
       await withBoardWriteLock(${JSON.stringify(lockedFolder)}, async () => { console.log("holding"); await new Promise(() => { setInterval(() => {}, 1000); }); });`);
  const holder = spawn(process.execPath, ["--import", "tsx/esm", script, "older-or-hung-marker"], { env });
  await started(holder);
  return {
    holder,
    async stop() {
      const exited = holder.exitCode !== null || holder.signalCode !== null ? Promise.resolve() : new Promise((resolveExit) => holder.once("exit", resolveExit));
      holder.kill("SIGKILL");
      await exited;
    },
  };
}

test("a lock taken part-way through an operation waits rather than giving up with half the work done", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-lock-"));
  const home = join(root, "home");
  const env = { ...process.env, PLANBAN_HOME: home, PLANBAN_LOCK_WAIT_MS: "1000" };
  try {
    await mkdir(home, { recursive: true });
    // Board creation writes the project files, then records the board in the
    // machine's board list under that list's own lock, held here.
    const held = await hang(root, home, env);
    const init = execFileAsync(process.execPath, ["--import", "tsx/esm", resolve("src/cli.ts"), "init", "--cwd", join(root, "project"), "--repo-id", "nested", "--no-agents", "-o", "json"], { env });
    await new Promise((resolveWait) => setTimeout(resolveWait, 2500));
    await held.stop();
    await init;
    assert.ok(JSON.parse(await readFile(join(home, "index.json"), "utf8")).boards.some((board: { repoId: string }) => board.repoId === "nested"));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("when an older Planban version holds the board, that is the process named", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-lock-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const env = { ...process.env, PLANBAN_HOME: home, PLANBAN_LOCK_WAIT_MS: "1500" };
  const cli = (args: string[]) => execFileAsync(process.execPath, ["--import", "tsx/esm", resolve("src/cli.ts"), ...args], { env });
  try {
    await cli(["init", "--cwd", project, "--repo-id", "legacy-held", "--no-agents", "-o", "json"]);
    const held = await hang(root, join(home, "repos", "legacy-held"), env, true);
    try {
      // A modern process queues first and waits behind the older version...
      const waiting = cli(["create-card", "First", "--cwd", project, "-o", "json"]).catch(() => null);
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      // ...and a second one must still name the older version's process.
      const failure = await cli(["create-card", "Second", "--cwd", project, "-o", "json"]).then(() => null, (error) => error);
      assert.match(failure?.stderr ?? "", new RegExp(`held by process ${held.holder.pid}`));
      await waiting;
    } finally {
      await held.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a card edit from the board page gives up with the same explanation", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-lock-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const env = { ...process.env, PLANBAN_HOME: home, PLANBAN_LOCK_WAIT_MS: "1500" };
  const saved = { home: process.env.PLANBAN_HOME, wait: process.env.PLANBAN_LOCK_WAIT_MS };
  process.env.PLANBAN_HOME = home;
  process.env.PLANBAN_LOCK_WAIT_MS = "1500";
  try {
    const storage = await import("../src/core/storage");
    await storage.initializeProject({ cwd: project, repoId: "page-board", title: "Page board", updateAgents: false });
    const created = await storage.createCard({ cwd: project, title: "Alpha" });
    const held = await hang(root, join(home, "repos", "page-board"), env);
    const { startServer } = await import("../src/server/server");
    const probe = createServer();
    await new Promise<void>((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
    const server = await startServer({ cwd: project, port, useVite: false });
    try {
      const registryBefore = await readFile(join(home, "index.json"), "utf8");
      const started = Date.now();
      const response = await fetch(`${server.url}/api/boards/page-board/cards/${created.createdCard.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "From the page", baseRevision: created.roadmap.revision }),
      });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, new RegExp(`held by process ${held.holder.pid}`));
      assert.ok(Date.now() - started < 4000);
      assert.equal(await readFile(join(home, "index.json"), "utf8"), registryBefore, "nothing was changed, not even the board list");
    } finally {
      await server.close();
      await held.stop();
    }
  } finally {
    if (saved.home === undefined) delete process.env.PLANBAN_HOME; else process.env.PLANBAN_HOME = saved.home;
    if (saved.wait === undefined) delete process.env.PLANBAN_LOCK_WAIT_MS; else process.env.PLANBAN_LOCK_WAIT_MS = saved.wait;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
