import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCard, createGroup as createGroupCore, editGoals, historyPayload, initializeProject, loadState, readDoc, writeDoc } from "../src/core/storage";
import { GOALS_GUIDANCE } from "../src/core/goals";
import { PLANBAN_MCP_VERSION } from "../src/core/version";

const MCP_SERVER = join(process.cwd(), "plugins/planban/scripts/start-planban-mcp.mjs");

function createGroup(input: Omit<Parameters<typeof createGroupCore>[0], "summary"> & { summary?: string }) {
  return createGroupCore({ ...input, summary: input.summary ?? `${input.title} objective` });
}

async function listen(server: Server) {
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return (server.address() as AddressInfo).port;
}

async function reserveClosedPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

// Point the Board URL probe (and activity bridge) at a closed local port so results
// are deterministic even when a real Planban service is running on 4317.
const CLOSED_PORT = await reserveClosedPort();
const UNVERIFIED_ORIGIN = `http://127.0.0.1:${CLOSED_PORT}`;

function mcpEnv(env: NodeJS.ProcessEnv) {
  return {
    ...process.env,
    PLANBAN_ACTIVITY_URL: UNVERIFIED_ORIGIN,
    ...env,
    PLANBAN_REPO_ROOT: process.cwd(),
  };
}

function parseResponses(stdout: string) {
  return stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function runMcpServerAsync(requests: unknown[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [MCP_SERVER], { env: mcpEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => { child.kill(); rejectExit(new Error("MCP server timed out")); }, 8_000);
    child.once("exit", (code) => { clearTimeout(timer); resolveExit(code); });
  });
  child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  assert.equal(await exited, 0, stderr);
  assert.equal(stderr, "");
  return parseResponses(stdout);
}

