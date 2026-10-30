// Taking a board online sends it in parts, each small enough for the online
// service's one second of work per request (staging rehearsal, 16 October
// 2026: Revival's 800 KB board versions ran out of time in 4 MB parts).
import assert from "node:assert/strict";
import test from "node:test";
test("taking a large board online sends its history in parts small enough for the service's time limit", async () => {
  const { uploadParts, PART_BYTES } = await import("../src/core/online/transfers");
  const { createEmptyRoadmap } = await import("../src/core/boardOperations");
  // Board versions the size of Revival's (about 800 KB each).
  const big = { ...createEmptyRoadmap({ repoId: "big", title: "Big", now: "2026-10-16T00:00:00.000Z" }), project: { id: "big", title: "Big", status: "active", description: "x".repeat(800 * 1024), tags: [] } };
  const history = Array.from({ length: 6 }, (_, i) => ({ entry: { version: i + 1, roadmapRevision: i + 1, createdAt: "2026-10-16T00:00:00.000Z", actor: "user" as const, operation: "x", summary: "x", affectedCards: [], affectedDocs: [] }, roadmap: big }));
  const parts = uploadParts({ format: "planban-board-bundle", version: 1, roadmap: big, docs: [], history } as never);
  assert.equal(parts.length, 6);
  for (const part of parts) assert.ok((part.history ?? []).length <= 1 && JSON.stringify(part).length <= PART_BYTES * 1.2);
});

