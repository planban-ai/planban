import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import { USAGE_POLICY, USAGE_CLOUD, collectionFailure, usageEnabled, mailEnabled, parseUsage, emptyMonitor, observeUsage, expiryNoticeDue, expiryNoticePayload, claimExpiryNotice, finishUsage, canSend, monitorStale, type MonitorState, type Reading, type Batch } from "./model/providerUsage";

import { emptyWorkerUsage, noteWorkerWarning, observeWorkerUsage, parseWorkerRequests, workerUsageConfigured, workerUsageRequest, type WorkerUsageState } from "./model/workerUsage";

const observeRef = makeFunctionReference<"mutation">("providerUsage:observe");
const observeWorkerRef = makeFunctionReference<"mutation">("providerUsage:observeWorker");
const noteWorkerRef = makeFunctionReference<"mutation">("providerUsage:noteWorker");
/** The Worker's requests are watched in their own row. */
const WORKER_POLICY = `${USAGE_POLICY}/worker`;

export const observeWorker = internalMutation({
  args: { requests: v.union(v.number(), v.null()), status: v.string(), now: v.number() },
  handler: async (ctx, { requests, status, now }): Promise<{ day: string; level: 70 | 90; payload: string } | null> => {
    if (!workerUsageConfigured(process.env)) return null;
    const row = await ctx.db.query("providerUsageMonitors").withIndex("by_policy", q => q.eq("policy", WORKER_POLICY)).unique();
    const state: WorkerUsageState = row?.state ?? emptyWorkerUsage();
    const warning = observeWorkerUsage(state, requests, status, now);
    if (row) await ctx.db.patch(row._id, { state }); else await ctx.db.insert("providerUsageMonitors", { policy: WORKER_POLICY, state });
    return warning;
  },
});
export const noteWorker = internalMutation({
  args: { day: v.string(), level: v.union(v.literal(70), v.literal(90)) },
  handler: async (ctx, { day, level }) => {
    const row = await ctx.db.query("providerUsageMonitors").withIndex("by_policy", q => q.eq("policy", WORKER_POLICY)).unique();
    if (!row) return;
    noteWorkerWarning(row.state as WorkerUsageState, day, level);
    await ctx.db.patch(row._id, { state: row.state });
  },
});

/** Reads today's Worker requests from Cloudflare and warns once per level per day. */
export async function runWorkerUsagePoll(ctx: Pick<ActionCtx, "runMutation">, now = Date.now()): Promise<string> {
  if (!workerUsageConfigured(process.env)) return "disabled";
  let requests: number | null = null; let status = "unavailable";
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${process.env.PLANBAN_WORKER_USAGE_TOKEN}`, "Content-Type": "application/json" },
      body: workerUsageRequest(process.env.PLANBAN_WORKER_USAGE_ACCOUNT!, now), signal: AbortSignal.timeout(10000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error([401, 403].includes(response.status) ? "worker_usage_unauthorized" : "worker_usage_unavailable"); }
    requests = parseWorkerRequests(await boundedJson(response)); status = "complete";
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("worker_usage_")) status = error.message;
    else if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) status = "timeout";
  }
  // The warning's body was stored before this send, so a retry repeats it exactly under the same key.
  const warning = await ctx.runMutation(observeWorkerRef, { requests, status, now }) as { day: string; level: 70 | 90; payload: string } | null;
  if (warning === null || !mailEnabled(process.env)) return status;
  const { day, level } = warning;
  const response = await fetch("https://api.resend.com/emails", { method: "POST", redirect: "error",
    headers: { Authorization: `Bearer ${process.env.PLANBAN_USAGE_EMAIL_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `planban-worker-requests-${day}-${level}` },
    body: warning.payload, signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (!response?.ok) { await response?.body?.cancel(); return "retry"; }
  await ctx.runMutation(noteWorkerRef, { day, level });
  return "sent";
}
const finishRef = makeFunctionReference<"mutation">("providerUsage:finish");