function runMcpServer(requests: unknown[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [MCP_SERVER], {
    encoding: "utf8",
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: mcpEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 8_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return parseResponses(result.stdout);
}

function assertUnverifiedBoardHandoff(result: { content: Array<{ text: string }>; structuredContent: Record<string, unknown> }, firstLine: RegExp) {
  const url = `${UNVERIFIED_ORIGIN}/boards/mcp-test`;
  const payload = result.structuredContent;
  assert.equal(payload.boardUrl, url);
  assert.equal(payload.boardUrlVerified, false);
  assert.deepEqual(payload.userReply, {
    urlRequired: true,
    url,
    markdown: `[Open the board](${url})`,
    verifyWith: "planban_launch_board",
  });
  const [head, tail] = result.content[0].text.split("\n");
  assert.match(head, firstLine);
  assert.equal(tail, `Board URL: ${url} - verify with planban_launch_board before presenting.`);
}

async function withPlanbanProject<T>(run: (input: { cwd: string; planbanHome: string; cardId: string }) => Promise<T>) {
  const root = mkdtempSync(join(tmpdir(), "planban-mcp-test-"));
  const cwd = join(root, "repo");
  const planbanHome = join(root, "home");
  const previousPlanbanHome = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = planbanHome;
  try {
    await initializeProject({ cwd, repoId: "mcp-test", title: "MCP Test", updateAgents: false });
    const created = await createGroup({
      cwd,
      title: "Alpha Card",
      status: "up-next",
      summary: "Initial summary",
      nextAction: "Initial next action",
    });
    const cardId = created.roadmap.roadmapItems.find((item) => item.title === "Alpha Card")?.id;
    assert.equal(cardId, "alpha-card");
    return await run({ cwd, planbanHome, cardId });
  } finally {
    if (previousPlanbanHome === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = previousPlanbanHome;
    rmSync(root, { recursive: true, force: true });
  }
}

test("Planban MCP server registers focused tools", () => {
  const responses = runMcpServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "planban-mcp-test", version: "0.1.0" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);

  assert.equal(responses[0].result.serverInfo.name, "Planban MCP");
  assert.equal(responses[0].result.serverInfo.version, PLANBAN_MCP_VERSION);
  const instructions = responses[0].result.instructions as string;
  assert.match(instructions, /Planban house style/u);
  assert.match(instructions, /\.planban\/agent-context\.md/u);
  assert.match(instructions, /absolute repository path/u);
  assert.match(instructions, /Serialize writes/u);
  assert.match(instructions, /Complete is person-controlled/u);
  assert.match(instructions, /move_card is the canonical placement operation/u);
  assert.match(instructions, /complete logical mutation batch/u);
  assert.match(instructions, /userReply\.markdown/u);
  assert.match(instructions, /at most one bounded attempt/u);
  assert.match(instructions, /never reopen the board after every write/u);
  assert.match(instructions, /call planban_launch_board once/u);
  assert.match(instructions, /explicit profiles/u);
  assert.match(instructions, /index, not file storage: link to files; planban_move_files_out tidies/u);
  assert.doesNotMatch(instructions, /Codex|Claude/u);
  const wordCount = instructions.split(/\s+/u).length;
  assert.ok(wordCount >= 120 && wordCount <= 210, `instructions should stay compact (${wordCount} words)`);
  const tools = responses[1].result.tools as Array<{ name: string; description: string; inputSchema: { properties?: Record<string, unknown> } }>;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "planban_status",
      "planban_list_boards",
      "planban_get_board",
      "planban_query_cards",
      "planban_get_card",
      "planban_unresolved_changes",
      "planban_drop_change",
      "planban_clear_landing",
      "planban_history",
      "planban_read_goals",
      "planban_suggest_goal_change",
      "planban_create_card",
      "planban_create_group",
      "planban_create_cards",
      "planban_read_doc",
      "planban_move_card",
      "planban_update_card",
      "planban_write_doc",
      "planban_write_doc_section",
      "planban_move_files_out",
      "planban_launch_board",
    ],
  );
  const queryProperties = tools.find((tool) => tool.name === "planban_query_cards")?.inputSchema.properties ?? {};
  assert.equal("programmeId" in queryProperties, false);
  assert.equal("programmeRole" in queryProperties, false);
  for (const toolName of ["planban_create_card", "planban_create_group", "planban_create_cards", "planban_update_card", "planban_write_doc"]) {
    assert.match(tools.find((tool) => tool.name === toolName)?.description ?? "", /Planban house style/u);
  }
  const launchDescription = tools.find((tool) => tool.name === "planban_launch_board")?.description ?? "";
  assert.match(launchDescription, /host's in-app browser when one is available/u);
  assert.doesNotMatch(launchDescription, /Browser plugin|Codex|Claude/u);
});

test("Planban MCP exposes administration, maintenance, and legacy tools only through explicit profiles", () => {
  const responses = runMcpServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ], { PLANBAN_MCP_PROFILE: "admin,maintenance,legacy" });
  const names = (responses[1].result.tools as Array<{ name: string }>).map((tool) => tool.name);
  for (const name of [
    "planban_archive_board",
    "planban_restore_board",
    "planban_duplicate_board",
    "planban_delete_board",
    "planban_export_flat_v1",
    "planban_reconstruct_hierarchy",
    "planban_set_card_parent",
  ]) assert.equal(names.includes(name), true, `${name} should be advertised by its explicit profile`);
  const reconstructionProperties = (responses[1].result.tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>)
    .find((tool) => tool.name === "planban_reconstruct_hierarchy")?.inputSchema.properties ?? {};
  assert.equal("programmes" in reconstructionProperties, false);
});

test("Planban MCP creates structured cards with docs and agent history", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome }) => {
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_create_card",
          arguments: {
            cwd,
            title: "MCP Structured",
            status: "pending",
            position: "top",
            tags: ["mcp", "agent"],
            metadata: { source: "mcp-test" },
            specMarkdown: "# MCP Spec\n",
            planMarkdown: "# MCP Plan\n",
          },
        },
      },
    ], { PLANBAN_HOME: planbanHome });

    const card = responses[1].result.structuredContent.card;
    assert.equal(card.id, "mcp-structured");
    assert.equal(card.priority, 1);
    assert.deepEqual(card.tags, ["mcp", "agent"]);
    assert.deepEqual(card.metadata, { source: "mcp-test" });

    const spec = await readDoc({ cwd, cardId: "mcp-structured", kind: "spec" });
    const plan = await readDoc({ cwd, cardId: "mcp-structured", kind: "plan" });
    assert.equal(spec.markdown, "# MCP Spec\n");
    assert.equal(plan.markdown, "# MCP Plan\n");

    const history = await historyPayload(cwd);
    assert.equal(history.entries[0]?.actor, "agent");
    assert.equal(history.entries[0]?.operation, "card.create");
    assert.deepEqual(
      history.entries[0]?.affectedDocs.map((doc) => doc.kind),
      ["spec", "plan"],
    );
  });
});

