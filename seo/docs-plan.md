# planban.ai/docs: proposal for owner approval

Status: proposal only. Nothing in this document has been built. No repository was changed to produce it.

Scope: a public documentation section at `https://planban.ai/docs/`, built in the `planban-site` repository with the same Markdown to prerendered page mechanism that PR 2 (`seo/host-pages-faq-definition`) introduces, served from the same Cloudflare Pages host, with no docs framework.

Source of truth: every claim is derived from the Planban product repository at tag `v1.1.6` (commit `ced8bcf`). Note that the main checkout at `~/repos/planban` is currently on `local/v1.1.6-with-wip`, which contains unreleased work; the implementing agent must read sources at the tag (for example `git show v1.1.6:<path>`), not from that working tree. The v1.1.6 GitHub release body and `release/notes/v1.1.6.md` were compared and are identical apart from a trailing blank line.

Writing rules for every page: shipped v1.1.6 behaviour only; British spelling; "Claude" in prose, "Claude Code" for the host product and its commands; no em dashes; each page opens with one definitional sentence and uses question-phrased H2s, matching the PR 2 pages.

---

## 1. Proposed pages

Sixteen pages plus a changelog index and one release page. All paths are folder-style with a trailing slash. Paths in the Sources column are relative to the product repository root at `v1.1.6`.

### 1.1 Summary table

| # | Slug under /docs/ | Page title (H1) | Section | Target length |
| --- | --- | --- | --- | --- |
| 1 | `/docs/` | Planban documentation | Index | 300 to 400 words plus generated link list |
| 2 | `/docs/install-codex/` | Install Planban in Codex | Get started | 800 to 900 |
| 3 | `/docs/install-claude-code/` | Install Planban in Claude Code | Get started | 750 to 850 |
| 4 | `/docs/other-mcp-hosts/` | Use Planban from other MCP hosts | Get started | 550 to 650 |
| 5 | `/docs/set-up-a-project/` | Set up Planban for a project | Get started | 650 to 750 |
| 6 | `/docs/slash-commands/` | Planban commands in Codex and Claude Code | Use Planban | 650 to 750 |
| 7 | `/docs/items-and-groups/` | Items and Groups | Use Planban | 750 to 850 |
| 8 | `/docs/status-and-priority/` | Status and priority | Use Planban | 650 to 750 |
| 9 | `/docs/specs-plans-next-actions/` | Specs, Plans and next actions | Use Planban | 750 to 850 |
| 10 | `/docs/agent-protocol/` | How agents work with the board | Use Planban | 750 to 850 |
| 11 | `/docs/cli/` | Planban CLI reference | Reference | 1,600 to 1,800 |
| 12 | `/docs/mcp-tools/` | Planban MCP tools reference | Reference | 1,800 to 2,000 |
| 13 | `/docs/data-storage/` | Where Planban stores your data | Reference | 850 to 950 |
| 14 | `/docs/git-worktrees/` | Planban in git worktrees | Reference | 550 to 650 |
| 15 | `/docs/updating/` | Update Planban | Maintain | 850 to 950 |
| 16 | `/docs/troubleshooting/` | Troubleshooting Planban | Maintain | 950 to 1,050 |
| 17 | `/docs/changelog/` | Planban changelog | Changelog | 350 to 450 |
| 18 | `/docs/changelog/v1-1-6/` | Planban v1.1.6 | Changelog | 400 to 500 |

Total: roughly 14,000 words.

Relationship to PR 2 pages: `/claude-code/` and `/codex/` stay as the short, persuasive host pages (one install prompt, one manual block, what the agent does). The docs install pages are the complete reference (prerequisites, every install path, verification, Windows, first-launch behaviour). Each host page gains one link to its docs install page; there is no canonical cross-reference because the search intents differ. `/what-is-an-agent-native-kanban-board/` stays the conceptual page and links to Items and Groups.

### 1.2 Page detail

Each block gives the remaining table columns for one page: the definitional opening, the H2s, and the exact sources for its claims.

#### 1. `/docs/` Planban documentation

- Opening: "Planban documentation explains how to install Planban in Codex and Claude Code, how its board models work as Items, Groups, Status, Specs and Plans, and how agents use its CLI and MCP tools to keep that board current."
- H2s:
  - Where do I start?
  - Which host should I install Planban in?
  - Which version do these docs describe?
- Body: short intro, then a grouped link list generated from the docs registry (not hand-written), so it cannot drift from the route table.
- Sources: `README.md` opening paragraphs and "Install" host table; `plugins/planban/.claude-plugin/plugin.json` and `plugins/planban/.codex-plugin/plugin.json` (version 1.1.6, MIT); site `src/site/site-facts.ts` (`planbanVersion`).

#### 2. `/docs/install-codex/` Install Planban in Codex

- Opening: "Planban installs in Codex as a Git-backed plugin marketplace named `planban`, and it needs Node.js 22.12.0 or later with npm on your machine."
- H2s:
  - What do I need before installing?
  - How do I install Planban by asking Codex?
  - How do I install Planban manually on macOS or Linux?
  - How do I install Planban with PowerShell on Windows?
  - How do I install Planban from a local clone?
  - How do I check that the install worked?
  - What happens on first launch if I skip `npm install`?
  - Why does Planban poll for changes on Windows?
