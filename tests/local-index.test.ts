// Strict Local Mode (owner decision 20): Planban is an index, not storage. Every local write path
// refuses embedded files and oversized text, a card holding files refuses changes until they are
// moved out, and `move-files-out` tidies it. Every board here lives in a temporary PLANBAN_HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planbanStalenessLine } from "../plugins/planban/scripts/claude-session-context.mjs";
import { PlanbanCardHoldsFilesError } from "../src/core/cardFiles";
import { moveFilesOut } from "../src/core/moveFilesOut";
import { stalenessAttention, stalenessChipLabel, stalenessLine } from "../src/core/staleness";
import { clearStalenessCaches, collectStaleness } from "../src/core/stalenessSources";
import {
  createCard,
  createGroup,
  deleteArchivedCard,
  historyPayload,
  initializeProject,
  loadState,
  moveCard,
  PlanbanValidationError,
  readDoc,
  reconstructHierarchy,
  reorderCards,
  restoreCardVersion,
  restoreDocVersion,
  setCardStatus,
  updateCard,
  writeDoc,
} from "../src/core/storage";
import { startServer } from "../src/server/server";
import { planbanCommand } from "../src/core/command";
const CMD = planbanCommand().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const repoId = "index-test";
const pngBase64 = Buffer.alloc(3000, 7).toString("base64");
const dataUriSpec = `# Spec\n\n![front](data:image/png;base64,${pngBase64})\n`;
const MCP_SERVER = join(process.cwd(), "plugins/planban/scripts/start-planban-mcp.mjs");

interface Board {
  root: string;
  cwd: string;
  home: string;
  planningRoot: string;
  folder: (cardId: string) => string;
}