test("Planban MCP board lifecycle tools require deliberate delete confirmation", async () => {
  await withPlanbanProject(async ({ planbanHome }) => {
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "planban_archive_board", arguments: { repoId: "mcp-test" } },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "planban_list_boards", arguments: { includeArchived: true } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "planban_restore_board", arguments: { repoId: "mcp-test" } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "planban_duplicate_board",
          arguments: { sourceRepoId: "mcp-test", repoId: "mcp-test-copy", title: "MCP Test Copy" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "planban_delete_board", arguments: { repoId: "mcp-test", confirmRepoId: "wrong" } },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "planban_delete_board", arguments: { repoId: "mcp-test", confirmRepoId: "mcp-test" } },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.board.repoId, "mcp-test");
    assert.equal(responses[2].result.structuredContent.boards[0].archivedAt !== null, true);
    assert.equal(responses[3].result.structuredContent.board.archivedAt, null);
    assert.equal(responses[4].result.structuredContent.board.repoId, "mcp-test-copy");
    assert.equal((await loadState(responses[4].result.structuredContent.board.cwd)).roadmap.project.title, "MCP Test Copy");
    assert.equal(responses[5].error.code, -32602);
    assert.match(responses[5].error.message, /confirmRepoId/);
    assert.equal(responses[6].result.structuredContent.repoId, "mcp-test");
    assert.match(responses[6].result.structuredContent.backupPath, /mcp-test/);
  });
});

test("Planban MCP read tools inspect boards, cards, and docs", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "planban_status", arguments: { cwd } },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "planban_get_card", arguments: { cwd, cardId } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "planban_read_doc", arguments: { cwd, cardId, kind: "spec" } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "planban_get_board", arguments: { cwd } },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.initialized, true);
    assertUnverifiedBoardHandoff(responses[1].result, /^Planban is initialized for /u);
    assert.equal(Array.isArray(responses[4].result.structuredContent.roadmapItems), true, "get_board remains the deliberate full read");
    // The fields every surface shares (the remote get_board has the same).
    assert.equal(typeof responses[4].result.structuredContent.boardId, "string");
    assert.equal(typeof responses[4].result.structuredContent.title, "string");
    assert.equal(typeof responses[4].result.structuredContent.revision, "number");
    assert.equal(responses[4].result.structuredContent.roadmapItems[0].id, cardId);
    assertUnverifiedBoardHandoff(responses[4].result, /^Loaded Planban board mcp-test at revision \d+\.$/u);
    assert.equal("boardUrl" in responses[2].result.structuredContent, false, "get_card stays a focused read");
    assert.equal(responses[2].result.structuredContent.card.title, "Alpha Card");
    assert.match(responses[3].result.structuredContent.markdown, /Alpha Card Spec/);
  });
});

test("Planban MCP Goals page carries its guidance in the structured part, which is all some agents see", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome }) => {
    await editGoals({ cwd, edit: { kind: "add", statement: "Win clubs", notes: "" }, baseRevision: (await loadState(cwd)).roadmap.revision });
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "planban_read_goals", arguments: { cwd } } },
    ], { PLANBAN_HOME: planbanHome });
    const result = responses[1].result;
    assert.equal(result.structuredContent.goals[0].statement, "Win clubs");
    assert.equal(result.structuredContent.text, result.content[0].text);
    assert.ok(result.structuredContent.text.includes(GOALS_GUIDANCE));
  });
});

test("Planban MCP status resolves a registered board by repoId", async () => {
  await withPlanbanProject(async ({ planbanHome }) => {
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "planban_status", arguments: { repoId: "mcp-test" } },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.initialized, true);
    assert.equal(responses[1].result.structuredContent.repoId, "mcp-test");
  });
});

test("Planban MCP queries owned Items without mutation", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    await createCard({ cwd, title: "Owned Result", parentId: cardId, nextAction: "Validate panel render", tags: ["visual"] });
    const before = await loadState(cwd);
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_query_cards",
          arguments: { cwd, search: "panel", projection: "main", hierarchyScope: "owned", tags: ["visual"] },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "planban_query_cards", arguments: { cwd, statuses: ["pendng"] } },
      },
    ], { PLANBAN_HOME: planbanHome });
    const payload = responses[1].result.structuredContent;
    assert.deepEqual(payload.matches.map((entry: { item: { id: string } }) => entry.item.id), ["owned-result"]);
    assert.deepEqual(payload.context.map((entry: { item: { id: string } }) => entry.item.id), [cardId]);
    assert.equal(payload.revision, before.roadmap.revision);
    assert.equal((await loadState(cwd)).roadmap.revision, before.roadmap.revision);
    assert.equal(responses[2].error.code, -32602);
    assert.match(responses[2].error.message, /status|enum/i);
  });
});

