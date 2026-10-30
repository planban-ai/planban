// The public address's Worker requests (Planban 2.0 plan, phase 5): read
// hourly from Cloudflare on production only, with one warning per level per
// UTC day at 70% and 90% of the Free plan's 100,000 a day.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { memoryService } from "./hosted-harness";
import * as providerUsage from "../online/service/convex/providerUsage";
import { USAGE_CLOUD, USAGE_POLICY, USAGE_SITE } from "../online/service/convex/model/providerUsage";
import { emptyWorkerUsage, noteWorkerWarning, observeWorkerUsage, parseWorkerRequests, workerUsageConfigured, workerUsageRequest, workerWarningPayload, WORKER_DAILY_INCLUDED, WORKER_SCRIPT } from "../online/service/convex/model/workerUsage";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const production = {
  PLANBAN_USAGE_ENABLED: "1", PLANBAN_USAGE_POLICY: USAGE_POLICY, CONVEX_CLOUD_URL: USAGE_CLOUD, CONVEX_SITE_URL: USAGE_SITE,
  PLANBAN_WORKER_USAGE_TOKEN: "synthetic-analytics-read", PLANBAN_WORKER_USAGE_ACCOUNT: ACCOUNT,
  PLANBAN_USAGE_EMAIL_ENABLED: "1", PLANBAN_USAGE_EMAIL_KEY: "synthetic-mail",
};
const NOON = Date.parse("2026-10-14T12:00:00Z");
const answer = (...requests: number[]) => ({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: requests.map((value) => ({ sum: { requests: value } })) }] } } });

test("only production, with an analytics key and its account, reads the Worker's requests", () => {
  assert.equal(workerUsageConfigured(production), true);
  assert.equal(workerUsageConfigured({ ...production, PLANBAN_WORKER_USAGE_TOKEN: "" }), false);
  assert.equal(workerUsageConfigured({ ...production, PLANBAN_WORKER_USAGE_ACCOUNT: "not-an-account" }), false);
  assert.equal(workerUsageConfigured({ ...production, CONVEX_CLOUD_URL: "https://staging.convex.cloud" }), false, "staging stays off");
});

test("the request asks for this Worker's requests over today's UTC day", () => {
  const body = JSON.parse(workerUsageRequest(ACCOUNT, NOON));
  assert.deepEqual(body.variables, { account: ACCOUNT, script: WORKER_SCRIPT, start: "2026-10-14T00:00:00Z", end: "2026-10-15T00:00:00Z" });
  assert.match(body.query, /workersInvocationsAdaptive/u);
  // Cloudflare's analytics schema names its scalar types in lowercase (string, not String or Time).
  const declared = /^query \(([^)]*)\)/u.exec(body.query)![1]!;
  assert.deepEqual(declared.split(",").map((part: string) => part.trim()), ["$account: string!", "$script: string!", "$start: string!", "$end: string!"]);
  assert.match(body.query, /accounts\(filter: \{ accountTag: \$account \}\)/u);
  assert.match(body.query, /filter: \{ scriptName: \$script, datetime_geq: \$start, datetime_lt: \$end \}/u);
});

test("an answer is summed, and anything unexpected is an error, never zero", () => {
  assert.equal(parseWorkerRequests(answer(40_000, 2_500)), 42_500);
  assert.equal(parseWorkerRequests(answer()), 0, "no requests yet today");
  for (const bad of [{ errors: [{ message: "x" }] }, {}, { data: { viewer: { accounts: [] } } }, answer(-1), answer(1.5), { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: {} }] }] } } }]) {
    assert.throws(() => parseWorkerRequests(bad), /worker_usage_/u, JSON.stringify(bad));
  }
});

test("warns at 70% and again at 90%, once each per UTC day", () => {
  const state = emptyWorkerUsage();
  const level = (requests: number | null, now = NOON) => observeWorkerUsage(state, requests, "complete", now)?.level ?? null;
  assert.equal(level(WORKER_DAILY_INCLUDED * 0.69), null);
  assert.equal(level(WORKER_DAILY_INCLUDED * 0.7), 70);
  assert.equal(level(WORKER_DAILY_INCLUDED * 0.75), 70, "until the email is accepted it is tried again");
  noteWorkerWarning(state, "2026-10-14", 70);
  assert.equal(level(WORKER_DAILY_INCLUDED * 0.8), null);
  assert.equal(level(WORKER_DAILY_INCLUDED * 0.95), 90);
  noteWorkerWarning(state, "2026-10-14", 90);
  assert.equal(level(WORKER_DAILY_INCLUDED), null);
  const tomorrow = NOON + 86_400_000;
  assert.equal(level(WORKER_DAILY_INCLUDED * 0.7, tomorrow), 70, "a new day warns again");
  observeWorkerUsage(state, 0, "complete", tomorrow + 2 * 86_400_000);
  assert.deepEqual(Object.keys(state.warned), [], "old days are forgotten");
  assert.equal(state.pending, undefined, "a warning from an earlier day is dropped");
  const fresh = emptyWorkerUsage();
  noteWorkerWarning(fresh, "2026-10-14", 90);
  assert.equal(observeWorkerUsage(fresh, WORKER_DAILY_INCLUDED * 0.72, "complete", NOON), null, "90 covers 70");
});