export const observe = internalMutation({
  args: { reading: v.any(), status: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<Batch | null> => {
    if (!usageEnabled(process.env)) return null;
    const row = await ctx.db.query("providerUsageMonitors").withIndex("by_policy", q => q.eq("policy", USAGE_POLICY)).unique();
    const state: MonitorState = row?.state ?? emptyMonitor();
    const batch = observeUsage(state, args.reading as Reading | null, args.status, args.now, mailEnabled(process.env));
    if (row) await ctx.db.patch(row._id, { state }); else await ctx.db.insert("providerUsageMonitors", { policy: USAGE_POLICY, state });
    return batch;
  },
});
export const finish = internalMutation({
  args: { id: v.string(), fence: v.number(), outcome: v.union(v.literal("sent"), v.literal("retry"), v.literal("held")), now: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("providerUsageMonitors").withIndex("by_policy", q => q.eq("policy", USAGE_POLICY)).unique();
    if (!row) return;
    finishUsage(row.state as MonitorState, args.id, args.fence, args.outcome, args.now);
    await ctx.db.patch(row._id, { state: row.state });
  },
});

const expiryClaimRef = makeFunctionReference<"mutation">("providerUsage:claimExpiryReminder");
const expiryNotedRef = makeFunctionReference<"mutation">("providerUsage:noteExpiryNotice");

async function monitorRow(ctx: MutationCtx) {
  return ctx.db.query("providerUsageMonitors").withIndex("by_policy", q => q.eq("policy", USAGE_POLICY)).unique();
}

/** Whether to send the renewal reminder now; records the first attempt before any send. */
export const claimExpiryReminder = internalMutation({
  args: { now: v.number() },
  handler: async (ctx, { now }): Promise<number | null> => {
    if (!mailEnabled(process.env)) return null;
    const row = await monitorRow(ctx);
    const state: MonitorState = row?.state ?? emptyMonitor();
    const expiry = expiryNoticeDue(process.env, state, now);
    if (expiry === null) return null;
    const send = claimExpiryNotice(state, expiry, now);
    if (row) await ctx.db.patch(row._id, { state }); else await ctx.db.insert("providerUsageMonitors", { policy: USAGE_POLICY, state });
    return send ? expiry : null;
  },
});

export const noteExpiryNotice = internalMutation({
  args: { expiry: v.number() },
  handler: async (ctx, { expiry }) => {
    const row = await monitorRow(ctx);
    if (!row) return;
    const state = row.state as MonitorState;
    state.expiryNoticeFor = expiry;
    await ctx.db.patch(row._id, { state });
  },
});

/** Reminds hello@planban.ai once, a week before the usage key expires; retried only inside the provider's duplicate window. */
export async function remindBeforeExpiry(ctx: Pick<ActionCtx, "runMutation">, now = Date.now()) {
  const expiry = await ctx.runMutation(expiryClaimRef, { now }) as number | null;
  if (expiry === null) return "not_due";
  const response = await fetch("https://api.resend.com/emails", { method: "POST", redirect: "error",
    headers: { Authorization: `Bearer ${process.env.PLANBAN_USAGE_EMAIL_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `planban-usage-key-expiry-${expiry}` },
    body: expiryNoticePayload(expiry), signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (!response?.ok) { await response?.body?.cancel(); return "retry"; }
  await ctx.runMutation(expiryNotedRef, { expiry });
  return "sent";
}

/** Internal operational inspection; no dashboard, public tool or credential. */
export const status = internalQuery({ args: {}, handler: async ctx => {
  if (!usageEnabled(process.env)) return { enabled: false };
  const row = await ctx.db.query("providerUsageMonitors").withIndex("by_policy", q => q.eq("policy", USAGE_POLICY)).unique();
  const state: MonitorState = row?.state ?? emptyMonitor();
  return { enabled: true, reason: state.status ?? "not_observed", stale: monitorStale(state, Date.now()),
    lastAttemptAt: state.lastAttemptAt ?? null, observedAt: state.lastSuccess?.at ?? null,
    month: state.lastSuccess?.month ?? null, heldBatches: state.batches.filter(b => b.status === "held").length };
} });

export async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try { part = await reader.read(); } catch (error) {
        if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw error;
        throw new Error("body_failure");
      }
      const { done, value } = part; if (done) break;
      size += value.length; if (size > 16384) throw new Error("oversized_response"); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function runUsagePoll(ctx: Pick<ActionCtx, "runMutation">): Promise<string> {
  if (!usageEnabled(process.env)) return "disabled";
  // The Worker's daily requests are checked on their own; a failure there never stops the included-usage check.
  await runWorkerUsagePoll(ctx).catch(() => undefined);
  const credentialFailure = collectionFailure(process.env, Date.now());
  if (credentialFailure) {
    await ctx.runMutation(observeRef, { reading: null, status: credentialFailure, now: Date.now() });
    return credentialFailure;
  }
  await remindBeforeExpiry(ctx).catch(() => undefined);
  const started = Date.now(); let reading: Reading | null = null; let status = "unavailable";
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${USAGE_CLOUD}/api/v1/get_current_usage`, { headers: { Authorization: `Convex ${process.env.PLANBAN_USAGE_READ_KEY}` }, redirect: "error", signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error([401, 403].includes(response.status) ? "usage_unauthorized" : "usage_unavailable"); }
    reading = parseUsage(await boundedJson(response), started, Date.now()); status = "complete";
  } catch (error) {
    const reasons = ["incomplete_reading", "invalid_metrics", "unknown_metric", "invalid_measurement", "month_changed", "invalid_response", "oversized_response", "body_failure", "usage_unauthorized", "usage_unavailable"];
    if (error instanceof Error && reasons.includes(error.message)) status = error.message;
    else if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) status = "timeout";
    else if (error instanceof SyntaxError) status = "invalid_json";
  } finally { clearTimeout(timer); }
  if (!usageEnabled(process.env)) return "disabled";
  const batch = await ctx.runMutation(observeRef, { reading, status, now: Date.now() }) as Batch | null;
  if (!batch || !canSend(batch, process.env, Date.now())) return status;
  let outcome: "sent" | "retry" | "held" = "retry";
  try {
    const response = await fetch("https://api.resend.com/emails", { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${process.env.PLANBAN_USAGE_EMAIL_KEY}`, "Content-Type": "application/json", "Idempotency-Key": batch.id }, body: batch.payload, signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const data = await boundedJson(response) as { id?: unknown };
      outcome = typeof data.id === "string" && data.id ? "sent" : "retry";
    } else {
      await response.body?.cancel();
      if (response.status < 500 && response.status !== 429) outcome = "held";
    }
  } catch { /* Ambiguous response: immutable batch and key remain for bounded retry. */ }
  await ctx.runMutation(finishRef, { id: batch.id, fence: batch.fence, outcome, now: Date.now() });
  return outcome;
}
export const poll = internalAction({ args: {}, handler: runUsagePoll });