test("Planban MCP reconstructs existing hierarchy and exports a recoverable flat board", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    await createCard({ cwd, title: "Existing Item", status: "pending" });
    const before = await loadState(cwd);
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "planban_reconstruct_hierarchy", arguments: { cwd, groups: [{ id: cardId, childIds: ["existing-item"] }], baseRevision: before.roadmap.revision },
      } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "planban_export_flat_v1", arguments: { cwd, exportId: "mcp-flat-v1" },
      } },
    ], { PLANBAN_HOME: planbanHome });
    assert.equal(responses[1].result.structuredContent.cards.find((item: { id: string }) => item.id === "existing-item").parentId, cardId);
    assert.equal(responses[2].result.structuredContent.exportId, "mcp-flat-v1");
  });
});

test("Planban MCP mutating tools move and update cards with agent history", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    const before = await loadState(cwd);
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_move_card",
          arguments: { cwd, cardId, status: "in-progress", baseRevision: before.roadmap.revision },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "planban_update_card",
          arguments: {
            cwd,
            cardId,
            title: "Renamed through MCP",
            summary: "Updated through MCP",
            nextAction: "Review MCP update",
            tags: ["mcp"],
            blockedBy: null,
          },
        },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.card.status, "in-progress");
    assert.equal(responses[2].result.structuredContent.card.summary, "Updated through MCP");
    assert.equal(responses[2].result.structuredContent.card.title, "Renamed through MCP");
    assert.deepEqual(responses[2].result.structuredContent.card.tags, ["mcp"]);

    const after = await loadState(cwd);
    for (const [index, firstLine] of [[1, /^Moved Planban card alpha-card to in-progress\.$/u], [2, /^Updated Planban card alpha-card\.$/u]] as const) {
      const payload = responses[index].result.structuredContent;
      assert.equal("roadmapItems" in payload, false, "mutation results must stay compact");
      assert.equal(payload.itemCount, after.roadmap.roadmapItems.length);
      assert.equal(payload.repoId, "mcp-test");
      assert.equal(typeof payload.revision, "number");
      assert.ok(Array.isArray(payload.columns));
      assertUnverifiedBoardHandoff(responses[index].result, firstLine);
    }

    const history = await historyPayload(cwd);
    assert.equal(history.entries[1]?.actor, "agent");
    assert.equal(history.entries[1]?.operation, "card.move");
    assert.equal(history.entries[0]?.actor, "agent");
    assert.equal(history.entries[0]?.operation, "card.update");
  });
});

test("Planban MCP creates a distinct Group from existing Items", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome }) => {
    await createCard({ cwd, title: "Panel-Aware", status: "in-progress" });
    await createCard({ cwd, title: "R-Logo", status: "up-next" });
    const before = await loadState(cwd);
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_create_group",
          arguments: {
            cwd,
            title: "MIMEeq Capability",
            itemIds: ["panel-aware", "r-logo"],
            anchorId: "panel-aware",
            baseRevision: before.roadmap.revision,
          },
        },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.group.isGroup, true);
    assert.equal(responses[1].result.structuredContent.group.summary, null);
    const state = await loadState(cwd);
    assert.deepEqual(state.roadmap.roadmapItems.filter((item) => item.parentId === "mimeeq-capability").map((item) => item.id), ["panel-aware", "r-logo"]);
    const history = await historyPayload(cwd);
    assert.equal(history.entries[0]?.actor, "agent");
    assert.equal(history.entries[0]?.operation, "group.create");
  });
});

test("Planban MCP preserves the deprecated Programme creation alias", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome }) => {
    await createCard({ cwd, title: "Legacy Item", status: "up-next" });
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_create_programme",
          arguments: { cwd, title: "Legacy Group", summary: "Legacy compatibility", deliverableIds: ["legacy-item"] },
        },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.group.isGroup, true);
    assert.equal((await loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === "legacy-item")?.parentId, "legacy-group");
  });
});

