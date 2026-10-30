// Several Planban accounts signed in on one computer at once, like the
// GitHub CLI (owner decision, 15 October 2026): each online board uses the
// account its link here names, never another's.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import { accountCredentials, credentialsRoot, onlineStatus, readCredentials, removeAccount, saveCredentials } from "../src/core/online/credentials";
import { onlineLogin } from "../src/core/online/login";
import { boardAccount, listAccounts, recordBoardAccount, rememberIdentity, switchAccount } from "../src/core/online/accounts";
import { boardCredentials } from "../src/core/online/client";
import { createKey, onlineLogout } from "../src/core/online/connections";
import { refreshBackup } from "../src/core/online/backup";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { attachOnline, othersOnBoard, takeLocal, takeOnline } from "../src/core/online/transfers";
import { serviceBridge } from "./service-bridge";

let root: string;
let bridge: Awaited<ReturnType<typeof serviceBridge>>;
const savedHome = process.env.PLANBAN_HOME;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-several-"));
  process.env.PLANBAN_HOME = join(root, "home");
  bridge = await serviceBridge([["ana", "Ana"], ["ben", "Ben"]]);
  resetCopyChecks();
});

test.afterEach(async () => {
  await bridge.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
});

async function project(name: string, repoId: string) {
  const cwd = join(root, name);
  await storage.initializeProject({ cwd, repoId, title: name, updateAgents: false });
  await storage.createCard({ cwd, title: "Alpha" });
  return cwd;
}
const lastEditor = (boardId: string) => bridge.service.rows.filter((row) => row._table === "history" && row.boardId === boardId).sort((a, b) => b.version - a.version)[0]!.entry.attribution.userId;
const owner = (boardId: string) => bridge.service.rows.find((row) => row._table === "boards" && row.boardId === boardId)!.ownerId;

test("two accounts, two boards, at the same time: each board's edits go as its own account", async () => {
  const revival = await project("revival", "revival");
  const planban = await project("planban", "planban");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, revival);
  await onlineLogin(bridge.url, { devUser: "ben" });
  await takeOnline(bridge.url, planban);
  assert.deepEqual([owner("revival"), owner("planban")], ["ana", "ben"]);
  // Edits to both, interleaved, with Ben the default throughout.
  await Promise.all([
    storage.updateCard({ cwd: revival, cardId: "alpha", summary: "Revival work", baseRevision: (await storage.loadState(revival)).roadmap.revision, actor: "agent" }),
    storage.updateCard({ cwd: planban, cardId: "alpha", summary: "Planban work", baseRevision: (await storage.loadState(planban)).roadmap.revision, actor: "agent" }),
  ]);
  assert.deepEqual([lastEditor("revival"), lastEditor("planban")], ["ana", "ben"]);
  // The automatic backup of Ana's board is taken as Ana too.
  await refreshBackup(bridge.url, "revival", { force: true });
  const accounts = await listAccounts();
  assert.deepEqual(accounts[0]!.accounts.map((account) => [account.email, account.default, account.boards.map((board) => board.boardId)]),
    [["ana@example.com", false, ["revival"]], ["ben@example.com", true, ["planban"]]]);
});

test("take-online and attach can name the account; the board then uses it", async () => {
  const revival = await project("revival", "revival");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await onlineLogin(bridge.url, { devUser: "ben" });
  await takeOnline(bridge.url, revival, { account: "ana@example.com" });
  assert.equal(owner("revival"), "ana");
  // Another folder on this computer attaches it as Ana, though Ben is the default.
  const second = join(root, "second");
  await attachOnline(bridge.url, "revival", second, { account: "ana@example.com" });
  assert.equal((await storage.loadState(second)).roadmap.roadmapItems[0]!.title, "Alpha");
  await assert.rejects(takeOnline(bridge.url, await project("other", "other"), { account: "nobody@example.com" }), /nobody@example\.com isn't signed in/);
});

test("a board linked before several accounts existed is found by the account that can open it, and linked", async () => {
  const revival = await project("revival", "revival");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, revival);
  await onlineLogin(bridge.url, { devUser: "ben" });
  // No link on this computer (as on a computer that attached it before this version).
  await rm(join(credentialsRoot(), "board-accounts.json"));
  assert.equal((await storage.loadState(revival)).roadmap.roadmapItems[0]!.title, "Alpha");
  const links = JSON.parse(await readFile(join(credentialsRoot(), "board-accounts.json"), "utf8"));
  assert.equal(links.boards[`${bridge.url}|revival`].person, "ana");
});

