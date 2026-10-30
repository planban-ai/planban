// A computer's Planban and the online service at different versions (owner decision,
// 16 October 2026): an older Planban says plainly that it's behind, and an action the
// service needs a newer Planban for gives that plain message, not a raw error.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import {
  BEHIND_NOTICE, compareVersions, knownFeaturesFor, PLANBAN_VERSION_HEADER, refusedForVersion, unknownFeatures, UPDATE_REQUIRED_MESSAGE,
} from "../src/core/clientVersion";
import { PlanbanUpdateRequiredError } from "../src/core/online/client";
import { readCredentials, serviceUrl } from "../src/core/online/credentials";
import { onlineLogin } from "../src/core/online/login";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { takeOnline } from "../src/core/online/transfers";
import { errorReport } from "../src/core/errorReport";
import { PLANBAN_VERSION } from "../src/core/version";
import { serviceBridge } from "./service-bridge";

let root: string;
let cwd: string;
const savedHome = process.env.PLANBAN_HOME;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-version-"));
  process.env.PLANBAN_HOME = join(root, "home");
  cwd = join(root, "revival");
  await storage.initializeProject({ cwd, repoId: "revival", title: "Revival", updateAgents: false });
  await storage.createCard({ cwd, title: "Alpha" });
  resetCopyChecks();
});

test.afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
});

test("an older version can't show goals and sees the notice; this version sees nothing", () => {
  assert.equal(compareVersions("1.1.7", "2.0.0"), -1);
  assert.equal(compareVersions("2.0.0", "2.0.0-beta.1"), 0);
  assert.equal(compareVersions("2.10.0", "2.9.3"), 1);
  assert.deepEqual(knownFeaturesFor("1.1.7"), []);
  assert.deepEqual(unknownFeatures(["goals"], "1.1.7"), ["goals"]);
  assert.deepEqual(unknownFeatures(["goals"], PLANBAN_VERSION), []);
  // A feature from a later version is unknown to this one.
  assert.deepEqual(unknownFeatures(["goals", "timeline"]), ["timeline"]);
  assert.deepEqual(unknownFeatures(undefined), []);
});

test("the service refuses an action only below its minimum version, with the plain message", () => {
  const rules = { minimums: { retiredOp: "2.1.0" }, floor: "1.0.0" };
  assert.equal(refusedForVersion("2.0.0", "retiredOp", rules), UPDATE_REQUIRED_MESSAGE);
  assert.equal(refusedForVersion("2.1.0", "retiredOp", rules), null);
  assert.equal(refusedForVersion("2.0.0", "createCard", rules), null);
  assert.equal(refusedForVersion("0.9.0", "createCard", rules), UPDATE_REQUIRED_MESSAGE);
  // A Planban too old to name its version counts as 1.0.0, so today's service still accepts it.
  assert.equal(refusedForVersion(null, "createCard"), null);
  assert.equal(refusedForVersion(PLANBAN_VERSION, "createCard"), null);
});

async function onlineBoard() {
  const bridge = await serviceBridge([["ana", "Ana"]]);
  await storage.editGoals({ cwd, edit: { kind: "add", statement: "Win clubs" }, baseRevision: (await storage.loadState(cwd)).roadmap.revision });
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, cwd);
  return bridge;
}

test("online: the service tells readers which features the board uses; this version shows them all", async () => {
  const bridge = await onlineBoard();
  try {
    const credentials = (await readCredentials()).services[serviceUrl(bridge.url)]!;
    const read = await fetch(`${bridge.url}/api/v1/boards/revival`, { headers: { Authorization: `Bearer ${credentials.accessToken}`, [PLANBAN_VERSION_HEADER]: PLANBAN_VERSION } });
    assert.deepEqual((await read.json()).features, ["goals"]);
    assert.equal((await storage.loadState(cwd)).planbanBehind, undefined);
    // Anything on the Goals page counts, a Context alone included.
    await storage.editGoals({ cwd, edit: { kind: "retire", goalId: "g1" }, baseRevision: (await storage.loadState(cwd)).roadmap.revision });
    await storage.editGoals({ cwd, edit: { kind: "context", context: "Ambition: 100 clubs." }, baseRevision: (await storage.loadState(cwd)).roadmap.revision });
    const featuresNow = async () => (await (await fetch(`${bridge.url}/api/v1/boards/revival`, { headers: { Authorization: `Bearer ${credentials.accessToken}` } })).json()).features;
    assert.deepEqual(await featuresNow(), ["goals"]);
  } finally {
    await bridge.close();
  }
});