test("Planban MCP atomically creates multiple Group children", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "planban_create_cards", arguments: { cwd, titles: ["Product Authoring", "R-Logo"], parentId: cardId },
      } },
    ], { PLANBAN_HOME: planbanHome });
    assert.deepEqual(responses[1].result.structuredContent.cards.map((item: { title: string }) => item.title), ["Product Authoring", "R-Logo"]);
    assert.equal("roadmapItems" in responses[1].result.structuredContent, false);
    assert.equal(responses[1].result.structuredContent.itemCount, 3);
    assertUnverifiedBoardHandoff(responses[1].result, /^Created 2 Planban cards\.$/u);
  });
});

test("Planban MCP creates inside, reparents, and reports ancestry", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    await createGroup({ cwd, title: "Second Group" });
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "planban_create_card", arguments: { cwd, title: "Nested Delivery", parentId: cardId },
      } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "planban_move_card", arguments: { cwd, cardId: "nested-delivery", parentId: "second-group" },
      } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: {
        name: "planban_get_card", arguments: { cwd, cardId: "nested-delivery" },
      } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: {
        name: "planban_move_card", arguments: { cwd, cardId: "nested-delivery", parentId: null },
      } },
    ], { PLANBAN_HOME: planbanHome });
    assert.equal(responses[1].result.structuredContent.card.parentId, cardId);
    assert.equal(responses[2].result.structuredContent.card.parentId, "second-group");
    assert.deepEqual(responses[3].result.structuredContent.ancestry.map((item: { id: string }) => item.id), ["second-group"]);
    assert.equal(responses[4].result.structuredContent.card.parentId, null);
  });
});

test("Planban MCP write doc uses stale protection and records agent history", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    const before = await readDoc({ cwd, cardId, kind: "plan" });
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_write_doc",
          arguments: {
            cwd,
            cardId,
            kind: "plan",
            markdown: "# MCP Plan\n",
            expectedMtimeMs: before.mtimeMs,
          },
        },
      },
    ], { PLANBAN_HOME: planbanHome });

    assert.equal(responses[1].result.structuredContent.exists, true);
    assert.equal(responses[1].result.structuredContent.markdown, "# MCP Plan\n");
    assertUnverifiedBoardHandoff(responses[1].result, /^Wrote plan document for alpha-card\.$/u);

    const history = await historyPayload(cwd);
    assert.equal(history.entries[0]?.actor, "agent");
    assert.equal(history.entries[0]?.operation, "doc.write");
  });
});

test("Planban MCP says rewrite, don't append, when a Spec or Plan passes 100 KB", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    const before = await readDoc({ cwd, cardId, kind: "plan" });
    const markdown = `# Plan\n\n${"Another appended update.\n".repeat(5000)}`;
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "planban_write_doc", arguments: { cwd, cardId, kind: "plan", markdown, expectedMtimeMs: before.mtimeMs } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "planban_read_doc", arguments: { cwd, cardId, kind: "plan" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "planban_read_doc", arguments: { cwd, cardId, kind: "spec" } } },
    ], { PLANBAN_HOME: planbanHome });
    assert.match(responses[1].result.content[0].text, /^Wrote plan document for alpha-card\.\nPlan is 122 KB; rewrite it to the current state, don't append\./u);
    assert.match(responses[2].result.content[0].text, /^Read plan document for alpha-card\.\nPlan is 122 KB; rewrite it to the current state, don't append\.$/u);
    assert.equal(responses[3].result.content[0].text, "Read spec document for alpha-card.");
  });
});

test("Planban MCP move card guards completion", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "planban_move_card",
          arguments: { cwd, cardId, status: "complete" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "planban_move_card",
          arguments: { cwd, cardId, status: "complete", completionConfirmed: true },
        },
      },
    ], { PLANBAN_HOME: planbanHome });

    // A refusal is a tool result that keeps its kind, not a protocol error.
    assert.equal(responses[1].result.isError, true);
    assert.equal(responses[1].result.structuredContent.error.category, "validation");
    assert.match(responses[1].result.content[0].text, /completionConfirmed/);
    assert.equal(responses[2].result.structuredContent.card.status, "complete");
  });
});

