<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="src/web/public/assets/planban-logo-wordmark-white.svg">
    <img src="src/web/public/assets/planban-logo-wordmark-black.svg" alt="Planban" height="40">
  </picture>
</h1>

Planban is a local-first, agent-native Kanban board that installs as a plugin in Codex and Claude Code, so your agents keep the plan current and you see the whole project at a glance.

It gives you a simple roadmap board, keeps your planning state local, and helps your coding agent start work from the right card, spec, and project context. Its MCP server also works from any host that can run a local MCP server.

Planban is free to use on your computer with no account. When you want to share a board, use it from another computer, or reach it from ChatGPT or claude.ai, you can take that one board online with a free Planban account (see [Online Boards](#online-boards)). Every other board stays on your computer.

Planban's broader product direction is a durable planning system shared by humans and agents, designed first to give an individual clear sight of project work across agent surfaces. Read the [Planban Product Constitution](PRODUCT.md) for the principles that guide product and feature decisions. Learn more at https://planban.ai/.

## What Planban Does

- Opens local project boards beside your session with `/pb` or `/planban` in Codex, and `/planban:pb` or `/planban:planban` in Claude Code.
- Keeps live planning state on your machine, separate from your source repo.
- Gives agents stable board, card, spec, plan, and next-action context.
- Organizes related outcomes into root Groups while each owned Item remains independently completable, ranked, documented, and movable.
- Supports board creation, duplication, archiving, restoring, card movement, docs, history, and feedback flows.
- Ships CLI, local API, and MCP tools so any agent host can work with Planban through structured local actions.
- Takes a board online when you choose, so people you invite and their agents can work on it, with roles and limits on what agents may do.
- Gives each board a Goals page: a short, ordered list of the project's goals, with notes and context. People change goals; agents weigh work against them with judgement, and raise a goal that looks out of date with you in chat rather than changing it.

## Install

Planban is installed separately in each host you use. Each install shares the same device-local boards, so a board you create from Codex is the same board you open from Claude Code.

| Host | Slash commands | Board beside the session | Install |
| --- | --- | --- | --- |
| Codex desktop | `/pb`, `/planban`, `/planban-create` | Codex in-app browser | [Install With Codex](#install-with-codex) |
| Claude Code desktop | `/planban:pb`, `/planban:planban`, `/planban:planban-create` | Claude Code browser pane | [Install With Claude Code](#install-with-claude-code) |
| Other MCP hosts | none | link only | [Other hosts](#other-hosts) |

When a project uses Planban but Planban is not installed in the host you are working from, the project's `.planban/agent-context.md` tells the agent to say so once and point you here.

### Install With Codex

Ask Codex:

```text
Install Planban from planban-ai/planban. Follow the Install With Codex details in the public GitHub README exactly, verify the plugin and MCP tools work, open the interactive tutorial in the Codex in-app browser, then ask whether I want to set up Planban for a local project.
```

#### Install With Codex details

These details are written for Codex to follow. If you want to run the commands yourself, use Manual Install below.

Planban installs as a Git-backed Codex plugin marketplace. Codex should:

1. Check whether Node.js and npm are available. Planban requires Node.js `>=22.12.0` so its local runtime and build tooling stay inside supported dependency ranges. If Node.js or npm is missing or too old, explain that Planban runs locally and requires a modern Node.js LTS release. Ask before installing or upgrading Node.js. If approved, install Node.js LTS using the safest method for the machine, then verify `node --version` and `npm --version` before continuing.
2. Add the Planban marketplace.
3. Locate the installed marketplace root.
4. Run `npm install` there.
5. For a local-clone install, configure the Planban MCP runtime before installing the plugin. Git-backed marketplace installs can use the shipped relative MCP bootstrap without configuration.
6. Install the Planban plugin.
7. Verify the plugin and MCP tools are available.
8. Open the interactive Planban tutorial in the Codex in-app browser.
9. Ask whether to set up Planban for one of the user's local projects.

#### Manual Install

Use this path only if you prefer to install without asking Codex to perform the setup.

Recommended Git-backed marketplace install:

```bash
codex plugin marketplace add planban-ai/planban
PLANBAN_ROOT="$(codex plugin marketplace list | awk '$1 == "planban" { print $2 }')"
cd "$PLANBAN_ROOT"
npm install
node scripts/configure-local-plugin.mjs "$PWD"
codex plugin add planban@planban
codex plugin list --marketplace planban
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

Then open the printed local tutorial URL. In Codex, ask your agent to open it in the in-app browser.

For a Git-backed marketplace, the shipped plugin can also bootstrap itself: after
adding the marketplace and installing `planban@planban`, start a new Codex session
and ask to open Planban. First launch installs missing dependencies in the
marketplace runtime. Node.js and npm must already be available to Codex. The MCP
startup allowance is two minutes; if a slow network exceeds that allowance, finish
`npm install` in the marketplace root and retry. Installer output goes to stderr,
keeping MCP's JSON-RPC channel clean.

PowerShell manual install:

```powershell
codex plugin marketplace add planban-ai/planban
$planbanRuntime = (codex plugin marketplace list --json | ConvertFrom-Json).marketplaces | Where-Object { $_.name -eq 'planban' } | Select-Object -ExpandProperty root
Set-Location $planbanRuntime
npm install
node scripts/configure-local-plugin.mjs "$PWD"
codex plugin add planban@planban
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

If an older cached plugin still contains `__PLANBAN_REPO_ROOT__`, refresh the
marketplace and reinstall the plugin, then start a new Codex session. Opening a
Board alone does not refresh an already-running session's MCP configuration.

On Windows, Planban uses polling for its small local planning state directory. This avoids native file-watcher permission failures while keeping board updates live. You can also force polling on other platforms with `CHOKIDAR_USEPOLLING=1`.

Local clone fallback:

```bash
git clone https://github.com/planban-ai/planban.git
cd planban
npm install
node scripts/configure-local-plugin.mjs "$PWD"
codex plugin marketplace add "$PWD"
codex plugin add planban@planban
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

### Install With Claude Code

Ask Claude Code:

```text
Install Planban from planban-ai/planban. Follow the Install With Claude Code details in the public GitHub README exactly, verify the plugin and MCP tools work, open the interactive tutorial in the browser pane, then ask whether I want to set up Planban for a local project.
```

#### Install With Claude Code details

Planban installs as a Claude Code plugin marketplace. Node.js `>=22.12.0` and npm must be available. Then:

```bash
claude plugin marketplace add planban-ai/planban
PLANBAN_ROOT="$HOME/.claude/plugins/marketplaces/planban"
cd "$PLANBAN_ROOT"
npm install
claude plugin install planban@planban
claude mcp list
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

`claude mcp list` should show `plugin:planban:planban` as connected. Start a new Claude Code session, then type `/planban:pb` in a project to open its board, or `/planban:planban-tutorial` for the tour. Claude Code opens the board in its browser pane when the desktop app provides one, and always replies with the clickable board URL.

Run `npm install` in the marketplace root before the first session. The plugin can install missing dependencies on first launch, but Claude Code allows MCP servers only a short startup window, so a slow network can make the first connection fail until dependencies are present.

Local clone fallback:

```bash
git clone https://github.com/planban-ai/planban.git
cd planban
npm install
claude plugin marketplace add "$PWD"
claude plugin install planban@planban
```

Updates: `claude plugin marketplace update planban` then `claude plugin update planban@planban`, and run `npm install` in the marketplace root again when a release changes dependencies.

Claude Code copies the plugin's skills, hooks, and scripts into its plugin cache at install time, while the Planban runtime itself resolves to the marketplace checkout. `claude plugin update` refreshes that cache only when the plugin version changes, so when developing Planban from a local clone, run `claude plugin uninstall planban@planban` then `claude plugin install planban@planban` after changing anything under `plugins/planban/`, then start a new session; an idle session keeps its plugin server process alive and will not see the change until it restarts.

### Other hosts

Any host that can run a local stdio MCP server can use Planban's tools without slash commands. Clone the repository, run `npm install`, and point the host's MCP configuration at `node <checkout>/plugins/planban/scripts/start-planban-mcp.mjs` with the environment variable `PLANBAN_REPO_ROOT=<checkout>`. The agent then gets the same tools and the same clickable board URLs; opening the board beside the session depends on what the host offers.

## First Run

Planban opens a short local tutorial and creates a `Planban Demo` board so you can try the product immediately.

Use it to:

- learn how `/pb`, `/planban`, and `/planban-tutorial` work in Codex, or `/planban:pb`, `/planban:planban`, and `/planban:planban-tutorial` in Claude Code
- drag cards between columns
- drag one Item onto another to create a Group, or move an Item into an existing Group
- open a Group to review its objective, progress, and status-ranked Items together
- open a roadmap item with your agent
- inspect roadmap item details and specs
- mark a card Complete when you are done
- send feedback from the toolbar
- ask your agent to create roadmap items from your existing plans

When you are ready to use Planban with a real project, ask your agent in Codex or Claude Code:

```text
Set up Planban for my local project at /path/to/project. If it is not initialized yet, ask me before initializing it. Then open the board and help me create roadmap items from the current repo docs, issues, notes, or my description of what I am building.
```

You can also give your agent planning context from Notion, Jira, Linear, GitHub Issues, copied notes, or a plain-language project update. Ask it to turn that context into draft Planban roadmap items for review.

## Feedback With Your Agent

Planban uses GitHub Issues for bugs, feature requests, and product feedback.

Feedback is welcome. If you want to share a bug, request, rough edge, or reaction, select the feedback button in the board toolbar and add whatever you remember. Your agent will use that note plus available conversation and workspace context, gather relevant Planban diagnostics, search existing issues and fixes, and recommend the best reporting route before anything is filed publicly. Missing details do not block a report.

For bugs, Planban Feedback normally prepares a new issue or a useful comment on an existing issue. It recommends a pull request only when it can verify that you or your agent already implemented and validated a focused fix for the same failure. Reporting a bug does not by itself create or recommend a PR.

You can also start from a chat: use `/planban-feedback` in Codex or `/planban:planban-feedback` in Claude Code, or ask your agent:

```text
I want to give feedback on Planban. Use the current conversation and safely discoverable Planban context so I do not have to repeat details. Investigate the report, search existing issues and fixes, then recommend and draft the best route for planban-ai/planban. Do not recommend a PR unless you verify that my agent already implemented and validated the fix. Do not include private repo paths, board contents, logs, screenshots, or personal project details unless I explicitly approve them.

Feedback:
<paste your feedback here>
```

Your agent can then help you review the issue draft and file it through GitHub. You can also open the issue chooser directly:

https://github.com/planban-ai/planban/issues/new/choose

## Contributing

Planban is early. Small focused bug fixes, docs improvements, and reliability
fixes are welcome. For larger feature, architecture, install, update, API, MCP, or
CLI contract changes, please open an issue first.

By submitting a pull request, you agree that your contribution is licensed under
the MIT License.

See `CONTRIBUTING.md`, `SUPPORT.md`, and `SECURITY.md`.

## Updates

Planban checks public version metadata from GitHub while the local board is open. If an update is available, the board shows a small update notice.

When Planban can prove your install is safe to update directly, choose `Update now`. Planban will show progress, refresh the local install, restart the local server, and reopen the board you were viewing.

If the install shape is ambiguous, dependencies are missing, a migration is needed, or local files make direct update unsafe, the board shows the `Update with Codex` panel instead. It prepares a prompt asking your agent to inspect the install, update Planban safely, verify the plugin and MCP tools, and open the right post-update surface. Open it as a Codex draft, or copy it into an agent session.

Fresh installs start with the interactive tutorial, which opens in the Codex in-app browser or the Claude Code browser pane. If you used an earlier private or preview build, use the agent-guided update or reinstall from this public repository so your local plugin marketplace points at the clean public release.

### Manual updates

Codex, for the recommended Git-backed marketplace install:

```bash
codex plugin marketplace upgrade planban
PLANBAN_ROOT="$(codex plugin marketplace list | awk '$1 == "planban" { print $2 }')"
cd "$PLANBAN_ROOT"
npm install
node scripts/configure-local-plugin.mjs
codex plugin add planban@planban
```

For a local clone install, run `git pull` in the clone instead of the marketplace upgrade, then the same remaining commands.

Claude Code:

```bash
claude plugin marketplace update planban
claude plugin update planban@planban
```

Run `npm install` in the marketplace root again when a release changes dependencies.

After a manual update, start a new session so the host loads the updated plugin and MCP server.

Planban does not silently update itself and does not send private board contents, repo paths, logs, or project details as part of update checks.

## Online Boards

An Online Board lives at app.planban.ai instead of on one computer. Use one when you want to work on a board with someone else, open it from another computer, or let ChatGPT or claude.ai read and update it. Boards stay on your computer unless you take them online, and Planban never needs an account for local boards.

In the commands below, `planban` means Planban's command line. If it isn't installed as a command on your computer, Planban's own messages print the exact form to run, which is `node "<Planban install folder>/bin/planban.mjs"`.

**Take a board online.** In the board, open Board settings and choose Take online, or run:

```bash
planban online login https://app.planban.ai          # once per computer; opens sign-in in your browser
planban online take-online https://app.planban.ai --cwd /path/to/project
```

On a computer without a browser you can use (a remote or cloud machine, or an agent working headless), add `--no-browser` or `--device` to `login`. Planban shows a short code and an approval link instead; open the link on any device where you're signed in, your phone included, check the code matches, and tap Allow. `--device` also opens the link in this computer's browser when it can.

A board goes online only when it holds no files (see [Local Storage](#local-storage)). Taking it online leaves `.planban/online-board.json` in the project folder: commit it, so other computers and agents know the board lives online. This computer keeps a backup copy. You can bring the board back any time with Board settings, Take local (or `planban online take-local`), and its history comes with it.

**Use it in a browser.** Every online board has its own address, `https://app.planban.ai/boards/<board>`, where you and the people you invite can read and edit it on any computer or phone, with nothing to install. Log in with GitHub or an email code. The same page has Your boards, New board, Connections (including access keys for agents that can't sign in themselves) and Sign out. Links from ChatGPT and claude.ai open the card they cite there.

**Invite people.** Board settings, People, Invite people, or `planban online invite --email <address> --role editor` (the role is viewer unless you say otherwise). Each person has a role:

- **Owner** can do everything, including inviting people and taking the board online or local.
- **Editor** can change cards, Specs and Plans, and mark work complete.
- **Viewer** can read the board and its history.

Each person also chooses what their own agents may do: read, plan, or plan and complete (`planban online my-agents <level>`). An agent can never do more than its person. People join by opening the invitation link in a browser (it leads through sign-in straight to the board), or with `planban online join <link>`.

**Several accounts on one computer.** Several Planban accounts can be signed in at once, like the GitHub CLI: for example a work account for one project and a personal one for another. Each online board remembers, on this computer, which account it uses, and always uses that one, so agents in each project just work. `planban online accounts` lists them, the default for new boards, and which boards use each. `planban online sign-in https://app.planban.ai` adds an account (the board page asks first) and makes it the default; the others stay signed in. `planban online switch https://app.planban.ai --account <email>` changes the default for new boards, and `take-online` and `attach` take `--account <email>`. `planban online sign-out https://app.planban.ai --account <email>` signs one account out; its boards say so, naming it, until it signs in again. The board page shows "Signed in as" with the board's own account.

**Bringing a board back, deleting it, and backups.** Board settings, Take local (or `planban online take-local`) brings an online board back to this computer with its history. On a shared board this removes everyone else and their agents, so Planban names them and asks first (`--remove-others`). A read-only online copy stays at app.planban.ai until you delete it there (Board settings, Delete online copy); that is also how an online board is deleted. `planban delete-board` refuses an online board, and with `--this-computer-only` only removes it from this computer's list. Each computer that uses an online board keeps an automatic backup; `planban online restore-backup --from <backup folder> --cwd <empty folder> --repo-id <new id>` makes a separate local board from it, named as a copy restored from a backup.

**Deleting your account.** Email hello@planban.ai (the web page's profile menu, Delete account). Within 30 days this removes the boards you own, for everyone on them; your edits on other people's boards stay, without your name.

**For agents.** An agent never does more than its person allows. Planban's service enforces this for agents connected through ChatGPT, claude.ai and the web address. On your own computer it relies on Planban's tools and command line saying they act for an agent (they always do), because an agent there uses your sign-in. Completing a card needs `--completion-confirmed` (`completionConfirmed` in the tools), and `-o json` gives results and failures as JSON. The [Planban protocol](plugins/planban/skills/planban/references/planban-protocol.md) has the details.

**Merged pull requests, recorded for you.** Link a GitHub repository to an online board with `planban online github link <owner/name>` (you need admin access to the repository, and the GitHub CLI, `gh`, signed in on that computer). From then on, whenever a pull request merges, the board notes it on every card that names it, such as `#123`, `owner/name#123` or its address, and asks your agents to write what it means into the card. Merges that name no card wait for your agents to sort out, out of your way. `planban online github status` shows the link and the last delivery; `planban online github unlink <owner/name>` stops it and removes the webhook from GitHub.

**Connect AI apps.** Codex and Claude Code with the Planban plugin already work with online boards once this computer is signed in. Other apps connect to `https://app.planban.ai/mcp` and ask you to sign in and click Allow:

- ChatGPT and claude.ai: add a custom connector with that address.
- Claude Code without the plugin: `claude mcp add --transport http planban https://app.planban.ai/mcp`, then sign in with `/mcp`.
- Codex without the plugin: `codex mcp add planban --url https://app.planban.ai/mcp`, then `codex mcp login planban`.

See and cut off any of these from Connections on the web page or in the board's menu, or with `planban online connections https://app.planban.ai`.

**Limits.** An online board holds up to 256 MB, each account can make up to 5,000 changes and write up to 64 MB of text a day, and Planban stays an index, not file storage.

## Local Storage

Planban keeps live planning state on your machine:

- repo discovery files: `.planban/project.json` and `.planban/agent-context.md`
- local board state: `~/.planban/repos/<repo-id>/roadmap.json`
- local card docs: `~/.planban/repos/<repo-id>/items/<card-id>/spec.md` and `plan.md`

Planban is an index, not file storage. A card holds only text: its fields, Spec, Plan and history. Files stay where they belong, such as your repository or a shared drive, and a card refers to them with a GitHub link, a web address, or a local path labelled with its machine (`Mac mini: ~/Projects/app/renders/front.png`). Planban refuses text that embeds a file, Specs and Plans over 1 MB, and cards over 128 KB.

If you upgrade with files already in a card's folder, Planban flags that card and refuses changes to it until the files are moved out. Reading it still works. To tidy it:

```bash
planban move-files-out <card-id> --to <folder> --dry-run   # preview
planban move-files-out <card-id> --to <folder>
```

This moves the files to that folder, never overwriting or deleting anything, and adds a Files section to the card's Spec that refers to each one where it now lives.

Do not commit `~/.planban` state to your project repo. We recommend adding `.planban/agent-context.md` to your project's `.gitignore`: `planban init` does not do this for you, and that file contains absolute paths from your machine. If the board is online, do commit `.planban/online-board.json`, so other computers know where the board lives.

## License

Planban's local core is open source under the MIT License. See `LICENSE`.

The Planban name, logo, wordmark, domain, social handles, and official release
channels are not granted under the code license. See `TRADEMARKS.md`.
