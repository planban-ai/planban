// Editing at the same time (Spec point 20): edits check only the fields they
// touch, and positions never clash.
import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyRoadmap, planCreateCard, planMoveCard, planReorderCards, planUpdateCard, committedRoadmap } from "../src/core/boardOperations";
import { rebaseEdit } from "../src/core/concurrent";
import type { PlanbanRoadmap } from "../src/core/types";

const now = "2026-10-15T20:00:00.000Z";
function board(...titles: string[]): PlanbanRoadmap {
  let roadmap = createEmptyRoadmap({ repoId: "b", title: "B", now });
  for (const title of titles) roadmap = committedRoadmap(planCreateCard(roadmap, { title }, { now }).roadmap, now);
  return roadmap;
}
const update = (roadmap: PlanbanRoadmap, input: Record<string, unknown>) => committedRoadmap(planUpdateCard(roadmap, input as never, { now }).roadmap, now);
const move = (roadmap: PlanbanRoadmap, input: Record<string, unknown>) => committedRoadmap(planMoveCard(roadmap, input as never, { now }).roadmap, now);
const order = (roadmap: PlanbanRoadmap, status = "pending") => roadmap.roadmapItems.filter((item) => item.status === status).map((item) => item.id);

test("different cards: no clash", () => {
  const read = board("Alpha", "Beta");
  const current = update(read, { cardId: "alpha", summary: "Theirs" });
  const result = rebaseEdit("updateCard", { cardId: "beta", summary: "Mine" }, read, current);
  assert.equal(result.ok, true);
});

test("different fields of the same card: no clash, and both survive", () => {
  const read = board("Alpha");
  const current = update(read, { cardId: "alpha", summary: "Theirs" });
  const result = rebaseEdit("updateCard", { cardId: "alpha", nextAction: "Mine" }, read, current);
  assert.ok(result.ok);
  const applied = update(current, result.input);
  assert.deepEqual([applied.roadmapItems[0]!.summary, applied.roadmapItems[0]!.nextAction], ["Theirs", "Mine"]);
});

test("the same field: a clash that says what was read, what it is now, and what this edit wanted", () => {
  const read = board("Alpha");
  const current = update(read, { cardId: "alpha", summary: "Theirs" });
  const result = rebaseEdit("updateCard", { cardId: "alpha", summary: "Mine" }, read, current);
  assert.equal(result.ok, false);
  assert.deepEqual("clashes" in result && result.clashes, [{ cardId: "alpha", field: "summary", read: null, current: "Theirs", yours: "Mine" }]);
});

test("the same field changed to the same value is already covered, not a clash", () => {
  const read = board("Alpha");
  const current = update(read, { cardId: "alpha", summary: "Same" });
  assert.equal(rebaseEdit("updateCard", { cardId: "alpha", summary: "Same" }, read, current).ok, true);
});

test("metadata clashes per key, and an edit to another key keeps theirs", () => {
  const read = update(board("Alpha"), { cardId: "alpha", metadata: { a: 1, b: 1 } });
  const current = update(read, { cardId: "alpha", metadata: { a: 2, b: 1 } });
  const other = rebaseEdit("updateCard", { cardId: "alpha", metadata: { a: 1, b: 3 } }, read, current);
  assert.ok(other.ok);
  assert.deepEqual(update(current, other.input).roadmapItems[0]!.metadata, { a: 2, b: 3 });
  const same = rebaseEdit("updateCard", { cardId: "alpha", metadata: { a: 5, b: 1 } }, read, current);
  assert.equal(same.ok, false);
  assert.deepEqual("clashes" in same && same.clashes.map((clash) => clash.field), ["metadata.a"]);
});

test("metadata is a patch: keys given are set, a key given as null is removed, null clears all", () => {
  const start = update(board("Alpha"), { cardId: "alpha", metadata: { a: 1, b: 1 } });
  assert.deepEqual(update(start, { cardId: "alpha", metadata: { c: 3 } }).roadmapItems[0]!.metadata, { a: 1, b: 1, c: 3 });
  assert.deepEqual(update(start, { cardId: "alpha", metadata: { a: null, b: 2 } }).roadmapItems[0]!.metadata, { b: 2 });
  assert.equal(update(start, { cardId: "alpha", metadata: { a: null, b: null } }).roadmapItems[0]!.metadata, undefined);
  assert.equal(update(start, { cardId: "alpha", metadata: null }).roadmapItems[0]!.metadata, undefined);
});

test("a metadata patch from an older read keeps keys others added, and removing a key they changed clashes", () => {
  const read = update(board("Alpha"), { cardId: "alpha", metadata: { a: 1, b: 1 } });
  const current = update(read, { cardId: "alpha", metadata: { c: 3 } });
  const removal = rebaseEdit("updateCard", { cardId: "alpha", metadata: { a: null } }, read, current);
  assert.ok(removal.ok);
  assert.deepEqual(update(current, removal.input).roadmapItems[0]!.metadata, { b: 1, c: 3 });
  const cleared = rebaseEdit("updateCard", { cardId: "alpha", metadata: null }, read, current);
  assert.ok(cleared.ok);
  assert.deepEqual(update(current, cleared.input).roadmapItems[0]!.metadata, { c: 3 }, "clearing removes only the keys that were read");
  const changed = update(read, { cardId: "alpha", metadata: { b: 9 } });
  const clash = rebaseEdit("updateCard", { cardId: "alpha", metadata: { b: null } }, read, changed);
  assert.equal(clash.ok, false);
  assert.deepEqual("clashes" in clash && clash.clashes.map((entry) => entry.field), ["metadata.b"]);
  // A key the edit sets to what was read is not touched, so their change to it stands.
  const unchanged = rebaseEdit("updateCard", { cardId: "alpha", metadata: { b: 1, d: 4 } }, read, changed);
  assert.ok(unchanged.ok);
  assert.deepEqual(update(changed, unchanged.input).roadmapItems[0]!.metadata, { a: 1, b: 9, d: 4 });
});

