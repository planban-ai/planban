// The release preflight's MCP check runs with the suite, so a change to what
// the MCP server returns fails here, on the pull request, not only at release.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

// The release preflight runs on Linux and macOS; its server cleanup there uses lsof.
test("the release preflight's MCP verification passes", { skip: process.platform === "win32" ? "the release preflight runs on Linux and macOS" : false }, async () => {
  const result = await new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/verify-planban-mcp.mjs"], { env: process.env });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
  });
  assert.equal(result.status, 0, result.output.slice(-2000));
});
