# Awesome-list submissions for Planban

Prepared 30 September 2026. Nothing has been submitted, forked or opened. Every step below is for the owner to run from the `piercekearns` account.

Canonical sentence the entries are based on: "Planban is a local-first, agent-native Kanban board that installs as a plugin in Codex and Claude Code, so your agents keep the plan current and you see the whole project at a glance."

Planban facts checked for these entries:

- Repository: https://github.com/piercekearns/planban, public, MIT (GitHub detects the licence), v1.1.6, 0 stars today.
- First commit on `main`: 18 June 2026; commits continue to 30 September 2026.
- All five planban.ai URLs used below returned HTTP 200 today.
- The bundled MCP server started from a checkout with an empty `HOME` and answered `initialize` and `tools/list` with 13 `planban_*` tools (`node plugins/planban/scripts/start-planban-mcp.mjs`).

| # | List | Mechanism | Status |
| --- | --- | --- | --- |
| 1 | hesreallyhim/awesome-claude-code | Web issue form only | Ready to submit |
| 2 | RoggeOhta/awesome-codex-cli | Issue (PR allowed, but only issues get processed) | Ready to submit |
| 3 | punkpeye/awesome-mcp-servers | PR, with a Glama listing and score badge first | Ready once Glama passes |

---

## 1. hesreallyhim/awesome-claude-code

- URL: https://github.com/hesreallyhim/awesome-claude-code
- Maintenance: 54,840 stars, not archived. A bot commits ticker data several times a day (last on 30 September 2026). The last human commit was on 14 September 2026 ("Add resource: Claude Style Patch (#2832)"), so submissions are still being accepted.
- Mechanism: the web UI issue form only. CONTRIBUTING says "Do not open a PR", that submitting through the `gh` CLI does not work, and that a human must create the recommendation. A bot checks the form fields. The list itself is generated from `THE_RESOURCES_TABLE_NEW.csv`, so there is no diff to write; the maintainer adds the CSV row.
- Form: https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml

### Rules that apply

- The resource must be at least 14 days old (from the first commit on the default branch) and still in active development, or have at least 100 stars. Planban meets the first condition: first commit 18 June 2026, active since then. It has 0 stars.
- One resource per submitter at a time.
- The description must describe what the software does. It must not be a sales pitch, must not address the reader and must not use emojis. The form asks for 1 to 3 sentences of 10 to 500 characters.
- A licence is detected automatically from GitHub. MIT is detected.
- Guidance, not a hard rule: the list prefers resources focused on Claude Code. The form has a required checkbox saying "This resource is specific to Claude Code". Planban is cross-host. The Claude Code-specific part is real (a Claude Code plugin with namespaced slash commands, skills, hooks and the board opening in the Claude Code browser pane). Tick the box only if you are comfortable with that reading. The description below mentions Codex openly so the maintainer is not misled.
- The maintainer warns that listing is selective and at their discretion. With 0 stars, acceptance is uncertain.

### Category: Agent Orchestration

Options considered:

- **Agent Orchestration** (chosen). This category already holds the project-management and planning workflow entries: Claude Code PM ("project-management workflow for Claude Code"), Project Workflow System ("task management"), Plannotator (plan review UI) and Claude Code Harness (Plan, Work, Review cycle). Planban is the planning layer that agents read from and write to while they work, so it belongs with these.
- Memory & Context Persistence. Close, because the board keeps planning state across sessions, but the entries there are session-history and memory stores. Planban is a planning board, not agent memory.
- Alternative Clients. No. Planban does not replace the Claude Code client.
- Multi-Purpose. No. That category is for broad toolkits.

### Exact form values

| Field | Value |
| --- | --- |
| Display Name | `Planban` |
| Category | `Agent Orchestration` |
| Link | `https://github.com/piercekearns/planban` |
| Author Name | `Pierce Kearns` |
| Author Link | `https://github.com/piercekearns` |
| Description | see below |

Description (3 sentences, 442 characters, no emojis, does not address the reader):

```text
A local-first, agent-native Kanban board that installs as a Claude Code plugin, so agents keep the project plan current and the whole project is visible at a glance. The /planban:pb command opens the board in the Claude Code browser pane, and a bundled local stdio MCP server lets agents list boards, move cards, and read and write card specs and plans. Board data stays on the local machine; the same boards are shared with the Codex plugin.
```

Checklist: tick the five required boxes only after you have done what each says (visited the list and confirmed nothing similar is already listed, checked the links, read CONTRIBUTING). **Leave the last box unchecked.** It is a trap: ticking it admits that you did not read the statements.

### Owner steps

