// An Online Board recording merged pull requests itself, from GitHub's webhook
// (online/service/convex/github.ts), against the service's real handlers: the
// signature check, replays, landing notes, the inbox, hosted surfaces, and
// linking from a computer, with the link's secret never shown again.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryService, NATIVE, withServiceEnv } from "./hosted-harness";
import { serviceBridge } from "./service-bridge";
import { boardPath } from "../src/web/apiPaths";
import { handleMcp, McpService } from "../online/service/convex/model/mcp";
import { apiResponse } from "../online/service/convex/http";
import { EDGE_PROOF_HEADER } from "../online/service/convex/model/auth";
import * as connections from "../online/service/convex/connections";
import { ADMITTED_PER_LINK_PER_MINUTE, constantTimeEqual, MAX_WEBHOOK_BYTES, verifyGitHubSignature } from "../online/service/convex/model/githubWebhook";
import * as github from "../online/service/convex/github";
import { DELIVERY_MEMORY_MS, DELIVERY_WRITES_PER_HOUR, FORGET_BATCH } from "../online/service/convex/github";
import { LANDED_LABEL, MERGES_NOT_CHECKED_NOTE } from "../src/core/staleness";
import { gitHubLinkStatus, linkGitHubRepo, unlinkGitHubRepo, useGhRunner } from "../src/core/online/github";
import { onlineLogin } from "../src/core/online/login";
import { takeOnline } from "../src/core/online/transfers";
import * as storage from "../src/core/storage";

type Json = Record<string, any>;
const REPO = "planban-ai/planban";
const web = { "X-Planban-Client": "web", "Content-Type": "application/json" };

