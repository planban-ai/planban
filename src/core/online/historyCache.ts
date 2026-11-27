// An Online Board's history list, kept between reads so only newer entries are
// fetched (PB-81). The full list is up to a thousand entries and was fetched
// again after every edit, which made it the service's largest database read.
// Runs in the local server and in the hosted web page alike: no Node imports.
import type { PlanbanHistoryPayload } from "../types";

/** The service's history list, with the oldest version it still keeps (absent on older services). */
export type ServiceHistoryPayload = PlanbanHistoryPayload & { oldestVersion?: number | null };

/** A full read at least this often, so entries the service rewrote (an account deleted) are picked up. */
export const HISTORY_FULL_READ_MS = 10 * 60 * 1000;

interface Cached { payload: PlanbanHistoryPayload; fullAt: number }

/**
 * Returns a reader: `read(key, fetch)` fetches `fetch(undefined)` (everything)
 * the first time, then `fetch(currentVersion)` (only newer entries) and merges.
 * Anything unexpected (an older service, a gap, the board taken online again,
 * versions going backwards) falls back to a full read.
 */
export function historyCache(now: () => number = Date.now) {
  const cache = new Map<string, Cached>();
  async function full(key: string, fetch: (after?: number) => Promise<ServiceHistoryPayload>) {
    const payload = await fetch(undefined);
    if (payload.oldestVersion === undefined) cache.delete(key);
    else cache.set(key, { payload: strip(payload), fullAt: now() });
    const out = strip(payload);
    return { ...out, entries: [...out.entries] };
  }
  return {
    async read(key: string, fetch: (after?: number) => Promise<ServiceHistoryPayload>): Promise<PlanbanHistoryPayload> {
      const cached = cache.get(key);
      if (!cached || now() - cached.fullAt >= HISTORY_FULL_READ_MS) return full(key, fetch);
      const since = cached.payload.currentVersion;
      const next = await fetch(since);
      const versions = next.entries.map((entry) => entry.version);
      const consistent = next.oldestVersion !== undefined
        && next.currentVersion >= since
        && versions.every((version) => version > since)
        && (versions.length === 0 ? next.currentVersion === since : Math.min(...versions) === since + 1 && Math.max(...versions) === next.currentVersion)
        && !next.entries.some((entry) => entry.operation === "board.take-online");
      if (!consistent) return full(key, fetch);
      const oldest = next.oldestVersion ?? 0;
      const entries = [...next.entries, ...cached.payload.entries]
        .filter((entry) => entry.version >= oldest)
        .sort((a, b) => b.version - a.version);
      const payload: PlanbanHistoryPayload = { currentVersion: next.currentVersion, retention: next.retention, entries };
      cache.set(key, { payload, fullAt: cached.fullAt });
      return { ...payload, entries: [...entries] };
    },
    forget(key?: string) {
      if (key === undefined) cache.clear();
      else cache.delete(key);
    },
  };
}

function strip(payload: ServiceHistoryPayload): PlanbanHistoryPayload {
  const { oldestVersion: _oldest, ...rest } = payload;
  return rest;
}
