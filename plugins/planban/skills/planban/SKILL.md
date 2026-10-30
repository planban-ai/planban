---
name: planban
description: Use when the user invokes /planban, asks to open Planban, mentions a Planban board, roadmap item, card, spec, plan, docs, or wants the agent to work with Planban state.
---

# Planban

If the user wants to report feedback or appears to be experiencing a Planban bug,
rough edge, or confusing behavior, use `planban-feedback` instead of opening the
board by default. Let that skill reconstruct, investigate, and route the report.

For a plain open request (`/planban`, "open Planban", or selecting Planban from the
slash menu), behave like `/pb`: open the best matching Planban board in the host's
in-app browser, when the host adapter supports one, before doing anything else.

## Non-negotiable response contract

After any successful board URL resolution, the user-facing reply **must include the exact verified URL as a clickable Markdown link**, even when automatic in-app browser opening succeeds. Never reply only that the board opened. Browser presentation is a convenience; the link is the durable handoff and must always remain available in chat.

Critical open path:

1. No pre-open explanation.
2. Do not read linked docs, inspect board state, load Browser docs, or load the full
   Planban protocol before the board is visible.
3. Call the Planban MCP tool whose name ends in `planban_launch_board` for the current
   `cwd` to start/discover and verify the board URL. A result with
   `serviceReady: true` and `urlVerified: true` is the authoritative successful
   launch; preserve its URL (also carried in `userReply.markdown`) before browser work.
4. Make one bounded in-app presentation attempt through the adapter for this host
   under **Host adapters**. Hosts without an adapter skip this step.
5. Reply with the preserved clickable verified URL whether presentation succeeds,
   fails, or is skipped.

If no `planban_launch_board` tool is callable, use the host adapter's fallbacks. A
host without fallbacks runs `node <plugin-root>/scripts/launch-planban.mjs --cwd /path/to/repo`,
where `<plugin-root>` is two directories above this skill's folder, and uses the URL
it prints.

Keep the response short, but always include the exact verified URL:

- Browser opened: `Planban is open: [Open the verified board](URL)`
- Browser unavailable, failed, or not attempted: `Planban is running: [Open the verified board](URL)` plus at most one short reason from the structured browser diagnostics.

Do not replace either response with an unlinked statement such as “Planban is open” or “Board opened.”

## Broader Planban Work

Opening a board is not a roadmap mutation.

For roadmap, card, spec, plan, docs, status, creation, review, completion, or other
Planban state work, read `references/planban-protocol.md` before changing Planban
state.

Planban is an index, not file storage. Never save files into a card's folder; keep
them where they belong and refer to them from the Spec or Plan with a GitHub link, a
web address, or a local path labelled with its machine. The protocol's
**Planban is an index, not storage** section explains references and how to tidy a
card that already holds files.

After a successful user-requested Planban creation or material mutation, follow the
shared protocol's post-mutation handoff. Resolve the verified Board URL once after
the complete logical mutation sequence: take it from the last mutation result's
`userReply`, and call `planban_launch_board` once only if that result has
`boardUrlVerified: false`. Make one bounded in-app presentation attempt through the
host adapter unless the user requested headless behavior, and include the
clickable verified URL in the final response. Do not reopen the Board after every
individual write in a multi-step mutation. Through the remote tools
(`https://app.planban.ai/mcp`), `userReply` holds the board's web address, which is
always verified, and there is no `planban_launch_board`. The protocol's **Tools on
each surface** section lists what differs between the local and remote tools.

On an online board, read the protocol's **Online authority** section before editing:
it covers the two version numbers, merging after a document conflict, retries,
refusals, Complete, accounts on this computer, and never editing the board's files.

After `/planban` or `/pb` opens a board in the current thread, treat near-term
ambiguous follow-ups like "work on this", "do the next thing", "start this card", or
"continue from here" as likely Planban-related when the in-app browser is showing a
Planban board or card. Load the broader protocol then, before reading or mutating
roadmap/card state. If the target card is unclear, ask a short clarifying question.

## Host adapters

Use only the subsection for the host you are running in. Each adapter makes at most
one presentation attempt and never turns a presentation failure into a launch or
mutation failure.

### Codex desktop

Open the returned URL with the installed browser-only adapter in one Node REPL `js`
call, unless the Codex browser bridge itself is unavailable:

```js
{
  const os = await import("node:os");
  const fs = await import("node:fs");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const url = await import("node:url");
  const root = path.join(nodeRepl.homeDir || os.homedir(), ".codex");
  const cacheRoot = path.join(root, "plugins/cache/planban/planban");
  const versions = await fsp.readdir(cacheRoot).catch(() => []);
  let script = versions
    .map((version) => path.join(cacheRoot, version, "scripts/codex-fast-open-planban.mjs"))
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
  if (!script) {
    const pluginCacheRoot = path.join(root, "plugins/cache");
    const matches = [];
    async function visit(directory, depth = 0) {
      if (depth > 6 || script) return;
      const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries.map(async (entry) => {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) return visit(candidate, depth + 1);
        if (entry.isFile() && candidate.endsWith("/scripts/codex-fast-open-planban.mjs")) matches.push(candidate);
      }));
    }
    await visit(pluginCacheRoot);
    script = matches.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
  }
  if (!script) throw new Error(`Could not find codex-fast-open-planban.mjs under ${cacheRoot}`);
  const mod = await import(url.pathToFileURL(script).href);
  const result = await mod.openUrlInCodexBrowser({
    url: "VERIFIED_URL_FROM_PLANBAN_LAUNCH_BOARD",
    urlVerified: true,
    serviceReady: true
  });
  nodeRepl.write(JSON.stringify(result));
}
```

The adapter returns `browserOpened: false`, the preserved verified `url`, and
structured browser diagnostics instead of throwing for browser degradation. Browser
presentation is optional and must not redefine the successful launch result.

If `node_repl` `js` is not callable, make at most one tool-discovery call for
`node_repl js execute JavaScript`. Do not call `js_reset`, `js_add_node_module_dir`,
or Browser documentation on the open path.

If the `node_repl` `js` call fails at the tool/runtime layer before JavaScript runs
(for example a missing sandbox metadata field, disabled Node REPL, permission bridge
failure, or MCP argument validation failure), treat the Codex browser bridge as
unavailable for this turn. Do not try local Node, Browser documentation, Computer Use,
Codex app UI automation, or repeated opener variations. Return the verified Planban
URL immediately and state that the board is running but automatic in-app opening is
unavailable.

Fallbacks:

1. If the Planban MCP tool is not callable, use
   `openPlanbanBoardInCodexBrowser({ cwd, statusTimeoutMs: 800, launchTimeoutMs: 3500 })`
   only when `node_repl` `js` is available.
2. Use the current Browser plugin/runtime when opening the returned URL; do not reuse
   a browser helper path from an older thread or older Codex app build.
3. Otherwise run `node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo`
   to resolve/start the board, then attempt the single browser opener above if
   `node_repl` is available.
4. Always return the clickable verified URL; use `browserOpened` only to choose the short success or degradation wording.

### Claude Code desktop

Open the verified URL in the built-in browser pane with the pane's navigate tool
(currently `mcp__Claude_Browser__navigate` with `{ "url": "<verified URL>" }`). Tool
names can change between app versions, so match on that capability.

- Make one attempt. If the tool is listed as deferred, load it with a single
  tool-search call first; search no further.
- If no such tool is in the session, or the call errors, skip presentation and return
  the link with one short reason.
- Keep the attempt inside the pane: the OS `open` command and external browsers are
  not first attempts, and Computer Use is out of scope.

### Other hosts

Make no presentation attempt. Return the link.