/** A computer's sign-in (as `planban online login` makes one) for this person: the link routes take no browser session. */
async function computerSignIn(service: ReturnType<typeof memoryService>, userId: string) {
  const token = `pbd_${randomBytes(24).toString("base64url")}`;
  await (connections.createDevConnection as any)._handler(service.ctx, { tokenHash: createHash("sha256").update(token).digest("hex"), userId, clientName: "Planban CLI", boards: "all", level: "complete" });
  return async (path: string, body?: unknown) => {
    const response = await apiResponse(service.actionCtx, new Request(`${NATIVE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      // As the edge forwards it from the public address.
      headers: { Authorization: `Bearer ${token}`, [EDGE_PROOF_HEADER]: "synthetic-edge-proof-only", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: response.status, body: await response.json() as Json };
  };
}

async function ownerBoard() {
  const service = memoryService();
  const owner = await service.signIn("user_owner", "Olive Owner");
  const call = await computerSignIn(service, "user_owner");
  const created = await call("/api/v1/boards", { title: "Planban" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const boardId = created.body.boardId as string;
  const board = async () => (await call(`/api/v1/boards/${boardId}`)).body;
  const op = async (name: string, input: Json) => {
    const result = await call(`/api/v1/boards/${boardId}/ops/${name}`, { ...input, baseRevision: (await board()).roadmap.revision, actor: "user" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const card = async (title: string, fields: Json = {}) => (await op("createCard", { title, status: "in-progress", ...fields })).result.createdCard.id as string;
  return { service, owner, boardId, call, board, op, card };
}

type Board = Awaited<ReturnType<typeof ownerBoard>>;

let hooks = 1000;
/**
 * Links a repository as the owner's computer does: makes the link, records the webhook id GitHub
 * gave, and GitHub's ping for that webhook confirms it. `confirmed: false` stops after making it.
 */
async function link(setup: Board, repo = REPO, options: { confirmed?: boolean } = {}) {
  const created = await setup.call(`/api/v1/boards/${setup.boardId}/github/links`, { repo });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const made = created.body as { linkId: string; webhookUrl: string; secret: string; home: boolean };
  const hookId = ++hooks;
  if (options.confirmed !== false) {
    assert.equal((await setup.call(`/api/v1/boards/${setup.boardId}/github/links/${made.linkId}/hook`, { hookId })).status, 200);
    assert.equal((await deliver(setup, made.linkId, made.secret, "ping", pingFor(hookId, repo))).status, 200);
  }
  return { ...made, hookId };
}

const pingFor = (hookId: number, repo = REPO) => ({ zen: "Hi", hook_id: hookId, hook: { id: hookId, type: "Repository" }, repository: { full_name: repo } });

let deliveries = 0;
/** A delivery as GitHub sends it through the edge, signed with `secret` unless a signature is given. */
async function deliver(setup: Board, linkId: string, secret: string, event: string, payload: unknown, options: { signature?: string | null; deliveryId?: string; raw?: string; edge?: boolean } = {}) {
  const body = options.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": options.deliveryId ?? `delivery-${++deliveries}`, "User-Agent": "GitHub-Hookshot/1",
    ...(options.edge === false ? {} : { [EDGE_PROOF_HEADER]: "synthetic-edge-proof-only" }),
  };
  const signature = options.signature === undefined ? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` : options.signature;
  if (signature !== null) headers["X-Hub-Signature-256"] = signature;
  const response = await apiResponse(setup.service.actionCtx, new Request(`${NATIVE}/api/v1/github/hooks/${linkId}`, { method: "POST", headers, body }));
  return { status: response.status, body: await response.json() as Json };
}

const merged = (number: number, title = `Change ${number}`, repo = REPO, extra: Json = {}) => ({
  action: "closed", number, repository: { full_name: repo },
  pull_request: { number, title, merged: true, merged_at: "2026-10-30T09:15:00Z", html_url: `https://github.com/${repo}/pull/${number}`, ...extra },
});

async function mcp(setup: Board, name: string, args: Json) {
  const service = new McpService(setup.service.actionCtx, setup.owner.connectionId as any);
  const response = await handleMcp(new Request("https://app.planban.example/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), service, "https://app.planban.example");
  const reply = await response.json() as Json;
  return reply.result.structuredContent as Json;
}

test("GitHub's signature: good, bad, missing, and the compare takes the same time whatever matches", async () => {
  const body = new TextEncoder().encode('{"zen":"Keep it logically awesome."}');
  const good = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(await verifyGitHubSignature("s3cret", body, good), true);
  assert.equal(await verifyGitHubSignature("other", body, good), false);
  assert.equal(await verifyGitHubSignature("s3cret", body, null), false);
  assert.equal(await verifyGitHubSignature("s3cret", body, "sha1=abc"), false);
  assert.equal(await verifyGitHubSignature("s3cret", body, good.toUpperCase()), false);
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
});

test("a delivery is refused alike for an unknown link, a bad or missing signature and another repository", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    const { linkId, secret } = await link(setup);
    const revision = (await setup.board()).roadmap.revision;
    const refusals = [
      await deliver(setup, linkId, "wrong-secret", "pull_request", merged(1)),
      await deliver(setup, linkId, secret, "pull_request", merged(1), { signature: null }),
      await deliver(setup, linkId, secret, "pull_request", merged(1), { signature: "sha256=" + "0".repeat(64) }),
      await deliver(setup, "ghl_unknownlinkid00000000000", secret, "pull_request", merged(1)),
      await deliver(setup, "x", secret, "pull_request", merged(1)),
      // Signed with this link's secret, but naming another repository.
      await deliver(setup, linkId, secret, "pull_request", merged(1, "Elsewhere", "someone/else")),
    ];
    for (const refusal of refusals) assert.deepEqual(refusal, { status: 401, body: { error: "unauthorized" } });
    assert.equal((await setup.board()).roadmap.revision, revision, "nothing was recorded");
    // Too large is refused before anything is read or checked.
    const big = await deliver(setup, linkId, secret, "pull_request", null, { raw: "x".repeat(MAX_WEBHOOK_BYTES + 1) });
    assert.equal(big.status, 413);
  });
});

test("ping is recorded as the last delivery; other events and unmerged pull requests change nothing", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    const { linkId, secret, hookId } = await link(setup);
    assert.equal((await deliver(setup, linkId, secret, "ping", pingFor(hookId))).status, 200);
    const status = await setup.call(`/api/v1/boards/${setup.boardId}/github`);
    assert.equal(status.body.links[0].confirmed, true);
    // A ping is status only: no delivery id is kept for it.
    assert.equal(setup.service.rows.filter((row) => row._table === "githubDeliveries").length, 0);
    assert.equal(status.body.links[0].repo, REPO);
    assert.equal(status.body.links[0].home, true);
    assert.equal(status.body.links[0].lastDelivery.event, "ping");
    assert.equal(status.body.links[0].lastDelivery.outcome, "GitHub reached Planban.");
    const revision = (await setup.board()).roadmap.revision;
    assert.equal((await deliver(setup, linkId, secret, "pull_request", { ...merged(2), action: "opened" })).status, 202);
    assert.equal((await deliver(setup, linkId, secret, "pull_request", merged(3, "Closed", REPO, { merged: false, merged_at: null }))).status, 202);
    assert.equal((await deliver(setup, linkId, secret, "push", { repository: { full_name: REPO } })).status, 202);
    assert.equal((await setup.board()).roadmap.revision, revision);
  });
});

