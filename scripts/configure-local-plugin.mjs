#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stableNodePath } from "./stable-node-path.mjs";

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const mcpPath = resolve(repoRoot, "plugins/planban/.mcp.json");

const manifest = {
  mcpServers: {
    planban: {
      cwd: repoRoot,
      command: stableNodePath(process.execPath),
      args: ["./plugins/planban/scripts/start-planban-mcp.mjs"],
      startup_timeout_sec: 120,
      env: {
        PLANBAN_REPO_ROOT: repoRoot,
      },
    },
  },
};

await writeFile(mcpPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

process.stdout.write(`Configured Planban plugin MCP runtime for ${repoRoot}

Next, in Codex:
  codex plugin marketplace add "${repoRoot}"
  codex plugin add planban@planban

Or in Claude Code:
  claude plugin marketplace add "${repoRoot}"
  claude plugin install planban@planban

Then:
  node plugins/planban/scripts/launch-planban.mjs --tutorial
`);
