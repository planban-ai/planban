// Deleting for good (owner decisions, 15 October 2026), against the service's
// real handlers: (a) a board's read-only online copy, deleted by its owner;
// (b) a whole account, deleted by the operator within 30 days of a request.
// After each deletion the tests search every stored row, compressed fields
// unpacked, for anything left behind.
import assert from "node:assert/strict";
import { test } from "node:test";
import { internal } from "../online/service/convex/_generated/api";
import { unpackText } from "../online/service/convex/model/codec";
import * as erasure from "../online/service/convex/erasure";
import { memoryService, withServiceEnv } from "./hosted-harness";

type Service = ReturnType<typeof memoryService>;

function as(service: Service, token: string) {
  const send = service.browserSend(token);
  return async (method: string, path: string, body?: unknown) => {
    const response = await send(path, { method, headers: { "X-Planban-Client": "web", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

async function boardWithCard(api: ReturnType<typeof as>, title: string) {
  const created = await api("POST", "/api/v1/boards", { title });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const boardId = created.body.boardId as string;
  const card = await api("POST", `/api/v1/boards/${boardId}/ops/createCard`, { title: "A card", status: "pending", baseRevision: 1 });
  assert.equal(card.status, 200, JSON.stringify(card.body));
  return boardId;
}

async function addCard(api: ReturnType<typeof as>, boardId: string, title: string) {
  const state = await api("GET", `/api/v1/boards/${boardId}`);
  const added = await api("POST", `/api/v1/boards/${boardId}/ops/createCard`, { title, status: "pending", baseRevision: state.body.roadmap.revision });
  assert.equal(added.status, 200, JSON.stringify(added.body));
}

/** A row as text, compressed fields (boards, documents, history) unpacked. */
function readable(row: Record<string, unknown>) {
  return JSON.stringify(row, (_key, value) => value instanceof ArrayBuffer ? unpackText(value) : value);
}

/** Every stored row that still mentions this text (a board id or a user id), by table. */
function leftovers(service: Service, text: string, except: string[] = []) {
  return service.rows.filter((row) => !except.includes(row._table) && readable(row).includes(text)).map((row) => row._table);
}

async function takeLocal(service: Service, connectionId: string, boardId: string, others: string[]) {
  await service.call(internal.boards.fence, { connectionId, boardId, transferId: "take-local-1", acknowledgedOthers: others });
  await service.call(internal.boards.finishTakeLocal, { connectionId, boardId, transferId: "take-local-1" });
}

/** The sign-in service as the operator's command sees it; `deletes` records each user it was asked to delete. */
function fakeClerk(users: Record<string, Array<{ id: string; email_addresses?: Array<{ email_address: string }> }>>, options: { reachable?: () => boolean } = {}) {
  const deletes: string[] = [];
  const realFetch = globalThis.fetch;
  process.env.CLERK_SECRET_KEY = "sk_test_operator";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/users" && (!init?.method || init.method === "GET")) return Response.json(users[url.searchParams.get("email_address") ?? ""] ?? []);
    if (init?.method === "DELETE") {
      if (options.reachable && !options.reachable()) return new Response("unavailable", { status: 503 });
      deletes.push(decodeURIComponent(url.pathname.replace("/v1/users/", "")));
      return Response.json({ deleted: true });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { deletes, restore: () => { globalThis.fetch = realFetch; delete process.env.CLERK_SECRET_KEY; } };
}

const requestAccount = (service: Service, email: string) => (erasure.requestAccount as any)._handler(service.actionCtx, { email });

test("an owner deletes a board's read-only online copy: it's gone at once for everyone, then every stored row goes", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    const owner = await service.signIn("user_owner", "Owen");
    const editor = await service.signIn("user_editor", "Edie");
    const ownerApi = as(service, owner.token);
    const boardId = await boardWithCard(ownerApi, "Copy board");
    await ownerApi("POST", `/api/v1/boards/${boardId}/members`, { userId: "user_editor", role: "editor" });
    await ownerApi("POST", `/api/v1/boards/${boardId}/invites`, { role: "viewer" });
    const key = await ownerApi("POST", "/api/v1/keys", { name: "For this board", boardId, level: "read" });
    assert.equal(key.status, 201, JSON.stringify(key.body));

    // While the board is online there is no read-only copy to delete.
    assert.equal((await ownerApi("POST", `/api/v1/boards/${boardId}/delete-copy`, { confirmTitle: "Copy board" })).status, 409);

    await takeLocal(service, owner.connectionId, boardId, ["user_editor"]);
    assert.equal((await ownerApi("GET", `/api/v1/boards/${boardId}`)).status, 200, "the owner can still read the copy");
    assert.equal((await ownerApi("POST", `/api/v1/boards/${boardId}/delete-copy`, { confirmTitle: "Copy" })).status, 400);
    assert.equal((await as(service, editor.token)("POST", `/api/v1/boards/${boardId}/delete-copy`, { confirmTitle: "Copy board" })).status, 404, "someone no longer on the board can't even see it");

    const deleted = await ownerApi("POST", `/api/v1/boards/${boardId}/delete-copy`, { confirmTitle: "Copy board" });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal((await ownerApi("GET", `/api/v1/boards/${boardId}`)).status, 404);
    assert.deepEqual((await ownerApi("GET", "/api/v1/boards")).body.boards, []);

    // Its id stays reserved until the rows are gone: a new board meanwhile gets another.
    const meanwhile = await boardWithCard(ownerApi, "Copy board");
    assert.notEqual(meanwhile, boardId);
    await service.runJobs();
    const stale = service.rows.filter((row) => row.boardId === boardId);
    assert.deepEqual(stale.map((row) => row._table).filter((table) => table !== "operations"), [], "no row of the deleted copy is left (retry records expire in 7 days)");
    assert.ok(service.rows.find((row) => row._table === "connections" && row.kind === "key").revokedAt, "a key for only this board stops working");
    assert.deepEqual(service.rows.filter((row) => row._table === "erasures"), []);
    // Once the rows are gone, the id is free again.
    assert.equal(await boardWithCard(ownerApi, "Copy board"), boardId);
  });
});

test("deleting an account removes everything of theirs, credits their changes elsewhere to a deleted account, and deletes the sign-in account first", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    const leaving = await service.signIn("user_leaving", "Lee Leaving");
    await service.signIn("user_leaving", "Lee Leaving");
    const friend = await service.signIn("user_friend", "Fran");
    const host = await service.signIn("user_host", "Hal");
    service.rows.find((row) => row._table === "people" && row.userId === "user_leaving").email = "lee@example.com";
    const leavingApi = as(service, leaving.token), friendApi = as(service, friend.token), hostApi = as(service, host.token);

    // Lee owns a board shared with Fran, and has a key.
    const own = await boardWithCard(leavingApi, "Lee's board");
    await leavingApi("POST", `/api/v1/boards/${own}/members`, { userId: "user_friend", role: "editor" });
    await leavingApi("POST", "/api/v1/keys", { name: "Laptop agent", boardId: own, level: "plan" });
    // Lee joined Hal's board by link and added a card; an email invitation to Lee waits on another.
    const hosts = await boardWithCard(hostApi, "Hal's board");
    const link = await hostApi("POST", `/api/v1/boards/${hosts}/invites`, { role: "editor" });
    assert.equal((await leavingApi("POST", "/api/v1/invites/accept", { token: String(link.body.link).split("/invite/")[1] })).status, 200);
    await addCard(leavingApi, hosts, "Lee's idea");
    // Lee also changed a board Hal later removed them from.
    const former = await boardWithCard(hostApi, "Hal's old board");
    await hostApi("POST", `/api/v1/boards/${former}/members`, { userId: "user_leaving", role: "editor" });
    await addCard(leavingApi, former, "Lee's old card");
    assert.equal((await hostApi("POST", `/api/v1/boards/${former}/members/user_leaving/remove`, {})).status, 200);
    const other = await boardWithCard(hostApi, "Hal's other board");
    await hostApi("POST", `/api/v1/boards/${other}/invites`, { role: "viewer", email: "lee@example.com" });
    // Lee signed the other browser out, leaving a barrier against its session.
    const listed = await leavingApi("GET", "/api/v1/connections");
    const otherBrowser = listed.body.connections.find((row: { id: string; current?: boolean; kind: string }) => row.kind === "web" && !row.current);
    assert.equal((await leavingApi("POST", `/api/v1/connections/${otherBrowser.id}/revoke`, {})).status, 200);
    assert.ok(service.rows.some((row) => row._table === "webSessionBarriers"));

    const clerk = fakeClerk({ "lee@example.com": [{ id: "user_leaving", email_addresses: [{ email_address: "lee@example.com" }, { email_address: "lee.work@example.com" }] }] });
    try {
      const started = await requestAccount(service, "LEE@example.com");
      assert.deepEqual(started, { userId: "user_leaving", invitesRemoved: 1, signInAccountDeleted: true, note: null });
      assert.deepEqual(clerk.deletes, ["user_leaving"], "the sign-in account is deleted straight away");

      // At once: every sign-in stops, and no new one can start.
      assert.equal((await leavingApi("GET", "/api/v1/boards")).status, 401);
      await assert.rejects(service.signIn("user_leaving", "Lee again"), /has been deleted/);

      await service.runJobs();

      assert.equal((await friendApi("GET", `/api/v1/boards/${own}`)).status, 404, "Lee's board is gone for Fran too");
      // The leak check reads inside compressed fields: Lee's card text is found there.
      assert.ok(leftovers(service, "Lee's idea").includes("boardState"));
      assert.deepEqual(leftovers(service, "user_leaving", ["erasures"]), [], "nothing names the account but its deletion record");
      assert.deepEqual(leftovers(service, own, ["operations", "erasures"]), [], "nothing of the board they owned is left");
      assert.deepEqual(leftovers(service, "lee@example.com"), []);
      // Hal's boards keep Lee's cards, credited to a deleted account, including the board Lee had left.
      const hostBoard = await hostApi("GET", `/api/v1/boards/${hosts}`);
      assert.ok(hostBoard.body.roadmap.roadmapItems.some((item: { title: string }) => item.title === "Lee's idea"));
      for (const boardId of [hosts, former]) {
        assert.ok(service.rows.some((row) => row._table === "history" && row.boardId === boardId && row.entry.attribution.userId === erasure.DELETED_ACCOUNT), boardId);
      }
      const status = await service.call(internal.erasure.accountStatus, { userId: "user_leaving" });
      assert.equal(status.finished, true, JSON.stringify(status));
      // The deletion record itself goes after a day.
      service.rows.find((row) => row._table === "erasures").doneAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await service.call(internal.erasure.sweep, {});
      await service.runJobs();
      assert.deepEqual(leftovers(service, "user_leaving"), []);
      assert.equal((await service.call(internal.erasure.accountStatus, { userId: "user_leaving" })).finished, true);
    } finally {
      clerk.restore();
    }
  });
});

