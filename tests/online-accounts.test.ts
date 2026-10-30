// More than one Planban account on one computer (owner request, 15 October
// 2026), run against the service's real handlers: the email shown for the
// sign-in, the warning before signing in as someone else, the plain "this
// board belongs to another account" message, and that a second account can't
// take the first account's online board online by any route.
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import { manifestPath } from "../src/core/paths";
import { startServer } from "../src/server/server";
import { PlanbanNotFoundError } from "../src/core/boardOperations";
import { onlineStatus, readCredentials, saveCredentials } from "../src/core/online/credentials";
import { onlineLogin } from "../src/core/online/login";
import { boardAccount, recordBoardAccountAs, rememberIdentity, switchAccount } from "../src/core/online/accounts";
import { onlineLogout } from "../src/core/online/connections";
import { OnlineAuthenticationError, onlineRequest } from "../src/core/online/client";
import { backupRoot } from "../src/core/online/backup";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { restoreBackup, takeOnline } from "../src/core/online/transfers";
import { serviceBridge } from "./service-bridge";

let root: string;
let url: string;
let service: Awaited<ReturnType<typeof serviceBridge>>["service"];
let close: () => Promise<void>;
let control: Awaited<ReturnType<typeof serviceBridge>>["control"];
const savedHome = process.env.PLANBAN_HOME;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-accounts-"));
  process.env.PLANBAN_HOME = join(root, "home");
  const bridge = await serviceBridge();
  ({ url, service, close, control } = bridge);
  resetCopyChecks();
});

test.afterEach(async () => {
  await close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
});

/** A's board, online, with a copy of its planning folder from before it went online. */
async function anasOnlineBoard() {
  const cwd = join(root, "ana-project");
  await storage.initializeProject({ cwd, repoId: "roadmap", title: "Roadmap", updateAgents: false });
  await storage.createCard({ cwd, title: "Alpha", specMarkdown: "# Spec" });
  const planningRoot = (await storage.loadState(cwd)).planningRoot;
  // Another machine's (or an old checkout's) local copy, made while the board was still local.
  const staleRoot = join(root, "stale-planning");
  await cp(planningRoot, staleRoot, { recursive: true });
  await onlineLogin(url, { devUser: "ana" });
  await takeOnline(url, cwd);
  return { cwd, planningRoot, staleRoot };
}

const anasBoardRow = () => service.rows.find((row) => row._table === "boards" && row.boardId === "roadmap");
const boardsOf = (userId: string) => service.rows.filter((row) => row._table === "boards" && row.ownerId === userId).map((row) => row.boardId).sort();

/** A project folder that holds a local board in `planningRoot`, with the given id. */
async function localProject(name: string, planningRoot: string, repoId = "roadmap") {
  const cwd = join(root, name);
  await storage.initializeProject({ cwd, repoId: `${name}-placeholder`, title: "Placeholder", updateAgents: false });
  await writeFile(manifestPath(cwd), JSON.stringify({ version: 1, repoId, enabled: true, storage: { kind: "local", root: planningRoot } }));
  resetCopyChecks();
  return cwd;
}

