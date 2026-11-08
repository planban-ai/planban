import assert from "node:assert/strict";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { USAGE_POLICY, USAGE_CLOUD, USAGE_SITE, HOUR, LEASE, RETRY_WINDOW, collectionConfigured, usageEnabled, mailEnabled, parseUsage, utcMonth, emptyMonitor, observeUsage, finishUsage, canSend, monitorStale, estimateCost, projectUsage, OVERAGE_PRICES, REGION_UPLIFT, PROJECTION_MIN_DAYS, type Reading } from "../online/service/convex/model/providerUsage";
import { boundedJson, runUsagePoll, status as usageStatus } from "../online/service/convex/providerUsage";

const now = Date.UTC(2026, 9, 12, 12);
const env = () => ({ PLANBAN_USAGE_ENABLED: "1", PLANBAN_USAGE_POLICY: USAGE_POLICY, CONVEX_CLOUD_URL: USAGE_CLOUD, CONVEX_SITE_URL: USAGE_SITE, PLANBAN_USAGE_READ_KEY: "synthetic-usage-only", PLANBAN_USAGE_KEY_EXPIRES_AT: String(now + 30 * 24 * HOUR), PLANBAN_USAGE_EMAIL_ENABLED: "1", PLANBAN_USAGE_EMAIL_KEY: "synthetic-alert-only" });
const body = () => ({ seedStatus: "complete", metrics: {
  functionCalls: { unit: "calls", usage: { current_month: 700000 } },
  actionComputeConvexGbHours: { unit: "GB-hours", usage: { current_month: 5 } },
  actionComputeNodeJsGbHours: { unit: "GB-hours", usage: { current_month: 1 } },
  databaseIoGb: { unit: "GB", usage: { current_month: 25 } },
  dataEgressGb: { unit: "GB", usage: { current_month: .1 } },
  actionComputeCpuGbHours: { unit: "GB-hours", usage: { current_month: 500 } },
} });
// Database I/O drives the cost in these readings, as it does in production.
// At EU prices each GB beyond the first costs $0.286, so 25 GB is about $6.86
// so far, and on 12 October the month-end projection is about $20 (function calls add $1).
const reading = (io = 25, at = now): Reading => ({ month: utcMonth(at), at, values: { calls: 500000, actions: 6, io, egress: .1 } });
const spent = (dollars: 5 | 15) => ({ kind: "spent", dollars });
const projected = { kind: "projected", dollars: 15 };

test("estimated overage charges each metric beyond its included amount at EU Starter prices", () => {
  assert.equal(REGION_UPLIFT, 1.3);
  assert.deepEqual(OVERAGE_PRICES, { calls: 2.2 / 1e6, actions: .33, io: .22, egress: .132 });
  assert.equal(estimateCost({ calls: 1e6, actions: 20, io: 1, egress: 1 }).total, 0, "the included amounts cost nothing");
  const cost = estimateCost({ calls: 2e6, actions: 30, io: 11, egress: 11 });
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
  close(cost.metrics.calls, 2.86); close(cost.metrics.actions, 4.29); close(cost.metrics.io, 2.86); close(cost.metrics.egress, 1.716);
  close(cost.total, 2.86 + 4.29 + 2.86 + 1.716);
  close(estimateCost({ calls: 0, actions: 0, io: 3, egress: 0 }).total, .572);
});

test("the month-end projection follows this month's daily rate and waits for a few days of readings", () => {
  assert.equal(PROJECTION_MIN_DAYS, 3);
  assert.equal(projectUsage(reading(10, Date.UTC(2026, 9, 3, 12))), null, "two and a half days in is too early");
  const mid = projectUsage(reading(10, Date.UTC(2026, 10, 16)))!;
  assert.equal(mid.io, 20, "halfway through a 30-day month doubles usage");
  assert.equal(mid.calls, 1000000);
  const end = projectUsage(reading(10, Date.UTC(2026, 11, 1) - 1))!;
  assert.ok(Math.abs(end.io - 10) < 1e-6, "the last moment of the month projects what was used");
});

test("a month spent a few times over the free allowance but under $5 sends nothing", () => {
  const s = emptyMonitor();
  for (const [io, at] of [[3, now], [8, now + HOUR], [2, Date.UTC(2026, 9, 28)], [18, Date.UTC(2026, 9, 31, 12)]] as const) {
    assert.equal(observeUsage(s, reading(io, at), "complete", at, true), null, `${io} GB must not warn`);
  }
  assert.equal(s.batches.length, 0);
});

