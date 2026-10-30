// One-tap approval by link (Planban 2.0, owner decision 16): an agent asks for
// a code and stores nothing; a signed-in person allows or denies from any
// device; the agent collects its sign-in. Includes a computer-only approval.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import * as oauth from "../online/service/convex/oauth";
import { deviceAuthorizationResponse, deviceDecision, devicePreview } from "../online/service/convex/model/deviceFlow";
import { tokenResponse } from "../online/service/convex/model/oauthHttp";
import { resolveToken } from "../online/service/convex/connections";

const origin = "https://planban.example";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function configured(run: () => Promise<void>) {
  const values = { PLANBAN_PUBLIC_URL: origin, PLANBAN_SIGNIN_NOTE_KEY: "synthetic-sign-in-note-key-for-tests-only" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try { Object.assign(process.env, values); await run(); }
  finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

function service() {
  const rows: any[] = [];
  let sequence = 0;
  const db: any = {
    get: async (id: string) => rows.find((row) => row._id === id) ?? null,
    insert: async (table: string, value: any) => { const id = `${table}-${++sequence}`; rows.push({ ...value, _id: id, _table: table }); return id; },
    patch: async (id: string, patch: any) => Object.assign(rows.find((row) => row._id === id), patch),
    delete: async (id: string) => { rows.splice(rows.findIndex((row) => row._id === id), 1); },
    normalizeId: (_table: string, id: string) => id,
    query: (table: string) => {
      let match = (row: any) => row._table === table;
      const query: any = {
        withIndex: (_name: string, range?: (q: any) => any) => {
          const q: any = {};
          const add = (test: (a: any, b: any) => boolean) => (field: string, value: any) => { const prior = match; match = (row) => prior(row) && test(row[field], value); return q; };
          q.eq = add((a, b) => a === b); q.lt = add((a, b) => a < b); q.lte = add((a, b) => a <= b); q.gt = add((a, b) => a > b);
          range?.(q);
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
  const ctx: any = { db, scheduler: { runAfter: async () => {} } };
  const writes: string[] = [];
  const call = async (ref: any, args: any) => {
    const fn = (oauth as any)[getFunctionName(ref).replace(/^oauth:/, "")];
    if (!fn) throw new Error(`no fake for ${getFunctionName(ref)}`);
    return fn._handler(ctx, args);
  };
  const actionCtx: any = { runQuery: call, runMutation: async (ref: any, args: any) => { writes.push(getFunctionName(ref)); return call(ref, args); } };
  return { rows, ctx, actionCtx, writes };
}

const form = (fields: Record<string, string>) => new Request(origin + "/oauth/x", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
const askForCode = (actionCtx: any) => deviceAuthorizationResponse(actionCtx, form({ client_id: "planban-cli", scope: "planban:machine", resource: origin }));
const collect = (actionCtx: any, deviceCode: string) => tokenResponse(actionCtx, form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: "planban-cli", resource: origin }));
const noteOf = (link: string) => new URL(link).hash.replace(/^#request=/, "");

async function signedIn(ctx: any, userId = "user_alice", own = true) {
  return ctx.db.insert("connections", { userId, kind: "web", name: "Web browser", clientName: "Planban on the web", boards: "all", level: "complete", canAdminister: own, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() });
}

test("a computer-only approval: the agent asks, the person allows in their desktop browser, the agent collects its sign-in", async () => configured(async () => {
  const { ctx, actionCtx, writes } = service();
  const asked = await (await askForCode(actionCtx)).json();
  assert.match(asked.device_code, /^pbv_[A-Za-z0-9_-]{43}$/);
  assert.match(asked.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(asked.verification_uri, `${origin}/approve`);
  assert.ok(asked.verification_uri_complete.startsWith(`${origin}/approve#request=pbn_`), "the note travels after #, so it never reaches a server log");
  assert.equal(asked.interval, 5);

  // Waiting: the agent polls, and nothing is written.
  assert.equal((await (await collect(actionCtx, asked.device_code)).json()).error, "authorization_pending");
  assert.deepEqual(writes.filter((name) => name !== "oauth:redeemDevice"), []);

  // The person's own desktop browser session opens the link and compares the code.
  const browser = await signedIn(ctx);
  const note = noteOf(asked.verification_uri_complete);
  const preview = await devicePreview(actionCtx, note);
  assert.equal(preview.state, "waiting");
  assert.equal((preview as any).userCode, asked.user_code);
  assert.equal((await deviceDecision(actionCtx, browser, note, true)).state, "allowed");
  assert.equal((await devicePreview(actionCtx, note)).state, "ended", "answered once");

  const collected = await (await collect(actionCtx, asked.device_code)).json();
  assert.match(collected.access_token, /^pbm_/);
  assert.equal(collected.user_id, "user_alice");
  assert.ok(await resolveToken._handler(ctx, { tokenHash: hash(collected.access_token) } as any), "the computer is signed in");
  assert.equal((await (await collect(actionCtx, asked.device_code)).json()).error, "expired_token", "collected once");
}));

test("deny ends the request, a second answer is refused, and only the person's own sign-in may answer", async () => configured(async () => {
  const { ctx, actionCtx } = service();
  const asked = await (await askForCode(actionCtx)).json();
  const note = noteOf(asked.verification_uri_complete);
  const agent = await signedIn(ctx, "user_alice", false);
  await assert.rejects(deviceDecision(actionCtx, agent, note, true), /your own sign-in/);
  const browser = await signedIn(ctx);
  assert.equal((await deviceDecision(actionCtx, browser, note, false)).state, "denied");
  await assert.rejects(deviceDecision(actionCtx, browser, note, true), /already answered/);
  assert.equal((await (await collect(actionCtx, asked.device_code)).json()).error, "access_denied");
}));

test("an altered or foreign approval link shows as ended and can't be answered", async () => configured(async () => {
  const { ctx, actionCtx } = service();
  const asked = await (await askForCode(actionCtx)).json();
  const note = noteOf(asked.verification_uri_complete);
  const altered = note.replace(/\.([A-Za-z0-9_-])/, (_m, c) => "." + (c === "A" ? "B" : "A"));
  assert.equal((await devicePreview(actionCtx, altered)).state, "ended");
  assert.equal((await deviceDecision(actionCtx, await signedIn(ctx), altered, true)).state, "ended");
}));

test("approving counts against the person's own hourly limit", async () => configured(async () => {
  const { ctx, actionCtx } = service();
  const browser = await signedIn(ctx);
  for (let i = 0; i < oauth.APPROVALS_PER_HOUR; i++) {
    const asked = await (await askForCode(actionCtx)).json();
    await deviceDecision(actionCtx, browser, noteOf(asked.verification_uri_complete), true);
  }
  const asked = await (await askForCode(actionCtx)).json();
  await assert.rejects(deviceDecision(actionCtx, browser, noteOf(asked.verification_uri_complete), true), /approved 20 sign-ins/);
}));