test("several accounts can be signed in at once: signing in adds one beside the others and makes it the default", async () => {
  await onlineLogin(url, { devUser: "ana" });
  const added = await onlineLogin(url, { devUser: "ben" }) as { note?: string };
  assert.match(added.note ?? "", /^Added ben@example\.com beside ana@example\.com, which stays signed in here\. Boards linked to it keep using it; boards you take online or attach from now on use ben@example\.com/);
  const [status] = await onlineStatus();
  assert.equal(status!.signedInAs, "ben@example.com");
  assert.deepEqual(status!.accounts, [{ email: "ana@example.com", default: false }, { email: "ben@example.com", default: true }]);
  assert.equal(JSON.stringify(await onlineStatus()).includes("\"ana\""), false, "status names emails, not the service's ids");
  // Signing in again as an account already here replaces only that account's sign-in.
  await onlineLogin(url, { devUser: "ana" });
  assert.deepEqual((await onlineStatus())[0]!.accounts.map((account) => account.email).sort(), ["ana@example.com", "ben@example.com"]);
});
test("each board uses its own account; one whose account signs out says so, naming it, and never uses another", async () => {
  const { cwd } = await anasOnlineBoard();
  await onlineLogin(url, { devUser: "ben" });
  // Ben is the default now, but Ana's board still opens as Ana.
  assert.equal((await storage.loadState(cwd)).roadmap.roadmapItems[0]!.title, "Alpha");
  assert.equal(service.rows.filter((row) => row._table === "connections" && row.userId === "ben").length, 1);
  await onlineLogout(url, { account: "ana@example.com" });
  await assert.rejects(storage.loadState(cwd), (error: unknown) => error instanceof OnlineAuthenticationError
    && error.message.startsWith("This board uses ana@example.com, which isn't signed in on this computer. Sign in as ana@example.com:")
    && error.signIn?.account === "ana@example.com");
  // Ben's sign-in was never tried for it, and the service still says only "not found" to Ben.
  await assert.rejects(onlineRequest(url, "/api/v1/boards/roadmap", undefined, { credentials: (await readCredentials()).services[url]! }), PlanbanNotFoundError);
  // Signing back in as Ana opens it again.
  await onlineLogin(url, { devUser: "ana" });
  assert.equal((await storage.loadState(cwd)).roadmap.roadmapItems[0]!.title, "Alpha");
});
test("a second account can't take the first account's online board online by any route", async () => {
  const { cwd, planningRoot, staleRoot } = await anasOnlineBoard();
  const before = structuredClone(anasBoardRow());
  assert.equal(before.ownerId, "ana");
  await onlineLogin(url, { devUser: "ben", switchAccount: true });

  // 1. The project folder that now points online.
  await assert.rejects(takeOnline(url, cwd), /already online/);

  // 2. The copy kept from before it went online: an old checkout still pointing at it has no
  // live board left to take online (its roadmap was set aside when the board went online),
  await assert.rejects(takeOnline(url, await localProject("old-checkout", planningRoot)), /Planban roadmap is missing/);
  // and so does that copy put back as a live board, in a folder of its own.
  const revived = join(root, "revived-planning");
  await cp(planningRoot, revived, { recursive: true });
  const snapshot = (await readdir(revived)).find((name) => name.startsWith("roadmap.local-before-online-"));
  assert.ok(snapshot, "the copy from before it went online is kept");
  await rename(join(revived, snapshot), join(revived, "roadmap.json"));
  await rm(join(revived, "ONLINE-BOARD.txt"), { force: true });
  await assert.rejects(takeOnline(url, await localProject("revived", revived)), /An Online Board called roadmap already exists/);

  // 3. A backup restored with restore-backup: it can't keep the board's id,
  const backup = join(backupRoot(url, "roadmap"), "latest");
  await assert.rejects(restoreBackup(backup, join(root, "restored-same-id"), "roadmap"), /needs its own id/);
  // so it goes online only as a second, separate board, named as a restored copy.
  const restoredCwd = join(root, "restored");
  const restored = await restoreBackup(backup, restoredCwd, "roadmap-restored");
  assert.match(restored.title, /^Roadmap \(copy restored from a backup of \d{4}-\d{2}-\d{2}\)$/);
  assert.match(restored.message, /a separate local board \(roadmap-restored\) copied from a backup of the online board roadmap\. It is not linked to that board; taking it online makes a second, separate board\./);
  await takeOnline(url, restoredCwd);
  assert.deepEqual(boardsOf("ben"), ["roadmap-restored"]);
  assert.match(service.rows.find((row) => row._table === "boards" && row.boardId === "roadmap-restored").title, /copy restored from a backup/);

  // 4. A stale local copy with the same board id, also once Ben has been invited to edit it.
  const stale = await localProject("stale", staleRoot);
  await assert.rejects(takeOnline(url, stale), /An Online Board called roadmap already exists/);
  await service.ctx.db.insert("members", { boardId: "roadmap", userId: "ben", role: "editor" });
  resetCopyChecks();
  await assert.rejects(takeOnline(url, stale), /An Online Board called roadmap already exists/);

  // Ana's board is exactly as it was, and still only hers.
  assert.deepEqual(anasBoardRow(), before);
  assert.deepEqual(boardsOf("ana"), ["roadmap"]);
  assert.equal(service.rows.filter((row) => row._table === "transfers" && row.userId === "ben" && row.boardId === "roadmap").length, 0);
});

