import { Sha256 } from "./sha256";

// Provisioning evidence binds this policy to exactly one deployment: Planban's
// production deployment (team 547105, project 3204497). Usage is shared by the
// team, so only one deployment watches it; on any other deployment, staging
// included, the monitor stays off.
export const USAGE_POLICY = "planban-547105-3204497-canny-turtle-411-v1";
export const USAGE_CLOUD = "https://canny-turtle-411.eu-west-1.convex.cloud";
export const USAGE_SITE = "https://canny-turtle-411.eu-west-1.convex.site";
export const USAGE_DASHBOARD = "https://dashboard.convex.dev/t/pierce-kearns-73417/usage";
export const HOUR = 3600000;
export const LEASE = 60000;
export const RETRY_WINDOW = 23 * HOUR; // Provider idempotency lasts 24 hours.
const MAX_BATCHES = 104;
const DEFINITIONS = {
  calls: { label: "Function calls", unit: "calls", included: 1000000 },
  actions: { label: "Action compute", unit: "GB-hours", included: 20 },
  io: { label: "Database I/O", unit: "GB", included: 1 },
  egress: { label: "Data egress", unit: "GB", included: 1 },
} as const;
export type Metric = keyof typeof DEFINITIONS;
export type Reading = { month: string; at: number; values: Record<Metric, number> };

// Starter plan prices for each unit beyond the included amount, in US dollars
// for US regions. Source: https://www.convex.dev/pricing and
// https://docs.convex.dev/production/state/limits, checked 7 November 2026.
export const OVERAGE_PRICES: Record<Metric, number> = {
  calls: 2.2 / 1e6, // $2.20 per additional million function calls
  actions: .33, // $0.33 per additional GB-hour of action compute
  io: .22, // $0.22 per additional GB of database I/O
  egress: .132, // $0.132 per additional GB of data egress
};
// "Pricing in other regions is 1.3x" (limits page, same date); production is
// in eu-west-1.
export const REGION_UPLIFT = 1.3;
/** Estimated dollars this month, per metric and in total, beyond the included amounts. */
export function estimateCost(values: Record<Metric, number>): { total: number; metrics: Record<Metric, number> } {
  const metrics = {} as Record<Metric, number>; let total = 0;
  for (const metric of Object.keys(DEFINITIONS) as Metric[]) {
    metrics[metric] = Math.max(0, values[metric] - DEFINITIONS[metric].included) * OVERAGE_PRICES[metric] * REGION_UPLIFT;
    total += metrics[metric];
  }
  return { metrics, total };
}

/** Before this many days of the month, a projection is mostly noise. */
export const PROJECTION_MIN_DAYS = 3;
const DAY = 24 * HOUR;
const monthStart = (month: string) => { const [y, m] = month.split("-").map(Number); return Date.UTC(y!, m! - 1, 1); };
const monthEnd = (month: string) => { const [y, m] = month.split("-").map(Number); return Date.UTC(y!, m!, 1); };
/** Month-end usage at this month's daily rate so far, or null this early in the month. */
export function projectUsage(reading: Reading): Record<Metric, number> | null {
  const start = monthStart(reading.month), elapsed = reading.at - start;
  if (elapsed < PROJECTION_MIN_DAYS * DAY) return null;
  const factor = (monthEnd(reading.month) - start) / elapsed, out = {} as Record<Metric, number>;
  for (const metric of Object.keys(DEFINITIONS) as Metric[]) out[metric] = reading.values[metric] * factor;
  return out;
}
const projectedCost = (reading: Reading) => { const p = projectUsage(reading); return p ? estimateCost(p).total : null; };

/** Warn once a month as the estimate passes $5 and $15, and early if the month-end projection passes $15. */
export const SPENT_LEVELS = [5, 15] as const;
export const PROJECTED_LEVEL = 15;
export type Event = { kind: "spent"; dollars: 5 | 15 } | { kind: "projected"; dollars: 15 };
export type Batch = {
  id: string; month: string; events: Event[]; payload: string; hash: string;
  firstAttemptAt: number; retryUntil: number; attempts: number; fence: number; leaseUntil: number;
  status: "sending" | "retry" | "sent" | "held";
};
export type MonitorState = {
  lastAttemptAt?: number; lastSuccess?: Reading; status?: string;
  covered: Record<string, true>; batches: Batch[];
  /** The usage key expiry a renewal reminder has been sent (or given up) for. */
  expiryNoticeFor?: number;
  /** The first attempt at the current reminder, so retries stay inside the provider's duplicate window. */
  expiryNoticeAttempt?: { expiry: number; firstAt: number };
};
export const emptyMonitor = (): MonitorState => ({ covered: {}, batches: [] });
export const utcMonth = (now: number) => new Date(now).toISOString().slice(0, 7);