- Sources: `README.md` sections "Install With Codex", "Install With Codex details" (nine steps), "Manual Install" (bash block, first-launch bootstrap paragraph with the two-minute allowance, PowerShell block, the `__PLANBAN_REPO_ROOT__` note, the Windows polling paragraph and `CHOKIDAR_USEPOLLING=1`, "Local clone fallback"); `package.json` `engines.node`; `plugins/planban/.mcp.json` (`startup_timeout_sec: 120`); `.agents/plugins/marketplace.json`; `plugins/planban/.codex-plugin/plugin.json`; `scripts/configure-local-plugin.mjs`; `plugins/planban/scripts/launch-planban.mjs` (`--tutorial`).

#### 3. `/docs/install-claude-code/` Install Planban in Claude Code

- Opening: "Planban installs in Claude Code as the `planban` plugin from the `planban` marketplace, which adds six `/planban:` commands, the Planban MCP server and a session-start hook to Claude Code."
- H2s:
  - What do I need before installing?
  - How do I install Planban by asking Claude?
  - How do I install Planban manually?
  - How do I install Planban from a local clone?
  - How do I check that the install worked?
  - Why should I run `npm install` before the first session?
  - Where does the board open?
  - Do Codex and Claude Code share the same boards?
- Sources: `README.md` sections "Install" (host table and the shared-boards sentence), "Install With Claude Code", "Install With Claude Code details" (commands, `claude mcp list` showing `plugin:planban:planban`, browser pane sentence, short startup window paragraph, "Local clone fallback"); `.claude-plugin/marketplace.json`; `plugins/planban/.claude-plugin/plugin.json` (`mcpServers.planban` using `${CLAUDE_PLUGIN_ROOT}/scripts/start-planban-mcp.mjs`); `plugins/planban/hooks/hooks.json` (SessionStart, 10 second timeout); `plugins/planban/scripts/runtime-root.mjs` (`claudeMarketplaceRuntime`, `known_marketplaces.json`, `CLAUDE_CONFIG_DIR`); `plugins/planban/skills/pb/SKILL.md` "Claude Code desktop" adapter; release notes v1.1.6 "Claude Code desktop support".

#### 4. `/docs/other-mcp-hosts/` Use Planban from other MCP hosts

- Opening: "Any agent host that can run a local stdio MCP server can use Planban's tools by starting `plugins/planban/scripts/start-planban-mcp.mjs` from a Planban checkout, although it gets no slash commands or skills."
- H2s:
  - What does another MCP host get, and what does it miss?
  - How do I configure the Planban MCP server?
  - How does the agent learn Planban's rules without the skills?
  - How does the agent return the board link?
  - What happens in a Planban project when the host has no Planban install?
- Sources: `README.md` "Other hosts"; `plugins/planban/scripts/start-planban-mcp.mjs`; `plugins/planban/scripts/runtime-root.mjs` (`PLANBAN_REPO_ROOT` and checkout resolution); `plugins/planban/mcp/server.mjs` (`PLANBAN_MCP_INSTRUCTIONS`, `userReply`, `boardUrlVerified`); `src/core/protocol.ts` section "If Planban tools are not available in this session"; release notes v1.1.6 "Host-neutral agent handoff". The configuration example will be a generic stdio command plus environment variable, labelled as such, because no host-specific format is documented or tested in the repo (see section 3).

#### 5. `/docs/set-up-a-project/` Set up Planban for a project

- Opening: "Setting up Planban for a project creates a board for that repository: it writes two discovery files in the project's `.planban/` folder, creates a live roadmap under `~/.planban`, and adds a managed Planban block to the project's `AGENTS.md`."
- H2s:
  - How do I set up a project by asking my agent?
  - What does setting up a project write?
  - How is the board's id chosen?
  - What are the tutorial and the Planban Demo board?
  - How do I turn existing plans into Planban Items?
  - How do I refresh a project's generated guidance after an update?
- Sources: `README.md` "First Run" (set-up prompt, import-from-notes paragraph); `src/core/storage.ts` `initializeProject`, `buildAgentsBlock`, `upsertManagedBlock` (`<!-- BEGIN PLANBAN -->` markers, existing roadmap never overwritten); `src/cli.ts` `init` options (`--cwd`, `--title`, `--repo-id`, `--no-agents`); `src/core/paths.ts` `defaultRepoId`, `slugify`; `src/core/protocol.ts` `buildAgentContext`; `src/core/demo.ts`; `plugins/planban/skills/planban-tutorial/SKILL.md`; `plugins/planban/skills/planban-create/SKILL.md`; release notes v1.1.6 "Updating" (subject to the discrepancy in section 3, item F).

#### 6. `/docs/slash-commands/` Planban commands in Codex and Claude Code

- Opening: "Planban adds six commands to each host, `pb`, `planban`, `planban-create`, `planban-help`, `planban-tutorial` and `planban-feedback`, and Claude Code lists them with the plugin prefix, as in `/planban:pb`."
- H2s:
  - Which commands does Planban add?
  - How do I type them in Codex and in Claude Code?
  - What does each command do?
  - Can I use plain prompts instead of commands?
  - What does the reply contain after a board opens?
  - Which command can run without being typed?