test("warnings go once a month at $5 and $15 so far, and early when the month-end projection passes $15", () => {
  const s = emptyMonitor(), day8 = Date.UTC(2026, 9, 8, 12);
  const early = observeUsage(s, reading(18, day8), "complete", day8, true)!;
  assert.deepEqual(early.events, [projected], "$4.86 so far, about $21 by month end");
  finishUsage(s, early.id, early.fence, "sent", day8);
  assert.equal(observeUsage(s, reading(18, day8 + HOUR), "complete", day8 + HOUR, true), null);
  const five = observeUsage(s, reading(19, day8 + 2 * HOUR), "complete", day8 + 2 * HOUR, true)!;
  assert.deepEqual(five.events, [spent(5)]);
  finishUsage(s, five.id, five.fence, "sent", day8 + 2 * HOUR);
  const fifteen = observeUsage(s, reading(60, day8 + 3 * HOUR), "complete", day8 + 3 * HOUR, true)!;
  assert.deepEqual(fifteen.events, [spent(15)]);
  finishUsage(s, fifteen.id, fifteen.fence, "sent", day8 + 3 * HOUR);
  assert.equal(observeUsage(s, reading(90, day8 + 4 * HOUR), "complete", day8 + 4 * HOUR, true), null);
  const jump = emptyMonitor();
  assert.deepEqual(observeUsage(jump, reading(60), "complete", now, true)!.events, [spent(15)], "one email when $15 is already passed");
  const both = observeUsage(emptyMonitor(), reading(25), "complete", now, true)!;
  assert.deepEqual(both.events, [spent(5), projected]);
});

test("complete provider readings validate constituent units, known exclusions and calendar boundaries without coercion", () => {
  assert.equal(parseUsage(body(), now, now + 5).values.actions, 6, "CPU compute is excluded");
  for (const seedStatus of [undefined, "pending", "partial", "failed"]) assert.throws(() => parseUsage({ ...body(), seedStatus }, now, now));
  for (const value of [undefined, "700000", -1, Infinity, NaN, .5, Number.MAX_SAFE_INTEGER + 1]) {
    const b: any = body(); b.metrics.functionCalls.usage.current_month = value; assert.throws(() => parseUsage(b, now, now));
  }
  for (const name of ["functionCalls", "actionComputeConvexGbHours", "actionComputeNodeJsGbHours", "databaseIoGb", "dataEgressGb"]) {
    const b: any = body(); delete b.metrics[name]; assert.throws(() => parseUsage(b, now, now));
    const c: any = body(); c.metrics[name].unit = "bytes"; assert.throws(() => parseUsage(c, now, now));
  }
  const b: any = body(); b.metrics.newMetric = { unit: "calls", usage: { current_month: 0 } }; assert.throws(() => parseUsage(b, now, now), /unknown_metric/);
  const c = body(); c.metrics.actionComputeConvexGbHours.usage.current_month = Number.MAX_VALUE; c.metrics.actionComputeNodeJsGbHours.usage.current_month = Number.MAX_VALUE;
  assert.throws(() => parseUsage(c, now, now));
  assert.throws(() => parseUsage(body(), Date.UTC(2026, 9, 31, 23, 59, 59), Date.UTC(2026, 10, 1)), /month_changed/);
});

test("monitor and mail require explicit opt-in, exact executing deployment and an unexpired separate usage credential", async () => {
  assert.equal(usageEnabled({}), false); assert.equal(mailEnabled({}), false);
  assert.equal(collectionConfigured(env(), now), true);
  for (const patch of [{ CONVEX_CLOUD_URL: "http://127.0.0.1:3410" }, { CONVEX_SITE_URL: "https://unrelated.convex.site" }, { PLANBAN_USAGE_POLICY: "production" }, { PLANBAN_USAGE_ENABLED: "0" }]) {
    assert.equal(usageEnabled({ ...env(), ...patch }), false);
  }
  assert.equal(collectionConfigured({ ...env(), PLANBAN_USAGE_KEY_EXPIRES_AT: String(now) }, now), false);
  assert.equal(collectionConfigured({ ...env(), PLANBAN_USAGE_READ_KEY: "" }, now), false);
  assert.equal(mailEnabled({ ...env(), PLANBAN_USAGE_EMAIL_ENABLED: "0" }), false);
});

