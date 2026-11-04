import { basename } from "node:path";

export const PLANBAN_INSTALL_URL = "https://github.com/planban-ai/planban#install";

export function buildAgentContext(input: {
  planningRoot: string;
  roadmapPath: string;
  manifestPath: string;
  /** Board id used in the canonical Board URL. Defaults to the planning root folder name. */
  repoId?: string | undefined;
  online?: { url: string; boardId: string } | undefined;
}): string {
  const repoId = input.repoId ?? basename(input.planningRoot);
  return `# Planban Agent Context

This repo uses Planban.

${input.online ? `The planning authority is the Online Board at ${input.online.url}, board ${input.online.boardId}.
Use Planban tools or the CLI for every read and edit. Local files are recovery evidence, not editable planning state.
Every edit must state the board revision it was based on (\`baseRevision\`, from the latest read); document edits state the document version (\`expectedMtimeMs\`; on the CLI, \`--expected-mtime <mtimeMs>\` or \`--expected-mtime new\`). A refused edit returns the current revision: reread, then retry.
Planban is an index, not storage: the board holds text only (cards, Specs, Plans and history). Never put files, images or encoded data in it; refer to them where they live instead: a GitHub link, a web address, or a local path labelled with its machine, such as "Mac mini: ~/Projects/app/renders/front.png". Edits that embed files are refused.
People on the board are owners, editors or viewers, and each chooses what their own agents may do (read, plan, or plan and complete); a "forbidden" refusal means this agent's level doesn't allow it, so tell the person.
Move a card to Complete only when a person on the board asks, confirms after review, or waives review. Never take the board local, invite people, change roles or agent levels, revoke connections or create keys unless the person explicitly asks.
Sign in on this machine with \`planban online login ${input.online.url}\` (if \`planban\` isn't a command here, Planban's messages print the full form).` : `Canonical live planning state for this device is not branch-local. Read and write the live roadmap at:

- ${input.roadmapPath}`}

Repo-local manifest:

- ${input.manifestPath}

${input.online ? "Local cache location (not planning authority)" : "Device-local planning root"}:

- ${input.planningRoot}

Board URL (the port can differ; verify it through \`planban_launch_board\` before sharing it):

- http://127.0.0.1:4317/boards/${repoId}

## Planban tools

Planban is exposed as MCP tools whose names end in \`planban_<operation>\`: status, list_boards, launch_board, get_board, query_cards, get_card, read_doc, create_card, create_cards, create_group, move_card, update_card, write_doc, move_files_out. Pass \`cwd\` as this repo's absolute path. Linked git worktrees resolve to the main checkout's board automatically, so pass the worktree path when working in one.

## Lean reads — leitura econômica obrigatória

- Comece por \`planban_status\`.
- Para listagem ou descoberta, use sempre \`lean: true\`; não peça a resposta completa nessa etapa.
- Para uma lista de rotina, use \`planban_query_cards\` com filtros de status, \`hierarchyScope: "leaf"\` e \`lean: true\`; use \`compact: true\` quando precisar dos Items completos sem as projeções repetidas.
- Só peça todos os campos depois de escolher um cartão ou quando a pergunta exigir explicitamente todos os detalhes.
- Só use \`planban_get_card\` ou \`planban_read_doc\` depois de escolher o cartão em que vai trabalhar.
- Não leia o quadro inteiro para responder uma pergunta sobre um cartão.

## Planban references

A \`planban:<board>/<item>\` token names a Planban Item or Group and \`planban:<board>\` names a Board. \`<board>\` is the registered repo id and \`<item>\` is the card id, so resolve a reference with \`planban_get_card\` (\`repoId\` and \`cardId\`) or the Board tools (\`repoId\`). A quoted title beside the token is display context only: the id is the identity, and if the two disagree, trust the id and say so. Cite Items the same way in replies: \`\u201C<title>\u201D \u00B7 planban:<board>/<item>\`.

## If Planban tools are not available in this session

- Tell the user once, in one sentence, that this project tracks work in Planban but Planban is not installed for this host, and link ${PLANBAN_INSTALL_URL} for the per-host install steps.
- Continue the requested work.
- When Planban state must change, use the Planban CLI from a Planban checkout (\`node <planban-checkout>/bin/planban.mjs <command> --cwd <this repo> -o json\`), or tell the user which Planban updates are pending. Every required Planning update is either applied or reported.

## Handoff

After opening the Board or completing a logical batch of Planning changes, include the clickable Board URL from the tool result in the reply and, if the host has an in-app browser, show the Board there once.

## Updating the roadmap

When the user asks to update the roadmap:

- update the roadmap item's status
- update priority when ordering changes within a column
- update the card summary and next action so they match the current phase of work
- update linked specs, and only create or update separate implementation plans when the work is complex enough to need one
- before creating or materially editing owner-facing Planban content, follow the installed Planban protocol and Planban house style
- if a tool result shows stale signals for a card you own or touch, re-read it and fix it in the same mutation batch
- Planban is an index, not file storage: never save files into a card's folder; refer to them from the Spec or Plan with a GitHub link, a web address, or a local path labelled with its machine, such as "Mac mini: ~/Projects/app/renders/front.png"
- a card whose folder holds files refuses changes until the owner chooses where they go and they are moved out with \`planban_move_files_out\` (dry run first)
- do not create or prefer ROADMAP.md

Roadmap status protocol for agent work:

- if the user explicitly asks an agent to start implementing a roadmap item, or the agent proceeds to implementation work for that item, move it to In Progress when it is not already there
- do not move a card to In Progress merely because an agent thread or session was opened, context was read, or planning/discussion happened
- when the agent finishes its own implementation and verification, leave the card In Progress and update summary and next action to say it is ready for user review/testing
- move a card to Complete only when the user explicitly asks, manually confirms completion after testing/review, or clearly waives user-side verification
- agent-side tests and verification are enough to update the next action for user review/testing; they are not enough by themselves to self-complete the roadmap item
- a landing is a card event: whoever merges a PR, pushes to a release branch or retires a branch updates every In Progress Item that names it, before reporting the landing
`;
}