type Settings = Record<string, string | undefined>;
export function usageEnabled(env: Settings): boolean {
  return env.PLANBAN_USAGE_ENABLED === "1" && env.PLANBAN_USAGE_POLICY === USAGE_POLICY
    && env.CONVEX_CLOUD_URL === USAGE_CLOUD && env.CONVEX_SITE_URL === USAGE_SITE;
}
export function collectionConfigured(env: Settings, now: number): boolean {
  return usageEnabled(env) && collectionFailure(env, now) === null;
}
export function collectionFailure(env: Settings, now: number): string | null {
  if (!env.PLANBAN_USAGE_READ_KEY) return "credential_missing";
  const expiry = Number(env.PLANBAN_USAGE_KEY_EXPIRES_AT);
  if (!Number.isSafeInteger(expiry) || expiry <= 0) return "credential_invalid_expiry";
  return expiry > now ? null : "credential_expired";
}
/** A renewal reminder goes out once the usage key is this close to expiring. */
export const EXPIRY_NOTICE_MS = 7 * 24 * HOUR;

/** The usage key's expiry when a renewal reminder is due and not yet sent; otherwise null. */
export function expiryNoticeDue(env: Settings, state: MonitorState, now: number): number | null {
  const expiry = Number(env.PLANBAN_USAGE_KEY_EXPIRES_AT);
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry - now > EXPIRY_NOTICE_MS) return null;
  return state.expiryNoticeFor === expiry ? null : expiry;
}

/**
 * Claims a reminder send, changing state. The first attempt is recorded before
 * sending; retries with the same idempotency key happen only inside the
 * provider's duplicate window, after which the reminder counts as sent, so an
 * accepted email whose reply was lost is never sent a second time.
 */
export function claimExpiryNotice(state: MonitorState, expiry: number, now: number): boolean {
  if (state.expiryNoticeFor === expiry) return false;
  const attempt = state.expiryNoticeAttempt;
  if (attempt?.expiry === expiry) {
    if (now - attempt.firstAt < RETRY_WINDOW) return true;
    state.expiryNoticeFor = expiry;
    return false;
  }
  state.expiryNoticeAttempt = { expiry, firstAt: now };
  return true;
}

export function expiryNoticePayload(expiry: number): string {
  const when = new Date(expiry).toUTCString();
  const text = [
    `Planban's usage monitor key expires on ${when}.`,
    "After that, usage cost warnings stop until a new key is set. Create a new production deploy key that can only view usage, then set it and its expiry on the production deployment.",
    USAGE_DASHBOARD,
  ].join("\n\n");
  const html = `<html lang="en"><body style="font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;color:#0d0d0d"><h1 style="font-size:22px">Planban usage monitor key expiring</h1><div style="white-space:pre-wrap;line-height:1.6">${escape(text)}</div></body></html>`;
  return JSON.stringify({ from: "Planban <alerts@planban.ai>", to: ["hello@planban.ai"], subject: "[Planban] Usage monitor key expires soon", text, html });
}

export function mailEnabled(env: Settings): boolean {
  return usageEnabled(env) && env.PLANBAN_USAGE_EMAIL_ENABLED === "1" && !!env.PLANBAN_USAGE_EMAIL_KEY;
}