test("actual cron export leaves the monitor absent by default and requires a coordinated bound deployment", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.PLANBAN_USAGE_ENABLED;
    const disabled = await import("../online/service/convex/crons.ts?usage-default");
    assert.ok(!disabled.default.export().includes("Planban included usage warnings"));
    Object.assign(process.env, env());
    const enabled = await import("../online/service/convex/crons.ts?usage-bound");
    assert.ok(enabled.default.export().includes("Planban included usage warnings"));
    process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3410";
    const copied = await import("../online/service/convex/crons.ts?usage-copied");
    assert.ok(!copied.default.export().includes("Planban included usage warnings"));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved);
  }
});

test("disabled-mail observations never flush stale or old-month warnings; enabling uses fresh highest qualifying levels", () => {
  const s = emptyMonitor(); assert.equal(observeUsage(s, reading(), "complete", now, false), null);
  assert.equal(s.batches.length, 0);
  assert.equal(observeUsage(s, null, "unavailable", now + HOUR, true), null);
  assert.equal(observeUsage(s, reading(), "complete", now + HOUR, true), null, "cached snapshot cannot trigger mail");
  assert.equal(observeUsage(s, reading(1, now + HOUR), "complete", now + HOUR, true), null);
  const b = observeUsage(s, reading(60, now + 2 * HOUR), "complete", now + 2 * HOUR, true)!;
  assert.deepEqual(b.events, [spent(15)]);
  finishUsage(s, b.id, b.fence, "sent", now + 2 * HOUR);
  assert.equal(observeUsage(s, reading(25, now + 3 * HOUR), "complete", now + 3 * HOUR, true), null);
  const next = Date.UTC(2026, 10, 1);
  assert.deepEqual(observeUsage(s, reading(25, next), "complete", next, true)?.events, [spent(5)], "new UTC month re-arms");
  assert.equal(s.lastSuccess?.month, "2026-11");
});

test("lost acknowledgments retry identical immutable bytes/key under a new fence and never expand attempted membership", () => {
  const s = emptyMonitor(), first = observeUsage(s, reading(), "complete", now, true)!;
  assert.equal(observeUsage(s, reading(25, now + 1), "complete", now + 1, true), null, "serialized concurrent claim cannot duplicate");
  const later = reading(60, now + LEASE + 1);
  const retry = observeUsage(s, later, "complete", later.at, true)!;
  assert.equal(retry.id, first.id); assert.equal(retry.payload, first.payload); assert.equal(retry.hash, first.hash);
  assert.deepEqual(retry.events, first.events); assert.equal(retry.fence, 2);
  finishUsage(s, first.id, first.fence, "sent", later.at); assert.equal(s.batches[0]?.status, "sending", "old lease cannot commit");
  finishUsage(s, retry.id, retry.fence, "sent", later.at);
  const high = observeUsage(s, later, "complete", later.at, true)!;
  assert.notEqual(high.id, first.id); assert.deepEqual(high.events, [spent(15)]);
});

test("ambiguous batches are held after bounded attempts or idempotency expiry; month rollover preserves in-flight outcomes", () => {
  const s = emptyMonitor(); let b = observeUsage(s, reading(), "complete", now, true)!;
  for (let i = 1; i < 3; i++) { finishUsage(s, b.id, b.fence, "retry", now + i); b = observeUsage(s, reading(25, now + i * HOUR), "complete", now + i * HOUR, true)!; }
  finishUsage(s, b.id, b.fence, "retry", now + 2 * HOUR);
  assert.equal(s.batches[0]?.status, "held"); assert.equal(observeUsage(s, reading(25, now + 3 * HOUR), "complete", now + 3 * HOUR, true), null);
  const expired = emptyMonitor(), old = observeUsage(expired, reading(), "complete", now, true)!;
  assert.equal(observeUsage(expired, reading(25, now + RETRY_WINDOW), "complete", now + RETRY_WINDOW, true), null);
  assert.equal(expired.batches[0]?.status, "held");
  const boundary = Date.UTC(2026, 9, 31, 23, 59, 50), crossing = emptyMonitor(), inflight = observeUsage(crossing, reading(25, boundary), "complete", boundary, true)!;
  const midnight = Date.UTC(2026, 10, 1); observeUsage(crossing, reading(0, midnight), "complete", midnight, true);
  assert.equal(canSend(inflight, env(), midnight), false);
  finishUsage(crossing, inflight.id, inflight.fence, "sent", midnight); assert.equal(crossing.batches[0]?.month, "2026-10"); assert.equal(crossing.batches[0]?.status, "sent");
  assert.ok(monitorStale(s, now + 6 * HOUR)); assert.equal(old.firstAttemptAt, now);
});

