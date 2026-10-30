// The guidance agents read can't drift from what Planban does (agent-surface
// audit, 15 October 2026): every command-line flag and online command it names
// exists, and no surface gives the old advice to just reread and retry a
// document conflict, or to pass a board revision when writing a document.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildAgentContext } from "../src/core/protocol";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const GUIDES = [
  "plugins/planban/skills/planban/references/planban-protocol.md",
  "plugins/planban/skills/planban/SKILL.md",
  "plugins/planban/skills/planban-help/SKILL.md",
  "README.md",
];
// Flags of other programs that the guides quote (claude mcp add, codex mcp add, git).
const OTHER_PROGRAMS = new Set(["--transport", "--url", "--help", "--version"]);

test("every flag and online command the guides name exists in the command line", async () => {
  const cli = await read("src/cli.ts");
  const commands = new Set([...cli.matchAll(/command\("([a-z-]+)/gu)].map((match) => match[1]));
  // Commands defined together, such as sign-out and logout.
  for (const [, names] of cli.matchAll(/for \(const name of \[([^\]]+)\]\)/gu)) for (const [, name] of names!.matchAll(/"([a-z-]+)"/gu)) commands.add(name);
  for (const path of GUIDES) {
    const text = await read(path);
    // Flags on lines that run Planban's command line (not its launcher script or other programs).
    const planbanLines = text.split("\n").filter((line) => /\bplanban(?: --|\s+[a-z-]+)|npm run planban/u.test(line) && !/launch-planban|mcp add|mcp login/u.test(line));
    for (const [flag] of planbanLines.join("\n").matchAll(/(?<![\w-])--[a-z][a-z-]+/gu)) {
      if (OTHER_PROGRAMS.has(flag)) continue;
      assert.ok(cli.includes(`"${flag}`) || cli.includes(` ${flag} `) || cli.includes(`${flag} <`), `${path} names ${flag}, which the command line doesn't have`);
    }
    for (const [, command] of text.matchAll(/planban online ([a-z-]+)/gu)) {
      assert.ok(commands.has(command!), `${path} names planban online ${command}, which doesn't exist`);
    }
  }
});

test("no surface tells an agent to reread and retry a document conflict, or to pass a board revision to write-doc", async () => {
  const surfaces: Array<[string, string]> = [
    ...await Promise.all(GUIDES.map(async (path) => [path, await read(path)] as [string, string])),
    ["local MCP instructions", await read("plugins/planban/mcp/server.mjs")],
    ["remote MCP instructions", await read("online/service/convex/model/mcp.ts")],
    ["agent context", buildAgentContext({ planningRoot: "/p", roadmapPath: "/p/r.json", manifestPath: "/m", online: { url: "https://app.planban.ai", boardId: "b" } })],
  ];
  for (const [name, text] of surfaces) {
    assert.doesNotMatch(text, /(?:reread|read again) and retry/iu, name);
    assert.doesNotMatch(text, /write-doc[^\n]*--base-revision|--base-revision[^\n]*write-doc(?! has no)/u, name);
  }
  // The owner's rule for a refused edit: read what changed, reconcile, say so, never resend or give up silently.
  for (const [name, text] of surfaces.filter(([name]) => !name.endsWith("SKILL.md") && name !== "README.md")) {
    assert.match(text, /what changed/iu, `${name} says to read what changed`);
    assert.match(text, /still needed/iu, `${name} says to apply only what is still needed`);
    assert.match(text, /never just resend/iu, `${name} says never to just resend`);
  }
  for (const [name, text] of surfaces.filter(([name]) => !name.endsWith("SKILL.md") && name !== "README.md" && name !== "local MCP instructions")) {
    assert.match(text, /never give up silently/iu, `${name} says never to give up silently`);
  }
});