async function withBoard(run: (board: Board) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "planban-index-test-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  const previousHome = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = home;
  clearStalenessCaches();
  try {
    await initializeProject({ cwd, repoId, title: "Index Test", updateAgents: false });
    const planningRoot = join(home, "repos", repoId);
    await run({ root, cwd, home, planningRoot, folder: (cardId) => join(planningRoot, "items", cardId) });
  } finally {
    if (previousHome === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = previousHome;
    clearStalenessCaches();
    rmSync(root, { recursive: true, force: true });
  }
}

/** Puts files where agents used to drop them: a picture, and a folder of evidence. */
function dropFiles(folder: string) {
  writeFileSync(join(folder, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  mkdirSync(join(folder, "evidence"), { recursive: true });
  writeFileSync(join(folder, "evidence", "run.log"), "ok\n");
}

test("single-card creation reserves folders containing leftover documents", async () => {
  await withBoard(async ({ cwd, folder }) => {
    mkdirSync(folder("alpha"), { recursive: true });
    const oldSpec = "# Kept Spec\n\nEvidence left by an older card.\n";
    writeFileSync(join(folder("alpha"), "spec.md"), oldSpec);
    const created = (await createCard({ cwd, title: "Alpha", specMarkdown: "# New Spec\n" })).createdCard;
    assert.notEqual(created.id, "alpha");
    assert.equal(readFileSync(join(folder("alpha"), "spec.md"), "utf8"), oldSpec);
    assert.equal((await readDoc({ cwd, cardId: created.id, kind: "spec" })).markdown, "# New Spec\n");
  });
});

test("every local write refuses embedded files and oversized text, with advice on writing a reference", async () => {
  await withBoard(async ({ cwd, planningRoot }) => {
    const card = (await createCard({ cwd, title: "Alpha", status: "up-next" })).createdCard;
    const refuses = (pattern: RegExp) => (error: unknown) => error instanceof PlanbanValidationError && pattern.test(error.message);
    const reference = /GitHub link.*local path labelled with its machine/su;

    await assert.rejects(createCard({ cwd, title: "Beta", specMarkdown: dataUriSpec }), refuses(/the Spec of card Beta contains (?:an embedded file|a picture stored in the text)/u));
    await assert.rejects(createCard({ cwd, title: "Beta", planMarkdown: pngBase64 }), refuses(/the Plan of card Beta contains an encoded file/u));
    await assert.rejects(createGroup({ cwd, title: "Gamma", summary: `Logo ${pngBase64}` }), refuses(/card gamma contains an encoded file/u));
    await assert.rejects(writeDoc({ cwd, cardId: card.id, kind: "spec", markdown: dataUriSpec }), refuses(reference));
    await assert.rejects(writeDoc({ cwd, cardId: card.id, kind: "spec", markdown: "<~" + "z".repeat(768) + "~>" }), refuses(/encoded file/u));
    await assert.rejects(writeDoc({ cwd, cardId: card.id, kind: "plan", markdown: "word ".repeat(220 * 1024) }), refuses(/limit is 1024 KB/u));
    await assert.rejects(updateCard({ cwd, cardId: card.id, summary: `Screenshot: data:image/png;base64,${pngBase64}` }), refuses(/card alpha contains (?:an embedded file|a picture stored in the text)/u));
    await assert.rejects(updateCard({ cwd, cardId: card.id, metadata: { logo: Array.from({ length: 4000 }, (_, index) => index % 256) } }), refuses(/long lists? of numbers/u));
    await assert.rejects(updateCard({ cwd, cardId: card.id, summary: "y ".repeat(70 * 1024) }), refuses(/limit is 128 KB/u));

    // Nothing was written, and ordinary text, including a document the size of the largest real Plan, still saves.
    assert.deepEqual((await loadState(cwd)).roadmap.roadmapItems.map((item) => item.id), ["alpha"]);
    await writeDoc({ cwd, cardId: card.id, kind: "plan", markdown: "Planning prose with a [link](https://github.com/o/r/blob/main/a.png). ".repeat(7_500) });
    const table = ["|North|South|East|West|", "|---|---|---|---|", ...Array(160).fill("|north|south|east|west|")].join("\n");
    await writeDoc({ cwd, cardId: card.id, kind: "plan", markdown: table });
    assert.equal(readFileSync(join(planningRoot, "items", card.id, "plan.md"), "utf8"), table);
    await updateCard({ cwd, cardId: card.id, summary: "Renders live at Mac mini: ~/Projects/app/renders/front.png." });
  });
});

test("a card holding files is refused every change until tidied, while reads and other cards still work", async () => {
  await withBoard(async ({ cwd, folder }) => {
    const alpha = (await createCard({ cwd, title: "Alpha", status: "up-next" })).createdCard;
    await createCard({ cwd, title: "Beta", status: "up-next" });
    const group = (await createGroup({ cwd, title: "Group", summary: "Objective" })).createdGroup;
    await updateCard({ cwd, cardId: alpha.id, summary: "Second version" });
    await writeDoc({ cwd, cardId: alpha.id, kind: "spec", markdown: "# Alpha Spec\n\nSecond version.\n" });
    const archived = (await createCard({ cwd, title: "Old", status: "archived" })).createdCard;
    const firstVersion = (await historyPayload(cwd)).entries.find((entry) => entry.operation === "card.create" && entry.affectedCards.includes(alpha.id))!.version;
    dropFiles(folder(alpha.id));
    dropFiles(folder(archived.id));
    // Planban's own unfinished saves and the operating system's folder settings are not files.
    writeFileSync(join(folder("beta"), ".DS_Store"), "");
    writeFileSync(join(folder("beta"), `.spec.md.123.1760000000000.${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.tmp`), "");

    const holdsFiles = (error: unknown) => {
      assert.ok(error instanceof PlanbanCardHoldsFilesError, String(error));
      assert.equal(error.cardId === alpha.id || error.cardId === archived.id, true);
      assert.deepEqual(error.files, ["evidence/run.log", "shot.png"]);
      assert.match(error.message, /holds 2 files in its folder, .*: evidence\/run\.log, shot\.png\./u);
      assert.match(error.message, /Planban is an index, not file storage.*reading it still works/su);
      assert.match(error.message, new RegExp(`${CMD} move-files-out (alpha|old) --to <folder>.*--dry-run.*without overwriting or deleting anything`, "su"));
      return true;
    };
    const before = readFileSync(join(folder(alpha.id), "spec.md"), "utf8");
    await assert.rejects(updateCard({ cwd, cardId: alpha.id, summary: "Changed" }), holdsFiles);
    await assert.rejects(writeDoc({ cwd, cardId: alpha.id, kind: "plan", markdown: "# Plan\n" }), holdsFiles);
    await assert.rejects(moveCard({ cwd, cardId: alpha.id, status: "in-progress" }), holdsFiles);
    await assert.rejects(moveCard({ cwd, cardId: alpha.id, afterId: "beta" }), holdsFiles);
    await assert.rejects(setCardStatus(cwd, alpha.id, "archived"), holdsFiles);
    await assert.rejects(moveCard({ cwd, cardId: alpha.id, parentId: group.id }), holdsFiles);
    await assert.rejects(reconstructHierarchy({ cwd, groups: [{ id: group.id, childIds: [alpha.id] }], baseRevision: (await loadState(cwd)).roadmap.revision }), holdsFiles);
    await assert.rejects(restoreCardVersion({ cwd, version: firstVersion, cardId: alpha.id }), holdsFiles);
    await assert.rejects(restoreDocVersion({ cwd, version: firstVersion, cardId: alpha.id, kind: "spec" }), holdsFiles);
    const items = (await loadState(cwd)).roadmap.roadmapItems;
    await assert.rejects(reorderCards({ cwd, items: items.map((item) => ({ id: item.id, status: item.id === alpha.id ? "pending" : item.status })) }), holdsFiles);
    // Deleting an archived card would delete its folder, files and all.
    await assert.rejects(deleteArchivedCard({ cwd, cardId: archived.id }), holdsFiles);
    assert.ok(existsSync(join(folder(archived.id), "shot.png")));

    // Reads still work; nothing changed; other cards can still be changed and reordered around it.
    assert.equal((await readDoc({ cwd, cardId: alpha.id, kind: "spec" })).markdown, before);
    assert.equal((await loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === alpha.id)!.summary, "Second version");
    await updateCard({ cwd, cardId: "beta", summary: "Still editable" });
    await writeDoc({ cwd, cardId: "beta", kind: "plan", markdown: "# Beta Plan\n" });
    await moveCard({ cwd, cardId: "beta", afterId: null });
    const card = (await createCard({ cwd, title: "Alpha" })).createdCard;
    assert.equal(card.id, "alpha-2", "a new card never takes over a folder that holds files");
  });
});

test("cards holding files are flagged in stale signals, the session-start line and the board note", async () => {
  await withBoard(async ({ cwd, planningRoot, folder }) => {
    await createCard({ cwd, title: "Alpha", status: "pending" });
    await createCard({ cwd, title: "Beta", status: "up-next" });
    dropFiles(folder("alpha"));
    const state = await loadState(cwd);
    const staleness = await collectStaleness({ cwd, planningRoot, items: state.roadmap.roadmapItems });
    assert.deepEqual(Object.keys(staleness.cards), ["alpha"], "a parked card is flagged too: it refuses changes whatever its status");
    const [signal] = staleness.cards.alpha!;
    assert.equal(signal!.kind, "holds-files");
    assert.match(signal!.detail, new RegExp(`^Holds 2 files in its folder \\(evidence\\/run\\.log, shot\\.png\\); changes are refused until they are moved out with \`${CMD} move-files-out alpha --to <folder>\`$`, "u"));
    assert.equal(stalenessChipLabel(signal!), "Holds files");
    const attention = stalenessAttention(staleness, state.roadmap.roadmapItems);
    assert.deepEqual(attention.holdingFiles, { ids: ["alpha"], total: 1 });
    assert.equal(attention.total, 0, "holding files is not a stale-content signal an edit could fix");
    const line = `1 card holds files in its folder (alpha). Planban is an index, not file storage, so it refuses changes to that card until the files are moved out with \`${planbanCommand()} move-files-out <card> --to <folder>\`.`;
    assert.equal(stalenessLine(attention), line);
    assert.equal(await planbanStalenessLine({ projectDir: cwd }), line);
  });
});

test("move-files-out previews, refuses to overwrite, moves the files, records references and unflags the card", async () => {
  await withBoard(async ({ root, cwd, home, folder }) => {
    await createCard({ cwd, title: "Alpha", status: "up-next", specMarkdown: "# Alpha Spec\n\nThe purpose.\n" });
    dropFiles(folder("alpha"));
    mkdirSync(join(folder("alpha"), "evidence", "empty"), { recursive: true });
    symlinkSync("/tmp/elsewhere", join(folder("alpha"), "link"));
    const linkTarget = readlinkSync(join(folder("alpha"), "link"));
    const destination = join(root, "repo", "docs", "alpha");
    const now = new Date("2026-10-12T09:00:00Z");

    const preview = await moveFilesOut({ cwd, cardId: "alpha", to: destination, dryRun: true, machine: "Test Mac", now });
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.moves.map((move) => move.from), ["evidence/empty/", "evidence/run.log", "link", "shot.png"]);
    assert.deepEqual(preview.conflicts, []);
    assert.match(preview.specSection, /^## Files\n\nMoved out of this card's Planban folder on 12 October 2026\. Planban is an index, not file storage, so these files now live here:\n\n/u);
    assert.match(preview.specSection, /- On Test Mac: .*[\\/]docs[\\/]alpha[\\/]evidence[\\/] \(a folder of 1 file\)\n- On Test Mac: .*[\\/]docs[\\/]alpha[\\/]link\n- On Test Mac: .*[\\/]docs[\\/]alpha[\\/]shot\.png\n$/u);
    assert.ok(existsSync(join(folder("alpha"), "shot.png")) && !existsSync(destination), "a dry run changes nothing");

    // Never overwrites: one clash refuses the whole move, and nothing moves.
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "shot.png"), "someone else's file");
    assert.deepEqual((await moveFilesOut({ cwd, cardId: "alpha", to: destination, dryRun: true, machine: "Test Mac" })).conflicts, [join(destination, "shot.png")]);
    await assert.rejects(moveFilesOut({ cwd, cardId: "alpha", to: destination, machine: "Test Mac" }), /Nothing was moved: this path already exists .*never overwrites a file: shot\.png\./su);
    assert.equal(readFileSync(join(destination, "shot.png"), "utf8"), "someone else's file");
    assert.ok(existsSync(join(folder("alpha"), "evidence", "run.log")));
    rmSync(join(destination, "shot.png"));

    // Never into Planban's own folders.
    await assert.rejects(moveFilesOut({ cwd, cardId: "alpha", to: join(home, "files") }), /outside Planban's own folders/u);

    const result = await moveFilesOut({ cwd, cardId: "alpha", to: destination, machine: "Test Mac", now });
    assert.equal(result.moves.length, 4);
    assert.ok(lstatSync(join(destination, "evidence", "empty")).isDirectory(), "an empty folder moves too");
    assert.deepEqual([...readFileSync(join(destination, "shot.png"))], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(readFileSync(join(destination, "evidence", "run.log"), "utf8"), "ok\n");
    assert.ok(lstatSync(join(destination, "link")).isSymbolicLink());
    assert.equal(readlinkSync(join(destination, "link")), linkTarget);
    assert.ok(!existsSync(join(folder("alpha"), "evidence")), "folders the move emptied are removed");
    assert.ok(existsSync(join(folder("alpha"), "spec.md")));
    const spec = (await readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown;
    assert.ok(spec.startsWith("# Alpha Spec\n\nThe purpose.\n\n## Files\n\n"), spec);
    assert.match(spec, /- On Test Mac: .*[\\/]docs[\\/]alpha[\\/]shot\.png\n$/u);
    const history = (await historyPayload(cwd)).entries.find((entry) => entry.operation === "card.files.move-out")!;
    assert.equal(history.operation, "card.files.move-out");
    assert.match(history.summary, /^Moved 4 files out of Alpha to Test Mac: /u);

    // The card is clean again: it can be changed, and running again finds nothing to do.
    await updateCard({ cwd, cardId: "alpha", summary: "Tidied" });
    assert.equal((await moveFilesOut({ cwd, cardId: "alpha", to: destination })).alreadyClean, true);
    // A second tidy-up adds a dated section rather than a second "Files" heading.
    writeFileSync(join(folder("alpha"), "late.txt"), "late\n");
    await moveFilesOut({ cwd, cardId: "alpha", to: join(root, "more"), machine: "Test Mac", now });
    assert.match((await readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown, /\n## Files moved out on 12 October 2026\n/u);
  });
});

function cli(args: string[], home: string, input?: string) {
  return spawnSync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, PLANBAN_HOME: home },
    ...(input === undefined ? {} : { input }),
  });
}

test("the CLI's write-doc states the document version it was based on when given one", async () => {
  await withBoard(async ({ cwd, home }) => {
    await createCard({ cwd, title: "Alpha", status: "up-next" });
    const read = JSON.parse(cli(["read-doc", "alpha", "spec", "--cwd", cwd, "-o", "json"], home).stdout);
    const stale = cli(["write-doc", "alpha", "spec", "--cwd", cwd, "--expected-mtime", String(read.mtimeMs - 1000)], home, "# Stale\n");
    assert.equal(stale.status, 1);
    const asNew = cli(["write-doc", "alpha", "spec", "--cwd", cwd, "--expected-mtime", "new"], home, "# New\n");
    assert.equal(asNew.status, 1, "an existing document can't be written as new");
    for (const value of ["soon", "", " "]) assert.equal(cli(["write-doc", "alpha", "spec", "--cwd", cwd, "--expected-mtime", value], home, "# Bad\n").status, 1, `refuses ${JSON.stringify(value)}`);
    await createCard({ cwd, title: "Beta", status: "up-next" });
    const created = cli(["write-doc", "beta", "plan", "--cwd", cwd, "--expected-mtime", "new", "-o", "json"], home, "# New plan\n");
    assert.equal(created.status, 0, created.stderr);
    const ok = cli(["write-doc", "alpha", "spec", "--cwd", cwd, "--expected-mtime", String(read.mtimeMs), "-o", "json"], home, "# Fresh\n");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).markdown, "# Fresh\n");
  });
});

test("the CLI refuses embedded files and flagged cards, and tidies with move-files-out", async () => {
  await withBoard(async ({ root, cwd, home, folder }) => {
    await createCard({ cwd, title: "Alpha", status: "up-next" });
    const embedded = cli(["write-doc", "alpha", "spec", "--cwd", cwd], home, dataUriSpec);
    assert.equal(embedded.status, 1);
    assert.match(embedded.stderr, /^Not saved: the Spec of card alpha contains (?:an embedded file|a picture stored in the text).*local path labelled with its machine/su);

    dropFiles(folder("alpha"));
    const refused = cli(["update-card", "alpha", "--summary", "Changed", "--cwd", cwd], home);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, new RegExp(`holds 2 files in its folder.*${CMD} move-files-out alpha --to <folder>`, "su"));
    assert.equal(cli(["get-card", "alpha", "--cwd", cwd, "-o", "json"], home).status, 0, "reads still work");

    const destination = join(root, "kept");
    const preview = cli(["move-files-out", "alpha", "--to", destination, "--dry-run", "--cwd", cwd], home);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /^Dry run: nothing has changed\. 2 files would move from card alpha to .*kept:\n  evidence\/run\.log -> .*\n  shot\.png -> .*\n\nThis section would be added to the end of the card's Spec:\n\n## Files\n/u);
    assert.ok(!existsSync(destination));

    const moved = cli(["move-files-out", "alpha", "--to", destination, "--cwd", cwd, "-o", "json"], home);
    assert.equal(moved.status, 0, moved.stderr);
    assert.equal(JSON.parse(moved.stdout).moves.length, 2);
    assert.ok(existsSync(join(destination, "shot.png")));
    assert.equal(cli(["update-card", "alpha", "--summary", "Changed", "--cwd", cwd], home).status, 0);
  });
});

