// The web page's hosted transport against the online service's real handlers
// (Planban 2.0 plan, phase 2): the page's own routes, answered from /api/v1
// through the browser session, in the shapes the local server answers with.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryService, PUBLIC, withServiceEnv } from "./hosted-harness";
import { newIdempotencyKey, WEB_ONLY_MESSAGE } from "../src/web/hostedAdapter";
import { boardPath, cardPath } from "../src/web/apiPaths";

type Json = Record<string, any>;

async function page(adapter: { fetch(path: string, init?: RequestInit): Promise<Response> }, path: string, init: { method?: string; body?: unknown; key?: string } = {}) {
  const response = await adapter.fetch(path, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", "X-Planban-Client": "web", ...(init.key ? { "Idempotency-Key": init.key } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: await response.json() as Json };
}

/** An owner signed in on the web with a new online board, opened on the page. */
async function ownerWithBoard(service = memoryService(), title = "Deadleg launch") {
  const owner = await service.signIn("user_owner", "Olive Owner");
  const created = await service.browserSend(owner.token)("/api/v1/boards", { method: "POST", headers: { "X-Planban-Client": "web", "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
  assert.equal(created.status, 201, await created.clone().text());
  const { boardId } = await created.json() as { boardId: string };
  const log: Array<{ path: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const adapter = service.adapterFor(owner.token, { log });
  return { service, owner, boardId, adapter, log };
}

async function addMember(service: ReturnType<typeof memoryService>, ownerToken: string, boardId: string, userId: string, role: "editor" | "viewer") {
  const response = await service.browserSend(ownerToken)(`/api/v1/boards/${boardId}/members`, { method: "POST", headers: { "X-Planban-Client": "web", "Content-Type": "application/json" }, body: JSON.stringify({ userId, role }) });
  assert.equal(response.status, 200, await response.clone().text());
}

test("the board list and the board come back in the page's shapes, with the person's role", async () => {
  await withServiceEnv(async () => {
    const { boardId, adapter } = await ownerWithBoard();
    const status = await page(adapter, "/api/status");
    assert.deepEqual(status.body, { initialized: true, currentRepoId: null });
    const list = await page(adapter, "/api/boards?includeArchived=true");
    assert.equal(list.status, 200);
    assert.equal(list.body.boards.length, 1);
    assert.equal(list.body.boards[0].repoId, boardId);
    assert.equal(list.body.boards[0].title, "Deadleg launch");
    assert.equal(list.body.boards[0].online.role, "owner");
    assert.equal(list.body.boards[0].online.needYou, 0);
    const state = await page(adapter, boardPath(boardId, "/state"));
    assert.equal(state.status, 200);
    assert.equal(state.body.manifest.repoId, boardId);
    assert.deepEqual(state.body.manifest.storage, { kind: "online", url: PUBLIC, boardId });
    assert.equal(state.body.roadmap.revision, 1);
    assert.deepEqual(state.body.hosted, { boardId, role: "owner", authority: "online" });
  });
});

test("edits carry the revision the person saw; a stale one is a conflict that names the current revision", async () => {
  await withServiceEnv(async () => {
    const { boardId, adapter, log } = await ownerWithBoard();
    const created = await page(adapter, boardPath(boardId, "/cards"), { method: "POST", body: { title: "Ship the web page", status: "pending", baseRevision: 1 } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.roadmap.revision, 2);
    const cardId = created.body.createdCard.id as string;
    assert.ok(created.body.roadmap.roadmapItems.some((item: Json) => item.id === cardId));
    // What went to the service: the person's own revision, and nothing of the page's own.
    assert.deepEqual(JSON.parse(log.at(-1)!.body!), { title: "Ship the web page", status: "pending", baseRevision: 1, actor: "user" });
    const history = await page(adapter, boardPath(boardId, "/history"));
    assert.equal(history.body.entries.find((entry: Json) => entry.version === history.body.currentVersion).actor, "user", "the person's own edit, not their agent's");

    const moved = await page(adapter, cardPath(boardId, cardId, "/move"), { method: "POST", body: { status: "in-progress", baseRevision: 2 } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.roadmap.roadmapItems.find((item: Json) => item.id === cardId).status, "in-progress");

    // From an older view: renaming touches only the title, which nobody changed since, so it applies (Spec point 20).
    const elsewhere = await page(adapter, cardPath(boardId, cardId), { method: "PATCH", body: { title: "Renamed from an old view", baseRevision: 2 } });
    assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body));
    assert.equal(elsewhere.body.roadmap.roadmapItems.find((item: Json) => item.id === cardId).status, "in-progress", "the move stays");
    // Renaming again from that same older view clashes on the title someone changed since.
    const stale = await page(adapter, cardPath(boardId, cardId), { method: "PATCH", body: { title: "Another name from the old view", baseRevision: 2 } });
    assert.equal(stale.status, 409);
    assert.equal(typeof stale.body.error, "string");
    assert.equal(stale.body.currentRevision, 4);
    const missing = await page(adapter, cardPath(boardId, cardId), { method: "PATCH", body: { title: "No revision" } });
    assert.equal(missing.status, 422, "a service validation error is the page's 422");
    assert.match(missing.body.error, /baseRevision/);

    const updated = await page(adapter, cardPath(boardId, cardId), { method: "PATCH", body: { title: "Renamed", baseRevision: 4 } });
    assert.equal(updated.status, 200);
    const group = await page(adapter, boardPath(boardId, "/groups"), { method: "POST", body: { title: "Launch", itemIds: [cardId], baseRevision: 5 } });
    assert.equal(group.status, 200, JSON.stringify(group.body));
    assert.equal(group.body.createdGroup.title, "Launch");
    const parent = await page(adapter, cardPath(boardId, cardId, "/parent"), { method: "POST", body: { parentId: null, baseRevision: 6 } });
    assert.equal(parent.status, 200, JSON.stringify(parent.body));
    const archived = await page(adapter, cardPath(boardId, cardId, "/archive"), { method: "POST", body: { baseRevision: 7 } });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    const deleted = await page(adapter, cardPath(boardId, cardId), { method: "DELETE", body: { baseRevision: 8 } });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.roadmap.roadmapItems.some((item: Json) => item.id === cardId), false);
  });
});

test("the web page marks cards that wait on a person, and a metadata edit through the service is a patch", async () => {
  await withServiceEnv(async () => {
    const { boardId, adapter } = await ownerWithBoard();
    const created = await page(adapter, boardPath(boardId, "/cards"), { method: "POST", body: { title: "Sign off", status: "in-progress", nextAction: "Owner: approve the copy.", baseRevision: 1 } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const cardId = created.body.createdCard.id as string;
    assert.deepEqual(created.body.staleness.cards[cardId].map((signal: Json) => signal.kind), ["awaiting-owner"], "an edit's answer carries the notes too");
    const state = await page(adapter, boardPath(boardId, "/state"));
    assert.deepEqual(state.body.staleness.cards[cardId].map((signal: Json) => signal.kind), ["awaiting-owner"]);

    const first = await page(adapter, cardPath(boardId, cardId), { method: "PATCH", body: { metadata: { thread: "t1", pr: 4 }, baseRevision: 2 } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await page(adapter, cardPath(boardId, cardId), { method: "PATCH", body: { metadata: { pr: null, owner: "olive" }, baseRevision: 3 } });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(second.body.roadmap.roadmapItems.find((item: Json) => item.id === cardId).metadata, { thread: "t1", owner: "olive" });
  });
});

test("Spec and Plan: new, existing and deleted documents, each write stating the stamp the page read", async () => {
  await withServiceEnv(async () => {
    const { boardId, adapter, log } = await ownerWithBoard();
    const card = (await page(adapter, boardPath(boardId, "/cards"), { method: "POST", body: { title: "Write the plan", baseRevision: 1 } })).body.createdCard.id as string;
    const docPath = cardPath(boardId, card, "/docs/plan");

    const empty = await page(adapter, docPath);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.exists, false);
    assert.equal(empty.body.mtimeMs, null);

    // A new document states null.
    const first = await page(adapter, docPath, { method: "PUT", body: { markdown: "# Plan\n\nFirst.", expectedMtimeMs: null } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.exists, true);
    assert.equal(first.body.markdown, "# Plan\n\nFirst.");
    assert.equal(typeof first.body.mtimeMs, "number");
    assert.deepEqual(Object.keys(first.body).sort(), ["cardId", "exists", "kind", "markdown", "mtimeMs", "path"], "the same result.doc shape as reading");

    // An existing one states the stamp that was read, and the adapter sends exactly that.
    const read = await page(adapter, docPath);
    assert.equal(read.body.mtimeMs, first.body.mtimeMs);
    const second = await page(adapter, docPath, { method: "PUT", body: { markdown: "# Plan\n\nSecond.", expectedMtimeMs: read.body.mtimeMs } });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(JSON.parse(log.at(-1)!.body!).expectedMtimeMs, read.body.mtimeMs);

    // Saving from the older read is a conflict, never a silent overwrite with a fresher stamp.
    const stale = await page(adapter, docPath, { method: "PUT", body: { markdown: "# Plan\n\nFrom an old tab.", expectedMtimeMs: read.body.mtimeMs } });
    assert.equal(stale.status, 409);
    // A person's own save gets the plain sentence; the page shows them what changed.
    assert.match(stale.body.error, /^Not saved: Olive Owner changed the Plan of card "Write the plan" since you read it \(/);
    assert.doesNotMatch(stale.body.error, /Never just resend/);
    assert.equal(typeof stale.body.currentRevision, "number");
    assert.equal(JSON.parse(log.at(-1)!.body!).expectedMtimeMs, read.body.mtimeMs);
    const asNew = await page(adapter, docPath, { method: "PUT", body: { markdown: "# Plan\n\nThought it was new.", expectedMtimeMs: null } });
    assert.equal(asNew.status, 409, "a document that exists can't be written as new");
    assert.equal((await page(adapter, docPath)).body.markdown, "# Plan\n\nSecond.");

    // The card and its documents deleted: reading and writing say it's gone.
    const state = (await page(adapter, boardPath(boardId, "/state"))).body;
    const archived = await page(adapter, cardPath(boardId, card, "/move"), { method: "POST", body: { status: "archived", baseRevision: state.roadmap.revision } });
    await page(adapter, cardPath(boardId, card), { method: "DELETE", body: { baseRevision: archived.body.roadmap.revision } });
    assert.equal((await page(adapter, docPath)).status, 404);
    const gone = await page(adapter, docPath, { method: "PUT", body: { markdown: "# Plan", expectedMtimeMs: second.body.mtimeMs } });
    assert.ok(gone.status === 404 || gone.status === 409, `writing to a deleted card is refused (${gone.status})`);
    assert.equal(typeof gone.body.error, "string");
  });
});

test("every restore type, from History, with the revision the person saw", async () => {
  await withServiceEnv(async () => {
    const { boardId, adapter } = await ownerWithBoard();
    const card = (await page(adapter, boardPath(boardId, "/cards"), { method: "POST", body: { title: "Original title", baseRevision: 1 } })).body.createdCard.id as string;
    const created = (await page(adapter, cardPath(boardId, card, "/docs/spec"))).body;
    const written = await page(adapter, cardPath(boardId, card, "/docs/spec"), { method: "PUT", body: { markdown: "# Spec\n\nOriginal.", expectedMtimeMs: created.mtimeMs } });
    assert.equal(written.status, 200, JSON.stringify(written.body));
    const history = await page(adapter, boardPath(boardId, "/history"));
    assert.equal(history.status, 200);
    const original = history.body.currentVersion as number;
    assert.equal(history.body.entries.at(-1)?.version ?? history.body.entries[0]?.version, history.body.entries.at(-1)?.version);
    assert.ok(history.body.entries.some((entry: Json) => entry.version === original));

    let revision = (await page(adapter, boardPath(boardId, "/state"))).body.roadmap.revision as number;
    const beforeTitle = revision;
    revision = (await page(adapter, cardPath(boardId, card), { method: "PATCH", body: { title: "Changed title", baseRevision: revision } })).body.roadmap.revision;
    const spec = (await page(adapter, cardPath(boardId, card, "/docs/spec"))).body;
    await page(adapter, cardPath(boardId, card, "/docs/spec"), { method: "PUT", body: { markdown: "# Spec\n\nChanged.", expectedMtimeMs: spec.mtimeMs } });
    revision = (await page(adapter, boardPath(boardId, "/state"))).body.roadmap.revision;

    // History snapshots become page state.
    const snapshot = await page(adapter, boardPath(boardId, `/history/${original}`));
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.roadmap.roadmapItems.find((item: Json) => item.id === card).title, "Original title");
    assert.equal(snapshot.body.manifest.repoId, boardId);
    const oldSpec = await page(adapter, cardPath(boardId, card, "/docs/spec", original));
    assert.equal(oldSpec.body.markdown, "# Spec\n\nOriginal.");
    assert.equal((await page(adapter, boardPath(boardId, "/history/0"))).status, 422);

    // Restoring a card from a view older than a change to that card is refused like any clashing edit.
    const stale = await page(adapter, cardPath(boardId, card, "/restore", original), { method: "POST", body: { actor: "user", baseRevision: beforeTitle } });
    assert.equal(stale.status, 409);

    const restoredCard = await page(adapter, cardPath(boardId, card, "/restore", original), { method: "POST", body: { actor: "user", baseRevision: revision } });
    assert.equal(restoredCard.status, 200, JSON.stringify(restoredCard.body));
    assert.equal(restoredCard.body.roadmap.roadmapItems.find((item: Json) => item.id === card).title, "Original title");
    revision = restoredCard.body.roadmap.revision;

    const restoredDoc = await page(adapter, cardPath(boardId, card, "/docs/spec/restore", original), { method: "POST", body: { actor: "user", baseRevision: revision } });
    assert.equal(restoredDoc.status, 200, JSON.stringify(restoredDoc.body));
    assert.equal(restoredDoc.body.markdown, "# Spec\n\nOriginal.", "the restored document as it now is");
    revision = (await page(adapter, boardPath(boardId, "/state"))).body.roadmap.revision;

    const restoredBoard = await page(adapter, boardPath(boardId, "/history/1/restore-board"), { method: "POST", body: { actor: "user", baseRevision: revision } });
    assert.equal(restoredBoard.status, 200, JSON.stringify(restoredBoard.body));
    assert.equal(restoredBoard.body.roadmap.roadmapItems.length, 0, "version 1 was the empty board");
  });
});

test("permissions: a viewer reads everything and changes nothing; an editor edits but can't manage people", async () => {
  await withServiceEnv(async () => {
    const { service, owner, boardId, adapter } = await ownerWithBoard();
    const card = (await page(adapter, boardPath(boardId, "/cards"), { method: "POST", body: { title: "Shared card", baseRevision: 1 } })).body.createdCard.id as string;
    const skeleton = (await page(adapter, cardPath(boardId, card, "/docs/spec"))).body;
    assert.equal((await page(adapter, cardPath(boardId, card, "/docs/spec"), { method: "PUT", body: { markdown: "# Spec", expectedMtimeMs: skeleton.mtimeMs } })).status, 200);
    const viewer = service.adapterFor((await service.signIn("user_viewer")).token);
    const editor = service.adapterFor((await service.signIn("user_editor")).token);
    await addMember(service, owner.token, boardId, "user_viewer", "viewer");
    await addMember(service, owner.token, boardId, "user_editor", "editor");

    const seen = await page(viewer, boardPath(boardId, "/state"));
    assert.equal(seen.status, 200);
    assert.equal(seen.body.hosted.role, "viewer");
    const revision = seen.body.roadmap.revision as number;
    assert.equal((await page(viewer, cardPath(boardId, card, "/docs/spec"))).body.markdown, "# Spec");
    assert.equal((await page(viewer, boardPath(boardId, "/history"))).status, 200);
    const spec = (await page(viewer, cardPath(boardId, card, "/docs/spec"))).body;
    for (const [path, method, body] of [
      [cardPath(boardId, card), "PATCH", { title: "Viewer edit", baseRevision: revision }],
      [cardPath(boardId, card, "/move"), "POST", { status: "complete", baseRevision: revision }],
      [cardPath(boardId, card, "/docs/spec"), "PUT", { markdown: "# Viewer", expectedMtimeMs: spec.mtimeMs }],
      [cardPath(boardId, card, "/restore", 1), "POST", { baseRevision: revision }],
      [boardPath(boardId, "/history/1/restore-board"), "POST", { baseRevision: revision }],
      [boardPath(boardId, "/online/invites"), "POST", { role: "viewer" }],
    ] as const) {
      const refused = await page(viewer, path, { method, body });
      assert.equal(refused.status, 403, `${method} ${path}: ${JSON.stringify(refused.body)}`);
      assert.equal(typeof refused.body.error, "string");
    }
    assert.equal((await page(adapter, boardPath(boardId, "/state"))).body.roadmap.revision, revision, "nothing changed");

    const edited = await page(editor, cardPath(boardId, card), { method: "PATCH", body: { title: "Editor edit", baseRevision: revision } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const invite = await page(editor, boardPath(boardId, "/online/invites"), { method: "POST", body: { role: "viewer" } });
    assert.equal(invite.status, 403);
    const role = await page(editor, boardPath(boardId, "/online/members/user_viewer/role"), { method: "POST", body: { role: "editor" } });
    assert.equal(role.status, 403);
    const ownerRole = await page(adapter, boardPath(boardId, "/online/members/user_viewer/role"), { method: "POST", body: { role: "editor" } });
    assert.equal(ownerRole.status, 200, JSON.stringify(ownerRole.body));

    // Board settings on the web: who is on the board, and which one is you.
    const settings = await page(adapter, boardPath(boardId, "/online"));
    assert.equal(settings.body.location, "online");
    assert.equal(settings.body.job, null);
    const you = settings.body.people.find((person: Json) => person.you);
    assert.equal(you.userId, "user_owner");
    assert.equal(you.role, "owner");
    assert.equal(settings.body.people.filter((person: Json) => person.you).length, 1);
  });
});

test("a lost response is resent with the same key and bytes, and the service applies the edit once", async () => {
  await withServiceEnv(async () => {
    const { service, owner, boardId } = await ownerWithBoard();
    const sent: Array<{ path: string; headers: Record<string, string>; body?: string }> = [];
    const real = service.browserSend(owner.token);
    let dropNext = false;
    const adapter = service.adapterFor(owner.token, {
      send: async (path, init) => {
        sent.push({ path, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
        const response = await real(path, init);
        // The service did the work, but the answer never arrived.
        if (dropNext && path.includes("/ops/")) {
          dropNext = false;
          throw new TypeError("Failed to fetch");
        }
        return response;
      },
    });
    const card = (await page(adapter, boardPath(boardId, "/cards"), { method: "POST", body: { title: "Once only", baseRevision: 1 } })).body.createdCard.id as string;
    dropNext = true;
    sent.length = 0;
    const key = newIdempotencyKey();
    const moved = await page(adapter, cardPath(boardId, card, "/move"), { method: "POST", body: { status: "complete", baseRevision: 2 }, key });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.onlineReplay?.replayed, true, "the second answer is the original result");
    assert.equal(moved.body.roadmap.revision, 3);
    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.headers["Idempotency-Key"], key);
    assert.equal(sent[1]!.headers["Idempotency-Key"], key);
    assert.equal(sent[0]!.body, sent[1]!.body, "byte-identical body");
    const state = await page(adapter, boardPath(boardId, "/state"));
    assert.equal(state.body.roadmap.revision, 3, "applied once");

    // Without a key from the page, the adapter makes one the service accepts.
    sent.length = 0;
    await page(adapter, cardPath(boardId, card), { method: "PATCH", body: { title: "Keyed by the adapter", baseRevision: 3 } });
    assert.match(sent[0]!.headers["Idempotency-Key"]!, /^[A-Za-z0-9_-]{8,100}$/);
    // The page's own keys have that form too.
    assert.match(newIdempotencyKey(), /^[A-Za-z0-9_-]{8,100}$/);
  });
});

test("a connection that drops while the answer arrives is a lost response too, resent with the same key and bytes", async () => {
  await withServiceEnv(async () => {
    const { service, owner, boardId } = await ownerWithBoard();
    const real = service.browserSend(owner.token);
    const sent: Array<{ key?: string; body?: string }> = [];
    let truncateNext = false;
    const adapter = service.adapterFor(owner.token, {
      send: async (path, init) => {
        sent.push({ ...(init.headers["Idempotency-Key"] ? { key: init.headers["Idempotency-Key"] } : {}), ...(init.body === undefined ? {} : { body: init.body }) });
        const response = await real(path, init);
        if (truncateNext && path.includes("/ops/")) {
          truncateNext = false;
          // The edit committed; the body never finishes arriving.
          return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("network connection lost")); } }), { status: 200, headers: response.headers });
        }
        return response;
      },
    });
    truncateNext = true;
    const created = await page(adapter, boardPath(boardId, "/cards"), { method: "POST", body: { title: "Arrives once", baseRevision: 1 } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.onlineReplay?.replayed, true);
    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.key, sent[1]!.key);
    assert.equal(sent[0]!.body, sent[1]!.body);
    const state = await page(adapter, boardPath(boardId, "/state"));
    assert.deepEqual(state.body.roadmap.roadmapItems.map((item: Json) => item.title), ["Arrives once"]);
  });
});

test("Board settings passes on a refusal instead of claiming the person is signed in", async () => {
  await withServiceEnv(async () => {
    const { service, boardId } = await ownerWithBoard();
    const signedOut = await page(service.adapterFor("pbw_" + "Q".repeat(43)), boardPath(boardId, "/online"));
    assert.equal(signedOut.status, 401);
    assert.equal(signedOut.body.signInNeeded, PUBLIC);
    const outsider = await page(service.adapterFor((await service.signIn("user_outsider")).token), boardPath(boardId, "/online"));
    assert.equal(outsider.status, 404);
  });
});

test("a key reused for a different edit is refused, and nothing changes", async () => {
  await withServiceEnv(async () => {
    const { boardId, adapter } = await ownerWithBoard();
    const key = newIdempotencyKey();
    const first = await page(adapter, boardPath(boardId, "/cards"), { method: "POST", body: { title: "First", baseRevision: 1 }, key });
    assert.equal(first.status, 200);
    const again = await page(adapter, boardPath(boardId, "/cards"), { method: "POST", body: { title: "First", baseRevision: 1 }, key });
    assert.equal(again.status, 200, "the same edit again is the original result");
    assert.equal(again.body.onlineReplay?.replayed, true);
    const different = await page(adapter, boardPath(boardId, "/cards"), { method: "POST", body: { title: "Something else", baseRevision: 2 }, key });
    assert.equal(different.status, 422);
    assert.match(different.body.error, /already used for a different request/);
    const state = await page(adapter, boardPath(boardId, "/state"));
    assert.equal(state.body.roadmap.revision, 2);
    assert.deepEqual(state.body.roadmap.roadmapItems.map((item: Json) => item.title), ["First"]);
  });
});

test("Sign out other devices repeats the batched revoke until it's done, and says so if it isn't", async () => {
  await withServiceEnv(async () => {
    const { service, owner, adapter } = await ownerWithBoard();
    const now = new Date().toISOString();
    for (let i = 0; i < 450; i += 1) {
      await service.ctx.db.insert("connections", { userId: "user_owner", kind: "machine", name: `Mac ${i}`, clientName: "Planban", tokenHash: `hash-${i}`, boards: "all", level: "complete", canAdminister: true, createdAt: now, lastUsedAt: now });
    }
    const other = await service.signIn("user_owner");
    const done = await page(adapter, "/api/online/connections/revoke-others", { method: "POST", body: {} });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body, { revoked: 451, complete: true });
    const live = service.rows.filter((row) => row._table === "connections" && row.userId === "user_owner" && !row.revokedAt);
    assert.deepEqual(live.map((row) => row._id), [owner.connectionId], "only this browser is left");
    assert.equal((await page(service.adapterFor(other.token), "/api/boards")).status, 401, "the other browser is signed out");

    // A batch that fails part-way is reported as unfinished, not done.
    for (let i = 0; i < 250; i += 1) {
      await service.ctx.db.insert("connections", { userId: "user_owner", kind: "machine", name: `Mac b${i}`, clientName: "Planban", tokenHash: `hash-b${i}`, boards: "all", level: "complete", canAdminister: true, createdAt: now, lastUsedAt: now });
    }
    let batches = 0;
    const real = service.browserSend(owner.token);
    const flaky = service.adapterFor(owner.token, {
      send: async (path, init) => {
        if (path.endsWith("/revoke-others") && ++batches === 2) return new Response(JSON.stringify({ error: { code: "internal", message: "The Online Board service failed. Try again." } }), { status: 500 });
        return real(path, init);
      },
    });
    const partial = await page(flaky, "/api/online/connections/revoke-others", { method: "POST", body: {} });
    assert.deepEqual(partial.body, { revoked: 200, complete: false });
  });
});

test("signed out, refused and computer-only routes come back in the page's error shape", async () => {
  await withServiceEnv(async () => {
    const { service, boardId, adapter, log } = await ownerWithBoard();
    const stranger = service.adapterFor("pbw_" + "Z".repeat(43));
    const signedOut = await page(stranger, boardPath(boardId, "/state"));
    assert.equal(signedOut.status, 401);
    assert.equal(signedOut.body.signInNeeded, PUBLIC);
    assert.equal(signedOut.body.signedOut, "missing");

    const outsider = service.adapterFor((await service.signIn("user_outsider")).token);
    const hidden = await page(outsider, boardPath(boardId, "/state"));
    assert.equal(hidden.status, 404, "someone not on the board can't tell it exists");

    log.length = 0;
    for (const [path, method] of [
      ["/api/update-status", "GET"], ["/api/demo", "POST"], ["/api/open-codex-thread", "POST"], [boardPath(boardId, "/online/take-local"), "POST"],
      [boardPath(boardId, "/online/conversion"), "GET"], ["/api/online/sign-in", "POST"], [cardPath(boardId, "c1", "/codex-thread/sync"), "POST"],
      ["/api/online/connections/c1/restore", "POST"], [boardPath(boardId, "/exports/flat-v1"), "POST"],
    ] as const) {
      const refused = await page(adapter, path, { method, body: method === "POST" ? {} : undefined });
      assert.equal(refused.status, 404, path);
      assert.equal(refused.body.error, WEB_ONLY_MESSAGE);
    }
    assert.equal(log.length, 0, "computer-only routes never reach the service");
    for (const path of [`/api/boards/${boardId}/cards/%2E%2E/docs/spec`, `/api/boards/${boardId}/cards/a%2Fb/docs/spec`, "/api/v1/boards", "https://elsewhere.example/api/boards"]) {
      const unsafe = await page(adapter, path);
      assert.ok(unsafe.status === 404 || unsafe.status === 422, `${path}: ${unsafe.status}`);
    }
    assert.equal(log.length, 0, "nor do unsafe or foreign addresses");
  });
});

test("the page is hosted everywhere but the local server's loopback address, and hides computer-only parts there", async () => {
  const { capabilitiesFor, isHostedLocation } = await import("../src/web/capabilities");
  for (const hostname of ["127.0.0.1", "localhost", "LOCALHOST", "[::1]"]) assert.equal(isHostedLocation({ hostname }), false, hostname);
  for (const hostname of ["app.planban.ai", "staging.planban.example", "192.168.1.10"]) assert.equal(isHostedLocation({ hostname }), true, hostname);
  assert.equal(isHostedLocation({ hostname: "127.0.0.1" }, "1"), true, "a development build can try hosted mode");
  assert.equal(isHostedLocation({ hostname: "app.planban.ai" }, "0"), false);
  const web = capabilitiesFor(true);
  assert.equal(web.hosted, true);
  for (const [name, value] of Object.entries(web)) if (name !== "hosted") assert.equal(value, false, name);
  for (const [name, value] of Object.entries(capabilitiesFor(false))) assert.equal(value, name !== "hosted", name);
});

test("New board on the web creates an empty online board owned by the person, within the daily limit", async () => {
  await withServiceEnv(async () => {
    const { DAILY_NEW_BOARDS } = await import("../online/service/convex/model/limits");
    const service = memoryService();
    const person = await service.signIn("user_new", "Nia New");
    const adapter = service.adapterFor(person.token);
    const created = await page(adapter, "/api/boards", { method: "POST", body: { title: "Deadleg launch" } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.deepEqual(created.body, { board: { repoId: "deadleg-launch", title: "Deadleg launch" } });
    const state = await page(adapter, boardPath("deadleg-launch", "/state"));
    assert.equal(state.body.hosted.role, "owner");
    assert.equal(state.body.roadmap.roadmapItems.length, 0);
    assert.equal((await page(adapter, "/api/boards", { method: "POST", body: { title: "   " } })).status, 422, "a board needs a name");
    for (let i = 1; i < DAILY_NEW_BOARDS; i += 1) assert.equal((await page(adapter, "/api/boards", { method: "POST", body: { title: `Board ${i}` } })).status, 200);
    const limited = await page(adapter, "/api/boards", { method: "POST", body: { title: "One too many" } });
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /today's limit/);
  });
});

test("a read that stalls is given up after its time limit and tried once more, never left pending", async () => {
  await withServiceEnv(async () => {
    const { service, owner, boardId } = await ownerWithBoard();
    const real = service.browserSend(owner.token);
    let stalls = 1;
    let attempts = 0;
    const { createHostedAdapter } = await import("../src/web/hostedAdapter");
    const adapter = createHostedAdapter({
      origin: PUBLIC, retryDelayMs: 0, attemptTimeoutMs: 50,
      send: async (path, init) => {
        attempts += 1;
        if (stalls > 0) {
          stalls -= 1;
          // Never answers, until the attempt's own time limit gives up on it.
          return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
        }
        return real(path, init);
      },
    });
    const state = await page(adapter, boardPath(boardId, "/state"));
    assert.equal(state.status, 200);
    assert.equal(attempts, 2);
    stalls = 2;
    attempts = 0;
    await assert.rejects(adapter.fetch(boardPath(boardId, "/state")), "two stalls in a row: the page hears it failed");
    assert.equal(attempts, 2);
  });
});

test("goals on the web: the page reads them and the owner changes them; a viewer only reads", async () => {
  await withServiceEnv(async () => {
    const { service, owner, boardId, adapter } = await ownerWithBoard();
    const empty = await page(adapter, boardPath(boardId, "/goals"));
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.goals, []);
    const added = await page(adapter, boardPath(boardId, "/goals"), { method: "POST", body: { edit: { kind: "add", statement: "Ship the first 300 vests" }, baseRevision: empty.body.revision } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.deepEqual(added.body.goals.map((goal: Json) => goal.statement), ["Ship the first 300 vests"]);
    // A page that read an older revision is still fine for a different part of the goals.
    const context = await page(adapter, boardPath(boardId, "/goals"), { method: "POST", body: { edit: { kind: "context", context: "Part-time until June." }, baseRevision: empty.body.revision } });
    assert.equal(context.status, 200, JSON.stringify(context.body));
    assert.equal((await page(adapter, boardPath(boardId, "/state"))).body.roadmap.revision, context.body.revision);
    // A suggestion from an agent, decided on the page.
    const suggested = await service.browserSend(owner.token)(`/api/v1/boards/${boardId}/ops/suggestGoalChange`, { method: "POST", headers: { "X-Planban-Client": "web", "Content-Type": "application/json" }, body: JSON.stringify({ change: { kind: "retire", goal: "1" }, reason: "Done.", actor: "agent" }) });
    assert.equal(suggested.status, 200, await suggested.clone().text());
    const waiting = (await page(adapter, boardPath(boardId, "/goals"))).body.suggestions;
    assert.equal(waiting.length, 1);
    const dismissed = await page(adapter, boardPath(boardId, `/goals/suggestions/${waiting[0].id}`), { method: "POST", body: { decision: "dismiss", baseRevision: context.body.revision } });
    assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
    assert.equal(dismissed.body.recentlyDismissed.length, 1);
    const viewer = await service.signIn("user_viewer", "Vera Viewer");
    await addMember(service, owner.token, boardId, "user_viewer", "viewer");
    const viewerPage = service.adapterFor(viewer.token, {});
    assert.equal((await page(viewerPage, boardPath(boardId, "/goals"))).body.goals.length, 1);
    const refused = await page(viewerPage, boardPath(boardId, "/goals"), { method: "POST", body: { edit: { kind: "add", statement: "Mine" } } });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
  });
});