test("a warning not yet accepted is resent byte for byte, even as the count grows", () => {
  const state = emptyWorkerUsage();
  const first = observeWorkerUsage(state, 72_000, "complete", NOON)!;
  const again = observeWorkerUsage(state, 78_000, "complete", NOON + 3_600_000)!;
  assert.equal(again.payload, first.payload, "same key, same body");
  assert.equal(observeWorkerUsage(state, null, "timeout", NOON + 7_200_000)!.payload, first.payload, "a failed reading still retries the stored warning");
  const higher = observeWorkerUsage(state, 92_000, "complete", NOON + 10_800_000)!;
  assert.equal(higher.level, 90, "a higher level replaces the pending one, with its own body");
  noteWorkerWarning(state, "2026-10-14", 90);
  assert.equal(observeWorkerUsage(state, 93_000, "complete", NOON + 14_400_000), null);
});

test("the warning names the count, the level and the free daily amount", () => {
  const payload = JSON.parse(workerWarningPayload(71_234, 70, NOON));
  assert.deepEqual(payload.to, ["hello@planban.ai"]);
  assert.match(payload.subject, /Worker requests at 70%/u);
  assert.match(payload.text, /71,234 Worker requests today \(2026-10-14, UTC\)/u);
  assert.match(payload.text, /100,000 a day/u);
});

test("the hourly check reads Cloudflare, warns once, and stays quiet afterwards", async () => {
  const prior = Object.fromEntries(Object.keys(production).map((name) => [name, process.env[name]]));
  Object.assign(process.env, production);
  const original = globalThis.fetch;
  const sent: Array<{ url: string; key: string | null; body: string }> = [];
  let requests = 72_000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    sent.push({ url, key: headers.get("Idempotency-Key"), body: String(init?.body ?? "") });
    if (url === "https://api.cloudflare.com/client/v4/graphql") {
      assert.equal(headers.get("Authorization"), "Bearer synthetic-analytics-read");
      return new Response(JSON.stringify(answer(requests)), { status: 200 });
    }
    if (url === "https://api.resend.com/emails") return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const { ctx } = memoryService();
    const byName: Record<string, any> = { "providerUsage:observeWorker": providerUsage.observeWorker, "providerUsage:noteWorker": providerUsage.noteWorker };
    const actionCtx = { runMutation: async (ref: any, args: any) => byName[getFunctionName(ref)]._handler(ctx, args) };
    // The first send's acknowledgement is lost; the next hour resends the same bytes under the same key.
    let loseAck = true;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (loseAck && String(input).includes("resend")) { loseAck = false; await realFetch(input, init); throw new TypeError("connection reset"); }
      return realFetch(input, init);
    }) as typeof fetch;
    assert.equal(await providerUsage.runWorkerUsagePoll(actionCtx as any, NOON), "retry");
    requests = 75_000;
    assert.equal(await providerUsage.runWorkerUsagePoll(actionCtx as any, NOON + 1_800_000), "sent");
    const resent = sent.filter((entry) => entry.url.includes("resend"));
    assert.equal(resent.length, 2);
    assert.equal(resent[0]!.body, resent[1]!.body, "byte-identical retry");
    assert.equal(resent[0]!.key, resent[1]!.key);
    sent.length = 0;
    globalThis.fetch = realFetch;
    requests = 72_000;
    assert.equal(await providerUsage.runWorkerUsagePoll(actionCtx as any, NOON + 3_600_000), "complete", "already warned today");
    requests = 91_000;
    assert.equal(await providerUsage.runWorkerUsagePoll(actionCtx as any, NOON + 7_200_000), "sent");
    const mails = sent.filter((entry) => entry.url.includes("resend"));
    assert.equal(mails.length, 1, "only the 90% warning since");
    assert.equal(mails[0]!.key, "planban-worker-requests-2026-10-14-90");
    process.env.PLANBAN_WORKER_USAGE_TOKEN = "";
    assert.equal(await providerUsage.runWorkerUsagePoll(actionCtx as any, NOON), "disabled");
  } finally {
    globalThis.fetch = original;
    for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
