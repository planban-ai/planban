import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mainCheckoutForWorktree, resolvePlanbanProjectDir } from "../plugins/planban/scripts/project-dir.mjs";
import { getStatus } from "../src/core/storage";
import { planbanSessionContext } from "../plugins/planban/scripts/claude-session-context.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "planban-project-dir-"));
  const main = join(root, "main");
  await mkdir(join(main, ".planban"), { recursive: true });
  await writeFile(join(main, ".planban/project.json"), JSON.stringify({ version: 1, repoId: "main-board", enabled: true, storage: { kind: "local" } }));
  await mkdir(join(main, ".git/worktrees/feature"), { recursive: true });
  await writeFile(join(main, ".git/worktrees/feature/commondir"), "../..\n");
  const linked = join(root, "linked");
  await mkdir(join(linked, "src/deep"), { recursive: true });
  await writeFile(join(linked, ".git"), `gitdir: ${join(main, ".git/worktrees/feature")}\n`);
  const plain = join(root, "plain");
  await mkdir(join(plain, ".git"), { recursive: true });
  return { root, main, linked, plain };
}

test("a cwd with its own manifest resolves to itself", async () => {
  const { root, main } = await fixture();
  try {
    assert.deepEqual(resolvePlanbanProjectDir(main), { projectDir: main, requestedCwd: main, via: "cwd" });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("a linked git worktree resolves to the main checkout that owns the board", async () => {
  const { root, main, linked } = await fixture();
  try {
    assert.equal(mainCheckoutForWorktree(linked), main);
    assert.deepEqual(resolvePlanbanProjectDir(linked), { projectDir: main, requestedCwd: linked, via: "worktree", worktreeDir: linked });
    const nested = join(linked, "src/deep");
    assert.deepEqual(resolvePlanbanProjectDir(nested), { projectDir: main, requestedCwd: nested, via: "worktree", worktreeDir: linked });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("discovery stops at the repository top and never leaks to unrelated parents", async () => {
  const { root, plain } = await fixture();
  try {
    await mkdir(join(root, ".planban"), { recursive: true });
    await writeFile(join(root, ".planban/project.json"), JSON.stringify({ version: 1, repoId: "parent-board", enabled: true }));
    assert.deepEqual(resolvePlanbanProjectDir(plain), { projectDir: plain, requestedCwd: plain, via: "none" });
    const inside = join(plain, "packages/app");
    await mkdir(inside, { recursive: true });
    assert.deepEqual(resolvePlanbanProjectDir(inside), { projectDir: inside, requestedCwd: inside, via: "none" });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("a subdirectory of an initialized repo resolves to the repo root", async () => {
  const { root, main } = await fixture();
  try {
    const sub = join(main, "packages/web");
    await mkdir(sub, { recursive: true });
    assert.deepEqual(resolvePlanbanProjectDir(sub), { projectDir: main, requestedCwd: sub, via: "ancestor" });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("status and the session hook report the main checkout board from a linked worktree", async () => {
  const { root, main, linked } = await fixture();
  try {
    const status = await getStatus(linked);
    assert.equal(status.initialized, true);
    assert.equal(status.cwd, main);
    assert.equal("requestedCwd" in status ? status.requestedCwd : null, linked);
    assert.equal("discoveredVia" in status ? status.discoveredVia : null, "worktree");
    assert.equal("repoId" in status ? status.repoId : null, "main-board");
    const context = planbanSessionContext({ projectDir: linked }) ?? "";
    assert.match(context, /board `main-board`/u);
    assert.match(context, /linked git worktree/u);
    assert.ok(context.includes(main));
    assert.ok(context.includes(join(main, ".planban/agent-context.md")), "the hook names the exact agent-context file to read");
    const own = planbanSessionContext({ projectDir: main }) ?? "";
    assert.doesNotMatch(own, /linked git worktree/u);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
