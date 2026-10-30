#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { terminatePid, assertPortClosed } from "./process-cleanup.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const MCP_SERVER = join(REPO_ROOT, "plugins/planban/scripts/start-planban-mcp.mjs");
function runMcpServer(requests, env = {}) {
  const result = spawnSync(process.execPath, [MCP_SERVER], {
    encoding: "utf8",
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      ...env,
      PLANBAN_REPO_ROOT: REPO_ROOT,
    },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function responseById(responses, id) {
  const response = responses.find((entry) => entry.id === id);
  assert.ok(response, `Missing MCP response ${id}`);
  return response;
}

function assertNoError(response) {
  assert.equal(response.error, undefined, response.error?.message);
  return response.result.structuredContent;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listenerPids(port) {
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  // Without lsof (Windows), there is nothing to look up; the launched server is stopped by its own process.
  if (result.error || typeof result.stdout !== "string") return [];
  if (result.status !== 0 && !result.stdout.trim()) return [];
  return result.stdout
    .split(/\s+/u)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function terminatePortListeners(port) {
  for (const pid of listenerPids(port)) {
    await terminatePid(pid, `Planban server on port ${port}`);
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  assert.equal(typeof address, "object");
  return address.port;
}

async function main() {
  await import("tsx/esm");
  const {
    createCard,
    historyPayload,
    initializeProject,
    loadState,
    readDoc,
    writeDoc,
  } = await import("../src/core/storage.ts");

  const root = mkdtempSync(join(tmpdir(), "planban-mcp-verify-"));
  const cwd = join(root, "repo");
  const planbanHome = join(root, "home");
  const launchPort = await freePort();
  const pidFile = join(root, "launch.pid");
  const previousPlanbanHome = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = planbanHome;

  const checks = [];
  function check(name, detail = "ok") {
    checks.push({ name, detail });
  }

  try {
    await initializeProject({ cwd, repoId: "mcp-verify", title: "MCP Verify", updateAgents: false });
    await createCard({
      cwd,
      title: "Verify MCP Card",
      status: "up-next",
      summary: "Initial MCP verification summary",
      nextAction: "Initial MCP verification next action",
    });
    await writeDoc({ cwd, cardId: "verify-mcp-card", kind: "spec", markdown: "# MCP Verification\n\n- [ ] Promoted verification outcome\n" });

    const cardId = "verify-mcp-card";
    const before = await loadState(cwd);
    const planBefore = await readDoc({ cwd, cardId, kind: "plan" });

    const responses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "planban_status", arguments: { cwd } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "planban_get_board", arguments: { cwd } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "planban_get_card", arguments: { cwd, cardId } },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "planban_read_doc", arguments: { cwd, cardId, kind: "spec" } },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "planban_move_card",
          arguments: { cwd, cardId, status: "in-progress", baseRevision: before.roadmap.revision },
        },
      },
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "planban_update_card",
          arguments: {
            cwd,
            cardId,
            summary: "Updated by MCP verification",
            nextAction: "MCP verification updated this next action",
            tags: ["mcp", "verification"],
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "planban_create_group",
          arguments: {
            cwd,
            title: "Distinct Group",
            summary: "Separate Group outcome",
            specMarkdown: "# Distinct Group\n\n- [ ] Promoted verification outcome\n",
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "planban_write_doc",
          arguments: {
            cwd,
            cardId,
            kind: "plan",
            markdown: "# MCP Verification Plan\n\nThis was written through the Planban MCP server.\n",
            expectedMtimeMs: planBefore.mtimeMs,
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "planban_move_card", arguments: { cwd, cardId, status: "complete" } },
      },
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "planban_launch_board",
          arguments: { cwd, port: launchPort },
        },
      },
      {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name: "planban_query_cards", arguments: { cwd, search: "verification", projection: "flattened" } },
      },
    ], { PLANBAN_HOME: planbanHome, PLANBAN_RESTART_PID_FILE: pidFile });

    assert.equal(responseById(responses, 1).result.serverInfo.name, "Planban MCP");
    check("initialize", "Planban MCP server responded");

    const tools = responseById(responses, 2).result.tools.map((tool) => tool.name);
    assert.deepEqual(tools, [
      "planban_status",
      "planban_list_boards",
      "planban_get_board",
      "planban_query_cards",
      "planban_get_card",
      "planban_unresolved_changes",
      "planban_drop_change",
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
    ]);
    check("tools/list", `${tools.length} focused Planban tools exposed by default`);

    const profiledResponses = runMcpServer([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ], {
      PLANBAN_HOME: planbanHome,
      PLANBAN_MCP_PROFILE: "admin,maintenance,legacy",
    });
    const profiledTools = responseById(profiledResponses, 2).result.tools.map((tool) => tool.name);
    for (const tool of [
      "planban_archive_board",
      "planban_restore_board",
      "planban_duplicate_board",
      "planban_delete_board",
      "planban_export_flat_v1",
      "planban_reconstruct_hierarchy",
      "planban_set_card_parent",
    ]) {
      assert.equal(profiledTools.includes(tool), true, `${tool} should be exposed by its explicit profile`);
    }
    check("tools/list profiles", `${profiledTools.length} Planban tools exposed with all optional profiles`);

    assert.equal(assertNoError(responseById(responses, 3)).initialized, true);
    check("planban_status", "temporary repo initialized");

    assert.equal(assertNoError(responseById(responses, 4)).roadmapItems.length, 1);
    check("planban_get_board", "board loaded through MCP");

    assert.equal(assertNoError(responseById(responses, 5)).card.title, "Verify MCP Card");
    check("planban_get_card", "card loaded through MCP");

    assert.match(assertNoError(responseById(responses, 6)).markdown, /Promoted verification outcome/);
    check("planban_read_doc", "spec markdown read through MCP");

    assert.equal(assertNoError(responseById(responses, 7)).card.status, "in-progress");
    check("planban_move_card", "card moved to In Progress");

    const updatedCard = assertNoError(responseById(responses, 8)).card;
    assert.equal(updatedCard.summary, "Updated by MCP verification");
    assert.equal(updatedCard.nextAction, "MCP verification updated this next action");
    assert.deepEqual(updatedCard.tags, ["mcp", "verification"]);
    check("planban_update_card", "summary, next action, and tags updated");

    assert.equal(assertNoError(responseById(responses, 9)).group.isGroup, true);
    check("planban_create_group", "distinct empty Group created");

    assert.equal(assertNoError(responseById(responses, 10)).markdown, "# MCP Verification Plan\n\nThis was written through the Planban MCP server.\n");
    check("planban_write_doc", "plan document written");

    // A refusal is a tool result that keeps its kind, not a protocol error.
    const completionResponse = responseById(responses, 11);
    assert.equal(completionResponse.result.isError, true);
    assert.equal(completionResponse.result.structuredContent.error.category, "validation");
    assert.match(completionResponse.result.content[0].text, /completionConfirmed/);
    check("completion guard", "complete without confirmation rejected");

    const launch = assertNoError(responseById(responses, 12));
    assert.equal(launch.url, `http://127.0.0.1:${launchPort}/boards/mcp-verify`);
    assert.equal(launch.ok, true);
    assert.equal(launch.serviceReady, true);
    assert.equal(launch.urlVerified, true);
    assert.equal(launch.capabilities.canonicalUrl, true);
    assert.equal(launch.capabilities.browserPresentation, "client-optional");
    assert.equal(launch.diagnostics[0].boundary, "service-url");
    check("planban_launch_board", `verified ${launch.url}`);

    assert.deepEqual(assertNoError(responseById(responses, 13)).matches.map((entry) => entry.item.id), [cardId]);
    check("planban_query_cards", "read-only hierarchy query matched the verification card");

    const finalState = await loadState(cwd);
    const finalCard = finalState.roadmap.roadmapItems.find((item) => item.id === cardId);
    assert.equal(finalCard.status, "in-progress");
    assert.equal(finalCard.summary, "Updated by MCP verification");
    assert.equal(finalCard.nextAction, "MCP verification updated this next action");
    assert.equal(finalCard.isGroup, false);
    assert.equal(finalState.roadmap.roadmapItems.find((item) => item.id === "distinct-group")?.isGroup, true);
    check("roadmap.json verification", `revision ${finalState.roadmap.revision}`);

    const planDoc = await readDoc({ cwd, cardId, kind: "plan" });
    assert.equal(planDoc.markdown, "# MCP Verification Plan\n\nThis was written through the Planban MCP server.\n");
    check("doc file verification", planDoc.path);

    const history = await historyPayload(cwd);
    const operations = history.entries.map((entry) => `${entry.actor}:${entry.operation}`);
    assert.ok(operations.includes("agent:card.move"));
    assert.ok(operations.includes("agent:card.update"));
    assert.ok(operations.includes("agent:doc.write"));
    check("history verification", operations.slice(0, 4).join(", "));

    const roadmapFile = readJson(finalState.roadmapPath);
    assert.equal(roadmapFile.roadmapItems[0].status, "in-progress");
    check("raw JSON verification", finalState.roadmapPath);

    process.stdout.write(JSON.stringify({
      ok: true,
      tempRepo: cwd,
      tempPlanbanHome: planbanHome,
      checks,
    }, null, 2) + "\n");
  } finally {
    if (existsSync(pidFile)) {
      const serverPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      await terminatePid(serverPid, "MCP verifier Planban server");
    }
    await terminatePortListeners(launchPort);
    await assertPortClosed(launchPort, "MCP verifier Planban port");
    if (previousPlanbanHome === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = previousPlanbanHome;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