test("online: a board using a feature this Planban doesn't have shows the notice, to people and agents", async () => {
  const bridge = await onlineBoard();
  try {
    const { roadmap } = await storage.loadState(cwd);
    bridge.control.intercept = async (path) => (path === "/api/v1/boards/revival" ? { status: 200, body: { roadmap, features: ["goals", "timeline"] } } : undefined);
    assert.deepEqual((await storage.loadState(cwd)).planbanBehind, { notice: BEHIND_NOTICE, features: ["timeline"] });
    const [, board] = await runMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "planban_get_board", arguments: { cwd } } },
    ]);
    assert.match(board.result.content[0].text, /This board uses features your Planban doesn't have yet\. Update to see everything\. Ask the person to update Planban/);
    assert.deepEqual(board.result.structuredContent.planbanBehind.features, ["timeline"]);
    assert.match(board.result.content[0].text, /open the board in Planban on this computer and choose Update/);
    // An edit's result keeps the notice: edits don't repeat the board's features.
    const edited = await storage.createCard({ cwd, title: "Beta", baseRevision: (await storage.loadState(cwd)).roadmap.revision });
    assert.deepEqual(edited.planbanBehind?.features, ["timeline"]);
  } finally {
    await bridge.close();
  }
});

test("online: an action the service needs a newer Planban for gives the plain message, not a raw error", async () => {
  const bridge = await onlineBoard();
  try {
    // The service itself refuses a Planban below its minimum, in plain words.
    const credentials = (await readCredentials()).services[serviceUrl(bridge.url)]!;
    const old = await fetch(`${bridge.url}/api/v1/boards/revival/ops/createCard`, {
      method: "POST", body: JSON.stringify({ title: "From an old Planban" }),
      headers: { Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": "application/json", [PLANBAN_VERSION_HEADER]: "0.9.0" },
    });
    assert.equal(old.status, 426);
    assert.deepEqual((await old.json()).error, { code: "update_required", message: UPDATE_REQUIRED_MESSAGE });
    // This Planban shows that message as it is, for people and agents, with how to update.
    bridge.control.intercept = async (path) => (path.includes("/ops/") ? { status: 426, body: { error: { code: "update_required", message: UPDATE_REQUIRED_MESSAGE } } } : undefined);
    const base = (await storage.loadState(cwd)).roadmap.revision;
    const refused = await storage.createCard({ cwd, title: "Beta", baseRevision: base }).then(() => null, (error: unknown) => error);
    assert.ok(refused instanceof PlanbanUpdateRequiredError);
    assert.equal(refused.message, UPDATE_REQUIRED_MESSAGE);
    const report = errorReport(refused);
    assert.equal(report.category, "update_required");
    assert.match(String(report.details?.howToUpdate), /choose Update/);
    // This version's own requests go through.
    bridge.control.intercept = undefined;
    await storage.createCard({ cwd, title: "Beta", baseRevision: base });
    assert.ok((await storage.loadState(cwd)).roadmap.roadmapItems.some((item) => item.title === "Beta"));
  } finally {
    await bridge.close();
  }
});

async function runMcp(requests: unknown[]) {
  const child = spawn(process.execPath, [join(process.cwd(), "plugins/planban/scripts/start-planban-mcp.mjs")], {
    env: { ...process.env, PLANBAN_ACTIVITY_URL: "http://127.0.0.1:9", PLANBAN_REPO_ROOT: process.cwd() }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => { child.kill(); rejectExit(new Error("MCP server timed out")); }, 15_000);
    child.once("exit", (code) => { clearTimeout(timer); resolveExit(code); });
  });
  child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  assert.equal(await exited, 0, stderr);
  return stdout.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

test("sign-in requests name this Planban's version too", async () => {
  const seen: Array<string | null> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get(PLANBAN_VERSION_HEADER));
    return new Response(JSON.stringify({ error: { message: "No sign-in here." } }), { status: 503 });
  }) as typeof fetch;
  try {
    await assert.rejects(onlineLogin("http://127.0.0.1:9", { devUser: "ana" }));
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(seen.length > 0);
  assert.ok(seen.every((version) => version === PLANBAN_VERSION));
});
