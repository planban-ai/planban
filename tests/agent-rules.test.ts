// What agents may do follows the person, by every route (agent-surface audit,
// 15 October 2026): an agent working through the person's own computer
// sign-in stays within the person's setting for their agents, as remote agents
// do, and every agent edit that would complete a card needs a person's
// confirmation, on local and online boards, from MCP, the CLI and the REST API.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import { createHash, randomBytes } from "node:crypto";
import { boardPath, onlineRequest } from "../src/core/online/client";
import { onlineLogin } from "../src/core/online/login";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { attachOnline, takeOnline } from "../src/core/online/transfers";
import { serviceBridge } from "./service-bridge";

let root: string;
let bridge: Awaited<ReturnType<typeof serviceBridge>>;
const savedHome = process.env.PLANBAN_HOME;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-agent-rules-"));
  process.env.PLANBAN_HOME = join(root, "home");
  bridge = await serviceBridge();
  resetCopyChecks();
});

test.afterEach(async () => {
  await bridge.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
});

const revision = async (cwd: string) => (await storage.loadState(cwd)).roadmap.revision;
const statusOf = async (cwd: string, cardId: string) => (await storage.loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === cardId)?.status;

/** Ana's board online with one card, and Ben's computer using it as `role`, their agents set to `agentLevel`. */
async function sharedBoard(role: "editor" | "viewer", agentLevel?: "read" | "plan" | "complete") {
  const ana = join(root, "ana");
  await storage.initializeProject({ cwd: ana, repoId: "roadmap", title: "Roadmap", updateAgents: false });
  await storage.createCard({ cwd: ana, title: "Alpha" });
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, ana);
  await bridge.service.ctx.db.insert("members", { boardId: "roadmap", userId: "ben", role, ...(agentLevel ? { agentLevel } : {}) });
  await onlineLogin(bridge.url, { devUser: "ben", switchAccount: true });
  const ben = join(root, "ben");
  // As Ben's own computer would: this test's one computer also has Ana's link to the board.
  await attachOnline(bridge.url, "roadmap", ben, { account: "ben@example.com" });
  return ben;
}

test("an editor whose agents may only read: their agents can't change the board from their computer, the person can", async () => {
  const ben = await sharedBoard("editor", "read");
  await assert.rejects(
    storage.updateCard({ cwd: ben, cardId: "alpha", summary: "By an agent", baseRevision: await revision(ben), actor: "agent" }),
    /Your agents may only read on this board, so they can't change this board\. The person can change what their agents may do in the board's People settings/,
  );
  // The board page (no actor: the person) still edits.
  await storage.updateCard({ cwd: ben, cardId: "alpha", summary: "By Ben", baseRevision: await revision(ben) });
  assert.equal((await storage.loadState(ben)).roadmap.roadmapItems[0]!.summary, "By Ben");
});

test("an editor whose agents may plan: their agents can't complete even with confirmation, the person can", async () => {
  const ben = await sharedBoard("editor", "plan");
  await storage.updateCard({ cwd: ben, cardId: "alpha", summary: "Planned by an agent", baseRevision: await revision(ben), actor: "agent" });
  await assert.rejects(
    storage.moveCard({ cwd: ben, cardId: "alpha", status: "complete", baseRevision: await revision(ben), actor: "agent", completionConfirmed: true }),
    /Your agents may plan but not complete on this board, so they can't mark cards complete/,
  );
  await storage.moveCard({ cwd: ben, cardId: "alpha", status: "complete", baseRevision: await revision(ben) });
  assert.equal(await statusOf(ben, "alpha"), "complete");
});

test("a viewer is told plainly that viewing can't change the board, whatever their agents are set to", async () => {
  const ben = await sharedBoard("viewer", "complete");
  await assert.rejects(
    storage.updateCard({ cwd: ben, cardId: "alpha", summary: "Nope", baseRevision: await revision(ben), actor: "agent" }),
    /You can only view this board, so you and your agents can't change it\. Ask its owner to make you an editor\./,
  );
});