- Sources: `plugins/planban/skills/*/SKILL.md` (six skills); `plugins/planban/skills/*/agents/openai.yaml` (`display_name`, `allow_implicit_invocation`: true only for `planban-feedback`); `plugins/planban/skills/planban/references/planban-protocol.md` "Command-Like Skills"; `plugins/planban/skills/planban-help/SKILL.md` command table and "Suggested Natural Prompts"; `README.md` "Install" host table; `plugins/planban/skills/pb/SKILL.md` "Response". The Codex column depends on resolving section 3, item B.

#### 7. `/docs/items-and-groups/` Items and Groups

- Opening: "In Planban, an Item is one independently trackable outcome, and a Group is a Main Board card that owns related Items and gives them their own status columns and priority order."
- H2s:
  - What is an Item?
  - What is a Group?
  - When should I create a Group rather than an Item?
  - How do I put Items into a Group?
  - Can a Group contain another Group?
  - What happens to an Item's status when it moves into a Group?
  - What is Group progress?
- Sources: `plugins/planban/skills/planban/references/planban-protocol.md` "Work Item Model"; `plugins/planban/skills/planban/references/planban-house-style.md` "Product terms"; `plugins/planban/skills/planban-help/SKILL.md` vocabulary list; `plugins/planban/skills/planban-create/SKILL.md` domain model bullets; `README.md` "First Run" bullets (drag one Item onto another); `src/core/storage.ts` `createGroup`, `moveCard`; `src/cli.ts` `create-group`, `move-card --parent`, `move-card --board`; release notes v1.1.0 "Groups and Items" (background only).

#### 8. `/docs/status-and-priority/` Status and priority

- Opening: "Status is the board column an Item or Group sits in, one of In Progress, Up Next, Pending, Complete or Archived, and priority is its position within that column, shown on the card as P1, P2 and so on."
- H2s:
  - What are the five statuses?
  - What does priority mean?
  - How do I change an Item's priority?
  - Who can mark work Complete?
  - What happens when an Item is archived?
  - What does "blocked by" mean on a card?
- Sources: `src/core/types.ts` `PLANBAN_STATUSES`, `priority`, `boardRank`, `groupRank`, `blockedBy`; `src/core/storage.ts` `STATUS_LABELS`, `normalizeColumnPriorities`, `assignHierarchyRanks`; `src/web/main.tsx` (the `P{rank}` badge, Archived hidden unless shown); `src/cli.ts` `move-card --after/--first`, `complete-card`, `archive-card`, `restore-card` (restores to Pending); `plugins/planban/mcp/server.mjs` `planban_move_card` (`completionConfirmed`); `plugins/planban/skills/planban/references/planban-protocol.md` "Roadmap Status Protocol"; `plugins/planban/skills/planban/references/planban-house-style.md` "Product terms". See section 3, item J, on the word "priority".

#### 9. `/docs/specs-plans-next-actions/` Specs, Plans and next actions

- Opening: "Every Planban Item carries a summary and a next action on its card, a Spec document that records its purpose, scope and acceptance, and, when the work needs one, a Plan document that sets out how it will be delivered and verified."
- H2s:
  - What goes on the card itself?
  - What is a Spec?
  - What is a Plan, and when does an Item get one?
  - What makes a good next action?
  - Where are Spec and Plan files stored?
  - How do agents read and write them safely?
- Sources: `plugins/planban/skills/planban/references/planban-house-style.md` "Information locations and ownership" table and the Title, Summary, Next action, Spec and Plan rules; `PRODUCT.md` principle 4 "Human clarity above, execution detail below"; `plugins/planban/mcp/server.mjs` `planban_create_card` (default Spec generated when omitted; Plan only when supplied), `planban_read_doc`, `planban_write_doc` (`expectedMtimeMs`); `src/core/storage.ts` `docPathForItem`, `writeDoc`; `src/core/paths.ts` `itemRoot`; `README.md` "Local Storage".

#### 10. `/docs/agent-protocol/` How agents work with the board

- Opening: "The Planban protocol is the set of rules an agent follows when it changes a board: it moves an Item to In Progress when implementation starts, leaves finished work In Progress for your review, and marks work Complete only when you say so."
- H2s:
  - When does an agent change an Item's status?
  - Why does finished agent work stay In Progress?
  - What does the agent tell me after changing the board?
  - Why does the agent make one change at a time?
  - How does an agent find the board in a new session?
  - What does a handoff to a new agent session include?
- Sources: `plugins/planban/skills/planban/references/planban-protocol.md` "Roadmap Status Protocol", "Updating Roadmap State", "Post-mutation handoff", "Agent handoff prompts", "First Reads"; `src/core/protocol.ts` `buildAgentContext`; `src/core/storage.ts` `buildAgentsBlock`; `plugins/planban/mcp/server.mjs` `PLANBAN_MCP_INSTRUCTIONS` and `baseRevision` parameters; `plugins/planban/scripts/claude-session-context.mjs`; `PRODUCT.md` principle 2 "One shared planning truth".

#### 11. `/docs/cli/` Planban CLI reference

- Opening: "The Planban CLI is the `planban` program at `bin/planban.mjs` in your Planban marketplace checkout; Planban is not published to npm, so you run it with `node` from that checkout."
- H2s:
  - How do I run the CLI?
  - Which options do most commands share?
  - Which commands manage boards?
  - Which commands read Items?
  - Which commands create and change Items?
  - Which commands read and write Specs and Plans?
  - How do I check for updates from the CLI?
  - Which commands are for recovery only?