test("a merge lands on every card that names it, by any reference, credited to GitHub", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    const { linkId, secret } = await link(setup);
    const bare = await setup.card("Bare", { summary: "Building it in #12." });
    const qualified = await setup.card("Qualified", { nextAction: `Merge ${REPO}#13.` });
    const address = await setup.card("Address", { summary: `https://github.com/${REPO}/pull/14` });
    const spec = await setup.card("Spec");
    const { mtimeMs } = (await setup.call(`/api/v1/boards/${setup.boardId}/docs/${spec}/spec`)).body;
    await setup.op("writeDoc", { cardId: spec, kind: "spec", markdown: "# Spec\n\nShips in PR 15.\n", expectedMtimeMs: mtimeMs });
    for (const number of [12, 13, 14, 15]) {
      const result = await deliver(setup, linkId, secret, "pull_request", merged(number, `Change ${number}`));
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.recorded, "cards");
    }
    const items: Json[] = (await setup.board()).roadmap.roadmapItems;
    for (const [id, number] of [[bare, 12], [qualified, 13], [address, 14], [spec, 15]] as const) {
      const card = items.find((item) => item.id === id)!;
      assert.equal(card.landings.length, 1, id);
      assert.equal(card.landings[0].number, number);
      assert.equal(card.landings[0].url, `https://github.com/${REPO}/pull/${number}`);
    }
    assert.equal(items.find((item) => item.id === bare)!.summary, "Building it in #12.", "the person's text is untouched");
    const history = await setup.call(`/api/v1/boards/${setup.boardId}/history`);
    const entry = history.body.entries.find((row: Json) => row.operation === "github.merge.landed" && row.affectedCards.includes(bare));
    assert.equal(entry.actor, "system");
    assert.equal(entry.attribution.clientName, "GitHub");
    assert.match(entry.summary, /^GitHub: pull request 12 merged in planban-ai\/planban \("Change 12"\); noted on Bare$/u);
  });
});

test("a replayed delivery and a redelivered merge change nothing", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    const { linkId, secret } = await link(setup);
    await setup.card("Card", { summary: "#21" });
    const first = await deliver(setup, linkId, secret, "pull_request", merged(21), { deliveryId: "same-delivery" });
    assert.equal(first.body.recorded, "cards");
    const revision = (await setup.board()).roadmap.revision;
    // The same delivery again (a replay, or GitHub's own redelivery of it).
    assert.deepEqual(await deliver(setup, linkId, secret, "pull_request", merged(21), { deliveryId: "same-delivery" }), { status: 200, body: { duplicate: true } });
    // Another delivery of the same merge.
    assert.deepEqual(await deliver(setup, linkId, secret, "pull_request", merged(21)), { status: 200, body: { duplicate: true } });
    assert.equal((await setup.board()).roadmap.revision, revision);
    assert.equal((await setup.board()).roadmap.roadmapItems[0].landings.length, 1);
  });
});

test("merges past the hourly limit are refused, unremembered, so GitHub can send them again", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    const { linkId, secret } = await link(setup);
    const row = setup.service.rows.find((entry) => entry._table === "githubLinks");
    Object.assign(row, { hour: Math.floor(Date.now() / 3_600_000), hourCount: DELIVERY_WRITES_PER_HOUR });
    const refused = await deliver(setup, linkId, secret, "pull_request", merged(31), { deliveryId: "limited" });
    assert.equal(refused.status, 429);
    Object.assign(row, { hourCount: 0 });
    const again = await deliver(setup, linkId, secret, "pull_request", merged(31), { deliveryId: "limited" });
    assert.equal(again.status, 200);
    assert.equal(again.body.recorded, "inbox");
  });
});