test("streamed provider responses stop at the body cap and release their reader", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(16385)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedJson(new Response(stream)), /oversized_response/); assert.ok(cancelled);
});

test("actual action adapter emits no external call while disabled or copied, and incomplete readings never send", async () => {
  const saved = { env: { ...process.env }, fetch: globalThis.fetch, now: Date.now }; let gets = 0, sends = 0, observed: any;
  try {
    Object.assign(process.env, env()); Date.now = () => now;
    globalThis.fetch = async (url) => { if (String(url).includes("resend")) sends++; else gets++; return new Response(JSON.stringify({ ...body(), seedStatus: "partial" }), { status: 200 }); };
    const ctx: any = { runMutation: async (_ref: unknown, args: any) => { observed = args; return null; } };
    process.env.PLANBAN_USAGE_ENABLED = "0"; assert.equal(await runUsagePoll(ctx), "disabled"); assert.equal(gets + sends, 0);
    process.env.PLANBAN_USAGE_ENABLED = "1"; process.env.CONVEX_SITE_URL = "https://foreign.convex.site"; assert.equal(await runUsagePoll(ctx), "disabled"); assert.equal(gets + sends, 0);
    process.env.CONVEX_SITE_URL = USAGE_SITE; assert.equal(await runUsagePoll(ctx), "incomplete_reading"); assert.equal(gets, 1); assert.equal(sends, 0); assert.equal(observed.reading, null);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k]; Object.assign(process.env, saved.env); globalThis.fetch = saved.fetch; Date.now = saved.now;
  }
});

test("the warning says in plain words what it costs so far, where the month is heading and what Convex does at $10 and $20", () => {
  const b = observeUsage(emptyMonitor(), reading(), "complete", now, true)!; const p = JSON.parse(b.payload);
  assert.deepEqual(p.to, ["hello@planban.ai"]); assert.equal(p.from, "Planban <alerts@planban.ai>");
  assert.equal(p.subject, "[Planban] Convex usage has passed $5 this month");
  assert.match(p.text, /^Planban's Convex usage this month has passed \$5 in estimated charges/);
  assert.match(p.text, /Estimated charges so far: \$6\.86\./);
  assert.match(p.text, /By the end of the month, at the current daily rate: about \$19\.98\./);
  assert.match(p.text, /Database I\/O: 25\.00 GB used, 1 GB included, about \$6\.86/);
  assert.ok(!p.text.includes("Function calls"), "metrics inside their allowance are left out");
  assert.match(p.text, /spending alert at \$10/); assert.match(p.text, /\$20/); assert.match(p.text, /seat fees/);
  assert.match(p.text, /12 October 2026/); assert.match(p.text, /1 November 2026/);
  assert.ok(!/included-usage/i.test(p.text + p.subject));
  const ahead = JSON.parse(observeUsage(emptyMonitor(), reading(18, Date.UTC(2026, 9, 8, 12)), "complete", Date.UTC(2026, 9, 8, 12), true)!.payload);
  assert.equal(ahead.subject, "[Planban] Convex usage is on course to pass $15 this month");
  assert.match(ahead.text, /^At this month's daily rate so far, Planban's Convex usage would cost more than \$15/);
  const day1 = Date.UTC(2026, 9, 1, 12), soon = JSON.parse(observeUsage(emptyMonitor(), reading(25, day1), "complete", day1, true)!.payload);
  assert.match(soon.text, /too early in the month to estimate the month-end total/);
  assert.ok(!p.html.includes("<script")); assert.ok(!p.text.includes("synthetic"));
  assert.equal(canSend({ ...b, payload: b.payload + "tampered" }, env(), now), false);
  assert.equal(canSend(b, { ...env(), PLANBAN_USAGE_EMAIL_ENABLED: "0" }, now), false);
});

test("action crash after mocked acceptance retries immutable provider bytes/key and commits only the owning fence", async () => {
  const saved = { env: { ...process.env }, fetch: globalThis.fetch, now: Date.now };
  let clock = now, loseAck = true; const state = emptyMonitor(); const sent: Array<{ payload: string; key: string }> = [];
  try {
    Object.assign(process.env, env()); Date.now = () => clock;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("resend")) {
        sent.push({ payload: String(init?.body), key: new Headers(init?.headers).get("Idempotency-Key")! });
        return new Response(JSON.stringify({ id: "mock-provider-accepted" }));
      }
      return new Response(JSON.stringify(body()));
    };
    const ctx: any = { runMutation: async (_ref: unknown, args: any) => {
      if ("reading" in args) return observeUsage(state, args.reading, args.status, args.now, mailEnabled(process.env));
      if (!("id" in args)) return null; // the renewal reminder's claim: not due with this key
      if (loseAck) { loseAck = false; throw new Error("simulated process loss before durable acknowledgement"); }
      finishUsage(state, args.id, args.fence, args.outcome, args.now); return null;
    } };
    await assert.rejects(runUsagePoll(ctx), /simulated process loss/); assert.equal(state.batches[0]?.status, "sending");
    clock += HOUR; assert.equal(await runUsagePoll(ctx), "sent");
    assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1], "provider can deduplicate identical retries");
    assert.equal(state.batches[0]?.status, "sent");
    clock += HOUR; await runUsagePoll(ctx); assert.equal(sent.length, 2, "no new key after durable acceptance");
    process.env.PLANBAN_USAGE_EMAIL_ENABLED = "0"; clock += HOUR; await runUsagePoll(ctx); assert.equal(sent.length, 2);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k]; Object.assign(process.env, saved.env); globalThis.fetch = saved.fetch; Date.now = saved.now;
  }
});