test("on an online board, every agent route to complete needs a person's confirmation", async () => {
  const ben = await sharedBoard("editor", "complete");
  const confirmation = /completionConfirmed must be true when this would put a card in complete/;
  const agent = async () => ({ cwd: ben, baseRevision: await revision(ben), actor: "agent" as const });
  await assert.rejects(storage.moveCard({ ...await agent(), cardId: "alpha", status: "complete" }), confirmation);
  await assert.rejects(storage.createCard({ ...await agent(), title: "Born done", status: "complete" }), confirmation);
  await assert.rejects(storage.createCards({ ...await agent(), titles: ["Done one"], status: "complete" }), confirmation);
  await assert.rejects(storage.createGroup({ ...await agent(), title: "Done group", status: "complete" }), confirmation);
  await assert.rejects(storage.reorderCards({ ...await agent(), items: [{ id: "alpha", status: "complete" }] }), confirmation);
  assert.equal(await statusOf(ben, "alpha"), "pending", "nothing completed");

  // The REST API takes the confirmation in the body, as MCP takes it as an argument.
  const op = (body: Record<string, unknown>) => onlineRequest(bridge.url, boardPath("roadmap", "/ops/moveCard"), body);
  await assert.rejects(op({ cardId: "alpha", status: "complete", baseRevision: await revision(ben), actor: "agent" }), confirmation);
  await op({ cardId: "alpha", status: "complete", baseRevision: await revision(ben), actor: "agent", completionConfirmed: true });
  assert.equal(await statusOf(ben, "alpha"), "complete");

  // Restoring a version in which the card was complete needs it too.
  const done = (await storage.historyPayload(ben)).currentVersion;
  await storage.moveCard({ cwd: ben, cardId: "alpha", status: "pending", baseRevision: await revision(ben), actor: "agent" });
  await assert.rejects(storage.restoreCardVersion({ ...await agent(), cardId: "alpha", version: done }), confirmation);
  await storage.restoreCardVersion({ ...await agent(), cardId: "alpha", version: done, completionConfirmed: true });
  assert.equal(await statusOf(ben, "alpha"), "complete");
});

test("on a local board, an agent completes only with confirmation; the person needs none", async () => {
  const cwd = join(root, "local");
  await storage.initializeProject({ cwd, repoId: "local", title: "Local", updateAgents: false });
  await storage.createCard({ cwd, title: "Alpha" });
  const confirmation = /completionConfirmed must be true/;
  await assert.rejects(storage.moveCard({ cwd, cardId: "alpha", status: "complete", actor: "agent" }), confirmation);
  await assert.rejects(storage.createCard({ cwd, title: "Born done", status: "complete", actor: "agent" }), confirmation);
  await assert.rejects(storage.createCards({ cwd, titles: ["Done one"], status: "complete", actor: "agent" }), confirmation);
  await assert.rejects(storage.reorderCards({ cwd, items: [{ id: "alpha", status: "complete" }], actor: "agent" }), confirmation);
  await storage.moveCard({ cwd, cardId: "alpha", status: "complete", actor: "agent", completionConfirmed: true });
  await storage.createCard({ cwd, title: "Done by Ana", status: "complete" });

  // The command line acts as an agent: complete-card needs --completion-confirmed.
  await storage.createCard({ cwd, title: "Beta" });
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", ...args, "--cwd", cwd], { encoding: "utf8", env: process.env });
  const refused = cli("complete-card", "beta");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--completion-confirmed/);
  assert.equal(cli("complete-card", "beta", "--completion-confirmed").status, 0);
  assert.equal(await statusOf(cwd, "beta"), "complete");
});

test("a key given less access is told so, not sent to change the person's agent setting", async () => {
  const ben = await sharedBoard("editor", "complete");
  const token = `pbk_${randomBytes(24).toString("base64url")}`;
  const now = new Date().toISOString();
  await bridge.service.ctx.db.insert("connections", {
    userId: "ben", kind: "key", name: "Read key", clientName: "Read key", tokenHash: createHash("sha256").update(token).digest("hex"),
    boards: ["roadmap"], level: "read", canAdminister: false, createdAt: now, lastUsedAt: now, serviceOrigin: bridge.url,
  });
  const credentials = { clientId: "key", accessToken: token, refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z" };
  await assert.rejects(
    onlineRequest(bridge.url, boardPath("roadmap", "/ops/updateCard"), { cardId: "alpha", summary: "By a key", baseRevision: await revision(ben), actor: "agent" }, { credentials }),
    /This connection \(an app or access key\) was given read-only access, so it can't change this board\. The person can make a new connection with more access from Connections\./,
  );
});

test("an app connection that says it is the person still gets the agent's guidance on a clash", async () => {
  const ben = await sharedBoard("editor", "complete");
  const token = `pbk_${randomBytes(24).toString("base64url")}`;
  const now = new Date().toISOString();
  await bridge.service.ctx.db.insert("connections", {
    userId: "ben", kind: "key", name: "Key", clientName: "Key", tokenHash: createHash("sha256").update(token).digest("hex"),
    boards: ["roadmap"], level: "complete", canAdminister: false, createdAt: now, lastUsedAt: now, serviceOrigin: bridge.url,
  });
  const credentials = { clientId: "key", accessToken: token, refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z" };
  const stale = await revision(ben);
  await storage.updateCard({ cwd: ben, cardId: "alpha", summary: "Ben's", baseRevision: stale });
  await assert.rejects(
    onlineRequest(bridge.url, boardPath("roadmap", "/ops/updateCard"), { cardId: "alpha", summary: "Claimed", baseRevision: stale, actor: "user" }, { credentials }),
    /Never just resend it, and never give up silently/,
  );
});
