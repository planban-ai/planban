// The public address's Worker requests (Planban 2.0 plan, "Traffic budget").
// Cloudflare's Free plan includes 100,000 Worker requests a day; only service
// calls count, because the web page's own files are static assets. Checked
// hourly beside the included-usage monitor, on production only, and a warning
// goes to hello@planban.ai once per UTC day at 70% and again at 90%.
import { usageEnabled } from "./providerUsage";

export const WORKER_DAILY_INCLUDED = 100_000;
export const WORKER_SCRIPT = "planban-service-edge";
const WORKER_DASHBOARD = "https://dash.cloudflare.com/?to=/:account/workers/services/view/planban-service-edge/production/metrics";

type Settings = Record<string, string | undefined>;

export interface WorkerUsageState {
  /** The UTC day ("2026-10-14") each level was warned about. */
  warned: Record<string, Array<70 | 90>>;
  lastReading?: { day: string; requests: number; at: number };
  /**
   * The warning being sent: kept byte for byte until the email is accepted,
   * because a retry under the same idempotency key must send the same body.
   */
  pending?: { day: string; level: 70 | 90; payload: string };
  status?: string;
}

export const emptyWorkerUsage = (): WorkerUsageState => ({ warned: {} });
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * On only where the included-usage monitor is (production), and only with a
 * read-only Cloudflare analytics key and the account it reads.
 */
export function workerUsageConfigured(env: Settings): boolean {
  return usageEnabled(env) && !!env.PLANBAN_WORKER_USAGE_TOKEN && /^[a-f0-9]{32}$/.test(env.PLANBAN_WORKER_USAGE_ACCOUNT ?? "");
}

/** The GraphQL request for one UTC day's Worker requests so far. */
export function workerUsageRequest(account: string, now: number): string {
  const day = utcDay(now);
  return JSON.stringify({
    query: "query ($account: string!, $script: string!, $start: string!, $end: string!) { viewer { accounts(filter: { accountTag: $account }) { workersInvocationsAdaptive(limit: 10000, filter: { scriptName: $script, datetime_geq: $start, datetime_lt: $end }) { sum { requests } } } } }",
    variables: { account, script: WORKER_SCRIPT, start: `${day}T00:00:00Z`, end: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z") },
  });
}

/** Today's request count from Cloudflare's answer; anything unexpected is an error, never zero. */
export function parseWorkerRequests(body: unknown): number {
  const data = body as { errors?: unknown; data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: unknown } }> }> } } };
  if (Array.isArray(data?.errors) && data.errors.length) throw new Error("worker_usage_error");
  const accounts = data?.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error("worker_usage_invalid");
  const rows = accounts[0]!.workersInvocationsAdaptive;
  if (!Array.isArray(rows)) throw new Error("worker_usage_invalid");
  let total = 0;
  for (const row of rows) {
    const requests = row?.sum?.requests;
    if (typeof requests !== "number" || !Number.isSafeInteger(requests) || requests < 0) throw new Error("worker_usage_invalid");
    total += requests;
  }
  return total;
}

/**
 * Records a reading and returns the warning to send now, if any: the highest
 * level crossed today that hasn't been warned about. A warning not yet
 * accepted is sent again with exactly the same body. Only today's and
 * yesterday's warnings are kept.
 */
export function observeWorkerUsage(state: WorkerUsageState, requests: number | null, status: string, now: number): { day: string; level: 70 | 90; payload: string } | null {
  state.status = status;
  const day = utcDay(now);
  for (const key of Object.keys(state.warned)) if (key < utcDay(now - 86_400_000)) delete state.warned[key];
  if (state.pending && (state.pending.day !== day || (state.warned[day] ?? []).includes(state.pending.level))) delete state.pending;
  if (requests !== null) state.lastReading = { day, requests, at: now };
  const level = requests === null ? null : requests >= WORKER_DAILY_INCLUDED * 0.9 ? 90 : requests >= WORKER_DAILY_INCLUDED * 0.7 ? 70 : null;
  const warned = state.warned[day] ?? [];
  // A higher level crossed meanwhile replaces a pending lower one (its own key, its own body).
  if (level !== null && !warned.includes(level) && (!state.pending || level > state.pending.level)) {
    state.pending = { day, level, payload: workerWarningPayload(requests!, level, now) };
  }
  return state.pending ? { ...state.pending } : null;
}

/** Marks a level warned once its email is accepted (crossing 90 also covers 70). */
export function noteWorkerWarning(state: WorkerUsageState, day: string, level: 70 | 90) {
  const warned = new Set(state.warned[day] ?? []);
  warned.add(level);
  if (level === 90) warned.add(70);
  state.warned[day] = [...warned].sort() as Array<70 | 90>;
  if (state.pending && state.pending.day === day && warned.has(state.pending.level)) delete state.pending;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function workerWarningPayload(requests: number, level: 70 | 90, now: number): string {
  const day = utcDay(now);
  const text = [
    `Planban's public address has served ${requests.toLocaleString("en-GB")} Worker requests today (${day}, UTC), ${level}% or more of the 100,000 a day the Cloudflare Free plan includes.`,
    "Only service calls count; the web page's own files don't. Past 100,000, Cloudflare refuses further Worker requests until the day resets at midnight UTC.",
    "Moving to Workers Paid is an owner decision.",
    WORKER_DASHBOARD,
  ].join("\n\n");
  const html = `<html lang="en"><body style="font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;color:#0d0d0d"><h1 style="font-size:22px">Planban Worker requests at ${level}% today</h1><div style="white-space:pre-wrap;line-height:1.6">${escape(text)}</div></body></html>`;
  return JSON.stringify({ from: "Planban <alerts@planban.ai>", to: ["hello@planban.ai"], subject: `[Planban] Worker requests at ${level}% of today's included amount`, text, html });
}