test("a merge that names no card waits in the inbox; agents see it and assign or dismiss it", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    const { linkId, secret } = await link(setup);
    const card = await setup.card("Release 2.0");
    await deliver(setup, linkId, secret, "pull_request", merged(40, "Release prep"));
    await deliver(setup, linkId, secret, "pull_request", merged(41, "Bump dependencies"));
    const read = await mcp(setup, "planban_get_board", { boardId: setup.boardId });
    assert.deepEqual(read.landingInbox.map((entry: Json) => entry.ref), [`${REPO}#41`, `${REPO}#40`]);
    assert.equal(read.landingInbox[1].note, `30 Oct 2026: pull request 40 merged in ${REPO}: Release prep`);
    assert.equal(read.attention.inbox.total, 2);

    const assigned = await mcp(setup, "planban_clear_landing", { boardId: setup.boardId, pullRequest: `${REPO}#40`, cardId: card });
    assert.equal(assigned.assignedTo, card);
    assert.equal(assigned.inboxLeft, 1);
    assert.equal(assigned.card.landings[0].number, 40);
    const dismissed = await mcp(setup, "planban_clear_landing", { boardId: setup.boardId, pullRequest: `${REPO}#41`, reason: "Dependency bump; nothing to record." });
    assert.equal(dismissed.dismissed, true);
    assert.equal(dismissed.inboxLeft, 0);
    const history = (await setup.call(`/api/v1/boards/${setup.boardId}/history`)).body.entries.map((row: Json) => row.summary);
    assert.ok(history.includes(`Dismissed pull request 41 merged in ${REPO} from the inbox: Dependency bump; nothing to record.`));
    assert.ok(history.includes(`Assigned pull request 40 merged in ${REPO} to Release 2.0`));
    // The web page shows no inbox at all.
    const page = await setup.service.adapterFor(setup.owner.token).fetch(boardPath(setup.boardId, "/state"), { headers: web });
    assert.doesNotMatch(JSON.stringify((await page.json() as Json).staleness ?? {}), /inbox/u);
  });
});

test("hosted surfaces show the landed signal until the card is rewritten, without the 'not checked' note", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    const id = await setup.card("Card", { summary: "Building it in #50." });
    const adapter = setup.service.adapterFor(setup.owner.token);
    const state = async () => (await (await adapter.fetch(boardPath(setup.boardId, "/state"), { headers: web })).json()) as Json;
    assert.deepEqual((await state()).staleness.notes, [MERGES_NOT_CHECKED_NOTE], "before a repository is linked, the page says merges aren't checked");
    const { linkId, secret } = await link(setup);
    // Merged after the card last noted progress, as merges are.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const at = new Date();
    await deliver(setup, linkId, secret, "pull_request", merged(50, "Change 50", REPO, { merged_at: at.toISOString() }));
    const day = `${at.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][at.getUTCMonth()]}`;
    const page = await state();
    assert.equal(page.staleness.notes, undefined);
    assert.equal(page.staleness.cards[id][0].detail, `${LANDED_LABEL} (${REPO}#50 merged ${day})`);
    const card = await mcp(setup, "planban_get_card", { boardId: setup.boardId, cardId: id });
    assert.deepEqual(card.landingNotes, [`${day} ${at.getUTCFullYear()}: pull request 50 merged in ${REPO}: Change 50`]);
    assert.equal(card.staleness[0].detail, `${LANDED_LABEL} (${REPO}#50 merged ${day})`);
    assert.equal(card.stalenessNote, undefined);
    // A touch doesn't clear it; rewriting the summary does.
    await setup.op("updateCard", { cardId: id, tags: ["shipped"] });
    assert.equal((await mcp(setup, "planban_get_card", { boardId: setup.boardId, cardId: id })).staleness[0]?.kind, "merged");
    await setup.op("updateCard", { cardId: id, summary: "Shipped in #50: boards record merges themselves." });
    assert.deepEqual((await mcp(setup, "planban_get_card", { boardId: setup.boardId, cardId: id })).staleness, []);
  });
});