- Coverage: every visible command in `src/cli.ts`: `init`, `status`, `update`, `demo`, `list-boards`, `archive-board`, `restore-board`, `duplicate-board`, `delete-board`, `serve`, `list-cards`, `query-cards`, `get-card`, `move-card`, `update-card`, `create-card`, `create-group`, `create-cards`, `complete-card`, `archive-card`, `restore-card`, `read-doc`, `write-doc`, `export-flat-v1`, `reconstruct-hierarchy`, and `set-card-parent` marked deprecated. Hidden aliases (`create-programme`, `--programme`, `--deliverable`) are omitted.
- Sources: `src/cli.ts` (every `.command(...)` block with its options and validation messages); `bin/planban.mjs`; `package.json` `bin` and `scripts.planban`; `src/core/protocol.ts` CLI fallback line (`node <planban-checkout>/bin/planban.mjs <command> --cwd <repo> -o json`); `plugins/planban/skills/planban/references/planban-protocol.md` CLI examples. See section 3, item F, for the invocation form.

#### 12. `/docs/mcp-tools/` Planban MCP tools reference

- Opening: "Planban's MCP server exposes 13 tools by default for reading boards, changing Items and opening the board, and seven more administration, recovery and legacy tools only when the `PLANBAN_MCP_PROFILE` environment variable asks for them."
- H2s:
  - Which tools are available by default?
  - What does each tool take and return?
  - What does every result include?
  - Which tools only read?
  - How do I enable the administration and recovery tools?
  - What instructions does the server give the agent?
- Coverage: default tools `planban_status`, `planban_list_boards`, `planban_get_board`, `planban_query_cards`, `planban_get_card`, `planban_create_card`, `planban_create_cards`, `planban_create_group`, `planban_read_doc`, `planban_move_card`, `planban_update_card`, `planban_write_doc`, `planban_launch_board`; profile tools `planban_archive_board`, `planban_restore_board`, `planban_duplicate_board`, `planban_delete_board` (admin), `planban_export_flat_v1`, `planban_reconstruct_hierarchy` (maintenance), `planban_set_card_parent` (legacy).
- Sources: `plugins/planban/mcp/server.mjs` (the `tools` array with input schemas and annotations, `PROFILE_TOOL_NAMES`, `advertisedTools`, `PLANBAN_MCP_INSTRUCTIONS`, `verifiedLaunchResult`, default port 4317); release notes v1.1.6 "Host-neutral agent handoff" (`boardUrl`, `boardUrlVerified`, `userReply`, compact `itemCount`). Whether to document the profiles is an owner decision (section 3, item Q).

#### 13. `/docs/data-storage/` Where Planban stores your data

- Opening: "Planban keeps two small discovery files in your project's `.planban/` folder and keeps all live board state, Specs, Plans and history in a planning root on your own machine at `~/.planban`, outside your repository."
- H2s:
  - What is in my project's `.planban/` folder?
  - Should I commit `.planban/` to my repository?
  - What is in `~/.planban`?
  - How much history does Planban keep?
  - Does Planban upload any of my data?
  - How do I back up or delete a board?
- Sources: `README.md` "Local Storage" and "Updates" (final paragraph on update checks); `src/core/paths.ts` (`index.json` registry, `repos/<repo-id>/roadmap.json`, `events.ndjson`, `items/<card-id>/`, `history/`, `backups/boards/`, `detached/`, `PLANBAN_HOME`); `src/core/demo.ts` (`demo/`); `plugins/planban/scripts/launch-planban.mjs` `launchLogPath` (`logs/launch-<port>.log`); `src/core/history.ts` retention (100 board versions, 25 card versions, 25 document versions, 90 days); `src/core/registry.ts` `deleteBoard` (timestamped backup), `duplicateBoard`; `src/core/types.ts` `PlanbanProjectManifest` (`storage.root`); `.gitignore` (the product repo ignores `.planban/`). Decisions needed: section 3, items H and P.

#### 14. `/docs/git-worktrees/` Planban in git worktrees

- Opening: "When an agent session runs in a linked git worktree, Planban resolves the board that belongs to the repository's main checkout, so every worktree of a repository shares one board."
- H2s:
  - Why do worktrees need special handling?
  - How does Planban find the main checkout?
  - Which path should the agent pass as `cwd`?
  - How can I tell that worktree resolution happened?
  - When does worktree resolution not apply?
  - Does each branch get its own board?
