// Landing notes and the merge inbox (src/core/landings.ts), and how they show in a card's
// freshness: the planning rules the service's GitHub webhook runs.
import assert from "node:assert/strict";
import test from "node:test";
import { committedRoadmap, createEmptyRoadmap, normalizeRoadmap, planMoveCard, planUpdateCard } from "../src/core/boardOperations";
import { cardsNamingMerge, landingNote, MAX_CARD_LANDINGS, MAX_INBOX, parseLandingRef, planClearLanding, planRecordMerge, type MergeEvent } from "../src/core/landings";
import { boardOnlyStaleness, computeStaleness, LANDED_LABEL, MERGES_NOT_CHECKED_NOTE, stalenessAttention, stalenessLine } from "../src/core/staleness";
import type { PlanbanRoadmap, PlanbanRoadmapItem } from "../src/core/types";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const REPO = "planban-ai/planban";

let rank = 0;
function item(overrides: Partial<PlanbanRoadmapItem> & { id: string }): PlanbanRoadmapItem {
  return {
    title: overrides.id, status: "in-progress", priority: null, summary: null, nextAction: null, tags: [], icon: null, blockedBy: null,
    specDoc: null, planDoc: null, completedAt: null, updatedAt: iso(NOW - 3 * DAY), progressNotedAt: iso(NOW - 3 * DAY),
    isGroup: false, parentId: null, boardRank: ++rank, groupRank: null, ...overrides,
  };
}

function board(items: PlanbanRoadmapItem[]): PlanbanRoadmap {
  return { ...createEmptyRoadmap({ repoId: "demo", title: "Demo", now: iso(NOW - 10 * DAY) }), roadmapItems: items };
}

function merge(number: number, overrides: Partial<MergeEvent> = {}): MergeEvent {
  return { repo: REPO, number, title: `Change ${number}`, mergedAt: iso(NOW - DAY), url: `https://github.com/${REPO}/pull/${number}`, ...overrides };
}

const record = (roadmap: PlanbanRoadmap, event: MergeEvent, specs?: Map<string, string>) =>
  planRecordMerge(roadmap, event, { homeRepo: REPO, now: iso(NOW), ...(specs ? { specs } : {}) });

const freshness = (roadmap: PlanbanRoadmap) => computeStaleness({ items: roadmap.roadmapItems, history: [], docMtimes: [], merges: [], now: NOW });

test("a merge finds the cards that name it, by every kind of reference", () => {
  const items = [
    item({ id: "bare", summary: "Built in #12." }),
    item({ id: "phrase", nextAction: "Wait for PR 13 to merge." }),
    item({ id: "qualified", summary: `Shipped ${REPO}#14.` }),
    item({ id: "address", summary: `See https://github.com/${REPO}/pull/15 for the change.` }),
    item({ id: "metadata", metadata: { prs: [16] } }),
    item({ id: "spec" }),
    item({ id: "other-repo", summary: "Needs someone/else#12 first." }),
    item({ id: "archived", status: "archived", summary: "#12" }),
  ];
  const specs = new Map([["spec", "## Pull requests\n\n- #17, the schema change"]]);
  const names = (number: number) => cardsNamingMerge(items, { repo: REPO, number }, { homeRepo: REPO, specs });
  assert.deepEqual(names(12), ["bare"], "a bare #12 is the home repository's; another repository's #12 and archived cards don't count");
  assert.deepEqual(names(13), ["phrase"]);
  assert.deepEqual(names(14), ["qualified"]);
  assert.deepEqual(names(15), ["address"]);
  assert.deepEqual(names(16), ["metadata"]);
  assert.deepEqual(names(17), ["spec"], "the Spec is read too");
  // Owner and name match whatever their case.
  assert.deepEqual(cardsNamingMerge(items, { repo: "Planban-AI/Planban", number: 14 }, { homeRepo: REPO }), ["qualified"]);
  // A second linked repository: only qualified references reach it; a bare #12 is still the home repository's.
  assert.deepEqual(cardsNamingMerge(items, { repo: "someone/else", number: 12 }, { homeRepo: REPO }), ["other-repo"]);
});

