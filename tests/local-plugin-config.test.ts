import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import { stableNodePath } from "../scripts/stable-node-path.mjs";

test("local plugin configuration records the executable that ran the installer", () => {
  const root = mkdtempSync(join(tmpdir(), "planban-local-plugin-config-"));
  try {
    mkdirSync(join(root, "plugins/planban"), { recursive: true });
    execFileSync(process.execPath, ["scripts/configure-local-plugin.mjs", root], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const manifest = JSON.parse(readFileSync(join(root, "plugins/planban/.mcp.json"), "utf8"));
    assert.equal(manifest.mcpServers.planban.cwd, root);
    assert.equal(manifest.mcpServers.planban.command, stableNodePath(process.execPath));
    assert.equal(manifest.mcpServers.planban.env.PLANBAN_REPO_ROOT, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Homebrew Node path is recorded through its opt link, which survives Node upgrades", () => {
  const prefix = mkdtempSync(join(tmpdir(), "planban-homebrew-"));
  try {
    const cellarBin = join(prefix, "Cellar/node@24/24.21.0_2/bin");
    mkdirSync(cellarBin, { recursive: true });
    writeFileSync(join(cellarBin, "node"), "");
    chmodSync(join(cellarBin, "node"), 0o755);
    mkdirSync(join(prefix, "opt"), { recursive: true });
    symlinkSync("../Cellar/node@24/24.21.0_2", join(prefix, "opt/node@24"));

    // Homebrew reports POSIX paths, even when this fixture runs on Windows CI.
    const cellarNode = join(cellarBin, "node").split(sep).join("/");
    assert.equal(stableNodePath(cellarNode), join(prefix, "opt/node@24/bin/node"));
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test("other Node paths, and Homebrew paths whose opt link leads elsewhere, are kept as they are", () => {
  const prefix = mkdtempSync(join(tmpdir(), "planban-homebrew-"));
  try {
    for (const version of ["24.20.0", "24.21.0_2"]) {
      mkdirSync(join(prefix, `Cellar/node@24/${version}/bin`), { recursive: true });
      writeFileSync(join(prefix, `Cellar/node@24/${version}/bin/node`), "");
    }
    mkdirSync(join(prefix, "opt"), { recursive: true });
    symlinkSync("../Cellar/node@24/24.21.0_2", join(prefix, "opt/node@24"));
    const older = join(prefix, "Cellar/node@24/24.20.0/bin/node").split(sep).join("/");

    assert.equal(stableNodePath(older), older);
    assert.equal(stableNodePath(join(prefix, "Cellar/node/25.0.0/bin/node")), join(prefix, "Cellar/node/25.0.0/bin/node"));
    assert.equal(stableNodePath("/usr/bin/node"), "/usr/bin/node");
    assert.equal(stableNodePath(String.raw`C:\Program Files\nodejs\node.exe`), String.raw`C:\Program Files\nodejs\node.exe`);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
