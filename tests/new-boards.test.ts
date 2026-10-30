// New boards on the web, and the online board limits that apply to every way
// a board comes online (Planban 2.0 plan, phase 1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmptyRoadmap } from "../src/core/boardOperations";
import { createBoard, begin } from "../online/service/convex/transfers";
import { packJson } from "../online/service/convex/model/codec";
import { listBoards } from "../online/service/convex/boards";
import { DAILY_NEW_BOARDS, MAX_OWNED_ONLINE_BOARDS } from "../online/service/convex/model/limits";

function store() {
  const rows: any[] = [];
  let sequence = 0;
  const db: any = {
    get: async (id: string) => rows.find((row) => row._id === id) ?? null,
    insert: async (table: string, value: any) => { const id = `${table}-${++sequence}`; rows.push({ ...value, _id: id, _table: table, _creationTime: sequence }); return id; },
    patch: async (id: string, patch: any) => Object.assign(rows.find((row) => row._id === id), patch),
    replace: async (id: string, value: any) => { const row = rows.find((r) => r._id === id); for (const key of Object.keys(row)) if (!key.startsWith("_")) delete row[key]; Object.assign(row, value); },
    delete: async (id: string) => { rows.splice(rows.findIndex((row) => row._id === id), 1); },
    normalizeId: (table: string, id: string) => rows.some((row) => row._id === id && row._table === table) ? id : null,
    query: (table: string) => {
      let match = (row: any) => row._table === table;
      let descending = false;
      const query: any = {
        withIndex: (_name: string, range?: (q: any) => any) => {
          const q: any = {};
          const add = (test: (a: any, b: any) => boolean) => (field: string, value: any) => { const prior = match; match = (row) => prior(row) && test(row[field], value); return q; };
          q.eq = add((a, b) => a === b); q.lt = add((a, b) => a < b); q.lte = add((a, b) => a <= b); q.gt = add((a, b) => a > b); q.gte = add((a, b) => a >= b);
          range?.(q);
          return query;
        },
        filter: () => query,
        order: (direction: string) => { descending = direction === "desc"; return query; },
        unique: async () => rows.find(match) ?? null,
        first: async () => (descending ? [...rows].reverse() : rows).find(match) ?? null,
        collect: async () => rows.filter(match),
        take: async (count: number) => (descending ? [...rows].reverse() : rows).filter(match).slice(0, count),
        async *[Symbol.asyncIterator]() { for (const row of (descending ? [...rows].reverse() : rows).filter(match)) yield row; },
      };
      return query;
    },
  };
  const ctx: any = { db, scheduler: { runAfter: async () => {} } };
  return { ctx, rows };
}

const run = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

async function person(ctx: any, userId = "user_alice", own = true) {
  return ctx.db.insert("connections", {
    userId, kind: own ? "web" : "oauth", name: "Web browser", clientName: "Planban on the web", boards: own ? "all" : ["x"],
    level: "complete", canAdminister: own, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
  });
}

async function ownedOnline(ctx: any, userId: string, count: number, authority = "online") {
  for (let i = 0; i < count; i += 1) {
    const boardId = `owned-${authority}-${i}`;
    await ctx.db.insert("boards", { boardId, title: boardId, ownerId: userId, authority, revision: 1, generation: 1, historyVersion: 0, createdAt: "", updatedAt: "" });
    await ctx.db.insert("members", { boardId, userId, role: "owner" });
  }
}

const takeOnline = (ctx: any, connectionId: string, boardId: string, transferId = `transfer-${boardId}`) =>
  run(begin, ctx, { connectionId, transferId, payload: packJson({ roadmap: createEmptyRoadmap({ repoId: boardId, title: boardId, now: new Date().toISOString() }) }) });

test("a person creates an empty online board on the web, owned by them, with its first history entry", async () => {
  const { ctx, rows } = store();
  const connectionId = await person(ctx);
  const created = await run(createBoard, ctx, { connectionId, title: "  Deadleg   launch " });
  assert.deepEqual(created, { boardId: "deadleg-launch", title: "Deadleg launch", revision: 1 });
  const board = rows.find((row) => row._table === "boards" && row.boardId === "deadleg-launch");
  assert.equal(board.authority, "online");
  assert.equal(board.ownerId, "user_alice");
  assert.ok(rows.some((row) => row._table === "members" && row.boardId === "deadleg-launch" && row.role === "owner"));
  assert.ok(rows.some((row) => row._table === "history" && row.boardId === "deadleg-launch"));
  const listed = await run(listBoards, ctx, { connectionId });
  assert.deepEqual(listed.map((entry: any) => entry.boardId), ["deadleg-launch"]);

  // The same name again gets a free id of its own.
  const again = await run(createBoard, ctx, { connectionId, title: "Deadleg launch" });
  assert.match(again.boardId, /^deadleg-launch-[a-z0-9]{1,6}$/);
});