test("when the sign-in service can't be reached, the deletion says so and isn't finished until the daily sweep deletes the sign-in account", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    await service.signIn("user_gone", "Gwen");
    let reachable = false;
    const clerk = fakeClerk({ "gwen@example.com": [{ id: "user_gone" }] }, { reachable: () => reachable });
    try {
      const started = await requestAccount(service, "gwen@example.com");
      assert.equal(started.signInAccountDeleted, false);
      assert.match(started.note, /answered 503/);
      await service.runJobs();
      let status = await service.call(internal.erasure.accountStatus, { userId: "user_gone" });
      assert.equal(status.stage, "done");
      assert.equal(status.finished, false, "not finished while the sign-in account exists");
      assert.deepEqual(leftovers(service, "user_gone", ["erasures"]), [], "everything else is already gone");
      await assert.rejects(service.signIn("user_gone", "Gwen"), /has been deleted/, "and the account still can't sign in");
      reachable = true;
      await service.call(internal.erasure.sweep, {});
      await service.runJobs();
      status = await service.call(internal.erasure.accountStatus, { userId: "user_gone" });
      assert.equal(status.finished, true);
      assert.deepEqual(clerk.deletes, ["user_gone"]);
    } finally {
      clerk.restore();
    }
  });
});

test("one deletion waiting on the sign-in service never holds up another", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    const clerk = fakeClerk(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`stuck${i}@example.com`, [{ id: `user_stuck${i}` }]])), { reachable: () => false });
    try {
      for (let i = 0; i < 12; i += 1) {
        await service.signIn(`user_stuck${i}`);
        await requestAccount(service, `stuck${i}@example.com`);
      }
      const owner = await service.signIn("user_owner", "Owen");
      const ownerApi = as(service, owner.token);
      const boardId = await boardWithCard(ownerApi, "Unrelated board");
      await takeLocal(service, owner.connectionId, boardId, []);
      assert.equal((await ownerApi("POST", `/api/v1/boards/${boardId}/delete-copy`, { confirmTitle: "Unrelated board" })).status, 200);
      await service.call(internal.erasure.sweep, {});
      await service.runJobs();
      assert.deepEqual(service.rows.filter((row) => row._table === "erasures" && row.kind === "board"), [], "the board's deletion finished");
      assert.equal(service.rows.filter((row) => row._table === "erasures" && row.kind === "account").length, 12);
    } finally {
      clerk.restore();
    }
  });
});