test("runtime mail kill switch between persisted claim and provider send prevents the external effect", async () => {
  const saved = { env: { ...process.env }, fetch: globalThis.fetch, now: Date.now }; let sends = 0;
  try {
    Object.assign(process.env, env()); Date.now = () => now;
    globalThis.fetch = async url => { if (String(url).includes("resend")) sends++; return new Response(JSON.stringify(body())); };
    const ctx: any = { runMutation: async (_ref: unknown, args: any) => {
      const b = observeUsage(emptyMonitor(), args.reading, args.status, args.now, true);
      process.env.PLANBAN_USAGE_EMAIL_ENABLED = "0"; return b;
    } };
    assert.equal(await runUsagePoll(ctx), "complete"); assert.equal(sends, 0);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k]; Object.assign(process.env, saved.env); globalThis.fetch = saved.fetch; Date.now = saved.now;
  }
});

test("retention holds ambiguous batches and refuses growth at the bound instead of erasing suppression", () => {
  const s = emptyMonitor(), b = observeUsage(s, reading(), "complete", now, true)!;
  finishUsage(s, b.id, b.fence, "held", now);
  s.batches = Array.from({ length: 104 }, (_, i) => ({ ...structuredClone(b), id: `${b.id}/${i}`, month: "2020-01", status: "held" as const }));
  assert.equal(observeUsage(s, reading(60), "complete", now, true), null);
  assert.equal(s.batches.length, 104); assert.equal(s.status, "retention_review_required");
});

test("twenty busy months keep all three warnings available while successful payload retention stays bounded", () => {
  const s = emptyMonitor();
  for (let m = 0; m < 20; m++) {
    let at = Date.UTC(2025, m, 8, 12);
    for (const [io, expected] of [[18, projected], [19, spent(5)], [60, spent(15)]] as const) {
      const r = reading(io, at); const b = observeUsage(s, r, "complete", at, true);
      assert.ok(b, `month ${m + 1}, ${io} GB must not be suppressed`);
      assert.deepEqual(b.events, [expected]); finishUsage(s, b.id, b.fence, "sent", at++);
    }
    assert.ok(s.batches.length <= 6, "only two months of successful payloads remain");
    assert.ok(Object.keys(s.covered).length <= 39, "compact suppression spans thirteen months");
  }
});

test("a warning left over from the old allowance thresholds is never resent", () => {
  const s = emptyMonitor(), b = observeUsage(s, reading(), "complete", now, true)!;
  finishUsage(s, b.id, b.fence, "retry", now);
  s.batches[0]!.events = [{ metric: "io", level: 90 } as any];
  assert.equal(observeUsage(s, reading(90, now + HOUR), "complete", now + HOUR, true)?.id === b.id, false);
  assert.equal(s.batches[0]?.status, "held");
});

