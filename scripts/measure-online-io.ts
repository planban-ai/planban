// Database traffic per online-board operation on a Revival-sized board
// (tests/large-board.ts), against the service's real handlers in memory.
// Prints, for each operation, the bytes of documents its functions read and
// wrote. Run: npx tsx scripts/measure-online-io.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, strToU8 } from "fflate";
import * as storage from "../src/core/storage";
import { onlineLogin } from "../src/core/online/login";
import { refreshBackup } from "../src/core/online/backup";
import { takeOnline } from "../src/core/online/transfers";
import { serviceBridge } from "../tests/service-bridge";
import { largeRoadmap } from "../tests/large-board";

const root = await mkdtemp(join(tmpdir(), "planban-io-"));
process.env.PLANBAN_HOME = join(root, "home");
const bridge = await serviceBridge();
const { meter } = bridge.service;
const results: Array<{ operation: string; read: number; written: number; rows: number; top: string }> = [];

async function measure<T>(operation: string, run: () => Promise<T>): Promise<T> {
  const before = { read: meter.read, written: meter.written, rows: meter.rowsRead, byTable: { ...meter.byTable } };
  const value = await run();
  const tables = Object.entries(meter.byTable).map(([table, bytes]) => [table, bytes - (before.byTable[table] ?? 0)] as const).filter(([, bytes]) => bytes > 0).sort((a, b) => b[1] - a[1]);
  results.push({ operation, read: meter.read - before.read, written: meter.written - before.written, rows: meter.rowsRead - before.rows, top: tables.slice(0, 3).map(([table, bytes]) => `${table} ${kb(bytes)}`).join(", ") });
  return value;
}
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

try {
  const cwd = join(root, "project");
  const state = await storage.initializeProject({ cwd, repoId: "revival-sized", title: "Revival sized", updateAgents: false });
  const roadmap = largeRoadmap(state.roadmap);
  await storage.saveRoadmap(state, roadmap);
  const json = JSON.stringify(roadmap);
  console.log(`Board: ${roadmap.roadmapItems.length} cards, roadmap ${kb(json.length)} as JSON, ${kb(deflateSync(strToU8(json), { level: 6 }).byteLength)} compressed.`);
  await storage.writeDoc({ cwd, cardId: "card-000", kind: "spec", markdown: "# Spec\n\n" + "A paragraph of the spec. ".repeat(200) });
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, cwd);
  const agent = "agent" as const;
  // Some history, so stale edits have versions to rebuild from.
  for (let index = 0; index < 30; index += 1) {
    const revision = (await storage.loadState(cwd)).roadmap.revision;
    await storage.updateCard({ cwd, cardId: `card-${String(index % 100).padStart(3, "0")}`, nextAction: `Warm-up edit ${index}`, baseRevision: revision, actor: agent });
  }
  await refreshBackup(bridge.url, "revival-sized", { force: true });

  const read = await measure("list-cards / query-cards / get-board (whole board read)", () => storage.loadState(cwd));
  await measure("get-card", () => storage.loadCard(cwd, "card-005"));
  const revision = read.roadmap.revision;
  await measure("read-doc", () => storage.readDoc({ cwd, cardId: "card-000", kind: "spec" }));
  await measure("goals", () => storage.readGoals({ cwd }));
  await measure("update-card, current revision", () => storage.updateCard({ cwd, cardId: "card-010", summary: "Fresh summary", baseRevision: revision, actor: agent }));
  await measure("update-card, from a read 1 edit old", () => storage.updateCard({ cwd, cardId: "card-011", summary: "Stale summary", baseRevision: revision, actor: agent }));
  const now = (await storage.loadState(cwd)).roadmap.revision;
  await measure("move-card, current revision", () => storage.moveCard({ cwd, cardId: "card-012", status: "in-progress", baseRevision: now, actor: agent }));
  await measure("backup refresh after a change (once a minute per machine)", () => refreshBackup(bridge.url, "revival-sized", { force: true }));
  await measure("history list", () => storage.historyPayload(cwd));
  const owner = (bridge.service.rows.find((row: any) => row._table === "connections" && row.userId === "ana"))!._id;
  await measure("web live subscription, one re-run", () => bridge.service.liveRevision(owner, "revival-sized"));
  console.log("");
  console.log("| Operation | Read | Written | Rows read | Largest reads |");
  console.log("|---|---:|---:|---:|---|");
  for (const result of results) console.log(`| ${result.operation} | ${kb(result.read)} | ${kb(result.written)} | ${result.rows} | ${result.top} |`);
} finally {
  await bridge.close();
  await rm(root, { recursive: true, force: true });
}