test("Planban MCP verifies the Board URL against a healthy local service without starting one", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome }) => {
    const healthRequests: string[] = [];
    const service = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/boards/mcp-test/health") {
        healthRequests.push(req.url);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, repoId: "mcp-test" }));
        return;
      }
      res.writeHead(404).end();
    });
    const port = await listen(service);
    try {
      const responses = await runMcpServerAsync([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
          name: "planban_create_card", arguments: { cwd, title: "Verified Handoff" },
        } },
      ], { PLANBAN_HOME: planbanHome, PLANBAN_ACTIVITY_URL: `http://127.0.0.1:${port}` });
      const url = `http://127.0.0.1:${port}/boards/mcp-test`;
      const result = responses[1].result;
      assert.equal(result.structuredContent.card.id, "verified-handoff");
      assert.equal("roadmapItems" in result.structuredContent, false);
      assert.equal(result.structuredContent.itemCount, 2);
      assert.equal(result.structuredContent.boardUrl, url);
      assert.equal(result.structuredContent.boardUrlVerified, true);
      assert.deepEqual(result.structuredContent.userReply, { urlRequired: true, url, markdown: `[Open the verified board](${url})` });
      assert.equal(result.content[0].text, `Created Planban card verified-handoff.\nBoard URL: ${url}`);
      assert.deepEqual(healthRequests, ["/api/boards/mcp-test/health"]);
    } finally {
      await new Promise<void>((resolveClose) => service.close(() => resolveClose()));
    }
  });
});

test("Planban MCP keeps a mutation result compact on a large board", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome }) => {
    for (let index = 0; index < 100; index += 1) {
      await createCard({ cwd, title: `Bulk Item ${index}`, summary: "A representative owner-facing summary for a bulk Item.", nextAction: "Review the bulk Item." });
    }
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "planban_update_card", arguments: { cwd, cardId: "bulk-item-0", summary: "Updated summary." },
      } },
    ], { PLANBAN_HOME: planbanHome });
    const payload = responses[1].result.structuredContent;
    assert.equal(payload.itemCount, 101);
    assert.equal("roadmapItems" in payload, false);
    assert.ok(JSON.stringify(responses[1].result).length < 10_000, "mutation result should not scale with board size");
  });
});

test("Planban MCP reports stale signals on card and board reads, and notes oversized metadata", async () => {
  await withPlanbanProject(async ({ cwd, planbanHome, cardId }) => {
    await createCard({ cwd, title: "Cart Drawer", status: "in-progress", nextAction: "Owner: review the drawer once PR 267 merges." });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "Merge pull request #267 from o/cart"], ["update-ref", "refs/remotes/origin/main", "HEAD"]]) {
      spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: gitEnv, encoding: "utf8" });
    }
    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "planban_get_card", arguments: { cwd, cardId: "cart-drawer" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "planban_query_cards", arguments: { cwd, search: "drawer" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "planban_status", arguments: { cwd } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "planban_get_board", arguments: { cwd } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "planban_get_card", arguments: { cwd, cardId } } },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: {
        name: "planban_update_card", arguments: { cwd, cardId, metadata: { ledger: "ledger entry ".repeat(400) } },
      } },
    ], { PLANBAN_HOME: planbanHome });

    const card = responses[1].result;
    assert.deepEqual(card.structuredContent.staleness.map((signal: { kind: string }) => signal.kind), ["merged", "awaiting-owner"]);
    assert.match(card.structuredContent.staleness[0].detail, /^#267 merged \d{1,2} [A-Z][a-z]{2}$/u);
    assert.match(card.content[0].text, /^Loaded Planban card cart-drawer\.\nStale signals: merged \(#267 merged .*\)/u);
    assert.deepEqual(Object.keys(responses[2].result.structuredContent.staleness), ["cart-drawer"]);
    for (const response of [responses[3], responses[4]]) {
      const attention = response.result.structuredContent.attention;
      assert.deepEqual(attention.cards.map((entry: { id: string }) => entry.id), ["cart-drawer"]);
      assert.equal(attention.awaitingOwner, 1);
      assert.equal(attention.wip, null);
      assert.match(response.result.content[0].text, /\n1 active card looks stale \(cart-drawer\); fix any you touch\.\n/u);
    }
    assert.deepEqual(responses[5].result.structuredContent.staleness, [], "a card with no signals reports an empty list");
    assert.match(responses[6].result.structuredContent.notes[0], /^Metadata is 5 KB\./u);
    assert.match(responses[6].result.content[0].text, /^Updated Planban card alpha-card\.\nMetadata is 5 KB\./u);
  });
});