test("only the owner links; unlinking forgets the secret, and its deliveries are refused", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    await setup.service.signIn("user_editor", "Ed Editor");
    assert.equal((await setup.call(`/api/v1/boards/${setup.boardId}/members`, { userId: "user_editor", role: "editor" })).status, 200);
    const editor = await computerSignIn(setup.service, "user_editor");
    assert.equal((await editor(`/api/v1/boards/${setup.boardId}/github/links`, { repo: REPO })).status, 403);
    // Nor does the web page's browser session reach the link routes at all.
    const viaPage = await setup.service.browserSend(setup.owner.token)(`/api/v1/boards/${setup.boardId}/github/links`, { method: "POST", headers: web, body: JSON.stringify({ repo: REPO }) });
    assert.equal(viaPage.status, 401);
    assert.equal((await setup.call(`/api/v1/boards/${setup.boardId}/github/links`, { repo: "not a repo" })).status, 400);
    const { linkId, secret } = await link(setup);
    assert.equal((await setup.call(`/api/v1/boards/${setup.boardId}/github/links`, { repo: REPO.toUpperCase() })).status, 409, "a repository links once");
    // The secret is nowhere but its link row: not on the board, in history, the status or an export.
    const everywhere = JSON.stringify([
      await setup.board(), await setup.call(`/api/v1/boards/${setup.boardId}/github`),
      await setup.call(`/api/v1/boards/${setup.boardId}/history`), await setup.call(`/api/v1/boards/${setup.boardId}/export`),
    ]);
    assert.ok(!everywhere.includes(secret), "the secret is never returned again");
    assert.ok(!everywhere.includes(linkId), "nor the link's address");
    // Only the owner unlinks, too.
    assert.equal((await editor(`/api/v1/boards/${setup.boardId}/github/unlink`, { repo: REPO })).status, 403);
    const removed = await setup.call(`/api/v1/boards/${setup.boardId}/github/unlink`, { repo: REPO });
    assert.equal(removed.status, 200);
    // The secret goes at once; the webhook id stays until GitHub has removed it.
    const row = setup.service.rows.find((entry) => entry._table === "githubLinks");
    assert.equal(row.secret, undefined);
    assert.equal(row.removing, true);
    assert.equal((await deliver(setup, linkId, secret, "pull_request", merged(60))).status, 401);
    assert.equal((await editor(`/api/v1/boards/${setup.boardId}/github/unlink/done`, { repo: REPO })).status, 403);
    assert.equal((await setup.call(`/api/v1/boards/${setup.boardId}/github/unlink/done`, { repo: REPO })).status, 200);
    assert.equal(setup.service.rows.some((entry) => entry._table === "githubLinks"), false);
  });
});