test("the operator's command refuses an address that matches no account, or more than one, and needs the sign-in service", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    await assert.rejects(requestAccount(service, "anyone@example.com"), /no sign-in service key/);
    const clerk = fakeClerk({ "twice@example.com": [{ id: "user_a" }, { id: "user_b" }] });
    try {
      await assert.rejects(requestAccount(service, "nobody@example.com"), /No account uses/);
      await assert.rejects(requestAccount(service, "twice@example.com"), /matches 2 accounts/);
      assert.deepEqual(service.rows.filter((row) => row._table === "erasures"), []);
      assert.deepEqual(clerk.deletes, []);
    } finally {
      clerk.restore();
    }
  });
});

test("on the web page, Board settings knows a read-only copy, and its Delete online copy reaches the service", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    const owner = await service.signIn("user_owner", "Owen");
    const boardId = await boardWithCard(as(service, owner.token), "Page board");
    const page = service.adapterFor(owner.token);
    const settings = async () => (await page.fetch(`/api/boards/${boardId}/online`)).json() as Promise<{ readOnlyCopy?: boolean }>;
    await page.fetch(`/api/boards/${boardId}/state`);
    assert.equal((await settings()).readOnlyCopy, undefined, "an online board isn't a copy");
    await takeLocal(service, owner.connectionId, boardId, []);
    await page.fetch(`/api/boards/${boardId}/state`);
    assert.equal((await settings()).readOnlyCopy, true);
    const refused = await page.fetch(`/api/boards/${boardId}/online/delete-copy`, { method: "POST", body: JSON.stringify({ confirmTitle: "Wrong" }) });
    assert.equal(refused.status, 422);
    const deleted = await page.fetch(`/api/boards/${boardId}/online/delete-copy`, { method: "POST", body: JSON.stringify({ confirmTitle: "Page board" }) });
    assert.equal(deleted.status, 200);
    assert.equal((await page.fetch(`/api/boards/${boardId}/state`)).status, 404);
  });
});

