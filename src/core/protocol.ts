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
Card and board edits state the board revision they were based on (\`baseRevision\`, from the latest read; \`--base-revision\` on the CLI). Spec and Plan writes state that document's own version instead (\`expectedMtimeMs\`, the \`mtimeMs\` from reading it; \`--expected-mtime <mtimeMs>\` or \`--expected-mtime new\`). An edit is refused only if a field it touches (or the document it writes) changed since you read it; edits elsewhere go through, and moves never clash. To change one section of a Spec or Plan, use \`planban_write_doc_section\` with its heading and the version \`planban_read_doc\` lists, so edits to other sections never clash. Reading or editing a card marks you as working on it for 15 minutes; \`planban_get_card\` says who else is (a heads-up, not a lock). A refused agent edit is kept as an unresolved change on its card (\`planban_get_card\` shows them; \`planban_unresolved_changes\` lists the board's): settle it by saving a reconsidered version, or drop it with \`planban_drop_change\` and a reason. If an edit is refused because someone changed things since you read them, the refusal says who and when, and includes what changed and the current card or document with its new version. Read what changed; decide whether your change is still needed, needs adjusting given theirs, or is already covered; apply only what is still needed against the new version (for a document, into the current text). If you drop or change your edit, tell the person. Never just resend it, and never give up silently. To retry an edit whose reply was lost, resend it unchanged with the same \`idempotencyKey\` (\`--idempotency-key\`).
Never edit files under ~/.planban for this board: its cache, backups and the copy kept from before it went online are not the board.
Planban is an index, not storage: the board holds text only (cards, Specs, Plans and history). Never put files, images or encoded data in it; refer to them where they live instead: a GitHub link, a web address, or a local path labelled with its machine, such as "Mac mini: ~/Projects/app/renders/front.png". Edits that embed files are refused.
People on the board are owners, editors or viewers, and each chooses what their own agents may do (read, plan, or plan and complete). On this computer Planban's tools and command line apply that by saying they act for an agent; never act as the person. A refusal says which applies (a viewer, the person's agent level, or an owner-only step): tell the person; never work around it.
Put a card in Complete only when a person on the board asks, confirms after review, or waives review, and then pass \`completionConfirmed: true\` (\`--completion-confirmed\`).
Several Planban accounts can be signed in on this computer at once; this board always uses the account it is linked to here (\`planban online accounts\` lists them). If Planban says that account isn't signed in, it names it: ask the person to sign in as it (\`planban online sign-in ${input.online.url}\`); another account is never used instead. Never take the board local, invite people, change roles or agent levels, revoke connections or create keys unless the person explicitly asks.
People open the board in any browser, phone included, at ${input.online.url}/boards/${encodeURIComponent(input.online.boardId)}.
Sign in on this machine with \`planban online login ${input.online.url}\` (if \`planban\` isn't a command here, Planban's messages print the full form); where no browser can open here, add \`--no-browser\` and give the person the printed approval link and code.` : `Canonical live planning state for this device is not branch-local. Read and write the live roadmap at:

- ${input.roadmapPath}`}

Repo-local manifest:

- ${input.manifestPath}

${input.online ? "Local cache location (not planning authority)" : "Device-local planning root"}:

- ${input.planningRoot}

Board URL (the port can differ; verify it through \`planban_launch_board\` before sharing it):

- http://127.0.0.1:4317/boards/${repoId}

## Planban tools

Planban is exposed as MCP tools whose names end in \`planban_<operation>\`: status, list_boards, launch_board, get_board, query_cards, get_card, read_doc, create_card, create_cards, create_group, move_card, update_card, write_doc, move_files_out, history, read_goals, suggest_goal_change. Pass \`cwd\` as this repo's absolute path. Linked git worktrees resolve to the main checkout's board automatically, so pass the worktree path when working in one.

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