test("credentials kept in the old one-account form migrate on read, and the next save writes the new form", async () => {
  await mkdir(credentialsRoot(), { recursive: true });
  await writeFile(join(credentialsRoot(), "credentials.json"), JSON.stringify({ version: 1, services: { [bridge.url]: { clientId: "machine", accessToken: "pbm_old", refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z", person: "ana", email: "ana@example.com" } } }));
  assert.deepEqual((await onlineStatus())[0]!.accounts, [{ email: "ana@example.com", default: true }]);
  assert.equal((await readCredentials()).services[bridge.url]!.accessToken, "pbm_old");
  await onlineLogin(bridge.url, { devUser: "ben" });
  const stored = JSON.parse(await readFile(join(credentialsRoot(), "credentials.json"), "utf8"));
  assert.equal(stored.version, 2);
  assert.deepEqual(Object.keys(stored.services[bridge.url].accounts).sort(), ["ana", "ben"]);
  assert.equal(stored.services[bridge.url].default, "ben");
});

test("attaching an already-linked board elsewhere keeps its account; a refused attach changes nothing", async () => {
  const revival = await project("revival", "revival");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, revival);
  await onlineLogin(bridge.url, { devUser: "ben" });
  await bridge.service.ctx.db.insert("members", { boardId: "revival", userId: "ben", role: "editor" });
  // Ben is the default and a member, yet the second folder uses Ana's board as Ana.
  await attachOnline(bridge.url, "revival", join(root, "second"));
  assert.equal((await boardAccount(bridge.url, "revival"))!.person, "ana");
  await storage.updateCard({ cwd: revival, cardId: "alpha", summary: "Still Ana", baseRevision: (await storage.loadState(revival)).roadmap.revision, actor: "agent" });
  assert.equal(lastEditor("revival"), "ana");
  // A folder holding another board is refused before the link changes.
  const other = await project("other", "other");
  await assert.rejects(attachOnline(bridge.url, "revival", other, { account: "ben@example.com" }), /already has a different board/);
  assert.equal((await boardAccount(bridge.url, "revival"))!.person, "ana");
});

test("take-local and the board's People list know you as the board's account, not the default", async () => {
  const revival = await project("revival", "revival");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, revival);
  await onlineLogin(bridge.url, { devUser: "ben" });
  assert.deepEqual(await othersOnBoard(bridge.url, "revival"), []);
  await takeLocal(revival);
  assert.equal((await storage.readManifest(revival))!.storage?.kind, "local");
});

test("a board called import is pinned to its account like any other", async () => {
  const board = await project("import", "import");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, board);
  await onlineLogin(bridge.url, { devUser: "ben" });
  await bridge.service.ctx.db.insert("members", { boardId: "import", userId: "ben", role: "editor" });
  await storage.updateCard({ cwd: board, cardId: "alpha", summary: "As Ana", baseRevision: (await storage.loadState(board)).roadmap.revision, actor: "agent" });
  assert.equal(lastEditor("import"), "ana");
});

test("a damaged list of board links is refused, never read as empty and never overwritten", async () => {
  const revival = await project("revival", "revival");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, revival);
  await onlineLogin(bridge.url, { devUser: "ben" });
  await bridge.service.ctx.db.insert("members", { boardId: "revival", userId: "ben", role: "editor" });
  const path = join(credentialsRoot(), "board-accounts.json");
  for (const damaged of ["{not json", JSON.stringify({ version: 1, boards: { [`${bridge.url}|revival`]: { email: "x" } } })]) {
    await writeFile(path, damaged);
    await assert.rejects(storage.loadState(revival), /list of which Planban account each online board uses on this computer is damaged/);
    assert.equal(await readFile(path, "utf8"), damaged);
  }
});

test("an old sign-in with no account id of its own: its boards follow it once its id is known, and switch works", async () => {
  await onlineLogin(bridge.url, { devUser: "ana" });
  const token = (await readCredentials()).services[bridge.url]!.accessToken;
  await writeFile(join(credentialsRoot(), "credentials.json"), JSON.stringify({ version: 1, services: { [bridge.url]: { clientId: "machine", accessToken: token, refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z" } } }));
  await recordBoardAccount(bridge.url, "revival", { person: "signed-in" });
  await onlineLogin(bridge.url, { devUser: "ben" });
  assert.equal((await switchAccount(bridge.url, "signed-in")).url, bridge.url);
  assert.equal((await readCredentials()).services[bridge.url]!.accessToken, token);
  await rememberIdentity(bridge.url, 1);
  assert.equal((await boardAccount(bridge.url, "revival"))!.person, "ana");
  assert.equal((await accountCredentials(bridge.url, "ana"))!.accessToken, token);
});

test("signing out never removes a newer sign-in of the same account made meanwhile", async () => {
  await onlineLogin(bridge.url, { devUser: "ana" });
  let reached!: () => void;
  const atRevoke = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  bridge.control.intercept = async (path) => {
    if (path !== "/api/v1/connections/self/revoke") return;
    reached();
    await released;
  };
  const signingOut = onlineLogout(bridge.url);
  await atRevoke;
  bridge.control.intercept = undefined;
  await onlineLogin(bridge.url, { devUser: "ana" });
  const fresh = (await readCredentials()).services[bridge.url]!.accessToken;
  release();
  assert.match((await signingOut).note ?? "", /signed in again here while signing out/);
  assert.equal((await accountCredentials(bridge.url, "ana"))?.accessToken, fresh);
});

test("requests about a board outside its own path (live updates, keys) use the board's account", async () => {
  const revival = await project("revival", "revival");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, revival);
  await onlineLogin(bridge.url, { devUser: "ben" });
  assert.equal((await boardCredentials(bridge.url, "revival")).person, "ana");
  assert.equal((await boardCredentials(bridge.url, "unlinked")).person, "ben");
  const key = await createKey(bridge.url, { boardId: "revival", level: "read", name: "trial" });
  assert.equal(key.boardId, "revival");
});

/** Holds the first request whose path starts with `prefix` until released. */
function hold(prefix: string) {
  let reached!: () => void;
  const atRequest = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  bridge.control.intercept = async (path) => {
    if (held || !path.startsWith(prefix)) return;
    held = true;
    reached();
    await released;
  };
  return { atRequest, release: () => { bridge.control.intercept = undefined; release(); } };
}

const oldSignIn = async () => {
  // As an older Planban saved it: one account, no id or email of its own.
  const token = (await readCredentials()).services[bridge.url]!.accessToken;
  await writeFile(join(credentialsRoot(), "credentials.json"), JSON.stringify({ version: 1, services: { [bridge.url]: { clientId: "machine", accessToken: token, refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z" } } }));
  return token;
};

test("signing in again, and another account becoming the default, while a board goes online: it is still linked to the account that took it", async () => {
  const revival = await project("revival", "revival");
  await onlineLogin(bridge.url, { devUser: "ana" });
  const paused = hold("/api/v1/transfers");
  const moving = takeOnline(bridge.url, revival);
  await paused.atRequest;
  await onlineLogin(bridge.url, { devUser: "ana" });
  await onlineLogin(bridge.url, { devUser: "ben" });
  paused.release();
  await moving;
  assert.equal((await boardAccount(bridge.url, "revival"))!.person, "ana");
  await bridge.service.ctx.db.insert("members", { boardId: "revival", userId: "ben", role: "editor" });
  await storage.updateCard({ cwd: revival, cardId: "alpha", summary: "As Ana", baseRevision: (await storage.loadState(revival)).roadmap.revision, actor: "agent" });
  assert.equal(lastEditor("revival"), "ana");
});

test("an old sign-in with no id of its own, named for attach or take-online, links the board to that account", async () => {
  const revival = await project("revival", "revival");
  await onlineLogin(bridge.url, { devUser: "ben" });
  await takeOnline(bridge.url, revival);
  await bridge.service.ctx.db.insert("members", { boardId: "revival", userId: "ana", role: "editor" });
  await onlineLogin(bridge.url, { devUser: "ana" });
  // Ana's sign-in as an older Planban saved it, with no id or email of its own; Ben's beside it, the default.
  const { accounts } = await readCredentials();
  const { person: _person, email: _email, ...anaOld } = accounts[bridge.url]!.accounts.ana!;
  await writeFile(join(credentialsRoot(), "credentials.json"), JSON.stringify({ version: 2, services: { [bridge.url]: { default: "ben", accounts: { "signed-in": anaOld, ben: accounts[bridge.url]!.accounts.ben } } } }));
  await attachOnline(bridge.url, "revival", join(root, "second"), { account: "signed-in" });
  assert.equal((await boardAccount(bridge.url, "revival"))!.person, "ana");
  const other = await project("other", "other");
  await takeOnline(bridge.url, other, { account: "ana@example.com" });
  assert.equal(owner("other"), "ana");
  assert.equal((await boardAccount(bridge.url, "other"))!.person, "ana");
});

test("a slow answer about who an old sign-in is never replaces a newer sign-in of that account", async () => {
  await onlineLogin(bridge.url, { devUser: "ana" });
  await oldSignIn();
  const paused = hold("/api/v1/me");
  const slow = rememberIdentity(bridge.url, 1);
  await paused.atRequest;
  await onlineLogin(bridge.url, { devUser: "ana" });
  const fresh = (await accountCredentials(bridge.url, "ana"))!.accessToken;
  paused.release();
  await slow;
  assert.equal((await accountCredentials(bridge.url, "ana"))!.accessToken, fresh);
  assert.deepEqual(Object.keys((await readCredentials()).accounts[bridge.url]!.accounts), ["ana"]);
});

test("a move online interrupted after it committed resumes only as the account that started it", async () => {
  const revival = await project("revival", "revival");
  await onlineLogin(bridge.url, { devUser: "ana" });
  // The board is committed online, then reading it back fails: the move stops before this project switches.
  let committed = false;
  bridge.control.intercept = async (path) => {
    if (path.includes("/commit")) committed = true;
    else if (committed && path === "/api/v1/boards/revival") return { status: 503, body: { error: { message: "Unavailable" } } };
  };
  await assert.rejects(takeOnline(bridge.url, revival));
  bridge.control.intercept = undefined;
  assert.equal(owner("revival"), "ana");
  await onlineLogin(bridge.url, { devUser: "ben" });
  await onlineLogout(bridge.url, { account: "ana@example.com" });
  await bridge.service.ctx.db.insert("members", { boardId: "revival", userId: "ben", role: "editor" });
  await assert.rejects(takeOnline(bridge.url, revival), /started while signed in to .* as ana@example\.com, which isn't signed in here now\. Sign in as that account/);
  assert.notEqual((await boardAccount(bridge.url, "revival"))?.person, "ben");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, revival);
  assert.equal((await boardAccount(bridge.url, "revival"))!.person, "ana");
});

test("of two sign-ins for one account, the one saved later is kept, whichever learns its id first", async () => {
  await onlineLogin(bridge.url, { devUser: "ana" });
  const older = (await accountCredentials(bridge.url, "ana"))!.accessToken;
  // A key signed in later is saved before the service says whose it is.
  await onlineLogin(bridge.url, { devUser: "ana" });
  const newer = (await accountCredentials(bridge.url, "ana"))!;
  await removeAccount(bridge.url, "ana");
  await saveCredentials(bridge.url, { ...newer, person: undefined, email: undefined });
  const stored = JSON.parse(await readFile(join(credentialsRoot(), "credentials.json"), "utf8"));
  stored.services[bridge.url].accounts.ana = { clientId: "machine", accessToken: older, refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z", person: "ana", email: "ana@example.com", savedAt: "2026-01-01T00:00:00.000Z" };
  await writeFile(join(credentialsRoot(), "credentials.json"), JSON.stringify(stored));
  await rememberIdentity(bridge.url, 1);
  assert.equal((await accountCredentials(bridge.url, "ana"))!.accessToken, newer.accessToken);
  assert.deepEqual(Object.keys((await readCredentials()).accounts[bridge.url]!.accounts), ["ana"]);
});

test("an old sign-in that turns out to open an unlinked board links it as the account it really is", async () => {
  const revival = await project("revival", "revival");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, revival);
  await oldSignIn();
  await rm(join(credentialsRoot(), "board-accounts.json"));
  await onlineLogin(bridge.url, { devUser: "ben" });
  assert.equal((await storage.loadState(revival)).roadmap.roadmapItems[0]!.title, "Alpha");
  assert.equal((await boardAccount(bridge.url, "revival"))!.person, "ana");
  // Signing Ana out leaves no sign-in of hers behind for the board to use.
  await onlineLogout(bridge.url, { account: "ana@example.com" });
  await assert.rejects(storage.loadState(revival), /This board uses ana@example\.com, which isn't signed in on this computer/);
});

test("the same sign-in saved twice stays one account", async () => {
  await onlineLogin(bridge.url, { devUser: "ana" });
  const ana = (await accountCredentials(bridge.url, "ana"))!;
  // As a personal key signed in again: saved before the service says whose it is.
  await saveCredentials(bridge.url, { ...ana, person: undefined, email: undefined });
  await rememberIdentity(bridge.url, 1);
  assert.deepEqual(Object.keys((await readCredentials()).accounts[bridge.url]!.accounts), ["ana"]);
  await onlineLogout(bridge.url);
  assert.equal((await readCredentials()).accounts[bridge.url], undefined);
});

test("signing out an old sign-in that learns its account id meanwhile still removes it", async () => {
  await onlineLogin(bridge.url, { devUser: "ana" });
  await oldSignIn();
  const paused = hold("/api/v1/connections/self/revoke");
  const signingOut = onlineLogout(bridge.url);
  await paused.atRequest;
  await rememberIdentity(bridge.url, 1);
  paused.release();
  assert.equal((await signingOut).note, undefined);
  assert.equal((await readCredentials()).accounts[bridge.url], undefined);
});

test("one sign-in saved under two ids: both ids' boards follow it to its account", async () => {
  await onlineLogin(bridge.url, { devUser: "ana" });
  const ana = (await accountCredentials(bridge.url, "ana"))!;
  const { person: _person, ...unnamed } = ana;
  await writeFile(join(credentialsRoot(), "credentials.json"), JSON.stringify({ version: 2, services: { [bridge.url]: { default: "ana", accounts: { ana, "signed-in": unnamed } } } }));
  await recordBoardAccount(bridge.url, "revival", { person: "signed-in" });
  await rememberIdentity(bridge.url, 1);
  assert.equal((await boardAccount(bridge.url, "revival"))!.person, "ana");
  assert.deepEqual(Object.keys((await readCredentials()).accounts[bridge.url]!.accounts), ["ana"]);
});