test("other people's boards show a deleted account's changes as 'A deleted account', and never anyone's raw account id", async () => {
  const { absentPerson } = await import("../src/web/onlineBoard");
  assert.equal(absentPerson(erasure.DELETED_ACCOUNT).name, "A deleted account");
  assert.equal(absentPerson("user_3KjNmCA4RC6B9pT7PIyRgMOdoUW").name, "Someone no longer on this board");
});

test("a deleted account stays deleted: it can't be added to a board, and while its record lasts it can't start a sign-in", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    const host = await service.signIn("user_host", "Hal");
    await service.signIn("user_gone", "Gwen");
    const hostApi = as(service, host.token);
    const boardId = await boardWithCard(hostApi, "Hal's board");
    const clerk = fakeClerk({ "gwen@example.com": [{ id: "user_gone" }] });
    try {
      await requestAccount(service, "gwen@example.com");
      await service.runJobs();
      const hex = "a".repeat(64);
      await assert.rejects(service.call(internal.oauth.createRequest, {
        requestHash: hex, browserHash: hex, csrfHash: hex, clientId: "planban-cli", clientName: "Planban CLI", redirectUri: "http://127.0.0.1/callback",
        resource: "https://planban.example", scopes: ["planban:machine"], level: "complete", challenge: "c".repeat(43), state: "s",
        purpose: "machine", userId: "user_gone", expiresAt: Date.now() + 60_000,
      }), /has been deleted/, "a sign-in already under way when the account was deleted is refused");
      // A day after it finishes, the deletion record goes; its Clerk user is long gone, so no sign-in can start.
      service.rows.find((row) => row._table === "erasures").doneAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await service.call(internal.erasure.sweep, {});
      await service.runJobs();
      assert.deepEqual(service.rows.filter((row) => row._table === "erasures"), []);
      assert.deepEqual(leftovers(service, "user_gone"), [], "nothing of the account is kept, not even its id");

      const added = await hostApi("POST", `/api/v1/boards/${boardId}/members`, { userId: "user_gone", role: "editor" });
      assert.equal(added.status, 404);
      assert.deepEqual(leftovers(service, "user_gone"), []);
    } finally {
      clerk.restore();
    }
  });
});