test("the board page shows the board's own account, asks before adding one, and names a signed-out board's account", async () => {
  const { cwd } = await anasOnlineBoard();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    // Sign-in from the page while Ana is signed in: the page asks first, and nothing starts.
    const signIn = (body: Record<string, unknown>) => fetch(`${server.url}/api/online/sign-in`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, ...body }) });
    const asked = await signIn({});
    assert.equal(asked.status, 409);
    const answer = await asked.json();
    assert.deepEqual(answer.accountInUse, { url, email: "ana@example.com" });
    assert.match(answer.error, /Signing in another account adds it: ana@example\.com stays signed in/);
    const started = await signIn({ switchAccount: true });
    assert.notEqual(started.status, 409);

    // With Ben added (the default now), the board shows its own account, Ana.
    await onlineLogin(url, { devUser: "ben" });
    const status = await (await fetch(`${server.url}/api/boards/roadmap/online`)).json();
    assert.equal(status.account, "ana@example.com");
    assert.equal((await fetch(`${server.url}/api/boards/roadmap/state`)).status, 200);

    // Ana signs out: the board says so, naming her, for the page to offer "Sign in as ana@example.com".
    await onlineLogout(url, { account: "ana@example.com" });
    const state = await fetch(`${server.url}/api/boards/roadmap/state`);
    assert.equal(state.status, 401);
    const body = await state.json();
    assert.equal(body.signInAccount, "ana@example.com");
    assert.match(body.signInCommand, /online sign-in /);
  } finally { await server.close(); }
});
test("a slow answer about an earlier sign-in never lands on a newer one", async () => {
  await onlineLogin(url, { devUser: "ana" });
  let reached!: () => void;
  const atMe = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  control.intercept = async (path) => {
    if (path !== "/api/v1/me" || held) return;
    held = true;
    reached();
    await released;
  };
  const slow = rememberIdentity(url, 1);
  await atMe;
  await onlineLogin(url, { devUser: "ben" });
  release();
  await slow;
  // Ben is the default; Ana's sign-in kept Ana's own identity.
  assert.equal((await onlineStatus())[0]!.signedInAs, "ben@example.com");
  assert.equal(Object.values((await readCredentials()).services)[0]!.person, "ben");
  assert.equal((await readCredentials()).accounts[url]!.accounts.ana!.email, "ana@example.com");
});

test("signing out names the account when several are signed in, and leaves the others", async () => {
  await onlineLogin(url, { devUser: "ana" });
  await onlineLogin(url, { devUser: "ben" });
  await assert.rejects(onlineLogout(url), /Several accounts are signed in .*ana@example\.com, ben@example\.com.*--account <email>/);
  await onlineLogout(url, { account: "ben@example.com" });
  assert.deepEqual((await onlineStatus())[0]!.accounts, [{ email: "ana@example.com", default: true }]);
  // Switching only changes the default for new boards.
  await onlineLogin(url, { devUser: "ben" });
  await switchAccount(url, "ana@example.com");
  assert.equal((await onlineStatus())[0]!.signedInAs, "ana@example.com");
  await assert.rejects(switchAccount(url, "nobody@example.com"), /nobody@example\.com isn't signed in/);
});
test("a board opened by an account that has signed out since stays that account's board, never another's", async () => {
  await onlineLogin(url, { devUser: "ana" });
  const pinned = Object.values((await readCredentials()).services)[0]!;
  await onlineLogin(url, { devUser: "ben" });
  await onlineLogout(url, { account: "ana@example.com" });
  await recordBoardAccountAs(url, "roadmap", pinned);
  // Linked to Ana, so it says Ana isn't signed in rather than opening as Ben.
  assert.equal((await boardAccount(url, "roadmap"))?.email, "ana@example.com");
});
test("a sign-in from before emails were kept gets its email on the board page", async () => {
  const { cwd } = await anasOnlineBoard();
  const [key, credentials] = Object.entries((await readCredentials()).services)[0]!;
  const { email: _email, ...older } = credentials;
  await saveCredentials(key, older);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const status = await (await fetch(`${server.url}/api/boards/roadmap/online`)).json();
    assert.deepEqual(status.accounts, { [url]: "ana@example.com" });
  } finally { await server.close(); }
});
