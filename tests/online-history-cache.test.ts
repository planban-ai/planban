// An Online Board's history list is fetched in full once, then only newer
// entries are fetched and merged (PB-81), falling back to a full read whenever
// the answer doesn't follow on from what is held.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_FULL_READ_MS, historyCache, type ServiceHistoryPayload } from "../src/core/online/historyCache";
import type { PlanbanHistoryEntry } from "../src/core/types";

const retention = { boardVersions: 1000, cardVersions: 1000, documentVersions: 1000, hourlyDays: 0, maxAgeDays: 0 };
const entry = (version: number, operation = "card.update") => ({ version, operation, roadmapRevision: version, createdAt: `v${version}` }) as unknown as PlanbanHistoryEntry;

/** A service holding versions oldest..current, answering like boards.history. */
function service(opts: { oldest: number; current: number; withOldest?: boolean; operations?: Record<number, string> }) {
  const calls: Array<number | undefined> = [];
  const fetch = async (after?: number): Promise<ServiceHistoryPayload> => {
    calls.push(after);
    const entries = [];
    for (let version = opts.current; version >= Math.max(opts.oldest, (after ?? 0) + 1); version -= 1) entries.push(entry(version, opts.operations?.[version]));
    return { currentVersion: opts.current, retention, entries, ...(opts.withOldest === false ? {} : { oldestVersion: opts.current ? opts.oldest : null }) };
  };
  return { opts, calls, fetch };
}

const versions = (payload: { entries: PlanbanHistoryEntry[] }) => payload.entries.map((item) => item.version);

test("after a full read, only newer entries are fetched, and the merged list matches a full read", async () => {
  const cache = historyCache();
  const board = service({ oldest: 1, current: 3 });
  assert.deepEqual(versions(await cache.read("b", board.fetch)), [3, 2, 1]);
  board.opts.current = 5;
  const merged = await cache.read("b", board.fetch);
  assert.deepEqual(board.calls, [undefined, 3]);
  assert.deepEqual(versions(merged), [5, 4, 3, 2, 1]);
  assert.equal(merged.currentVersion, 5);
  assert.equal("oldestVersion" in merged, false, "the page gets the same shape as before");
  // Nothing new: a cheap read, the same list.
  assert.deepEqual(versions(await cache.read("b", board.fetch)), [5, 4, 3, 2, 1]);
  assert.deepEqual(board.calls, [undefined, 3, 5]);
});

test("versions the service trimmed are dropped from the held list", async () => {
  const cache = historyCache();
  const board = service({ oldest: 1, current: 4 });
  await cache.read("b", board.fetch);
  board.opts.oldest = 3;
  board.opts.current = 5;
  assert.deepEqual(versions(await cache.read("b", board.fetch)), [5, 4, 3]);
});

test("anything that doesn't follow on is read in full again", async () => {
  // An older service that doesn't say its oldest version: always a full read.
  const old = service({ oldest: 1, current: 2, withOldest: false });
  const plain = historyCache();
  await plain.read("b", old.fetch);
  await plain.read("b", old.fetch);
  assert.deepEqual(old.calls, [undefined, undefined]);

  // The board taken online again.
  const cache = historyCache();
  const board = service({ oldest: 1, current: 2, operations: { 3: "board.take-online" } });
  await cache.read("b", board.fetch);
  board.opts.current = 3;
  await cache.read("b", board.fetch);
  assert.deepEqual(board.calls, [undefined, 2, undefined]);

  // Versions going backwards.
  const back = service({ oldest: 1, current: 4 });
  const again = historyCache();
  await again.read("b", back.fetch);
  back.opts.current = 2;
  assert.deepEqual(versions(await again.read("b", back.fetch)), [2, 1]);
  assert.deepEqual(back.calls, [undefined, 4, undefined]);
});

test("a full read happens again after a while, so rewritten entries are picked up", async () => {
  let now = 0;
  const cache = historyCache(() => now);
  const board = service({ oldest: 1, current: 1 });
  await cache.read("b", board.fetch);
  now = HISTORY_FULL_READ_MS - 1;
  await cache.read("b", board.fetch);
  now = HISTORY_FULL_READ_MS;
  await cache.read("b", board.fetch);
  assert.deepEqual(board.calls, [undefined, 1, undefined]);
});

test("each board keeps its own list, and a failed read keeps nothing new", async () => {
  const cache = historyCache();
  const a = service({ oldest: 1, current: 2 });
  const b = service({ oldest: 1, current: 7 });
  await cache.read("a", a.fetch);
  assert.deepEqual(versions(await cache.read("b", b.fetch)), [7, 6, 5, 4, 3, 2, 1]);
  await assert.rejects(cache.read("a", async () => { throw new Error("offline"); }), /offline/);
  assert.deepEqual(versions(await cache.read("a", a.fetch)), [2, 1]);
  assert.deepEqual(a.calls, [undefined, 2]);
});