- Sources: `plugins/planban/scripts/project-dir.mjs` (`mainCheckoutForWorktree` via the `.git` file's `gitdir` and `commondir`, discovery stops at the repository top, an ancestor manifest wins); `src/core/storage.ts` `getStatus` (`requestedCwd`, `discoveredVia`); `plugins/planban/scripts/claude-session-context.mjs` worktree sentence; `src/core/protocol.ts` tools paragraph; `src/core/protocol.ts` "not branch-local" wording; release notes v1.1.6 "Board discovery from linked git worktrees".

#### 15. `/docs/updating/` Update Planban

- Opening: "Planban checks public version metadata on GitHub while a board is open and shows an update notice, and you then update it from the board, through your agent, or with your host's plugin commands."
- H2s:
  - How do I know an update is available?
  - What do "Update now" and "Update with Codex" do?
  - How do I update Planban in Codex?
  - How do I update Planban in Claude Code?
  - Why does Claude Code need a reinstall to pick up plugin changes?
  - Why do I need to start a new session after updating?
  - What does the update check send to GitHub?
- Sources: `README.md` "Updates", "Install With Claude Code details" (update commands and the plugin-cache paragraph), "Manual Install" (`__PLANBAN_REPO_ROOT__` note); `release/latest.json` (`updatePrompt`, `postUpdateRoute`); `src/core/updatePreflight.ts` (`recommendedAction`, `buildFallbackPrompt` with `codex plugin marketplace upgrade planban`); `src/core/updateRunner.ts`; `src/cli.ts` `update --dry-run/--execute`; `src/web/main.tsx` update panel labels; release notes v1.1.6 "Updating" and v1.1.5 "Updating". Decisions needed: section 3, items D and E.

#### 16. `/docs/troubleshooting/` Troubleshooting Planban

- Opening: "Most Planban problems come from an MCP server that did not start, a stale plugin cache, a busy port or a project that has not been set up, and each has a specific fix."
- H2s:
  - Why are the Planban tools missing from my session?
  - What does "Planban runtime not found" mean?
  - What does "Planban is not initialized" mean?
  - What if port 4317 is already in use?
  - Where is Planban's launch log?
  - Why did the board not open beside my session?
  - Why do my plugin changes not appear in Claude Code?
  - Why are board updates slow to appear on Windows?
  - How do I report a bug or send feedback?
- Sources: `plugins/planban/scripts/runtime-root.mjs` (exact "Planban runtime not found" message); `src/core/storage.ts` `loadState` ("Planban is not initialized in", "Planban roadmap is missing at"); `plugins/planban/scripts/launch-planban.mjs` (port-in-use and stale-process messages, `--port`, `launchLogPath`); `plugins/planban/.mcp.json` startup timeout; `README.md` "Manual Install" (first-launch and Windows paragraphs), "Install With Claude Code details" (startup window and cache paragraphs), "Feedback With Codex"; `plugins/planban/skills/pb/SKILL.md` degradation replies; `SUPPORT.md`; `SECURITY.md`; `plugins/planban/skills/planban-feedback/SKILL.md`; `.github/ISSUE_TEMPLATE/` (bug, agent-investigated bug, feature request, feedback).

#### 17. `/docs/changelog/` Planban changelog

- Opening: "The Planban changelog lists every public Planban release, with a page for each release from v1.1.6 onwards and a link to the GitHub release notes for earlier versions."
- H2s:
  - What changed in the latest release?
  - Which releases came before v1.1.6?
  - How do I update to the latest release?
- Body: latest release summary, then a table of earlier releases (version, date, one-line summary, GitHub link), generated from a small data list, not free text.
- Sources: `gh release list --repo piercekearns/planban`; `release/notes/*.md` (one-line summaries); `release/latest.json` `changelogSummary`.

#### 18. `/docs/changelog/v1-1-6/` Planban v1.1.6

- Opening: "Planban v1.1.6, released on 26 September 2026, adds Claude Code desktop support, makes the agent's board-link handoff work the same way in every host, and resolves boards from linked git worktrees."
- H2s:
  - What is new for Claude Code?
  - What changed in how agents hand back the board link?
  - What changed for git worktrees?
  - How do I update to v1.1.6?
- Sources: `release/notes/v1.1.6.md` (identical to the GitHub release body); `release/latest.json` (`summary`, `changelogSummary`, `updatePrompt`); GitHub release publish time 2026-09-26T17:51:59Z.

### 1.3 Releases and changelog recommendation

Public GitHub releases that exist (UTC publish dates):

| Version | Published | Theme (from `release/notes/`) |
| --- | --- | --- |
| v1.0.0 | 2026-06-17 | First public release (Codex only) |
| v1.0.2 | 2026-08-28 | Fixes |
| v1.0.3 | 2026-08-28 | Fixes |
| v1.0.4 | 2026-08-29 | Fixes |
| v1.0.5 | 2026-08-30 | Feedback flow and PR eligibility |
| v1.1.0 | 2026-08-30 | Groups and Items, clearer records |
| v1.1.1 | 2026-08-30 | Reliability and usability patch |
| v1.1.2 | 2026-08-30 | Compatibility and launch reliability |
| v1.1.3 | 2026-08-31 | Visible agent activity, calmer surfaces |
| v1.1.4 | 2026-09-01 | Faster future updates, Windows updates |
| v1.1.5 | 2026-09-16 | Reliable first launches |
| v1.1.6 | 2026-09-26 | Claude Code support, host-neutral handoff, worktrees |

`release/notes/v1.0.1.md` exists in the repo, but there is no `v1.0.1` tag or GitHub release.

Recommendation: create per-release pages from v1.1.6 onwards only, and list v1.0.0 to v1.1.5 in the changelog index as one-line rows linking to GitHub. Reasons: those releases predate Claude Code support, most are short patch notes that would make thin pages, several contain install or preview-user instructions that are now wrong, and a page that describes superseded behaviour conflicts with the "shipped v1.1.6 behaviour only" rule. If the owner wants one historical page, v1.1.0 is the only candidate with lasting value, because it introduced Groups and Items.

---

## 2. llms.txt

### 2.1 Structure (per llmstxt.org)

Generated at build time to `dist/site/llms.txt`:

```text
# Planban

> Planban is a local-first, agent-native Kanban board that installs as a plugin in Codex and Claude Code, so your agents keep the plan current and you see the whole project at a glance.

Current version: 1.1.6. MIT licence. Planban is not published to npm; install it through the Codex or Claude Code plugin marketplace from https://github.com/piercekearns/planban. Board state stays on your machine under ~/.planban.

## Get started
- [Install Planban in Codex](https://planban.ai/docs/install-codex/): <front matter description>
- [Install Planban in Claude Code](https://planban.ai/docs/install-claude-code/): ...
- [Use Planban from other MCP hosts](...): ...
- [Set up Planban for a project](...): ...

## Use Planban
- (pages 6 to 10)

## Reference
- (pages 11 to 14)

## Maintain
- (pages 15 and 16)

## Changelog
- [Planban changelog](https://planban.ai/docs/changelog/): ...
- [Planban v1.1.6](https://planban.ai/docs/changelog/v1-1-6/): ...

## Optional
- [Planban for Claude Code](https://planban.ai/claude-code/): ...
- [Planban for Codex](https://planban.ai/codex/): ...
- [What is an agent-native Kanban board?](https://planban.ai/what-is-an-agent-native-kanban-board/): ...
- [Planban on GitHub](https://github.com/piercekearns/planban): source, README and issues
- [Earlier releases](https://github.com/piercekearns/planban/releases): v1.0.0 to v1.1.5
```

### 2.2 How it is produced

- A single ordered docs registry (proposed `src/site/docs.ts`) lists each docs page's Markdown import and its section. `routes.ts` builds the docs routes from it, the docs index and page navigation render from it, and the prerender step writes `llms.txt` from it. One list, four consumers, so a page cannot be in the site but missing from `llms.txt`, or the reverse.
- The H1 and blockquote come from `site-facts.ts` (`planbanCanonicalDescription`), the version from `planbanVersion`, each link title from the page H1 (`articleHeadline`) and each note from the front matter `description`. The "Optional" section is a short fixed list in the same registry.
- `scripts/prerender-site.mjs` writes the file after rendering pages, in the same pass that writes `sitemap.xml`. `llms.txt` is not added to the sitemap.
- `src/site/public/_headers` gains:

  ```text
  /llms.txt
    X-Robots-Tag: noindex
    Cache-Control: public, max-age=3600
  ```

  The file stays fetchable by agents and allowed in `robots.txt`, but search engines do not list it as a result.
- `scripts/audit-public-site.mjs` adds `dist/site/llms.txt` to its required files and checks that every planban.ai link in it matches an indexable route.
- Deferred, owner decision: an `llms-full.txt` or raw `.md` mirrors of each page. Both are cheap because the Markdown source already exists, but neither is needed for the first release.

### 2.3 Site mechanism changes the docs need

PR 2's mechanism is reused, but these parts do not yet support a docs section and must change in this PR:

1. `vite.site.config.ts`: the Markdown transform only matches `src/site/content/[^/]+\.md`. It must also match `src/site/content/docs/**/*.md`.
2. `routes.ts` `articleRoute`: the path check only accepts one segment (`/^\/[a-z0-9-]+\/$/`). It must accept `/docs/`, `/docs/<slug>/` and `/docs/changelog/<slug>/`. `SiteRouteId` becomes a union that includes generated docs ids.
3. Breadcrumbs: `ContentPage` and `buildArticleStructuredData` produce two levels (Home, page). Docs pages need three (Home, Docs, page) in both the visible breadcrumb and the `BreadcrumbList` JSON-LD.
4. Related links: `ContentPage` currently lists every other article page in its footer. With 18 docs pages that list becomes noise. Docs pages get previous and next links plus a compact section navigation from the registry; marketing pages keep their current related list and exclude docs pages.
5. Tables: `markdown.ts` has no table support. The CLI and MCP reference pages read far better with tables. Recommendation: add GitHub-style pipe tables to the parser (about 40 lines plus CSS, with a horizontal scroll wrapper for mobile). Alternative: one `###` heading per command with a bullet list, and no parser change.
6. Navigation: add "Docs" to the header and footer in `PlanbanPublicWebsite.tsx`, and one link from `/claude-code/` and `/codex/` to their install pages.
7. Bundle size: every content document is imported statically, so all docs JSON would ship in the one client bundle for every page (the current `main` bundle is 280 KB before compression). Recommendation: set a budget of +30 KB gzipped; if exceeded, load a docs page's document with a dynamic import in `entry-client.tsx` before hydration. This may instead be folded into PR 4 (performance) if the owner prefers.
8. Maintenance aid: each docs Markdown file gets a `sources:` front matter line listing its product repo paths. The parser already ignores unknown single-line keys, so this costs nothing at render time and tells the next release's agent what to re-check.
9. Audit: add the docs outputs to `requiredFiles`, and add an internal link check (every `/docs/...` link resolves to a route, every heading anchor exists). Optional: a style check that fails on em dashes in `src/site/content/**`.

---

## 3. Unverified facts and disagreements

Items the owner should decide or confirm before content is written. Each names the sources that disagree.

### 3.1 Disagreements between README, SUPPORT.md, skills and code

- **A. Feedback command name.** `SUPPORT.md` says `/planbanfeedback`, and only for Codex. The skill is `planban-feedback` (`plugins/planban/skills/planban-feedback/`); `planban-help` lists it as `/Planban Feedback` in Codex and `/planban:planban-feedback` in Claude Code. Proposal: docs use the skill names; `SUPPORT.md` gets a follow-up fix in the product repo.
- **B. Codex command spelling.** `README.md` host table: `/pb`, `/planban`, `/planban-create`. `planban-help` skill: `/PB` or `/Planban`, `/Planban Help`, `/Planban Tutorial`, `/Planban Create`, `/Planban Feedback` (these match the `display_name` values in each `agents/openai.yaml`). `README.md` "First Run": "`/PB`, `/Planban`, and `Planban Tutorial`". `planban-protocol.md`: "`/pb`, `/planban`, and so on". The owner needs to confirm what a Codex user actually types or picks from the `/` menu in v1.1.6.
- **C. Board UI wording is Codex-only.** In `src/web/main.tsx` the feedback dialog's primary button is "Open in Codex" (a `codex://threads/new` deep link; `src/server/server.ts` rejects other URL schemes), the update panel says "Update with Codex" and "Open setup prompt in Codex", and generated update prompts mention "the Codex in-app browser". There are no Claude Code strings in the board UI. In Claude Code only the "copy prompt" fallback applies. Docs will describe the buttons exactly as labelled and tell Claude Code users to copy the prompt. The PR 2 `/claude-code/` page tells users to "use the feedback button in the board toolbar", which is true but may surprise them.
- **D. Direct updater and Claude Code installs.** `src/core/updatePreflight.ts` checks for the `codex` CLI and reads Codex's marketplace configuration. What "Update now" does on a machine with only Claude Code installed is not verifiable from the repo; it may fall back to "Setup needed" and ask for the Codex CLI. Needs an owner test, or docs say "In Claude Code, update with the plugin commands".
- **E. Manual Codex update commands are missing from the README.** The README gives manual update commands for Claude Code only. The only Codex manual path in the repo is inside the updater's fallback prompt (`codex plugin marketplace upgrade planban`, then reinstall `planban@planban`). Confirm that this is the command to publish.
- **F. `planban init` in the v1.1.6 release notes.** The notes say to refresh guidance by "re-running `planban init` with `--repo-id` and `--no-agents`". There is no `planban` command on the user's PATH (not on npm). The repo uses three invocation forms: `npm run planban -- <command>` (skills; works only inside a checkout), `node <planban-checkout>/bin/planban.mjs <command>` (`agent-context.md`), and bare `planban` (release notes). Also, `--no-agents` skips the `AGENTS.md` block, while the same notes say that block gained new content. Proposal: docs use `node "$PLANBAN_ROOT/bin/planban.mjs"` throughout, and the refresh instruction says whether to keep or drop `--no-agents`.
- **G. `AGENTS.md` but no `CLAUDE.md`.** `initializeProject` writes a managed block to `AGENTS.md` only. Whether Claude Code reads `AGENTS.md` cannot be verified from the repo; for Claude Code, orientation comes from the SessionStart hook (`claude-session-context.mjs`). Docs will say exactly that, unless the owner wants a different claim.
- **H. Should users commit `.planban/`?** `README.md` only says not to commit `~/.planban`. `project-dir.mjs` and the v1.1.6 notes say `.planban/` discovery files are "usually git-ignored", but `init` does not edit `.gitignore`. `agent-context.md` contains absolute device paths (for example the user's home directory), which argues for ignoring it. The owner needs to choose the recommendation.
- **I. Tool list in `agent-context.md`.** It names 12 tools and omits `planban_list_boards`, which the server advertises by default (13 tools).
- **J. "Priority" has no field to set.** `agent-context.md` says "update priority when ordering changes within a column", but no MCP tool or CLI option accepts a priority value; `priority` is recomputed from position in the column (`normalizeColumnPriorities`). Docs will define priority as position and explain reordering. Confirm this wording.
- **K. Codex-first wording elsewhere.** `src/cli.ts` describes the program as a "Codex-native local planning board"; `CONTRIBUTING.md` says "local Codex plugin" and lists "host support beyond Codex" as needing an issue; `SUPPORT.md` says "Codex-first local core"; `SECURITY.md` says "through Codex, CLI, local API, and MCP tools"; `README.md` "Updates" still says "For this first public release, fresh installs should start with the interactive tutorial in the Codex in-app browser", and "First Run" and "Feedback With Codex" are Codex-only. Docs will be host-neutral; these files need a follow-up README-style PR in the product repo.
- **L. `restore-card` destination.** The CLI's `restore-card` moves an archived Item to Pending, not to its previous status. Confirm that this is intended before docs state it.
- **M. Completion guard differs by interface.** MCP `planban_move_card` requires `completionConfirmed: true` to move to Complete; the CLI `complete-card` and `move-card --status complete` have no such guard. Docs will state both accurately; confirm that is acceptable to publish.

### 3.2 Facts that could not be verified from the repo

- **N. Claude Code outside the desktop app.** README and release notes say "Claude Code desktop". The skills fall back to returning the link when no browser pane exists, which implies the terminal app works, but nothing states it is supported or tested. PR 2 already says "Elsewhere, Claude gives you the board as a link". Confirm the supported-surfaces claim.
- **O. Other MCP hosts.** No specific host (for example Cursor or Windsurf) is named, configured or tested. `runtime-root.mjs` can also find the checkout from the script's own location, so `PLANBAN_REPO_ROOT` may be optional, although the README requires it. Docs will show a generic stdio configuration and keep the README's environment variable.
- **P. Undocumented environment variables and settings.** `PLANBAN_HOME` (moves `~/.planban`), `PLANBAN_MCP_PROFILE`, `PLANBAN_LAUNCH_LOG_FILE`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and the manifest's `storage.root`. `CONTRIBUTING.md` treats CLI and MCP contracts as changes that need an issue, so documenting these makes them public contract. Proposal: document only `CHOKIDAR_USEPOLLING` (already in the README) and `PLANBAN_MCP_PROFILE`; leave the rest out.
- **Q. Administration tools.** Documenting `planban_delete_board` and the other profile tools makes them discoverable. Proposal: list them in one short section with the profile names, and note that deletion writes a timestamped backup first.
- **R. Claude Code MCP startup window.** The README says Claude Code allows "only a short startup window" but gives no figure; Codex's is 120 seconds (`.mcp.json`). Docs will not state a Claude Code number.
- **S. Windows for Claude Code.** The README gives PowerShell commands for Codex only; the Claude Code instructions are bash with `$HOME`. Windows support for the Claude Code install path is not stated. Docs will not claim it without an owner test.
- **T. Codex marketplace location.** The README finds it with `codex plugin marketplace list`; `runtime-root.mjs` assumes `~/.codex/.tmp/marketplaces/planban`. Docs will use the command, not the path.
- **U. Security contact.** `SECURITY.md` gives `security@planban.ai` but adds "If that address is not available yet". Confirm that the address works before the troubleshooting page repeats it.
- **V. Issue templates.** `.github/ISSUE_TEMPLATE/` has bug, agent-investigated bug, feature request and feedback templates; `SUPPORT.md` names only three. Minor; docs will link the chooser.
- **W. Online Mode.** `PRODUCT.md` describes Online Mode, and PR 2 says it is "in design". It is not shipped in v1.1.6, so docs will not mention it.
- **X. Local HTTP API.** The README mentions a "local API", and `src/server/server.ts` exposes `/api/...` routes. It is not documented as a public contract, so it is out of scope for these docs.

---

## 4. Effort and PR structure

### 4.1 Estimate

| Work | Agent-hours |
| --- | --- |
| Site mechanism: nested paths, docs registry, docs index, three-level breadcrumbs, section and previous/next navigation, related-link scoping, header and footer links | 3 to 4 |
| Markdown pipe tables in `markdown.ts` plus CSS (if approved) | 1 |
| `llms.txt` generation, `_headers`, audit additions (required files, internal link check) | 1 to 1.5 |
| Content: 16 pages and 2 changelog pages (about 14,000 words), each checked line by line against its `v1.1.6` sources | 8 to 10 |
| Bundle check and, if over budget, per-route dynamic import | 0.5 to 1.5 |
| Verification: `npm run site:preflight`, local preview at mobile and desktop widths, link and anchor check, style pass (British spelling, no em dashes, "Claude" usage), final fact pass | 2 to 3 |
| Owner review rounds | 1.5 to 2 |
| **Total** | **17 to 23** |

The estimate assumes the section 3 decisions are made before content work starts; unresolved items would be written conservatively and flagged in the PR.

### 4.2 Commit and PR structure

One PR in `planban-site`, branch `seo/docs-and-changelog`, stacked on `seo/host-pages-faq-definition` (PR 2), which is itself stacked on PR 1. It is "PR 3" in `seo/owner-checklist.md`. It must merge after PR 2; if PR 2 changes during review, rebase this branch onto PR 2's final head before merging.

Proposed commits, in order:

1. `feat: allow nested docs paths for Markdown content pages` (transform pattern, path validation, route ids)
2. `feat: add the docs registry, docs index, breadcrumbs and page navigation`
3. `feat: support pipe tables in content Markdown` (only if approved)
4. `content: add Get started docs` (index, install in Codex, install in Claude Code, other MCP hosts, set up a project)
5. `content: add Use Planban docs` (commands, Items and Groups, Status and priority, Specs Plans and next actions, agent protocol)
6. `content: add reference docs` (CLI, MCP tools, data storage, git worktrees)
7. `content: add updating and troubleshooting docs`
8. `content: add the changelog index and v1.1.6 release page`
9. `feat: generate llms.txt from the docs registry and serve it with noindex`
10. `feat: link Docs from the header, footer and host pages`
11. `chore: audit docs outputs, llms.txt and internal links`
12. `perf: load docs documents per route` (only if the bundle budget is exceeded)

The PR description will list, per page, the source paths and the section 3 decisions applied, so the owner can review content against sources without re-deriving them.

Follow-ups outside this PR (product repo, separate small PR): fix `SUPPORT.md` (item A), README Codex update commands and stale Codex-only passages (items E, K), the `planban init` wording in future release notes (item F), and the `agent-context.md` tool list (item I).