test("mocked mail adapter holds permanent failures and retries transient or ambiguous receipts with original batch state", async () => {
  const saved = { env: { ...process.env }, fetch: globalThis.fetch, now: Date.now };
  try {
    Object.assign(process.env, env()); Date.now = () => now;
    for (const [httpStatus, reply, expected] of [[400, "invalid", "held"], [401, "unauthorized", "held"], [429, "limited", "retry"], [503, "unavailable", "retry"], [200, "{}", "retry"], [200, "not-json", "retry"]] as const) {
      const state = emptyMonitor();
      globalThis.fetch = async url => String(url).includes("resend") ? new Response(reply, { status: httpStatus }) : new Response(JSON.stringify(body()));
      const ctx: any = { runMutation: async (_ref: unknown, args: any) => {
        if ("reading" in args) return observeUsage(state, args.reading, args.status, args.now, true);
        finishUsage(state, args.id, args.fence, args.outcome, args.now); return null;
      } };
      assert.equal(await runUsagePoll(ctx), expected); assert.equal(state.batches[0]?.status, expected);
      assert.equal(state.batches[0]?.attempts, 1);
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k]; Object.assign(process.env, saved.env); globalThis.fetch = saved.fetch; Date.now = saved.now;
  }
});

test("enabled collection records redacted expiry/auth/parser/stream/timeout and UTC failures without sending or relabeling prior success", async () => {
  const saved = { env: { ...process.env }, fetch: globalThis.fetch, now: Date.now, timer: globalThis.setTimeout };
  let clock = now, network = 0; const state = emptyMonitor(); state.lastSuccess = reading(1, now - 4 * HOUR);
  const ctx: any = { runMutation: async (_ref: unknown, args: any) => observeUsage(state, args.reading, args.status, args.now, true) };
  try {
    Object.assign(process.env, env()); Date.now = () => clock;
    globalThis.fetch = async () => { network++; throw new Error("must not fetch missing credential"); };
    delete process.env.PLANBAN_USAGE_READ_KEY; assert.equal(await runUsagePoll(ctx), "credential_missing");
    process.env.PLANBAN_USAGE_READ_KEY = "synthetic"; process.env.PLANBAN_USAGE_KEY_EXPIRES_AT = String(now); assert.equal(await runUsagePoll(ctx), "credential_expired");
    process.env.PLANBAN_USAGE_KEY_EXPIRES_AT = "broken"; assert.equal(await runUsagePoll(ctx), "credential_invalid_expiry"); assert.equal(network, 0);
    process.env.PLANBAN_USAGE_KEY_EXPIRES_AT = env().PLANBAN_USAGE_KEY_EXPIRES_AT;
    const cases: Array<[() => Response, string]> = [
      [() => new Response("PRIVATE PROVIDER DIAGNOSTIC", { status: 403 }), "usage_unauthorized"],
      [() => new Response("not-json"), "invalid_json"],
      [() => new Response(JSON.stringify({ ...body(), seedStatus: "failed" })), "incomplete_reading"],
      [() => { const b: any = body(); b.metrics.unknown = {}; return new Response(JSON.stringify(b)); }, "unknown_metric"],
      [() => new Response(new ReadableStream({ start(c) { c.error(new Error("PRIVATE BODY ERROR")); } })), "body_failure"],
    ];
    for (const [response, expected] of cases) {
      globalThis.fetch = async () => response(); assert.equal(await runUsagePoll(ctx), expected); assert.equal(state.status, expected);
      assert.equal(state.lastSuccess.at, now - 4 * HOUR); assert.equal(state.batches.length, 0);
    }
    globalThis.setTimeout = ((fn: () => void) => { fn(); return 0; }) as any;
    globalThis.fetch = async (_url, init) => { assert.ok(init?.signal?.aborted); throw new DOMException("PRIVATE TIMEOUT", "AbortError"); };
    assert.equal(await runUsagePoll(ctx), "timeout"); globalThis.setTimeout = saved.timer;
    clock = Date.UTC(2026, 9, 31, 23, 59, 59);
    globalThis.fetch = async () => { clock = Date.UTC(2026, 10, 1); return new Response(JSON.stringify(body())); };
    assert.equal(await runUsagePoll(ctx), "month_changed"); assert.equal(state.lastSuccess.month, "2026-10");
    assert.ok(!JSON.stringify(state).includes("PRIVATE"));
    const queryCtx: any = { db: { query: () => ({ withIndex: () => ({ unique: async () => ({ state }) }) }) } };
    const result = await (usageStatus as any)._handler(queryCtx, {});
    assert.equal(result.reason, "month_changed"); assert.equal(result.stale, true); assert.equal(result.observedAt, now - 4 * HOUR);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k]; Object.assign(process.env, saved.env); globalThis.fetch = saved.fetch; Date.now = saved.now; globalThis.setTimeout = saved.timer;
  }
});

