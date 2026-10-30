import assert from "node:assert/strict";
import { test } from "node:test";
import { fail } from "../online/service/convex/model/errors";
import { handleMcp, McpService } from "../online/service/convex/model/mcp";

const roadmap: any = {
  revision: 3, project: { id: "deadleg", title: "Deadleg" }, updatedAt: new Date().toISOString(),
  roadmapItems: [{ id: "vest", title: "Choose the vest supplier", status: "in-progress", summary: "Two suppliers left.", nextAction: "Owner: pick one.", tags: [], metadata: {}, isGroup: false, parentId: null, priority: 1 }],
};
const service: any = {
  listBoards: async () => [{ boardId: "deadleg", title: "Deadleg" }],
  getBoard: async () => roadmap,
  readDoc: async () => ({ markdown: "## Purpose\nOne supplier for 300 units." }),
  goals: async () => ({ page: { goals: [], context: "", retired: [], suggestions: [], recentlyDismissed: [] }, revision: 3 }),
};
const call = async (name: string, args: Record<string, unknown>) => {
  const response = await handleMcp(new Request("https://app.planban.example/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), service, "https://app.planban.example");
  return (await response.json()).result;
};

test("search and fetch cite each card's address on the web page", async () => {
  const link = "https://app.planban.example/boards/deadleg#card=vest";
  const search = await call("search", { query: "vest" });
  assert.equal(search.isError, false);
  assert.deepEqual(search.structuredContent.results, [{ id: "deadleg/vest", title: "Choose the vest supplier (Deadleg)", url: link }]);
  const fetched = await call("fetch", { id: "deadleg/vest" });
  assert.equal(fetched.isError, false);
  assert.equal(fetched.structuredContent.url, link);
  assert.equal(fetched.structuredContent.title, "Choose the vest supplier");
  assert.match(fetched.structuredContent.text, /One supplier for 300 units/);
});

test("remote results have the local tools' shape: query matches at the top level, and every edit returns the link to give the person", async () => {
  const board = (await call("planban_get_board", { boardId: "deadleg" })).structuredContent;
  assert.deepEqual([board.boardId, board.title, board.revision, board.roadmapItems.length], ["deadleg", "Deadleg", 3, 1]);
  const query = await call("planban_query_cards", { boardId: "deadleg", search: "vest" });
  assert.equal(query.structuredContent.boardId, "deadleg");
  assert.equal(query.structuredContent.revision, 3);
  assert.equal(query.structuredContent.matches[0].item.id, "vest");
  assert.equal(query.structuredContent.results, undefined);

  const edited: any = { ...service, run: async () => ({ roadmap: { ...roadmap, revision: 4 }, result: {} }) };
  const response = await handleMcp(new Request("https://app.planban.example/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "planban_update_card", arguments: { boardId: "deadleg", cardId: "vest", summary: "Picked.", baseRevision: 3 } } }) }), edited, "https://app.planban.example");
  const result = (await response.json()).result.structuredContent;
  assert.equal(result.revision, 4);
  assert.equal(result.card.id, "vest", "the changed card, as the local tools return it");
  assert.equal(result.boardUrl, "https://app.planban.example/boards/deadleg");
  assert.equal(result.boardUrlVerified, true);
  assert.deepEqual(result.userReply, { urlRequired: true, url: "https://app.planban.example/boards/deadleg#card=vest", markdown: "[Open the board](https://app.planban.example/boards/deadleg#card=vest)" });
});

test("the hosted tools show every freshness warning they can, and say merges aren't checked here", async () => {
  const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const board: any = {
    ...roadmap,
    roadmapItems: [
      ...roadmap.roadmapItems,
      { id: "ship", title: "Ship it", status: "in-progress", summary: null, nextAction: "Merge PR 41.", tags: [], isGroup: false, parentId: null, priority: 2, updatedAt: week },
    ],
  };
  const hosted: any = { ...service, getBoard: async () => board, unresolved: async () => ({ changes: [] }), working: async () => ({ working: {} }), notePresence: async () => undefined };
  const ask = async (name: string, args: Record<string, unknown>) => {
    const response = await handleMcp(new Request("https://app.planban.example/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), hosted, "https://app.planban.example");
    return (await response.json()).result.structuredContent;
  };
  const got = await ask("planban_get_board", { boardId: "deadleg" });
  assert.equal(got.attention.total, 1);
  assert.deepEqual(got.attention.cards.map((card: any) => [card.id, card.signals.map((signal: any) => signal.kind)]), [["ship", ["quiet"]]]);
  assert.equal(got.attention.awaitingOwner, 1);
  assert.match(got.attention.notes.join(" "), /Merged-PR warnings aren't checked here/u);
  const card = await ask("planban_get_card", { boardId: "deadleg", cardId: "ship" });
  assert.deepEqual(card.staleness.map((signal: any) => signal.kind), ["quiet"]);
  assert.match(card.stalenessNote, /Merged-PR warnings aren't checked here/u);
});

test("a remote refusal keeps its kind and the details to reconcile, as the local tools do", async () => {
  const conflict = { currentRevision: 5, yourRevision: 3, changes: [{ version: 9, revision: 5, at: "2026-10-15T18:00:00.000Z", by: "Ana", agent: false, summary: "Updated Choose the vest supplier", cards: ["vest"] }], card: roadmap.roadmapItems[0] };
  // The real service wrapper, whose mutation refuses as the board does.
  const refusing: any = new McpService({ runMutation: async () => fail("conflict", "Not saved: Ana changed card ...", { currentRevision: 5, conflict }) } as any, "connections-1" as any);
  const response = await handleMcp(new Request("https://app.planban.example/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "planban_update_card", arguments: { boardId: "deadleg", cardId: "vest", summary: "Mine", baseRevision: 3 } } }) }), refusing, "https://app.planban.example");
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.category, "conflict");
  assert.deepEqual(result.structuredContent.error.details, { currentRevision: 5, conflict });
});
