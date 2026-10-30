// Invitations on the web (Planban 2.0 plan, phase 1): previews with the
// inviter, each invitation state, waiting invitations for verified emails,
// joining by id, and "already on this board".
import assert from "node:assert/strict";
import { test } from "node:test";
import { accept, acceptById, previewState, waitingFor } from "../online/service/convex/invites";

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
const DAY = 24 * 60 * 60 * 1000;

async function fixture() {
  const { ctx, rows } = store();
  const now = new Date().toISOString();
  await ctx.db.insert("boards", { boardId: "northfold", title: "Northfold", ownerId: "user_alice", authority: "online", revision: 1, generation: 1, historyVersion: 0, createdAt: now, updatedAt: now });
  await ctx.db.insert("members", { boardId: "northfold", userId: "user_alice", role: "owner" });
  await ctx.db.insert("people", { userId: "user_alice", name: "Alice", updatedAt: now });
  const bob = await ctx.db.insert("connections", { userId: "user_bob", kind: "web", name: "Web browser", clientName: "Planban on the web", boards: "all", level: "complete", canAdminister: true, createdAt: now, lastUsedAt: now });
  const invite = (fields: Record<string, unknown>) => ctx.db.insert("invites", {
    boardId: "northfold", tokenHash: `hash-${Math.random()}`, role: "editor", createdBy: "user_alice", createdAt: now,
    expiresAt: new Date(Date.now() + 7 * DAY).toISOString(), joinedBy: [], ...fields,
  });
  return { ctx, rows, bob, invite };
}

test("the web preview names the board, role and inviter for a valid invitation, and only the state otherwise", async () => {
  const { ctx, invite } = await fixture();
  await invite({ tokenHash: "valid" });
  await invite({ tokenHash: "expired", expiresAt: new Date(Date.now() - 1).toISOString() });
  await invite({ tokenHash: "cancelled", revokedAt: new Date().toISOString() });
  await invite({ tokenHash: "used", email: "bob@example.com", joinedBy: ["user_bob"], revokedAt: new Date().toISOString() });
  assert.deepEqual(await run(previewState, ctx, { tokenHash: "valid" }), {
    state: "valid", boardTitle: "Northfold", role: "editor", expiresAt: (await ctx.db.query("invites").withIndex("by_tokenHash", (q: any) => q.eq("tokenHash", "valid")).unique()).expiresAt,
    forEmail: false, inviterName: "Alice",
  });
  assert.deepEqual(await run(previewState, ctx, { tokenHash: "expired" }), { state: "expired" });
  assert.deepEqual(await run(previewState, ctx, { tokenHash: "cancelled" }), { state: "cancelled" });
  assert.deepEqual(await run(previewState, ctx, { tokenHash: "used" }), { state: "used" });
  assert.deepEqual(await run(previewState, ctx, { tokenHash: "nothing" }), { state: "unknown" });
});

test("waiting invitations list only usable email invitations for the person's verified addresses", async () => {
  const { ctx, bob, invite } = await fixture();
  await invite({ email: "bob@example.com" });
  await invite({ email: "bob@example.com", expiresAt: new Date(Date.now() - 1).toISOString() });
  await invite({ email: "someone@example.com" });
  await invite({});
  const { invitations } = await run(waitingFor, ctx, { connectionId: bob, verifiedEmails: ["Bob@Example.com"] });
  assert.equal(invitations.length, 1);
  assert.deepEqual({ ...invitations[0], id: undefined, expiresAt: undefined }, { id: undefined, boardTitle: "Northfold", role: "editor", inviterName: "Alice", expiresAt: undefined });
  assert.deepEqual((await run(waitingFor, ctx, { connectionId: bob, verifiedEmails: [] })).invitations, []);
});

test("joining by id works only for an email invitation, with the address verified at that moment", async () => {
  const { ctx, rows, bob, invite } = await fixture();
  const forBob = await invite({ email: "bob@example.com" });
  const link = await invite({});
  await assert.rejects(run(acceptById, ctx, { connectionId: bob, inviteId: link, verifiedEmails: ["bob@example.com"] }), /invitation link/);
  await assert.rejects(run(acceptById, ctx, { connectionId: bob, inviteId: forBob, verifiedEmails: ["other@example.com"] }), /This invite is for b•••@example.com/);
  await assert.rejects(run(acceptById, ctx, { connectionId: bob, inviteId: "invites-999", verifiedEmails: ["bob@example.com"] }), /expired or was cancelled/);
  const joined = await run(acceptById, ctx, { connectionId: bob, inviteId: forBob, verifiedEmails: ["bob@example.com"] });
  assert.deepEqual(joined, { boardId: "northfold", title: "Northfold", role: "editor", alreadyMember: false });
  assert.ok(rows.find((row) => row._id === forBob).revokedAt, "used once");
});

test("opening an already-used invitation as a member of that board says so instead of failing", async () => {
  const { ctx, bob, invite } = await fixture();
  await invite({ tokenHash: "email", email: "bob@example.com" });
  await run(accept, ctx, { connectionId: bob, tokenHash: "email", verifiedEmails: ["bob@example.com"] });
  const again = await run(accept, ctx, { connectionId: bob, tokenHash: "email", verifiedEmails: [] });
  assert.deepEqual(again, { boardId: "northfold", title: "Northfold", role: "editor", alreadyMember: true });
  // Someone else opening that used invitation gets the expired message.
  const now = new Date().toISOString();
  const carol = await ctx.db.insert("connections", { userId: "user_carol", kind: "web", name: "Web browser", clientName: "Planban on the web", boards: "all", level: "complete", canAdminister: true, createdAt: now, lastUsedAt: now });
  await assert.rejects(run(accept, ctx, { connectionId: carol, tokenHash: "email", verifiedEmails: ["bob@example.com"] }), /expired or was cancelled/);
});

test("old invitations for an address never hide a current one from the waiting list", async () => {
  const { ctx, bob, invite } = await fixture();
  for (let i = 0; i < 60; i++) await invite({ email: "bob@example.com", expiresAt: new Date(Date.now() - 1).toISOString() });
  await invite({ email: "bob@example.com", revokedAt: new Date().toISOString() });
  await invite({ email: "bob@example.com" });
  const { invitations } = await run(waitingFor, ctx, { connectionId: bob, verifiedEmails: ["bob@example.com"] });
  assert.equal(invitations.length, 1);
});