test("a merge lands on its cards as a dated note, kept apart from the person's text", () => {
  const before = board([item({ id: "card", summary: "Building it in #12.", nextAction: "Merge it.", boardRank: 1 }), item({ id: "other", boardRank: 2 })]);
  const change = record(before, merge(12, { title: "  Fix   the\nthing " }))!;
  const card = change.roadmap.roadmapItems.find((entry) => entry.id === "card")!;
  assert.equal(card.summary, "Building it in #12.");
  assert.equal(card.nextAction, "Merge it.");
  assert.deepEqual(card.landings, [{ repo: REPO, number: 12, title: "Fix the thing", mergedAt: iso(NOW - DAY), url: `https://github.com/${REPO}/pull/12`, recordedAt: iso(NOW) }]);
  assert.equal(landingNote(card.landings![0]!), `29 Oct 2026: pull request 12 merged in ${REPO}: Fix the thing`);
  // Noting a merge is not progress.
  assert.equal(card.progressNotedAt, iso(NOW - 3 * DAY));
  assert.equal(change.history.actor, "system");
  assert.equal(change.history.operation, "github.merge.landed");
  assert.deepEqual(change.history.affectedCards, ["card"]);
  assert.match(change.history.summary, /^GitHub: pull request 12 merged in planban-ai\/planban \("Fix the thing"\); noted on card$/u);
  assert.equal(change.roadmap.landingInbox, undefined);
  // The note survives the board's own reading and writing.
  const reread = normalizeRoadmap(JSON.parse(JSON.stringify(committedRoadmap(change.roadmap, iso(NOW)))));
  assert.deepEqual(reread.roadmapItems.find((entry) => entry.id === "card")!.landings, card.landings);
});

test("a card keeps its newest landing notes only", () => {
  let roadmap = board([item({ id: "card", summary: `PRs 1-${MAX_CARD_LANDINGS + 2}` })]);
  for (let number = 1; number <= MAX_CARD_LANDINGS + 2; number += 1) roadmap = record(roadmap, merge(number, { mergedAt: iso(NOW - DAY + number) }))!.roadmap;
  const notes = roadmap.roadmapItems[0]!.landings!;
  assert.equal(notes.length, MAX_CARD_LANDINGS);
  assert.equal(notes[0]!.number, MAX_CARD_LANDINGS + 2, "newest first");
});

test("the same merge delivered again changes nothing", () => {
  const first = record(board([item({ id: "card", summary: "#12" })]), merge(12))!;
  assert.equal(record(first.roadmap, merge(12)), null);
  const inboxed = record(board([]), merge(40))!;
  assert.equal(record(inboxed.roadmap, merge(40)), null);
});

test("a merge that names no card waits in the inbox, newest first, capped", () => {
  const change = record(board([item({ id: "card", summary: "#12" })]), merge(99, { title: "Release 2.0" }))!;
  assert.equal(change.history.operation, "github.merge.inbox");
  assert.deepEqual(change.history.affectedCards, []);
  assert.match(change.history.summary, /no card names it, so it waits in the inbox$/u);
  assert.deepEqual(change.roadmap.landingInbox?.map((entry) => entry.number), [99]);
  assert.equal(change.roadmap.roadmapItems[0]!.landings, undefined);

  let roadmap = board([]);
  for (let number = 1; number <= MAX_INBOX + 3; number += 1) roadmap = record(roadmap, merge(number))!.roadmap;
  assert.equal(roadmap.landingInbox!.length, MAX_INBOX);
  assert.equal(roadmap.landingInbox![0]!.number, MAX_INBOX + 3);
  assert.equal(roadmap.landingInbox!.at(-1)!.number, 4, "the oldest drop off");
});