test("a metadata key stored as null is not the same as a missing key", () => {
  // A stored null, from before metadata edits were patches, can still be removed from an older read.
  const withNull = (roadmap: PlanbanRoadmap, value: Record<string, unknown>) => ({ ...roadmap, roadmapItems: roadmap.roadmapItems.map((item) => ({ ...item, metadata: value })) });
  const read = withNull(board("Alpha"), { old: null, keep: 1 });
  const removal = rebaseEdit("updateCard", { cardId: "alpha", metadata: { old: null } }, read, read);
  assert.ok(removal.ok);
  assert.deepEqual(removal.touched.map((entry) => entry.field), ["metadata.old"]);
  assert.deepEqual(update(read, removal.input).roadmapItems[0]!.metadata, { keep: 1 });

  // Someone stored a null where the key was missing: setting it from the older read is a clash.
  const before = withNull(board("Alpha"), { keep: 1 });
  const changed = withNull(board("Alpha"), { keep: 1, k: null });
  const clash = rebaseEdit("updateCard", { cardId: "alpha", metadata: { k: 5 } }, before, changed);
  assert.equal(clash.ok, false);
  assert.deepEqual("clashes" in clash && clash.clashes.map((entry) => entry.field), ["metadata.k"]);
  // And removing a key they had just stored as null is already done.
  const gone = rebaseEdit("updateCard", { cardId: "alpha", metadata: { k: null } }, changed, before);
  assert.ok(gone.ok);
});

test("moves never clash: two agents rearranging different cards both land", () => {
  const read = board("A", "B", "C", "D");
  // One agent puts D first; another, from the same read, puts A after C.
  const current = move(read, { cardId: "d", afterId: null });
  const result = rebaseEdit("moveCard", { cardId: "a", afterId: "c" }, read, current);
  assert.ok(result.ok);
  assert.deepEqual(order(move(current, result.input)), ["d", "b", "c", "a"]);
});

test("a move after a neighbour that has gone elsewhere lands at the end of the column", () => {
  const read = board("A", "B", "C");
  const current = move(read, { cardId: "b", status: "up-next" });
  const result = rebaseEdit("moveCard", { cardId: "a", afterId: "b" }, read, current);
  assert.ok(result.ok);
  assert.deepEqual(order(move(current, result.input)), ["c", "a"]);
});

test("two agents moving the same card to different columns clash on its column", () => {
  const read = board("A");
  const current = move(read, { cardId: "a", status: "up-next" });
  const result = rebaseEdit("moveCard", { cardId: "a", status: "in-progress" }, read, current);
  assert.equal(result.ok, false);
});

test("a whole-board reorder from an older read keeps cards added since, at the end of their column", () => {
  const read = board("A", "B");
  const current = committedRoadmap(planCreateCard(read, { title: "New" }, { now }).roadmap, now);
  const items = [{ id: "b", status: "pending" }, { id: "a", status: "pending" }];
  const result = rebaseEdit("reorderCards", { items }, read, current);
  assert.ok(result.ok);
  const applied = committedRoadmap(planReorderCards(current, result.input as never, { now }).roadmap, now);
  assert.deepEqual(order(applied), ["b", "a", "new"]);
});

test("deleting a card someone changed since is a clash", () => {
  const read = move(board("A"), { cardId: "a", status: "archived" });
  const current = update(read, { cardId: "a", summary: "Kept for a reason" });
  assert.equal(rebaseEdit("deleteArchivedCard", { cardId: "a" }, read, current).ok, false);
});

test("restoring the whole board still needs the current revision", () => {
  const read = board("A");
  assert.deepEqual(rebaseEdit("restoreBoard", { version: 1 }, read, update(read, { cardId: "a", summary: "x" })), { ok: false, boardWide: true });
});

test("a stale whole-board reorder keeps a column someone changed since, for a card it didn't move", async () => {
  const read = board("A", "B");
  const current = move(read, { cardId: "a", status: "in-progress" });
  const items = [{ id: "b", status: "pending" }, { id: "a", status: "pending" }];
  const result = rebaseEdit("reorderCards", { items }, read, current);
  assert.ok(result.ok);
  const applied = committedRoadmap(planReorderCards(current, result.input as never, { now }).roadmap, now);
  assert.equal(applied.roadmapItems.find((item) => item.id === "a")!.status, "in-progress");
});

test("clearing metadata from an older read removes only the keys that were read", () => {
  const read = update(board("Alpha"), { cardId: "alpha", metadata: { a: 1 } });
  const current = update(read, { cardId: "alpha", metadata: { a: 1, newKey: "keep me" } });
  const result = rebaseEdit("updateCard", { cardId: "alpha", metadata: null }, read, current);
  assert.ok(result.ok);
  assert.deepEqual(update(current, result.input).roadmapItems[0]!.metadata, { newKey: "keep me" });
});