test("a board's deletion removes every generation under its id, however many uploads it had", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    const owner = await service.signIn("user_owner", "Owen");
    const ownerApi = as(service, owner.token);
    const boardId = await boardWithCard(ownerApi, "Many uploads");
    await takeLocal(service, owner.connectionId, boardId, []);
    // 120 abandoned uploads, each with rows in its own generation.
    for (let i = 0; i < 120; i += 1) {
      const generation = 1000 + i;
      await service.ctx.db.insert("transfers", { transferId: `upload-${i}`, userId: "user_owner", boardId, generation, state: "aborted", previousRevision: 1, maxVersion: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await service.ctx.db.insert("transferParts", { transferId: `upload-${i}`, seq: 0 });
      await service.ctx.db.insert("boardSizes", { boardId, generation, bytes: 10 });
    }
    assert.equal((await ownerApi("POST", `/api/v1/boards/${boardId}/delete-copy`, { confirmTitle: "Many uploads" })).status, 200);
    await service.runJobs(10_000);
    assert.deepEqual([...new Set(service.rows.filter((row) => row.boardId === boardId).map((row) => row._table))].filter((table) => table !== "operations"), []);
    assert.deepEqual(service.rows.filter((row) => row._table === "transferParts"), []);
    assert.deepEqual(service.rows.filter((row) => row._table === "erasures"), []);
  });
});

test("an account deletion drains every refresh token of an app connection before removing the connection", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    const signedIn = await service.signIn("user_apps", "Ada");
    const grant = await service.ctx.db.insert("connections", { userId: "user_apps", kind: "oauth", name: "ChatGPT", clientName: "ChatGPT", boards: "all", level: "plan", canAdminister: false, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() });
    for (let i = 0; i < 250; i += 1) {
      await service.ctx.db.insert("oauthRefresh", { tokenHash: `spent-${i}`, connectionId: grant, clientId: "chatgpt", resource: "https://planban.example", scopes: ["planban:plan"], expiresAt: Date.now() + 1e9, usedAt: Date.now() });
    }
    assert.ok(signedIn.connectionId);
    await service.call(internal.erasure.beginAccount, { userId: "user_apps", emails: [] });
    await service.call(internal.erasure.noteClerkDeleted, { userId: "user_apps" });
    await service.runJobs(10_000);
    assert.deepEqual(service.rows.filter((row) => row._table === "oauthRefresh"), []);
    assert.equal((await service.call(internal.erasure.accountStatus, { userId: "user_apps" })).finished, true);
  });
});