test("an inbox merge is assigned to a card or dismissed, into history", () => {
  const inboxed = record(board([item({ id: "card" })]), merge(99))!.roadmap;
  const assigned = planClearLanding(inboxed, { repo: REPO, number: 99, cardId: "card", actor: "agent" }, { now: iso(NOW) });
  assert.equal(assigned.roadmap.landingInbox?.length, 0);
  assert.equal(assigned.roadmap.roadmapItems[0]!.landings?.[0]?.number, 99);
  assert.equal(assigned.history.operation, "github.inbox.assigned");
  assert.equal(assigned.history.summary, `Assigned pull request 99 merged in ${REPO} to card`);
  assert.deepEqual(assigned.history.affectedCards, ["card"]);

  const dismissed = planClearLanding(inboxed, { repo: "PLANBAN-AI/planban", number: 99, reason: "A release merge; nothing to record." }, { now: iso(NOW) });
  assert.equal(dismissed.roadmap.landingInbox?.length, 0);
  assert.equal(dismissed.roadmap.roadmapItems[0]!.landings, undefined);
  assert.equal(dismissed.history.summary, `Dismissed pull request 99 merged in ${REPO} from the inbox: A release merge; nothing to record.`);

  assert.throws(() => planClearLanding(dismissed.roadmap, { repo: REPO, number: 99 }, { now: iso(NOW) }), /not in the inbox/u);
  assert.throws(() => planClearLanding(inboxed, { repo: REPO, number: 99, cardId: "missing" }, { now: iso(NOW) }), /Card not found/u);
  assert.throws(() => planClearLanding(inboxed, { repo: "not a repo", number: 99 }, { now: iso(NOW) }), /repository/u);
  assert.deepEqual(parseLandingRef(`${REPO}#99`), { repo: REPO, number: 99 });
  assert.deepEqual(parseLandingRef(`https://github.com/${REPO}/pull/7`), { repo: REPO, number: 7 });
  assert.equal(parseLandingRef("#99"), null);
});

test("a landed card reads 'needs a wrap-up' until its summary or next action is rewritten", () => {
  const landed = record(board([item({ id: "card", summary: "Building it in #12." })]), merge(12))!.roadmap;
  const signals = freshness(landed).cards.card!;
  assert.equal(signals[0]!.kind, "merged");
  assert.equal(signals[0]!.detail, `${LANDED_LABEL} (${REPO}#12 merged 29 Oct)`);

  // A touch doesn't clear it: tags, metadata, a move within its column.
  const touched = planUpdateCard(landed, { cardId: "card", tags: ["x"], metadata: { note: 1 } }, { now: iso(NOW) }).roadmap;
  assert.equal(freshness(touched).cards.card?.[0]?.detail, `${LANDED_LABEL} (${REPO}#12 merged 29 Oct)`);
  const moved = planMoveCard(touched, { cardId: "card", status: "up-next" }, { now: iso(NOW) }).roadmap;
  assert.equal(freshness(moved).cards.card?.[0]?.kind, "merged");

  // Rewriting the summary (or the next action) clears it; the note stays as the record.
  const rewritten = planUpdateCard(landed, { cardId: "card", summary: "Shipped in #12; the schema change is live." }, { now: iso(NOW + 1000) }).roadmap;
  assert.equal(freshness(rewritten).cards.card, undefined);
  assert.equal(rewritten.roadmapItems[0]!.landings?.length, 1);
  const nextAction = planUpdateCard(landed, { cardId: "card", nextAction: "Check it on staging." }, { now: iso(NOW + 1000) }).roadmap;
  assert.equal(freshness(nextAction).cards.card, undefined);

  // Completing it clears it too: complete cards have no freshness warnings.
  const completed = planMoveCard(landed, { cardId: "card", status: "complete" }, { now: iso(NOW + 1000) }).roadmap;
  assert.equal(freshness(completed).cards.card, undefined);

  // A merge older than the card's last progress (delivered late) needs no wrap-up.
  const late = record(board([item({ id: "card", summary: "#12", progressNotedAt: iso(NOW - DAY / 2) })]), merge(12))!.roadmap;
  assert.equal(freshness(late).cards.card, undefined);
});