/** Unknown and missing measures are never silently interpreted as zero. */
export function parseUsage(body: unknown, started: number, ended: number): Reading {
  if (utcMonth(started) !== utcMonth(ended) || ended < started) throw new Error("month_changed");
  const data = body as { seedStatus?: unknown; metrics?: Record<string, any> };
  if (!data || data.seedStatus !== "complete") throw new Error("incomplete_reading");
  if (!data.metrics || typeof data.metrics !== "object" || Array.isArray(data.metrics)) throw new Error("invalid_metrics");
  const excluded = new Set(["actionComputeCpuGbHours", "aiGatewayCostDollars", "queryMutationComputeGbHours", "searchQueryGb"]);
  const required: Record<string, string> = { functionCalls: "calls", actionComputeConvexGbHours: "GB-hours", actionComputeNodeJsGbHours: "GB-hours", databaseIoGb: "GB", dataEgressGb: "GB" };
  if (Object.keys(data.metrics).some(k => !Object.hasOwn(required, k) && !excluded.has(k))) throw new Error("unknown_metric");
  const value = (name: string) => {
    const item = data.metrics![name], n = item?.usage?.current_month;
    if (item?.unit !== required[name] || typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error("invalid_measurement");
    return n;
  };
  const calls = value("functionCalls"), actions = value("actionComputeConvexGbHours") + value("actionComputeNodeJsGbHours");
  if (!Number.isSafeInteger(calls) || !Number.isFinite(actions)) throw new Error("invalid_measurement");
  return { month: utcMonth(ended), at: ended, values: { calls, actions, io: value("databaseIoGb"), egress: value("dataEgressGb") } };
}

const key = (month: string, event: Event) => `${month}/${event.kind}/${event.dollars}`;
const known = (e: Event) => (e?.kind === "spent" && SPENT_LEVELS.includes(e.dollars)) || (e?.kind === "projected" && e.dollars === PROJECTED_LEVEL);
const qualifies = (reading: Reading, e: Event) => e.kind === "spent"
  ? estimateCost(reading.values).total >= e.dollars
  : (projectedCost(reading) ?? 0) >= e.dollars;
const hash = (text: string) => { const sha = new Sha256(); sha.update(new TextEncoder().encode(text)); return sha.hex(); };
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const day = (at: number) => { const d = new Date(at); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const time = (at: number) => new Date(at).toISOString().slice(11, 16);
const dollars = (n: number) => `$${n.toFixed(2)}`;
const used = (metric: Metric, n: number) => metric === "calls" ? Math.round(n).toLocaleString("en-US") : n.toFixed(2);
const included = (metric: Metric) => DEFINITIONS[metric].included.toLocaleString("en-US");

/** Immutable bytes contain only validated provider amounts and fixed policy copy. */
export function warningPayload(reading: Reading, events: Event[]): string {
  const cost = estimateCost(reading.values), projection = projectedCost(reading);
  const passed = Math.max(0, ...events.map(e => e.kind === "spent" ? e.dollars : 0));
  const headline = passed
    ? `Planban's Convex usage this month has passed $${passed} in estimated charges beyond the free allowance.`
    : `At this month's daily rate so far, Planban's Convex usage would cost more than $${PROJECTED_LEVEL} beyond the free allowance by the end of the month.`;
  const subject = passed ? `[Planban] Convex usage has passed $${passed} this month` : `[Planban] Convex usage is on course to pass $${PROJECTED_LEVEL} this month`;
  const rows = (Object.keys(DEFINITIONS) as Metric[]).filter(m => cost.metrics[m] > 0).map(m => {
    const d = DEFINITIONS[m];
    return `${d.label}: ${used(m, reading.values[m])} ${d.unit} used, ${included(m)} ${d.unit} included, about ${dollars(cost.metrics[m])}.`;
  });
  const text = [
    headline,
    "Nothing needs doing if this is expected. If it isn't, the Convex usage page shows what is driving it:",
    USAGE_DASHBOARD,
    `Estimated charges so far: ${dollars(cost.total)}.\n${projection === null ? "It is too early in the month to estimate the month-end total." : `By the end of the month, at the current daily rate: about ${dollars(projection)}.`}`,
    `Where the charges come from:\n${rows.join("\n")}`,
    "Convex's own controls still apply: it sends a spending alert at $10 and switches usage off at $20.",
    "This is an estimate. It counts only Planban's production deployment, uses Convex's published Starter prices for EU regions, and leaves out storage, search, AI Gateway and seat fees.",
    `Reading taken ${day(reading.at)} at ${time(reading.at)} UTC. The monthly allowance starts again on ${day(monthEnd(reading.month))}.`,
  ].join("\n\n");
  const html = `<html lang="en"><body style="font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;color:#0d0d0d"><h1 style="font-size:22px">Planban usage cost</h1><div style="white-space:pre-wrap;line-height:1.6">${escape(text)}</div></body></html>`;
  return JSON.stringify({ from: "Planban <alerts@planban.ai>", to: ["hello@planban.ai"], subject, text, html });
}

/** Transactional state transition; caller persists it before any external send. */
export function observeUsage(state: MonitorState, reading: Reading | null, status: string, now: number, email: boolean): Batch | null {
  state.lastAttemptAt = now; state.status = status;
  if (!reading || reading.month !== utcMonth(now) || reading.at > now || now - reading.at > 60000) return null;
  state.lastSuccess = reading;
  // Keep sent suppression throughout its month; never discard ambiguous work.
  const date = new Date(now);
  const oldest = utcMonth(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 12, 1));
  const payloadOldest = utcMonth(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  // Compact sent suppression lasts 13 calendar months; successful payloads
  // last two. Healthy months cannot fill the ambiguity retention bound.
  state.batches = state.batches.filter(b => b.status !== "sent" || b.month >= payloadOldest);
  for (const k of Object.keys(state.covered)) if (k.slice(0, 7) < oldest) delete state.covered[k];
  for (const b of state.batches) {
    if (b.status === "sent" || b.status === "held") continue;
    if (b.status === "sending" && b.leaseUntil > now) continue;
    // Batches from the old allowance thresholds are never resent.
    if (b.month !== reading.month || now >= b.retryUntil || b.attempts >= 3 || !b.events.every(known)) { b.status = "held"; continue; }
    if (!email || !b.events.every(e => qualifies(reading, e))) continue;
    b.fence++; b.attempts++; b.leaseUntil = now + LEASE; b.status = "sending";
    return structuredClone(b);
  }
  if (!email) { state.status = "delivery_disabled"; return null; }
  if (state.batches.length >= MAX_BATCHES) { state.status = "retention_review_required"; return null; }
  const candidates: Event[] = [];
  const spentLevel = [...SPENT_LEVELS].reverse().find(dollars => qualifies(reading, { kind: "spent", dollars }));
  if (spentLevel) candidates.push({ kind: "spent", dollars: spentLevel });
  // Once $15 is actually spent, the projection has nothing to add.
  if (spentLevel !== 15 && qualifies(reading, { kind: "projected", dollars: PROJECTED_LEVEL })) candidates.push({ kind: "projected", dollars: PROJECTED_LEVEL });
  const events = candidates.filter(e => !state.covered[key(reading.month, e)]
    && !state.batches.some(b => b.month === reading.month && b.events.some(x => x.kind === e.kind && x.dollars === e.dollars)));
  if (!events.length) return null;
  const payload = warningPayload(reading, events), digest = hash(payload);
  const b: Batch = { id: `${USAGE_POLICY}/${reading.month}/${hash(JSON.stringify(events))}`, month: reading.month, events, payload, hash: digest, firstAttemptAt: now, retryUntil: now + RETRY_WINDOW, attempts: 1, fence: 1, leaseUntil: now + LEASE, status: "sending" };
  // A higher warning stands in for the lower ones it passes.
  if (events.some(e => e.kind === "spent" && e.dollars === 15)) {
    state.covered[key(reading.month, { kind: "spent", dollars: 5 })] = true;
    state.covered[key(reading.month, { kind: "projected", dollars: PROJECTED_LEVEL })] = true;
  }
  state.batches.push(b); return structuredClone(b);
}

export function finishUsage(state: MonitorState, id: string, fence: number, outcome: "sent" | "retry" | "held", now: number): void {
  const b = state.batches.find(b => b.id === id);
  if (!b || b.fence !== fence || b.status !== "sending") return;
  b.status = outcome === "retry" && (now >= b.retryUntil || b.attempts >= 3) ? "held" : outcome;
  b.leaseUntil = 0;
  if (b.status === "sent") for (const e of b.events) state.covered[key(b.month, e)] = true;
}

export function canSend(batch: Batch, env: Settings, now: number): boolean {
  return mailEnabled(env) && batch.month === utcMonth(now) && now < batch.retryUntil && now < batch.leaseUntil && hash(batch.payload) === batch.hash;
}
export const monitorStale = (state: MonitorState, now: number) => !state.lastSuccess || now - state.lastSuccess.at >= 3 * HOUR;