test("linking from a computer: gh gets the secret on its standard input only, and unlinking removes the webhook", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-github-link-"));
  const savedHome = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = join(root, "home");
  const bridge = await serviceBridge([["ana", "Ana"]]);
  const calls: Array<{ args: string[]; input?: string | undefined }> = [];
  const output: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  try {
    const cwd = join(root, "project");
    await storage.initializeProject({ cwd, repoId: "linkdemo", title: "Link demo", updateAgents: false });
    await onlineLogin(bridge.url, { devUser: "ana" });
    await takeOnline(bridge.url, cwd);
    useGhRunner(async (args, input) => {
      calls.push({ args, input });
      if (args.join(" ") === `api repos/${REPO}`) return JSON.stringify({ full_name: REPO, permissions: { admin: true } });
      if (args.includes("--paginate")) return "[[]]";
      if (args.includes("POST")) return JSON.stringify({ id: 4242 });
      return "";
    });
    process.stdout.write = ((chunk: unknown) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    const linked = await linkGitHubRepo(cwd, REPO);
    process.stdout.write = write;
    assert.equal(linked.linked, REPO);
    assert.deepEqual(calls[0]!.args, ["api", `repos/${REPO}`], "gh checks admin access first");
    const create = calls[1];
    assert.deepEqual(create!.args, ["api", "--method", "POST", `repos/${REPO}/hooks`, "--input", "-"]);
    const hook = JSON.parse(create!.input!);
    assert.deepEqual(hook.events, ["pull_request"]);
    assert.equal(hook.config.content_type, "json");
    assert.match(hook.config.url, new RegExp(`^${bridge.url}/api/v1/github/hooks/ghl_`, "u"));
    const secret = hook.config.secret as string;
    assert.ok(secret.length >= 40);
    // Never in gh's arguments, what was returned or printed, or any file Planban keeps.
    assert.ok(!create!.args.join(" ").includes(secret));
    assert.ok(!JSON.stringify(linked).includes(secret));
    assert.ok(!output.join("").includes(secret));
    for (const file of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      assert.ok(!(await readFile(join(file.parentPath, file.name), "utf8")).includes(secret), `${file.name} holds the secret`);
    }
    const status = await gitHubLinkStatus(cwd);
    assert.equal(status.links[0]!.repo, REPO);
    assert.equal(status.links[0]!.webhook, "added");
    assert.ok(!JSON.stringify(status).includes(secret));

    const unlinked = await unlinkGitHubRepo(cwd, REPO);
    assert.equal(unlinked.unlinked, REPO);
    assert.deepEqual(calls.at(-1)!.args, ["api", "--method", "DELETE", `repos/${REPO}/hooks/4242`]);
    assert.equal(unlinked.finished, true);
    assert.deepEqual((await gitHubLinkStatus(cwd)).links, []);

    // GitHub refusing the webhook leaves no link behind.
    useGhRunner(async (args) => {
      if (args.join(" ") === `api repos/${REPO}`) return JSON.stringify({ permissions: { admin: true } });
      throw Object.assign(new Error("gh exited with 1"), { stderr: "HTTP 404: Not Found" });
    });
    await assert.rejects(linkGitHubRepo(cwd, REPO), /Not linked: GitHub says planban-ai\/planban doesn't exist/u);
    assert.deepEqual((await gitHubLinkStatus(cwd)).links, []);
  } finally {
    process.stdout.write = write;
    useGhRunner();
    await bridge.close();
    if (savedHome === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = savedHome;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("replays with new delivery ids, pings included, stop at the hourly limit and write nothing more", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    const { linkId, secret, hookId } = await link(setup);
    const row = setup.service.rows.find((entry) => entry._table === "githubLinks");
    const hour = Math.floor(Date.now() / 3_600_000);
    // Below the limit, every write counts, a ping's too, and a ping leaves no delivery row.
    const before = row.hourCount;
    assert.equal((await deliver(setup, linkId, secret, "ping", pingFor(hookId))).status, 200);
    assert.equal(row.hourCount, before + 1);
    assert.equal(setup.service.rows.filter((entry) => entry._table === "githubDeliveries").length, 0);
    Object.assign(row, { hour, hourCount: DELIVERY_WRITES_PER_HOUR });
    const deliveriesBefore = setup.service.rows.filter((entry) => entry._table === "githubDeliveries").length;
    const revision = (await setup.board()).roadmap.revision;
    const writes: string[] = [];
    const patch = setup.service.ctx.db.patch.bind(setup.service.ctx.db);
    setup.service.ctx.db.patch = async (id: unknown, value: Json) => { writes.push(JSON.stringify(value)); return patch(id, value); };
    try {
      for (let index = 0; index < 5; index += 1) {
        assert.equal((await deliver(setup, linkId, secret, "ping", pingFor(hookId), { deliveryId: `replayed-ping-${index}` })).status, 429);
        assert.equal((await deliver(setup, linkId, secret, "pull_request", merged(70 + index), { deliveryId: `replayed-merge-${index}` })).status, 429);
      }
    } finally {
      setup.service.ctx.db.patch = patch;
    }
    assert.equal(writes.length, 1, "the refusal is noted once an hour, and nothing else is written");
    assert.match(row.lastDelivery.outcome, /over 120 deliveries this hour/u);
    assert.equal(row.hourCount, DELIVERY_WRITES_PER_HOUR);
    assert.equal(setup.service.rows.filter((entry) => entry._table === "githubDeliveries").length, deliveriesBefore);
    assert.equal((await setup.board()).roadmap.revision, revision);
  });
});

test("deliveries are admitted a bounded number a minute per link before any lookup, and only through the edge", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    const { linkId, secret } = await link(setup);
    let lookups = 0;
    const runQuery = setup.service.actionCtx.runQuery;
    setup.service.actionCtx.runQuery = async (ref: unknown, args: unknown) => { lookups += 1; return runQuery(ref, args); };
    try {
      // Straight to the native address, skipping the edge: refused before the link is looked up.
      assert.deepEqual(await deliver(setup, linkId, secret, "pull_request", merged(80), { edge: false }), { status: 401, body: { error: "unauthorized" } });
      assert.equal(lookups, 0);
      const flood = "ghl_floodedlinkaddress0000000";
      const answers: number[] = [];
      for (let index = 0; index <= ADMITTED_PER_LINK_PER_MINUTE; index += 1) answers.push((await deliver(setup, flood, secret, "pull_request", merged(81))).status);
      assert.deepEqual(answers.slice(0, -1), Array(ADMITTED_PER_LINK_PER_MINUTE).fill(401));
      assert.equal(answers.at(-1), 429);
      assert.equal(lookups, ADMITTED_PER_LINK_PER_MINUTE, "the refused one never reached the database");
      // Another link is admitted as usual.
      assert.equal((await deliver(setup, linkId, secret, "pull_request", merged(82))).status, 200);
    } finally {
      setup.service.actionCtx.runQuery = runQuery;
    }
  });
});

