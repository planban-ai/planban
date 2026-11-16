---
title: "Planban FAQ"
description: "Answers to common questions about Planban: supported agents, where data is stored, licence, offline use, other MCP hosts, and how to install."
path: /
updated: 2026-09-30
appliesTo: v1.1.6
---

## What is Planban?

Planban is a local-first, agent-native Kanban board that installs as a plugin in Codex and Claude Code, so your agents keep the plan current and you see the whole project at a glance. Agents write and update Items, Specs, Plans, and next actions. You own intent, priority, and acceptance.

## Which agents does it work with?

Planban works with Codex and Claude today. In the Codex desktop app the board opens in the in-app browser with `/pb`, and in the Claude Code desktop app it opens in the browser pane with `/planban:pb`. Both installs share the same boards on your device.

## Where is my planning data stored?

Your planning data stays on your machine. Live board state lives under `~/.planban`, separate from your repo, and only small discovery files sit in `.planban/` in your project. Planban does not upload your boards.

## Is Planban free and open source?

Yes. Planban's local core is open source under the MIT licence, and the code is on GitHub at piercekearns/planban. It is not published on npm; you install it from GitHub as a plugin.

## Does it replace Linear, Jira, or Trello?

No. Planban is built for one person directing project work with agents, not for team project management, sprints, or reporting. If you use those tools, you can ask your agent to turn their context into draft Planban Items for review.

## Does it work offline?

Yes, once it is installed. The board, local API, and MCP server run on your machine against `~/.planban`. Installing and updating need access to GitHub, and the open board checks GitHub for new versions when it can.

## Can other MCP hosts use it?

Yes. Any host that can run a local stdio MCP server can use the same Planban tools by pointing at `plugins/planban/scripts/start-planban-mcp.mjs` in a clone of the repo. Those hosts have no slash commands, and the board opens as a link.

## How do I install it?

Ask your agent to install it with one prompt from the README, or run the commands yourself. In Claude Code the key commands are `claude plugin marketplace add piercekearns/planban` and `claude plugin install planban@planban`, and in Codex they are `codex plugin marketplace add piercekearns/planban` and `codex plugin add planban@planban`. Planban needs Node.js 22.12.0 or later, and the full steps are on the [Codex](/codex/) and [Claude Code](/claude-code/) pages.
