// The managed Planban block in a project's AGENTS.md follows the board when it
// moves between local and online (fit-for-purpose audit O6).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { refreshAgentsBlock } from "../src/core/storage";

const OLD_BLOCK = `<!-- BEGIN PLANBAN -->

This repo uses Planban.

Canonical live planning state for this device is not branch-local. Read \`.planban/project.json\` and \`.planban/agent-context.md\` before making roadmap or plan updates.

<!-- END PLANBAN -->`;

test("a 1.x project's Planban block is brought up to date, and everything around it is kept", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "planban-agents-"));
  try {
    await writeFile(join(cwd, "AGENTS.md"), `# Project rules\n\nUse tabs.\n\n${OLD_BLOCK}\n\n## More rules\n\nRun the tests.\n`);
    assert.equal(await refreshAgentsBlock(cwd), true);
    const next = await readFile(join(cwd, "AGENTS.md"), "utf8");
    assert.doesNotMatch(next, /for this device is not branch-local/u, "the 1.x wording is gone");
    assert.match(next, /it lives on this device for a local board, or at its online service for an online board/u);
    assert.match(next, /^# Project rules\n\nUse tabs\.\n\n<!-- BEGIN PLANBAN -->/u, "text before the block is kept");
    assert.match(next, /<!-- END PLANBAN -->\n\n## More rules\n\nRun the tests\.\n$/u, "text after the block is kept");
    assert.equal(next.split("<!-- BEGIN PLANBAN -->").length, 2, "one block");
    assert.equal(await refreshAgentsBlock(cwd), false, "nothing to change the second time");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a project without the block, or without AGENTS.md, is left alone", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "planban-agents-"));
  try {
    assert.equal(await refreshAgentsBlock(cwd), false);
    await assert.rejects(readFile(join(cwd, "AGENTS.md"), "utf8"), "not created");
    await writeFile(join(cwd, "AGENTS.md"), "# Rules\n");
    assert.equal(await refreshAgentsBlock(cwd), false);
    assert.equal(await readFile(join(cwd, "AGENTS.md"), "utf8"), "# Rules\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("moving a board online or local refreshes the block", async () => {
  const transfers = await readFile(new URL("../src/core/online/transfers.ts", import.meta.url), "utf8");
  const publish = transfers.slice(transfers.indexOf("async function publishManifest"), transfers.indexOf("const carriedDocsSchema"));
  assert.match(publish, /await refreshAgentsBlock\(cwd\);/u);
});