1. Sign in to GitHub as `piercekearns`.
2. Read https://github.com/hesreallyhim/awesome-claude-code/blob/main/CONTRIBUTING.md and the Code of Conduct. The form's checkboxes ask you to confirm that you did.
3. Open https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml
4. Keep the pre-filled title format and set it to `[Resource]: Planban`.
5. Paste the field values above, tick the five required boxes and leave the final "Do not check" box empty.
6. Submit. Wait for the validation bot's comment and fix any field it flags by editing the issue. Do not open a second issue.

---

## 2. Codex list: RoggeOhta/awesome-codex-cli

### Choosing the list

`gh search repos "awesome codex" --sort stars` results, checked on 30 September 2026:

| Repo | Stars | Last push | What it lists | Decision |
| --- | --- | --- | --- | --- |
| composio-community/awesome-codex-skills | 16,729 | 2026-07-26 | Skills only | Wrong kind of resource |
| VoltAgent/awesome-codex-subagents | 6,255 | 2026-09-21 | Subagent definitions | Wrong kind of resource |
| hashgraph-online/awesome-codex-plugins | 1,109 | 2026-09-30 | Codex plugins, mirrored into its own installable marketplace | Not ready (see below) |
| RoggeOhta/awesome-codex-cli | 537 | 2026-09-06 | Tools, plugins, MCP servers, apps for Codex | **Chosen** |
| milisp/awesome-codex-cli | 117 | 2026-09-24 | Resources and tools | Smaller and less curated |
| KarelDO/awesome-codex | 203 | 2023-01-03 | Legacy Codex model | Abandoned |

Why not hashgraph-online/awesome-codex-plugins, although it is the most active plugin list:

- It does not just link to a plugin. Its CI copies the plugin folder (`plugins/planban/`) into its own repository and publishes it in its own Codex marketplace. Planban's MCP bootstrap (`plugins/planban/scripts/runtime-root.mjs`) needs the full repository runtime: `package.json`, `src/`, `bin/` and `npm install`. It finds that runtime only in a checkout, or in a marketplace named `planban`. An install from their mirror would fail with "Planban runtime not found". Listing Planban there would put a broken install path in front of users.
- It requires `repository`, `license` and `interface.composerIcon` in `.codex-plugin/plugin.json`, plus an icon file. Planban's manifest has none of these today.
- A centralised HOL Plugin Scanner score of at least 80/130 is required. Planban's score is unknown.

Revisit that list only if Planban adds those manifest fields and an icon, and a mirrored-bundle install is either made to work or the maintainers agree to a metadata-only mirror. Their generator already has a `METADATA_ONLY_MIRROR_REPOS` setting.

### RoggeOhta/awesome-codex-cli

- URL: https://github.com/RoggeOhta/awesome-codex-cli
- Maintenance: 537 stars, not archived. Last commits on 6 September 2026 by the owner. The maintainer reviews in batches and records each batch in `maintenance/2026-09-06.md`, which resolved 11 submission issues after reading each upstream README.
- Mechanism: CONTRIBUTING allows either an issue or a fork-and-PR. In practice, **use an issue**. The repository has zero PRs merged through GitHub, dozens of open PRs, and the maintenance record says open pull requests are "outside this issue-maintenance batch". Accepted submissions are issues that the maintainer closes with "Fixes #N".
- The list licence is CC0.

### Rules that apply

- The resource must be directly related to Codex, which it is (a Codex plugin with `.codex-plugin/plugin.json`, skills and an MCP server).
- It must be actively maintained, which it is.
- One sentence describing what the resource does, followed by a shields.io star badge in `flat-square` style.
- Format: `- [owner/repo](https://github.com/owner/repo) - Description. ![GitHub stars](...)`.
- Not accepted: "Self-promotion without substance: your project needs real users or a clear unique value." The unique value has to come through in the issue, because the star count is 0.
- The maintainer checks claims against the upstream README. For example, they removed a claim that Claude-specific hooks were enforced by Codex. Keep claims to what the README documents. The README documents the Codex **desktop** app (the board opens in the Codex in-app browser). It does not describe Codex CLI terminal use, so the entry says "Codex" and does not claim CLI-specific behaviour.

### Section: Plugins

The Plugins section is described as "Distributable bundles combining skills + app integrations + MCP servers. Defined in `.codex-plugin/plugin.json`", which is exactly what Planban is. It already includes a cross-host entry, EveryInc/compound-engineering-plugin ("for Claude Code, Codex, and more"). Session & Workflow Management (which has Claw-Kanban) was the runner-up. The section is not alphabetical; entries are appended.

### Exact entry line

```markdown
- [piercekearns/planban](https://github.com/piercekearns/planban) - Local-first, agent-native Kanban board plugin for Codex and Claude Code that lets agents keep the plan current while the board shows the whole project at a glance. ![GitHub stars](https://img.shields.io/github/stars/piercekearns/planban?style=flat-square)
```

