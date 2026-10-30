import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionIsUsable, IDLE_SIGN_OUT_MS } from "../online/service/convex/model/access";
import { resolveToken, touch } from "../online/service/convex/connections";
import * as invites from "../online/service/convex/invites";

const handler = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Runs `body` with a process-local clock the test moves by hand. */
async function withClock(start: number, body: (clock: { now: number }) => Promise<void>) {
  const clock = { now: start };
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args: any[]) { super(...(args.length ? args : [clock.now]) as [any]); }
    static now() { return clock.now; }
  } as DateConstructor;
  try { await body(clock); } finally { globalThis.Date = RealDate; }
}

function store() {
  const rows: any[] = [];
  let sequence = 0;
  const db: any = {
    get: async (id: string) => rows.find((row) => row._id === id) ?? null,
    insert: async (table: string, value: any) => { const id = `${table}-${++sequence}`; rows.push({ ...value, _id: id, _table: table }); return id; },
    patch: async (id: string, patch: any) => Object.assign(rows.find((row) => row._id === id), patch),
    query: (table: string) => {
      let match = (row: any) => row._table === table;
      const query: any = {
        withIndex: (_name: string, range: (q: any) => any) => {
          const q: any = { eq: (field: string, value: unknown) => { const prior = match; match = (row) => prior(row) && row[field] === value; return q; } };
          range(q);
          return query;
        },
        order: () => query,
        unique: async () => rows.find(match) ?? null,
        first: async () => rows.find(match) ?? null,
        collect: async () => rows.filter(match),
        take: async (count: number) => rows.filter(match).slice(0, count),
      };
      return query;
    },
  };
  return { db };
}

const START = Date.parse("2030-01-01T00:00:00.000Z");

test("a machine sign-in lasts exactly ninety idle days, and use or revocation changes that", async () => {
  await withClock(START, async (clock) => {
    const ctx = store();
    const id = await ctx.db.insert("connections", { userId: "u1", kind: "machine", boards: "all", canAdminister: true, level: "complete", lastUsedAt: new Date(START).toISOString(), tokenHash: "machine-hash" });
    const machine = await ctx.db.get(id);
    clock.now = START + IDLE_SIGN_OUT_MS - 1;
    assert.equal(connectionIsUsable(machine), true);
    clock.now = START + IDLE_SIGN_OUT_MS;
    assert.equal(connectionIsUsable(machine), true);
    clock.now += 1;
    assert.equal(connectionIsUsable(machine), false);
    assert.equal(await handler(resolveToken, ctx, { tokenHash: "machine-hash" }), null);

    // Using it before the deadline restarts the ninety days.
    clock.now = START + IDLE_SIGN_OUT_MS - 1;
    await handler(touch, ctx, { connectionId: id });
    clock.now = START + IDLE_SIGN_OUT_MS + 1;
    assert.equal(connectionIsUsable(machine), true);
    machine.revokedAt = new Date(clock.now).toISOString();
    assert.equal(connectionIsUsable(machine), false);
  });
});

test("a personal key stops exactly at its expiry", async () => {
  await withClock(START, async (clock) => {
    const key = { kind: "key", lastUsedAt: new Date(START).toISOString(), expiresAt: new Date(START + 1).toISOString() } as any;
    assert.equal(connectionIsUsable(key), true);
    clock.now += 1;
    assert.equal(connectionIsUsable(key), false);
  });
});

test("an invitation lasts exactly seven days", async () => {
  await withClock(START, async (clock) => {
    const ctx = store();
    const owner = await ctx.db.insert("connections", { userId: "u1", kind: "machine", boards: "all", canAdminister: true, level: "complete", lastUsedAt: new Date(START).toISOString() });
    await ctx.db.insert("boards", { boardId: "expiry-board", title: "Expiry board", authority: "online" });
    await ctx.db.insert("members", { boardId: "expiry-board", userId: "u1", role: "owner" });
    // Someone not yet on the board; a member opening any invitation is told they're already on it.
    const guest = await ctx.db.insert("connections", { userId: "u2", kind: "machine", boards: "all", canAdminister: true, level: "complete", lastUsedAt: new Date(START).toISOString() });
    const made = await handler(invites.create, ctx, { connectionId: owner, boardId: "expiry-board", tokenHash: "invite-hash", role: "viewer" });
    const invite = await ctx.db.get(made.id);
    assert.equal(invites.INVITE_LIFETIME_MS, 7 * DAY_MS);
    assert.equal(Date.parse(invite.expiresAt) - Date.parse(invite.createdAt), 7 * DAY_MS);

    clock.now = START + invites.INVITE_LIFETIME_MS;
    assert.equal(await handler(invites.preview, ctx, { tokenHash: "invite-hash" }), null);
    assert.deepEqual((await handler(invites.list, ctx, { connectionId: owner, boardId: "expiry-board" })).invites, []);
    for (const offset of [0, 1]) {
      clock.now = START + invites.INVITE_LIFETIME_MS + offset;
      await assert.rejects(handler(invites.accept, ctx, { connectionId: guest, tokenHash: "invite-hash" }), /expired or was cancelled/);
    }

    clock.now = START + invites.INVITE_LIFETIME_MS - 1;
    assert.ok(await handler(invites.preview, ctx, { tokenHash: "invite-hash" }));
    assert.equal((await handler(invites.accept, ctx, { connectionId: guest, tokenHash: "invite-hash" })).boardId, "expiry-board");
  });
});
