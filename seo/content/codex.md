---
title: "Kanban board for Codex | Planban"
description: "Planban is a local-first, agent-native Kanban board that installs as a Codex plugin. Codex keeps the plan current; you see the whole project."
path: /codex/
updated: 2026-09-30
appliesTo: v1.1.6
---

# Kanban board for Codex

Planban is a local-first, agent-native Kanban board that installs as a plugin in Codex, so Codex keeps the plan current and you see the whole project at a glance.

You describe the work in the thread. Codex turns it into Items and Groups, writes the Spec and Plan, and keeps each card's Status and next action up to date as it works. You open the board beside the thread to see what exists, where it is up to, and what needs your decision.

![Planban board open in the Codex in-app browser beside a thread](/assets/placeholder-codex-board.png)

*Caption: The Planban board open in the Codex in-app browser. Items sit in Status columns, and each card shows its summary and next action.*

## How do I install Planban in Codex?

Ask Codex to install it with one prompt. Planban needs Node.js `>=22.12.0` and npm on your machine. Codex asks before installing or upgrading Node.js.

Ask Codex:

```text
Install Planban from piercekearns/planban. Follow the Install With Codex details in the public GitHub README exactly, verify the plugin and MCP tools work, open the interactive tutorial in the Codex in-app browser, then ask whether I want to set up Planban for a local project.
```

If you prefer to run the commands yourself:

```bash
codex plugin marketplace add piercekearns/planban
PLANBAN_ROOT="$(codex plugin marketplace list | awk '$1 == "planban" { print $2 }')"
cd "$PLANBAN_ROOT"
npm install
node scripts/configure-local-plugin.mjs "$PWD"
codex plugin add planban@planban
codex plugin list --marketplace planban
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

Then open the printed local tutorial URL. In Codex, ask your agent to open it in the in-app browser. The README also has PowerShell and local clone versions.

Planban is installed separately in each host. If you also use Claude, both installs share the same device-local boards.

## How do I open the board?

Type `/pb` in a thread to open the project's board. The board opens in the Codex in-app browser beside the thread, and Codex replies with the clickable board URL.

Other commands:

- `/planban` works with the board, its Items, Specs, and Plans.
- `/planban-create` creates boards, Items, or Groups from rough notes.

To reopen the tour, ask Codex to open the Planban tutorial.

## What does the agent do to the board?

Codex acts as a trusted editor of the plan. It creates Items and Groups, writes Specs and Plans, moves Items between Statuses, and keeps each summary and next action current.

You own intent, priority, and acceptance. Only you mark work Complete. Codex reads and writes the board through Planban's MCP tools, so a drag on the board and a tool call from Codex run the same operation and write the same history.

Threads in a Codex worktree resolve to the same board as the repository's main checkout.

## Where is my planning data stored?

Your planning data stays on your machine. Planban does not upload it.

- Repo discovery files live in `.planban/` in your project: `.planban/project.json` and `.planban/agent-context.md`.
- Live board state lives under the device-local planning root `~/.planban`, separate from your repo. For example, `~/.planban/repos/<repo-id>/roadmap.json`.
- Each Item's Spec and Plan are Markdown files under `~/.planban/repos/<repo-id>/items/<card-id>/`.

Do not commit `~/.planban` to your project repo.

## Can I use Planban from other MCP hosts?

Yes. Any host that can run a local stdio MCP server can use the same Planban tools without slash commands. You clone the repository, run `npm install`, and point the host at `plugins/planban/scripts/start-planban-mcp.mjs`. The agent gets the same tools and the same clickable board URLs, and the board opens as a link. The [Other hosts section of the README](https://github.com/piercekearns/planban#other-hosts) has the exact configuration.

## What is not supported yet?

Online Mode is not available yet. It is in design, and will add remote access to your own board. Local Mode is complete and stays a permanent choice.

The board opens beside the thread only in the Codex desktop app, which provides the in-app browser. Other hosts get the board as a link to open in your browser.

Planban is built for one person directing project work with agents. If you need a team project-management suite with sprints, roles, and reporting, Planban is not the right choice.

## Where can I get help?

Use the feedback button in the board toolbar. Codex drafts a GitHub issue from your note and checks existing issues first. Nothing is filed publicly until you have reviewed it.

You can also open an issue directly at https://github.com/piercekearns/planban/issues/new/choose. The full install guide, including update steps, is in the [README on GitHub](https://github.com/piercekearns/planban#install-with-codex).

Applies to Planban v1.1.6. Updated 30 September 2026.