test("the usage key's renewal reminder is due once, in its last week", async () => {
  const { expiryNoticeDue, expiryNoticePayload, EXPIRY_NOTICE_MS, emptyMonitor: empty } = await import("../online/service/convex/model/providerUsage");
  const start = Date.parse("2026-11-01T00:00:00Z");
  const expiry = start + EXPIRY_NOTICE_MS + HOUR;
  const env = { PLANBAN_USAGE_KEY_EXPIRES_AT: String(expiry) };
  assert.equal(expiryNoticeDue(env, empty(), start), null, "not yet in the last week");
  assert.equal(expiryNoticeDue(env, empty(), start + 2 * HOUR), expiry, "due within the last week");
  assert.equal(expiryNoticeDue(env, { ...empty(), expiryNoticeFor: expiry }, start + 2 * HOUR), null, "sent once per key");
  assert.equal(expiryNoticeDue(env, empty(), expiry + 1), null, "an expired key is reported as expired instead");
  assert.equal(expiryNoticeDue({ PLANBAN_USAGE_KEY_EXPIRES_AT: "soon" }, empty(), start), null);
  const mail = JSON.parse(expiryNoticePayload(expiry));
  assert.equal(mail.to[0], "hello@planban.ai");
  assert.match(mail.subject, /Usage monitor key expires soon/);
  assert.match(mail.text, new RegExp(new Date(expiry).toUTCString().replace(/[()+]/g, ".")));
});

test("the renewal reminder records its first attempt, retries only within the duplicate window, then stops", async () => {
  const { claimExpiryNotice, emptyMonitor: empty, RETRY_WINDOW: window } = await import("../online/service/convex/model/providerUsage");
  const state = empty();
  const expiry = Date.parse("2026-11-12T16:27:00Z");
  const first = expiry - 3 * 24 * HOUR;
  assert.equal(claimExpiryNotice(state, expiry, first), true);
  assert.deepEqual(state.expiryNoticeAttempt, { expiry, firstAt: first }, "recorded before sending");
  assert.equal(claimExpiryNotice(state, expiry, first + HOUR), true, "a retry inside the window is allowed");
  assert.equal(claimExpiryNotice(state, expiry, first + window), false, "past the window it counts as sent");
  assert.equal(state.expiryNoticeFor, expiry);
  assert.equal(claimExpiryNotice(state, expiry, first + window + HOUR), false);
  const renewed = expiry + 30 * 24 * HOUR;
  assert.equal(claimExpiryNotice(state, renewed, renewed - 2 * 24 * HOUR), true, "a renewed key gets its own reminder");
});

test("the reminder's send path: success, provider failure, and no send when not due", async () => {
  const { remindBeforeExpiry } = await import("../online/service/convex/providerUsage");
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const ctx = (claim: number | null) => ({ runMutation: async (fn: any) => { const name = getFunctionName(fn); calls.push(name); return name === "providerUsage:claimExpiryReminder" ? claim : null; } }) as any;
  try {
    let sentKey = "";
    globalThis.fetch = (async (_url: string, init: any) => { sentKey = init.headers["Idempotency-Key"]; return new Response(JSON.stringify({ id: "e1" }), { status: 200 }); }) as typeof fetch;
    assert.equal(await remindBeforeExpiry(ctx(1234)), "sent");
    assert.equal(sentKey, "planban-usage-key-expiry-1234");
    assert.deepEqual(calls, ["providerUsage:claimExpiryReminder", "providerUsage:noteExpiryNotice"]);
    calls.length = 0;
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
    assert.equal(await remindBeforeExpiry(ctx(1234)), "retry");
    assert.deepEqual(calls, ["providerUsage:claimExpiryReminder"], "a failed send isn't recorded as sent");
    calls.length = 0;
    globalThis.fetch = (async () => { throw new Error("must not send"); }) as typeof fetch;
    assert.equal(await remindBeforeExpiry(ctx(null)), "not_due");
  } finally { globalThis.fetch = realFetch; }
});