test("the web board's API refuses embedded files and flagged cards, and flags them in board state", async () => {
  await withBoard(async ({ cwd, folder }) => {
    await createCard({ cwd, title: "Alpha", status: "up-next" });
    await createCard({ cwd, title: "Beta", status: "up-next" });
    const server = await startServer({ cwd, port: await freePort(), useVite: false });
    try {
      const send = (method: string, path: string, body: unknown) => fetch(`${server.url}/api/boards/${repoId}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const embedded = await send("PUT", "/cards/beta/docs/spec", { markdown: dataUriSpec });
      assert.equal(embedded.status, 422);
      assert.match(((await embedded.json()) as { error: string }).error, /^Not saved: the Spec of card beta contains (?:an embedded file|a picture stored in the text)/u);
      const created = await send("POST", "/cards", { title: "Gamma", summary: `Logo ${pngBase64}` });
      assert.equal(created.status, 422);

      dropFiles(folder("alpha"));
      const patched = await send("PATCH", "/cards/alpha", { summary: "Changed" });
      assert.equal(patched.status, 409);
      assert.match(((await patched.json()) as { error: string }).error, new RegExp(`holds 2 files in its folder.*${CMD} move-files-out alpha`, "su"));
      assert.equal((await send("POST", "/cards/alpha/move", { status: "in-progress" })).status, 409);
      assert.equal((await send("PUT", "/cards/alpha/docs/plan", { markdown: "# Plan\n" })).status, 409);
      assert.equal((await fetch(`${server.url}/api/boards/${repoId}/cards/alpha/docs/spec`)).status, 200, "reads still work");

      const state = await (await fetch(`${server.url}/api/boards/${repoId}/state`)).json() as { staleness: { cards: Record<string, Array<{ kind: string }>> } };
      assert.deepEqual(state.staleness.cards.alpha!.map((signal) => signal.kind), ["holds-files"]);
    } finally {
      await server.close();
    }
  });
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function runMcp(requests: unknown[], home: string) {
  const result = spawnSync(process.execPath, [MCP_SERVER], {
    encoding: "utf8",
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    // A closed port keeps the Board URL probe away from any real Planban service.
    env: { ...process.env, PLANBAN_HOME: home, PLANBAN_ACTIVITY_URL: "http://127.0.0.1:9", PLANBAN_REPO_ROOT: process.cwd() },
    timeout: 8_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

test("MCP tools teach the rule, flag cards holding files, refuse writes to them, and tidy them", async () => {
  await withBoard(async ({ root, cwd, home, folder }) => {
    await createCard({ cwd, title: "Alpha", status: "up-next" });
    dropFiles(folder("alpha"));
    const destination = join(root, "kept");
    const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { cwd, ...args } } });
    const responses = runMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      call(3, "planban_get_card", { cardId: "alpha" }),
      call(4, "planban_get_board", {}),
      call(5, "planban_write_doc", { cardId: "alpha", kind: "spec", markdown: "# Changed\n" }),
      call(6, "planban_create_card", { title: "Beta", specMarkdown: dataUriSpec }),
      call(7, "planban_move_files_out", { cardId: "alpha", to: destination, dryRun: true }),
      call(8, "planban_move_files_out", { cardId: "alpha", to: destination }),
      call(9, "planban_update_card", { cardId: "alpha", summary: "Tidied" }),
    ], home);

    const tools = responses[1].result.tools as Array<{ name: string; description: string }>;
    for (const name of ["planban_create_card", "planban_update_card", "planban_write_doc"]) {
      assert.match(tools.find((tool) => tool.name === name)!.description, /Planban is an index, not file storage.*GitHub link.*local path labelled with its machine/su, name);
    }
    assert.match(tools.find((tool) => tool.name === "planban_move_files_out")!.description, /never overwriting or deleting anything/u);
    assert.match(responses[2].result.content[0].text, new RegExp(`\\nThis card holds 2 files in its folder \\(evidence\\/run\\.log, shot\\.png\\); changes are refused until they are moved out with \`${CMD} move-files-out alpha --to <folder>\` or planban_move_files_out\\. Planban is an index, not file storage\\.`, "u"));
    assert.match(responses[3].result.content[0].text, /\n1 card holds files in its folder \(alpha\)\./u);
    assert.equal(responses[4].result.isError, true);
    assert.match(responses[4].result.content[0].text, /holds 2 files in its folder.*planban_move_files_out/su);
    assert.equal(responses[5].result.isError, true);
    assert.match(responses[5].result.content[0].text, /^Not saved: the Spec of card Beta contains (?:an embedded file|a picture stored in the text)/u);
    assert.match(responses[6].result.content[0].text, /^Dry run: nothing changed\. 2 files would move from card alpha to /u);
    assert.match(responses[7].result.content[0].text, /^Moved 2 files from card alpha to .* and added a Files section to its Spec\./u);
    assert.ok(existsSync(join(destination, "evidence", "run.log")));
    assert.match(responses[8].result.content[0].text, /^Updated Planban card alpha\./u);
    assert.match((await readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown, /\n## Files\n/u);
  });
});

test("an empty folder flags a card, and move-files-out keeps relative links working and records partial moves", async () => {
  await withBoard(async ({ root, cwd, folder }) => {
    await createCard({ cwd, title: "Alpha", status: "up-next" });
    mkdirSync(join(folder("alpha"), "drafts"));
    await assert.rejects(updateCard({ cwd, cardId: "alpha", summary: "Changed" }), /holds 1 file in its folder, .*: drafts\/\./u);
    const emptied = await moveFilesOut({ cwd, cardId: "alpha", to: join(root, "kept-empty"), machine: "Test Mac" });
    assert.match(emptied.specSection, /kept-empty[\\/]drafts[\\/] \(an empty folder\)\n$/u);
    assert.ok(lstatSync(join(root, "kept-empty", "drafts")).isDirectory());
    assert.ok(!existsSync(join(folder("alpha"), "drafts")));
    await updateCard({ cwd, cardId: "alpha", summary: "Changed" });

    // Relative links: one to a file moving with it stays relative; one to a file staying behind becomes absolute.
    writeFileSync(join(folder("alpha"), "shot.png"), "png");
    writeFileSync(join(root, "outside.txt"), "outside");
    symlinkSync("shot.png", join(folder("alpha"), "latest"));
    const outsideLink = join(folder("alpha"), "outside");
    symlinkSync(join("..", "..", "..", "..", "..", "outside.txt"), outsideLink);
    assert.equal(readFileSync(outsideLink, "utf8"), "outside", "the test link works before the move");
    const kept = join(root, "kept-links");
    await moveFilesOut({ cwd, cardId: "alpha", to: kept, machine: "Test Mac" });
    assert.equal(readlinkSync(join(kept, "latest")), "shot.png");
    assert.equal(readFileSync(join(kept, "latest"), "utf8"), "png");
    assert.equal(readlinkSync(join(kept, "outside")), realpathSync.native(join(root, "outside.txt")));
    assert.equal(readFileSync(join(kept, "outside"), "utf8"), "outside");
  });
});

test("move-files-out cannot be led back into Planban through a link, and refuses what it cannot move", { skip: process.platform === "win32" }, async () => {
  await withBoard(async ({ root, cwd, home, folder }) => {
    await createCard({ cwd, title: "Alpha", status: "up-next" });
    writeFileSync(join(folder("alpha"), "a.txt"), "a");
    symlinkSync(home, join(root, "alias"));
    await assert.rejects(moveFilesOut({ cwd, cardId: "alpha", to: join(root, "alias", "kept") }), /outside Planban's own folders/u);
    assert.ok(existsSync(join(folder("alpha"), "a.txt")));

    // A named pipe is neither a file nor a link: nothing moves.
    assert.equal(spawnSync("mkfifo", [join(folder("alpha"), "pipe")]).status, 0);
    await assert.rejects(moveFilesOut({ cwd, cardId: "alpha", to: join(root, "kept") }), /Nothing was moved: Planban moves only files, links and empty folders, and pipe is something else/u);
    assert.ok(existsSync(join(folder("alpha"), "a.txt")) && !existsSync(join(root, "kept", "a.txt")));
  });
});

test("when a move cannot finish, everything moved so far goes back", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  await withBoard(async ({ root, cwd, folder }) => {
    await createCard({ cwd, title: "Alpha", status: "up-next" });
    writeFileSync(join(folder("alpha"), "a.txt"), "a");
    symlinkSync(join("z", "b.txt"), join(folder("alpha"), "b-link"));
    mkdirSync(join(folder("alpha"), "z"));
    writeFileSync(join(folder("alpha"), "z", "b.txt"), "b");
    const specBefore = (await readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown;
    const destination = join(root, "kept");
    mkdirSync(join(destination, "z"), { recursive: true });
    chmodSync(join(destination, "z"), 0o500);
    try {
      await assert.rejects(moveFilesOut({ cwd, cardId: "alpha", to: destination, machine: "Test Mac" }), /^Error: Nothing was moved: .*Everything is back in the card's folder\./su);
    } finally {
      chmodSync(join(destination, "z"), 0o700);
    }
    // a.txt and the link moved before z/b.txt failed; both are back exactly as they were.
    assert.equal(readFileSync(join(folder("alpha"), "a.txt"), "utf8"), "a");
    assert.equal(readlinkSync(join(folder("alpha"), "b-link")), join("z", "b.txt"));
    assert.ok(!existsSync(join(destination, "a.txt")) && !existsSync(join(destination, "b-link")));
    assert.equal((await readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown, specBefore);
    await assert.rejects(updateCard({ cwd, cardId: "alpha", summary: "Changed" }), PlanbanCardHoldsFilesError);
    // Running again, with the problem fixed, moves everything and the link still works.
    await moveFilesOut({ cwd, cardId: "alpha", to: destination, machine: "Test Mac" });
    assert.equal(readFileSync(join(destination, "b-link"), "utf8"), "b");
    assert.match((await readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown, /- On Test Mac: .*kept[\\/]a\.txt\n/u);
    await updateCard({ cwd, cardId: "alpha", summary: "Changed" });
  });
});

test("board titles are checked too, when a board is created or duplicated", async () => {
  await withBoard(async ({ root }) => {
    const { duplicateBoard } = await import("../src/core/registry");
    await assert.rejects(
      initializeProject({ cwd: join(root, "other"), repoId: "other", title: `Logo data:image/png;base64,${pngBase64}`, updateAgents: false }),
      /^PlanbanValidationError: Not saved: the board title contains (?:an embedded file|a picture stored in the text)/u,
    );
    await assert.rejects(duplicateBoard({ sourceRepoId: repoId, title: pngBase64 }), /Not saved: the board title contains an encoded file/u);
  });
});

test("move-files-out points moved links at the Spec and Plan that stay, and hands back references it could not record", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  await withBoard(async ({ root, cwd, planningRoot, folder }) => {
    await createCard({ cwd, title: "Alpha", status: "up-next", planMarkdown: "# Plan\n" });
    symlinkSync("spec.md", join(folder("alpha"), "spec-link"));
    symlinkSync("plan.md", join(folder("alpha"), "plan-link"));
    const kept = join(root, "kept-links");
    await moveFilesOut({ cwd, cardId: "alpha", to: kept, machine: "Test Mac" });
    assert.equal(readlinkSync(join(kept, "spec-link")), realpathSync.native(join(folder("alpha"), "spec.md")));
    assert.equal(readlinkSync(join(kept, "plan-link")), realpathSync.native(join(folder("alpha"), "plan.md")));
    assert.equal(readFileSync(join(kept, "plan-link"), "utf8"), "# Plan\n");

    // A Spec kept in a folder Planban cannot write to: every file moves, and the error carries the references.
    await createCard({ cwd, title: "Beta", status: "up-next" });
    const roadmapFile = join(planningRoot, "roadmap.json");
    const roadmap = JSON.parse(readFileSync(roadmapFile, "utf8"));
    roadmap.roadmapItems.find((item: { id: string }) => item.id === "beta").specDoc = "locked/beta-spec.md";
    writeFileSync(roadmapFile, JSON.stringify(roadmap));
    mkdirSync(join(planningRoot, "locked"));
    writeFileSync(join(planningRoot, "locked", "beta-spec.md"), "# Beta Spec\n");
    writeFileSync(join(folder("beta"), "shot.png"), "png");
    chmodSync(join(planningRoot, "locked"), 0o500);
    try {
      await assert.rejects(
        moveFilesOut({ cwd, cardId: "beta", to: join(root, "kept-beta"), machine: "Test Mac" }),
        /^Error: Moved the file to .*kept-beta, and nothing was deleted\. The Files section could not be added to the card's Spec \(.*\), so add it yourself, for example with planban write-doc:\n\n## Files\n\n.*- On Test Mac: .*kept-beta[\\/]shot\.png\n$/su,
      );
    } finally {
      chmodSync(join(planningRoot, "locked"), 0o700);
    }
    assert.equal(readFileSync(join(root, "kept-beta", "shot.png"), "utf8"), "png");
  });
});

test("links reached through a moving linked folder keep working", { skip: process.platform === "win32" }, async () => {
  await withBoard(async ({ root, cwd, folder }) => {
    await createCard({ cwd, title: "Alpha", status: "up-next" });
    mkdirSync(join(root, "renders"));
    writeFileSync(join(root, "renders", "image.png"), "png");
    symlinkSync(join(root, "renders"), join(folder("alpha"), "assets"));
    symlinkSync(join("assets", "image.png"), join(folder("alpha"), "latest"));
    symlinkSync(join(folder("alpha"), "assets", "image.png"), join(folder("alpha"), "latest-absolute"));
    const kept = join(root, "kept");
    await moveFilesOut({ cwd, cardId: "alpha", to: kept, machine: "Test Mac" });
    assert.equal(readFileSync(join(kept, "latest"), "utf8"), "png");
    assert.equal(readFileSync(join(kept, "latest-absolute"), "utf8"), "png");
    assert.equal(readFileSync(join(kept, "assets", "image.png"), "utf8"), "png");

    // A linked folder pointing back at the card folder: the link through it follows the file that moved.
    await createCard({ cwd, title: "Beta", status: "up-next" });
    writeFileSync(join(folder("beta"), "shot.png"), "beta png");
    symlinkSync(".", join(folder("beta"), "assets"));
    symlinkSync(join("assets", "shot.png"), join(folder("beta"), "latest"));
    const keptBeta = join(root, "kept-beta");
    await moveFilesOut({ cwd, cardId: "beta", to: keptBeta, machine: "Test Mac" });
    assert.equal(readlinkSync(join(keptBeta, "latest")), "shot.png");
    assert.equal(readFileSync(join(keptBeta, "latest"), "utf8"), "beta png");
    assert.equal(readlinkSync(join(keptBeta, "assets")), realpathSync.native(folder("beta")));
  });
});

test("a reorder may move other cards around a card holding files, but never repositions it", async () => {
  await withBoard(async ({ cwd, folder }) => {
    for (const title of ["Alpha", "Beta", "Gamma"]) await createCard({ cwd, title, status: "up-next" });
    writeFileSync(join(folder("beta"), "evidence.txt"), "kept\n");
    const order = async () => (await loadState(cwd)).roadmap.roadmapItems.map((item) => item.id);
    const reorder = (ids: string[]) => reorderCards({ cwd, items: ids.map((id) => ({ id, status: "up-next" as const })) });

    // Gamma moves to the top: Beta's rank changes, but only Gamma was repositioned.
    await reorder(["gamma", "alpha", "beta"]);
    assert.deepEqual(await order(), ["gamma", "alpha", "beta"]);
    await moveCard({ cwd, cardId: "alpha", afterId: "beta" });
    assert.deepEqual(await order(), ["gamma", "beta", "alpha"]);
    // Swapping Beta with a neighbour is read as the neighbour moving.
    await reorder(["beta", "gamma", "alpha"]);
    assert.deepEqual(await order(), ["beta", "gamma", "alpha"], "Gamma moved down past Beta");
    // Moving Beta to the end, past two cards that keep their order, repositions Beta itself.
    await assert.rejects(reorder(["gamma", "alpha", "beta"]), (error: unknown) => error instanceof PlanbanCardHoldsFilesError && error.cardId === "beta");
    assert.deepEqual(await order(), ["beta", "gamma", "alpha"]);
  });
});

test("a copy of a board carries its text only, checked, and never the files in its folders", async () => {
  await withBoard(async ({ home, cwd, folder }) => {
    const { duplicateBoard } = await import("../src/core/registry");
    await createCard({ cwd, title: "Alpha", status: "up-next", planMarkdown: "# Alpha Plan\n" });
    const items = join(folder("alpha"), "..");
    writeFileSync(join(folder("alpha"), "evidence.bin"), Buffer.from([0, 1, 2]));
    mkdirSync(join(items, "supporting files"));
    writeFileSync(join(items, "supporting files", "evidence.bin"), "x");
    mkdirSync(join(items, "deleted-card"));
    writeFileSync(join(items, "deleted-card", "spec.md"), dataUriSpec);
    writeFileSync(join(items, "notes.txt"), "stray");
    if (process.platform !== "win32") symlinkSync(join(items, "supporting files"), join(items, "linked card"));

    const copied = await duplicateBoard({ sourceRepoId: repoId, repoId: "copy-a" });
    const copyItems = join(home, "repos", copied.board.repoId, "items");
    assert.equal(readFileSync(join(copyItems, "alpha", "spec.md"), "utf8"), readFileSync(join(folder("alpha"), "spec.md"), "utf8"));
    assert.equal(readFileSync(join(copyItems, "alpha", "plan.md"), "utf8"), "# Alpha Plan\n");
    for (const left of ["alpha/evidence.bin", "supporting files", "deleted-card", "notes.txt", "linked card"]) {
      assert.ok(!existsSync(join(copyItems, left)), `${left} is not copied`);
    }

    // A document that cannot be read is never silently left out of a copy.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      chmodSync(join(folder("alpha"), "plan.md"), 0o000);
      try {
        await assert.rejects(duplicateBoard({ sourceRepoId: repoId, repoId: "copy-c" }), /Not copied: Planban could not read the Plan of card alpha/u);
      } finally {
        chmodSync(join(folder("alpha"), "plan.md"), 0o644);
      }
      assert.ok(!existsSync(join(home, "repos", "copy-c")));
    }

    // A Spec written before strict Local Mode, with a picture stored inside it, is refused, and no copy is made.
    writeFileSync(join(folder("alpha"), "spec.md"), dataUriSpec);
    await assert.rejects(duplicateBoard({ sourceRepoId: repoId, repoId: "copy-b" }), /Not saved: the Spec of card alpha contains (?:an embedded file|a picture stored in the text)/u);
    assert.ok(!existsSync(join(home, "repos", "copy-b")));
  });
});