test("a landing note and a merge found in GitHub for the same pull request are said once", () => {
  const landed = record(board([item({ id: "card", summary: "Building it in #12 and #13." })]), merge(12))!.roadmap;
  const signals = computeStaleness({
    items: landed.roadmapItems, history: [], docMtimes: [], now: NOW, homeRepo: REPO,
    merges: [{ pr: 12, mergedAt: iso(NOW - DAY) }, { pr: 13, mergedAt: iso(NOW - 2 * DAY) }],
  }).cards.card!;
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.detail, `${LANDED_LABEL} (${REPO}#12, #13 merged 29 Oct)`);
});

test("pull requests with the same number in different repositories are each said", () => {
  // The card names this project's #12 and another repository's #12; only the other one landed here.
  const other = "someone/else";
  const landed = record(board([item({ id: "card", summary: `Building it in #12, after ${other}#12.` })]), merge(12, { repo: other, url: `https://github.com/${other}/pull/12` }))!.roadmap;
  const merges = [{ pr: 12, mergedAt: iso(NOW - 2 * DAY) }];
  const signals = computeStaleness({ items: landed.roadmapItems, history: [], docMtimes: [], now: NOW, homeRepo: REPO, merges }).cards.card!;
  assert.equal(signals[0]!.detail, `${LANDED_LABEL} (${other}#12, #12 merged 29 Oct)`);
  // Unknown home repository: a bare #12 is never taken for another repository's landing.
  const unknown = computeStaleness({ items: landed.roadmapItems, history: [], docMtimes: [], now: NOW, merges }).cards.card!;
  assert.equal(unknown[0]!.detail, `${LANDED_LABEL} (${other}#12, #12 merged 29 Oct)`);
  // With the other repository as home, the bare #12 is that landing, said once.
  const same = computeStaleness({ items: landed.roadmapItems, history: [], docMtimes: [], now: NOW, homeRepo: other, merges }).cards.card!;
  assert.equal(same[0]!.detail, `${LANDED_LABEL} (${other}#12 merged 29 Oct)`);
});

test("hosted surfaces show landed cards, and drop the 'not checked' note once a repository is linked", () => {
  const landed = record(board([item({ id: "card", summary: "Building it in #12." })]), merge(12))!.roadmap;
  const unlinked = boardOnlyStaleness(landed.roadmapItems, NOW);
  assert.equal(unlinked.cards.card?.[0]?.detail, `${LANDED_LABEL} (${REPO}#12 merged 29 Oct)`);
  assert.deepEqual(unlinked.notes, [MERGES_NOT_CHECKED_NOTE]);
  const linked = boardOnlyStaleness(landed.roadmapItems, NOW, [], [REPO]);
  assert.equal(linked.cards.card?.[0]?.detail, `${LANDED_LABEL} (${REPO}#12 merged 29 Oct)`);
  assert.equal(linked.notes, undefined);
  // A card naming another repository's pull request still says what isn't checked.
  const elsewhere = boardOnlyStaleness([...landed.roadmapItems, item({ id: "other", summary: "Waits on someone/else#3" })], NOW, [], [REPO]);
  assert.match(elsewhere.notes?.[0] ?? "", /linked to this board \(planban-ai\/planban\)\. Pull requests in other repositories aren't checked here/u);
});

test("agents hear about the inbox in the attention section and the session line", () => {
  let roadmap = board([]);
  for (const number of [1, 2, 3, 4, 5, 6, 7]) roadmap = record(roadmap, merge(number))!.roadmap;
  const attention = stalenessAttention(freshness(roadmap), roadmap.roadmapItems, roadmap.landingInbox);
  assert.equal(attention.inbox?.total, 7);
  assert.deepEqual(attention.inbox?.items[0], { ref: `${REPO}#7`, title: "Change 7", mergedAt: iso(NOW - DAY), url: `https://github.com/${REPO}/pull/7` });
  assert.equal(
    stalenessLine(attention, "planban_get_board"),
    `7 merged pull requests name no card (${REPO}#7, ${REPO}#6, ${REPO}#5, ${REPO}#4, ${REPO}#3, +2 more; planban_get_board lists them all); write what each finished into the right card and assign it there, or dismiss it, with planban_clear_landing.`,
  );
  assert.equal(stalenessAttention(freshness(board([])), [], []).inbox, undefined);
});