test("an unconfirmed link: merges are credited to the person who set it up, and hosted surfaces don't call them checked", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    const id = await setup.card("Card", { summary: "Building it in #90 and #91." });
    const { linkId, secret } = await link(setup, REPO, { confirmed: false });
    const adapter = setup.service.adapterFor(setup.owner.token);
    const state = async () => (await (await adapter.fetch(boardPath(setup.boardId, "/state"), { headers: web })).json()) as Json;
    const status = async () => (await setup.call(`/api/v1/boards/${setup.boardId}/github`)).body.links[0];
    assert.equal((await status()).confirmed, false);
    await deliver(setup, linkId, secret, "pull_request", merged(90, "Change 90"));
    const card = await mcp(setup, "planban_get_card", { boardId: setup.boardId, cardId: id });
    assert.equal(card.card.landings[0].reportedThrough, "Olive Owner");
    assert.match(card.landingNotes[0], /: pull request 90 merged in planban-ai\/planban: Change 90 \(reported through the link Olive Owner set up\)$/u);
    const entry = (await setup.call(`/api/v1/boards/${setup.boardId}/history`)).body.entries.find((row: Json) => row.operation === "github.merge.landed");
    assert.match(entry.summary, /^Reported through the link Olive Owner set up: pull request 90/u);
    assert.notEqual(entry.attribution.clientName, "GitHub");
    assert.deepEqual((await state()).staleness.notes, [MERGES_NOT_CHECKED_NOTE], "an unconfirmed link isn't counted as checked");
    // A signed ping alone doesn't confirm it, nor one naming another webhook.
    assert.equal((await deliver(setup, linkId, secret, "ping", pingFor(5150))).status, 200);
    assert.equal((await setup.call(`/api/v1/boards/${setup.boardId}/github/links/${linkId}/hook`, { hookId: 5151 })).status, 200);
    assert.equal((await status()).confirmed, false);
    // GitHub's ping for the recorded webhook confirms it.
    assert.equal((await deliver(setup, linkId, secret, "ping", pingFor(5151))).status, 200);
    assert.equal((await status()).confirmed, true);
    assert.equal((await state()).staleness.notes, undefined);
    await deliver(setup, linkId, secret, "pull_request", merged(91, "Change 91"));
    const later = await mcp(setup, "planban_get_card", { boardId: setup.boardId, cardId: id });
    assert.equal(later.card.landings[0].reportedThrough, undefined);
    assert.doesNotMatch(later.landingNotes[0], /reported through/u);
  });
});

test("a ping that arrives before the webhook id is recorded confirms the link once it is", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    const { linkId, secret } = await link(setup, REPO, { confirmed: false });
    assert.equal((await deliver(setup, linkId, secret, "ping", pingFor(6060))).status, 200);
    const recorded = await setup.call(`/api/v1/boards/${setup.boardId}/github/links/${linkId}/hook`, { hookId: 6060 });
    assert.equal(recorded.body.confirmed, true);
    assert.equal((await setup.call(`/api/v1/boards/${setup.boardId}/github`)).body.links[0].confirmed, true);
  });
});

test("the daily cleanup forgets a backlog of old delivery ids in batches until none is left", async () => {
  await withServiceEnv(async () => {
    const setup = await ownerBoard();
    const old = new Date(Date.now() - DELIVERY_MEMORY_MS - 60_000).toISOString();
    for (let index = 0; index < FORGET_BATCH * 2 + 37; index += 1) await setup.service.ctx.db.insert("githubDeliveries", { deliveryId: `old-${index}`, linkId: "ghl_x", at: old });
    await setup.service.ctx.db.insert("githubDeliveries", { deliveryId: "recent", linkId: "ghl_x", at: new Date().toISOString() });
    await (github.forgetDeliveries as any)._handler(setup.service.ctx, {});
    await setup.service.runJobs();
    assert.deepEqual(setup.service.rows.filter((row) => row._table === "githubDeliveries").map((row) => row.deliveryId), ["recent"]);
  });
});