### Owner steps (issue, recommended)

1. Open https://github.com/RoggeOhta/awesome-codex-cli/issues/new
2. Title: `Add piercekearns/planban to Plugins`
3. Body:

````markdown
**Resource:** https://github.com/piercekearns/planban
**Suggested section:** Plugins
**Suggested entry:**

```markdown
- [piercekearns/planban](https://github.com/piercekearns/planban) - Local-first, agent-native Kanban board plugin for Codex and Claude Code that lets agents keep the plan current while the board shows the whole project at a glance. ![GitHub stars](https://img.shields.io/github/stars/piercekearns/planban?style=flat-square)
```

**Codex integration (inspectable):**

- Plugin manifest: `plugins/planban/.codex-plugin/plugin.json`, installed as a Git-backed Codex plugin marketplace (`.agents/plugins/marketplace.json`).
- Slash commands `/pb`, `/planban` and `/planban-create` open the local board in the Codex in-app browser.
- A bundled local stdio MCP server gives the agent structured tools to list boards, query and update cards, move cards, and read and write card specs and plans.
- Install and usage: https://planban.ai/codex/ and the "Install With Codex" section of the README.

**Other facts:** MIT licence, free, no account or sign-up. Board data is stored on the local machine. Requires Node.js 22.12 or later. Actively maintained (v1.1.6, first commit June 2026). I am the author.
````

4. Submit. Do not also open a PR, since that would duplicate the submission.

Optional PR route, if you prefer it despite the evidence above: fork, create branch `add-planban`, append the entry line as the last bullet under `## Plugins` in `README.md` (after the `EveryInc/compound-engineering-plugin` line), commit `Add piercekearns/planban to Plugins`, and open a PR with the same title and the issue body above.

---

## 3. MCP list: punkpeye/awesome-mcp-servers

### Choosing the list

| Repo | Stars | Last commit | Accepts submissions? | Decision |
| --- | --- | --- | --- | --- |
| punkpeye/awesome-mcp-servers | 95,704 | 2026-09-27 (maintainer merging PRs daily) | Yes, PRs | **Chosen** |
| wong2/awesome-mcp-servers | 4,334 | 2026-07-13 (sponsor removals only) | No. The README says "We do not accept PRs" and points to https://mcpservers.org/submit | Not a GitHub-list submission |
| appcypher/awesome-mcp-servers | 5,782 | 2026-05-06 | No. The repository is archived | Dropped |

### Does punkpeye accept a server that is not a standalone package?

Yes, as long as it is presented honestly. The Scope section of CONTRIBUTING says the list is for "servers with a public GitHub repository, something you install and run yourself", and sends remote-only servers elsewhere. Planban is a public repository that you install and run locally. Nothing requires an npm package or a repository that contains only the MCP server. The Workplace & Productivity section already lists entries whose repository is a plugin or an app with an MCP server inside it:

- `alex13slem/openproject-codex-plugin` (a Codex plugin repository)
- `CrossPaste/crosspaste-desktop` (a desktop app)
- `bzdOS/hubd` (a local project hub with a kanban)

The entry below states the actual shape ("stdio server bundled with the Codex and Claude Code plugin"), so nobody expects an `npx` package.

### Rules that apply (CONTRIBUTING plus the `check-glama.yml` PR workflow)

- Fork, branch, edit `README.md` only, one server per line, and put it in the right category in alphabetical order.
- The link text must be the full `owner/repo` (`piercekearns/planban`), and the link must be a `https://github.com/` URL.
- At least one permitted emoji tag must follow the link, and no other emojis are allowed. The permitted tags used here are 📇 TypeScript/JS, 🏠 Local Service, 🍎 macOS, 🪟 Windows and 🐧 Linux. Windows is supported: the README documents Windows polling and CI runs on `windows-latest`.
- **A Glama listing and score badge are required.** The bot labels any PR without one `missing-glama` and asks for a Glama listing that passes checks. The server must build from a Dockerfile you add in Glama's UI, start, and respond to introspection. The badge format is `[![OWNER/REPO MCP server](https://glama.ai/mcp/servers/OWNER/REPO/badges/score.svg)](https://glama.ai/mcp/servers/OWNER/REPO)`.
- Duplicate URLs are flagged. Planban is not listed yet.
- CONTRIBUTING has a note for automated agents about adding a robot-emoji suffix to PR titles for fast-tracking. That note is about agents opening PRs. You are submitting as a human, so leave it out of the title.

### Prerequisite: list Planban on Glama