test("a board needs a name, and only the person's own sign-in can create one", async () => {
  const { ctx } = store();
  const connectionId = await person(ctx);
  await assert.rejects(run(createBoard, ctx, { connectionId, title: "   " }), /name/);
  await assert.rejects(run(createBoard, ctx, { connectionId, title: "x".repeat(121) }), /name/);
  const agent = await person(ctx, "user_alice", false);
  await assert.rejects(run(createBoard, ctx, { connectionId: agent, title: "Agent board" }), /owner's own connection/);
});

test(`an account brings at most ${DAILY_NEW_BOARDS} boards online a day, on the web and through Take Online together`, async () => {
  const { ctx, rows } = store();
  const connectionId = await person(ctx);
  for (let i = 0; i < DAILY_NEW_BOARDS - 2; i += 1) await run(createBoard, ctx, { connectionId, title: `Web ${i}` });
  await takeOnline(ctx, connectionId, "from-computer-a");
  await takeOnline(ctx, connectionId, "from-computer-b");
  const before = rows.length;
  await assert.rejects(run(createBoard, ctx, { connectionId, title: "One too many" }), /today's limit/);
  await assert.rejects(takeOnline(ctx, connectionId, "from-computer-c"), /today's limit/);
  assert.equal(rows.length, before, "refused before anything was written");
  // A resumed upload of a board already counted isn't charged again.
  const resumed = await takeOnline(ctx, connectionId, "from-computer-a");
  assert.equal(resumed.boardId, "from-computer-a");
});

test(`an account owns at most ${MAX_OWNED_ONLINE_BOARDS} online boards, however they come online`, async () => {
  const { ctx, rows } = store();
  const connectionId = await person(ctx);
  await ownedOnline(ctx, "user_alice", MAX_OWNED_ONLINE_BOARDS - 1);
  await ownedOnline(ctx, "user_alice", 3, "returned-local");
  // Boards taken back to a computer don't count, and others' boards don't either.
  await ownedOnline(ctx, "user_bob", 5);
  await run(createBoard, ctx, { connectionId, title: "The twentieth" });
  const before = rows.length;
  await assert.rejects(run(createBoard, ctx, { connectionId, title: "Twenty-one" }), /already owns 20 online boards/);
  await assert.rejects(takeOnline(ctx, connectionId, "brand-new"), /already owns 20 online boards/);
  // A board taken local coming back online counts like a new one.
  await assert.rejects(takeOnline(ctx, connectionId, "owned-returned-local-0"), /already owns 20 online boards/);
  assert.equal(rows.length, before, "refused before anything was written");
});

test("a board being taken online counts towards the owned limit while it uploads", async () => {
  const { ctx } = store();
  const connectionId = await person(ctx);
  await ownedOnline(ctx, "user_alice", MAX_OWNED_ONLINE_BOARDS - 1);
  await takeOnline(ctx, connectionId, "uploading");
  await assert.rejects(run(createBoard, ctx, { connectionId, title: "While it uploads" }), /already owns 20 online boards/);
});

test("the board list gives the dashboard people, cards per column, and \"need you\" to the owner only", async () => {
  const { packJson } = await import("../online/service/convex/model/codec");
  const { ctx, rows } = store();
  const alice = await person(ctx);
  const { boardId } = await run(createBoard, ctx, { connectionId: alice, title: "Shared" });
  const item = (id: string, status: string, nextAction: string | null, isGroup = false) => ({ id, title: id, status, priority: null, summary: null, nextAction, tags: [], icon: null, blockedBy: null, specDoc: null, planDoc: null, completedAt: null, updatedAt: null, isGroup, parentId: null, boardRank: null, groupRank: null });
  const state = rows.find((row) => row._table === "boardState" && row.boardId === boardId);
  const roadmap = createEmptyRoadmap({ repoId: boardId, title: "Shared", now: new Date().toISOString() });
  roadmap.roadmapItems = [
    item("a", "in-progress", "Owner: pick a supplier"), item("b", "in-progress", "Agent: build it"),
    item("c", "up-next", "  Owner: approve"), item("d", "complete", "Owner: old"), item("g", "pending", "Owner: group", true),
  ] as any;
  state.roadmap = packJson(roadmap);
  await ctx.db.insert("people", { userId: "user_alice", name: "Alice", updatedAt: "" });
  await ctx.db.insert("members", { boardId, userId: "user_bob", role: "editor" });
  const bob = await person(ctx, "user_bob");

  const [own] = await run(listBoards, ctx, { connectionId: alice });
  assert.equal(own.people, 2);
  assert.deepEqual(own.cardCounts, { "in-progress": 2, "up-next": 1, complete: 1 });
  assert.equal(own.needYou, 2, "open cards whose next action starts with Owner:, groups and completed cards left out");
  assert.equal(own.ownerName, undefined);
  assert.ok(own.lastChangedAt);

  const [shared] = await run(listBoards, ctx, { connectionId: bob });
  assert.equal(shared.ownerName, "Alice");
  assert.equal(shared.needYou, undefined, "shared boards show no \"need you\"");
  assert.equal(shared.role, "editor");
});

test("boards coming back online hold their place from the start of their upload, so two can't overfill the limit", async () => {
  const { ctx } = store();
  const connectionId = await person(ctx);
  await ownedOnline(ctx, "user_alice", MAX_OWNED_ONLINE_BOARDS - 1);
  await ownedOnline(ctx, "user_alice", 2, "returned-local");
  await takeOnline(ctx, connectionId, "owned-returned-local-0");
  await assert.rejects(takeOnline(ctx, connectionId, "owned-returned-local-1"), /already owns 20 online boards/);
  await assert.rejects(run(createBoard, ctx, { connectionId, title: "Mixed" }), /already owns 20 online boards/);
  // Retrying the same upload isn't charged again.
  assert.equal((await takeOnline(ctx, connectionId, "owned-returned-local-0")).boardId, "owned-returned-local-0");
});