test("a board with a thousand cards created in one go still goes online; that entry lists as many as fit", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const storage = await import("../src/core/storage");
  const { onlineLogin } = await import("../src/core/online/login");
  const { takeOnline } = await import("../src/core/online/transfers");
  const { serviceBridge } = await import("./service-bridge");
  const root = await mkdtemp(join(tmpdir(), "planban-bulk-"));
  const saved = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = join(root, "home");
  const bridge = await serviceBridge([["ana", "Ana"]]);
  try {
    const cwd = join(root, "bulk");
    await storage.initializeProject({ cwd, repoId: "bulk", title: "Bulk", updateAgents: false });
    await storage.createCards({ cwd, titles: Array.from({ length: 1_000 }, (_, i) => `Card ${i}`) });
    await onlineLogin(bridge.url, { devUser: "ana" });
    await takeOnline(bridge.url, cwd);
    const history = await storage.historyPayload(cwd);
    const bulk = history.entries.find((entry) => / more cards\)/.test(entry.summary));
    assert.ok(bulk, "the bulk entry says how many more cards it changed");
    assert.equal((await storage.loadState(cwd)).roadmap.roadmapItems.length, 1_000);
  } finally {
    await bridge.close();
    if (saved === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = saved;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a history version holding more documents than one response comes back over several pages", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { onlineLogin } = await import("../src/core/online/login");
  const { exportOnline, attachOnline } = await import("../src/core/online/transfers");
  const { onlineRequest } = await import("../src/core/online/client");
  const { createEmptyRoadmap, planCreateCards } = await import("../src/core/boardOperations");
  const { serviceBridge } = await import("./service-bridge");
  const root = await mkdtemp(join(tmpdir(), "planban-bigversion-"));
  const saved = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = join(root, "home");
  const bridge = await serviceBridge([["ana", "Ana"]]);
  try {
    await onlineLogin(bridge.url, { devUser: "ana" });
    const now = new Date().toISOString();
    const planned = planCreateCards(createEmptyRoadmap({ repoId: "big", title: "Big", now }), { titles: Array.from({ length: 8 }, (_, i) => `Card ${i}`) } as never, { now });
    const roadmap = { ...planned.roadmap, roadmapItems: planned.roadmap.roadmapItems.map((item: any) => ({ ...item, specDoc: `items/${item.id}/spec.md` })) };
    // About 900 KB of ordinary prose per Spec, eight of them in one history version: over 6 MB.
    const prose = (n: number) => Array.from({ length: 9_000 }, (_, i) => `Line ${i} of card ${n}: the club wants the kit in navy and gold, with names on the back.`).join("\n").slice(0, 900_000);
    const docs = roadmap.roadmapItems.map((item: any, n: number) => ({ cardId: item.id, kind: "spec", markdown: prose(n) }));
    const entry = { version: 1, roadmapRevision: roadmap.revision, createdAt: now, actor: "user", operation: "x", summary: "Specs", affectedCards: roadmap.roadmapItems.map((item: any) => item.id), affectedDocs: roadmap.roadmapItems.map((item: any) => ({ cardId: item.id, kind: "spec", path: item.specDoc })) };
    await onlineRequest(bridge.url, "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap, docs, history: [{ entry, roadmap }], historyDocs: docs.map((doc: any) => ({ ...doc, version: 1 })) });
    const cwd = join(root, "big");
    await attachOnline(bridge.url, "big", cwd);
    const bundle = await exportOnline(cwd);
    assert.equal((bundle.historyDocs ?? []).filter((doc) => doc.version === 1).length, 8);
  } finally {
    await bridge.close();
    if (saved === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = saved;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("the whole-board export refuses, pointing to the paged export, when history makes it too large even after the board shrank", async () => {
  const { memoryService } = await import("./hosted-harness");
  const boards = await import("../online/service/convex/boards");
  const transfers = await import("../online/service/convex/transfers");
  const { packJson, unpacked } = await import("../online/service/convex/model/codec");
  const { createEmptyRoadmap, planCreateCard } = await import("../src/core/boardOperations");
  const svc = memoryService();
  const { connectionId } = await svc.signIn("owner");
  const now = new Date().toISOString();
  const first = planCreateCard(createEmptyRoadmap({ repoId: "shrunk", title: "Shrunk", now }), { title: "Card" }, { now, isIdReserved: () => false }).roadmap;
  const roadmap = { ...first, roadmapItems: Array.from({ length: 7 }, (_, i) => ({ ...first.roadmapItems[0]!, id: `card-${i}`, title: `Card ${i}`, priority: i + 1, boardRank: i + 1 })) };
  await (transfers.begin as any)._handler(svc.ctx, { connectionId, transferId: "shrunk-board-1", payload: packJson({ roadmap }) });
  await (transfers.commit as any)._handler(svc.ctx, { connectionId, transferId: "shrunk-board-1", partCount: 0 });
  let seed = 12345;
  const word = () => Array.from({ length: 6 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return String.fromCharCode(97 + (seed % 26)); }).join("");
  const run = async (input: Record<string, unknown>) => unpacked<any>(await (boards.run as any)._handler(svc.ctx, { connectionId, boardId: "shrunk", op: "updateCard", payload: packJson({ ...input, baseRevision: svc.rows.find((row: any) => row._table === "boards").revision }) }));
  for (let i = 0; i < 7; i += 1) await run({ cardId: `card-${i}`, summary: Array.from({ length: 15_000 }, word).join(" ") });
  for (let i = 0; i < 50; i += 1) await run({ cardId: "card-0", title: `Renamed ${i}` });
  for (let i = 0; i < 7; i += 1) await run({ cardId: `card-${i}`, summary: "Small now" });
  await assert.rejects((boards.exportBoard as any)._handler(svc.ctx, { connectionId, boardId: "shrunk" }), /too large to export in one response\. Use the paged export/);
});

test("history exports rebuild only the versions that fit: a large board's page holds one version, and only one more is rebuilt", async () => {
  const { memoryService } = await import("./hosted-harness");
  const boards = await import("../online/service/convex/boards");
  const transfers = await import("../online/service/convex/transfers");
  const { packJson, unpacked } = await import("../online/service/convex/model/codec");
  const { createEmptyRoadmap, planCreateCard } = await import("../src/core/boardOperations");
  const svc = memoryService();
  const { connectionId } = await svc.signIn("owner");
  const now = new Date().toISOString();
  const first = planCreateCard(createEmptyRoadmap({ repoId: "wide-history", title: "Wide history", now }), { title: "Card" }, { now, isIdReserved: () => false }).roadmap;
  // About 15 MB of board per version (150 cards with 100 KB summaries), ten versions.
  const summary = "Discuss the next order with the club and agree how the new kit will be delivered. ".repeat(1_250);
  const roadmap = { ...first, roadmapItems: Array.from({ length: 150 }, (_, i) => ({ ...first.roadmapItems[0]!, id: `card-${i}`, title: `Card ${i}`, summary, priority: i + 1, boardRank: i + 1 })) };
  await (transfers.begin as any)._handler(svc.ctx, { connectionId, transferId: "wide-history-1", payload: packJson({ roadmap }) });
  for (let i = 1; i <= 10; i += 1) {
    const entry = { version: i, roadmapRevision: roadmap.revision, createdAt: now, actor: "user", operation: "x", summary: "Updated board", affectedCards: [], affectedDocs: [] };
    await (transfers.part as any)._handler(svc.ctx, { connectionId, transferId: "wide-history-1", seq: i - 1, payload: packJson({ history: [{ entry, roadmap }] }) });
  }
  await (transfers.commit as any)._handler(svc.ctx, { connectionId, transferId: "wide-history-1", partCount: 10 });
  let rebuilt = 0;
  const parse = JSON.parse;
  JSON.parse = ((text: string, ...rest: unknown[]) => { const value = parse(text, ...(rest as [])); if (value && typeof value === "object" && "roadmapItems" in value) rebuilt += 1; return value; }) as typeof JSON.parse;
  try {
    const page = unpacked<{ history: unknown[] }>(await (boards.exportHistory as any)._handler(svc.ctx, { connectionId, boardId: "wide-history", after: 0, limit: 8 }));
    assert.equal(page.history.length, 1);
    assert.ok(rebuilt <= 2, `rebuilt ${rebuilt} versions for a page of one`);
    rebuilt = 0;
    await assert.rejects((boards.exportBoard as any)._handler(svc.ctx, { connectionId, boardId: "wide-history" }), /too large to export in one response/);
    assert.ok(rebuilt <= 2, `rebuilt ${rebuilt} versions before refusing`);
  } finally {
    JSON.parse = parse;
  }
});