test("linking checks admin access, reuses a webhook whose record failed, and retries a failed removal without duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-github-retry-"));
  const savedHome = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = join(root, "home");
  const bridge = await serviceBridge([["ana", "Ana"]]);
  const onGitHub: Array<{ id: number; config: { url: string; secret: string } }> = [];
  const calls: string[][] = [];
  let admin = true;
  let deleteFails = false;
  try {
    const cwd = join(root, "project");
    await storage.initializeProject({ cwd, repoId: "retrydemo", title: "Retry demo", updateAgents: false });
    await onlineLogin(bridge.url, { devUser: "ana" });
    await takeOnline(bridge.url, cwd);
    useGhRunner(async (args, input) => {
      calls.push(args);
      const line = args.join(" ");
      if (line === `api repos/${REPO}`) return JSON.stringify({ permissions: { admin } });
      if (args.includes("--paginate")) return JSON.stringify([onGitHub.map((hook) => ({ id: hook.id, config: { url: hook.config.url } }))]);
      if (line === `api --method POST repos/${REPO}/hooks --input -`) {
        const hook = { id: 7000 + onGitHub.length, config: JSON.parse(input!).config };
        onGitHub.push(hook);
        return JSON.stringify({ id: hook.id });
      }
      const patched = /^api --method PATCH repos\/.+\/hooks\/(\d+) --input -$/u.exec(line);
      if (patched) {
        onGitHub.find((hook) => hook.id === Number(patched[1]))!.config = JSON.parse(input!).config;
        return "{}";
      }
      const deleted = /^api --method DELETE repos\/.+\/hooks\/(\d+)$/u.exec(line);
      if (deleted) {
        if (deleteFails) throw Object.assign(new Error("gh exited with 1"), { stderr: "error connecting to api.github.com" });
        onGitHub.splice(onGitHub.findIndex((hook) => hook.id === Number(deleted[1])), 1);
        return "";
      }
      return "";
    });

    // Without admin access, nothing is made, here or on GitHub.
    admin = false;
    await assert.rejects(linkGitHubRepo(cwd, REPO), /doesn't administer planban-ai\/planban\. Linking needs admin access/u);
    assert.deepEqual((await gitHubLinkStatus(cwd)).links, []);
    assert.equal(onGitHub.length, 0);
    admin = true;

    // GitHub adds the webhook, but recording it on the service fails.
    let failRecord = true;
    bridge.control.intercept = async (path) => {
      if (failRecord && path.endsWith("/hook")) {
        failRecord = false;
        return { status: 503, body: { error: { code: "unavailable", message: "Busy." } } };
      }
    };
    await assert.rejects(linkGitHubRepo(cwd, REPO), /Run planban online github link planban-ai\/planban again: it finds that webhook/u);
    assert.equal(onGitHub.length, 1);
    assert.match((await gitHubLinkStatus(cwd)).links[0]!.webhook as string, /^not added yet/u);
    const firstSecret = onGitHub[0]!.config.secret;

    // Linking again finds that webhook by its address and finishes, with a new secret, without adding another.
    const linked = await linkGitHubRepo(cwd, REPO);
    assert.equal(linked.linked, REPO);
    assert.equal(onGitHub.length, 1);
    assert.notEqual(onGitHub[0]!.config.secret, firstSecret);
    assert.ok(calls.some((args) => args.join(" ") === `api --method POST repos/${REPO}/hooks/${onGitHub[0]!.id}/pings`), "GitHub is asked to ping the reused webhook");
    assert.equal((await gitHubLinkStatus(cwd)).links[0]!.webhook, "added");

    // GitHub can't be reached to remove it: the link stays as being removed, with its webhook id.
    deleteFails = true;
    const half = await unlinkGitHubRepo(cwd, REPO);
    assert.equal(half.finished, false);
    assert.match(half.note, /Run planban online github unlink planban-ai\/planban again to finish/u);
    assert.match((await gitHubLinkStatus(cwd)).links[0]!.webhook as string, /^being removed/u);
    // Linking again now is refused, rather than adding a second webhook.
    await assert.rejects(linkGitHubRepo(cwd, REPO), /Unlinking planban-ai\/planban hasn't finished/u);
    assert.equal(onGitHub.length, 1);
    deleteFails = false;
    const done = await unlinkGitHubRepo(cwd, REPO);
    assert.equal(done.finished, true);
    assert.equal(onGitHub.length, 0);
    assert.deepEqual((await gitHubLinkStatus(cwd)).links, []);

    // And relinking makes exactly one webhook.
    await linkGitHubRepo(cwd, REPO);
    assert.equal(onGitHub.length, 1);
  } finally {
    useGhRunner();
    await bridge.close();
    if (savedHome === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = savedHome;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
