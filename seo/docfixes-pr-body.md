# docs: host-neutral docs and string fixes found while planning the public docs

Branch: `seo/host-neutral-doc-fixes` (stacked on `seo/readme-entity-alignment`)

Text-only fixes for mismatches found while planning the public docs site. No behaviour or logic changes: only Markdown, one issue-template contact link, the CLI program description, and the generated `agent-context.md` template text.

## Fixes

1. **Feedback command and issue templates** (`SUPPORT.md`)
   - `/planbanfeedback` did not exist. Now lists `/planban-feedback` (Codex) and `/planban:planban-feedback` (Claude Code), plus the board toolbar button.
   - Lists all four issue templates, adding the agent-investigated bug template, and links the issue chooser.
   - "Codex-first local core" now reads "the local core and its Codex and Claude Code plugins".
2. **README host neutrality and manual updates** (`README.md`, `.github/ISSUE_TEMPLATE/config.yml`)
   - New "Manual updates" subsection. The Codex commands match the updater's agent prompt in `src/web/main.tsx` and `src/core/updatePreflight.ts`: `codex plugin marketplace upgrade planban`, `npm install`, `node scripts/configure-local-plugin.mjs`, `codex plugin add planban@planban`, with `git pull` for local-clone installs. The existing Claude Code update commands are repeated there as well.
   - "First Run" uses lowercase Codex commands and the Claude Code equivalents, and says "your agent" where it said Codex.
   - "Feedback With Codex" is renamed "Feedback With Your Agent" and names both slash commands. The issue chooser contact link in `config.yml` now points at the new anchor and mentions both hosts.
   - "Updates" drops the Codex-only "first public release" wording. It still describes the `Update with Codex` panel by its real label and notes that its prompt can be copied into any agent session.
   - Local Storage recommends adding `.planban/` to `.gitignore`, because `planban init` does not do it and `agent-context.md` contains absolute paths.
   - Install commands are unchanged.
3. **Agent-context tool list** (`src/core/protocol.ts`)
   - The generated `.planban/agent-context.md` now names all 13 default MCP tools, adding `list_boards`. Existing repos get the new text when their guidance is regenerated.
4. **Codex-first wording** (`src/cli.ts`, `CONTRIBUTING.md`, `SECURITY.md`)
   - The CLI description is now "Local, agent-native planning board for Codex and Claude Code".
   - CONTRIBUTING says "local Codex and Claude Code plugins", and its open-an-issue-first list now says "host support beyond Codex and Claude Code".
   - SECURITY lists Claude Code among the ways Planban reaches project planning state.
5. **Release-note CLI convention** (`CONTRIBUTING.md`)
   - One sentence in the release section: CLI examples in release notes use `node "$PLANBAN_ROOT/bin/planban.mjs" <command>`, because Planban is not on npm. Past release notes are unchanged.

## Verification

- `npm run typecheck`: passed.
- `npm test`: 253 passed, 0 failed.
- `npx tsx src/cli.ts --help` shows the new description.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