1. Sign in at https://glama.ai/mcp/servers and use its "Add server" flow for `https://github.com/piercekearns/planban`.
2. When Glama asks for a Dockerfile, a starting point is below. Adjust it to Glama's build form if the form already clones the repository for you:

   ```dockerfile
   FROM node:22-slim
   RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
   WORKDIR /app
   RUN git clone --depth 1 https://github.com/piercekearns/planban.git . && npm ci
   ENV PLANBAN_REPO_ROOT=/app
   CMD ["node", "plugins/planban/scripts/start-planban-mcp.mjs"]
   ```

   Local evidence that this should pass: from a checkout after `npm install`, with an empty `HOME`, the server answered `initialize` and `tools/list` (13 tools). Glama's build itself has not been tested.
3. Wait for Glama's checks to pass, then confirm the server's Glama path. Use that path in the badge. The entry below assumes `piercekearns/planban`.

### Category: Workplace & Productivity

The kanban and project-management servers are in this section: `bivex/kanboard-mcp`, `davegomez/fizzy-mcp`, `Developyn/laver-mcp`, `khaoss85/mcp-orchestro` ("Task management for Claude Code with a visual Kanban board") and `bzdOS/hubd`. Product Management was considered, but its entries are about customer feedback and roadmaps for product teams.

### Exact diff

The section is only roughly alphabetical. Insert the line between `pdfops/pdfops-mcp` and `poolside-ventures/meetbot-mcp`, where `piercekearns` belongs.

```diff
 - [pdfops/pdfops-mcp](https://github.com/pdfops/pdfops-mcp) [![pdfops-mcp MCP server](https://glama.ai/mcp/servers/...)](...) ...
+- [piercekearns/planban](https://github.com/piercekearns/planban) [![piercekearns/planban MCP server](https://glama.ai/mcp/servers/piercekearns/planban/badges/score.svg)](https://glama.ai/mcp/servers/piercekearns/planban) 📇 🏠 🍎 🪟 🐧 - Local-first, agent-native Kanban board: agents list boards, query, update and move cards, and read and write card specs and plans through a local stdio server bundled with the Codex and Claude Code plugin.
 - [poolside-ventures/meetbot-mcp](https://github.com/poolside-ventures/meetbot-mcp) [![poolside-ventures/meetbot-mcp MCP server](https://glama.ai/mcp/servers/...)](...) ...
```

(The context lines are shortened with `...`. Only the `+` line is added, exactly as written.)

### Owner steps

1. Complete the Glama prerequisite above and note the Glama path.
2. Fork https://github.com/punkpeye/awesome-mcp-servers to `piercekearns/awesome-mcp-servers`.
3. Clone the fork and create the branch:
   ```bash
   git clone https://github.com/piercekearns/awesome-mcp-servers.git
   cd awesome-mcp-servers
   git checkout -b add-planban
   ```
4. In `README.md`, find the `Workplace & Productivity` section and the line starting `- [pdfops/pdfops-mcp]`. Add the `+` line from the diff directly below it. Edit only `README.md`, not the translated READMEs.
5. Commit and push:
   ```bash
   git commit -am "Add piercekearns/planban"
   git push -u origin add-planban
   ```
6. Open a PR against `punkpeye/awesome-mcp-servers:main`.
   - Title: `Add piercekearns/planban`
   - Body:
     ```markdown
     Adds Planban to Workplace & Productivity.

     - Repository: https://github.com/piercekearns/planban (MIT)
     - Glama: https://glama.ai/mcp/servers/piercekearns/planban
     - Shape: a local stdio MCP server bundled in the Planban plugin repository, started with `node plugins/planban/scripts/start-planban-mcp.mjs` from a checkout after `npm install`. It is not a standalone npm package. Setup for any MCP host: https://planban.ai/docs/other-mcp-hosts/
     - Tools: list boards, query and get cards, create, update and move cards, and read and write card documents (specs and plans). Board data stays on the local machine.
     ```
7. Check the bot's labels: `has-glama`, `has-emoji` and `valid-name` should appear. If `missing-glama` appears, the badge path does not match your Glama path. Fix it on the branch.

---

## Blockers and owner decisions

1. **awesome-claude-code "specific to Claude Code" checkbox.** Planban is cross-host. Decide whether you can tick this box honestly. The description names Codex so the maintainer can judge. With 0 stars, acceptance is at the maintainer's discretion.
2. **punkpeye needs Glama first.** The PR will be labelled `missing-glama` and stall without a passing Glama listing. The Dockerfile above is untested on Glama.
3. **awesome-codex-cli is CLI-focused.** The README documents Planban in the Codex desktop app. The entry avoids CLI-specific claims. If you know Planban works in the Codex CLI terminal (for example, printing the board URL), you can add one line saying so to the issue body.
4. **Low adoption signal.** All three lists weigh stars or users. Submitting after Planban has some stars and users would improve the odds, particularly for awesome-claude-code and awesome-codex-cli.
