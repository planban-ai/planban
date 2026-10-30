# Planban Protocol

Planban is a local, agent-native planning board. Use this protocol when the user asks
the agent to read, create, update, review, move, or complete work tracked in Planban.

## Command-Like Skills

This plugin includes focused command-like skills:

- `pb`: fast-open the best matching Planban board.
- `planban`: full-name entry point; by default it opens the same board target as `pb`.
- `planban-help`: show Planban commands, common prompts, and a short getting-started guide.
- `planban-tutorial`: open the interactive first-run Planban tutorial.
- `planban-create`: create boards or roadmap items from rough user intent.
- `planban-feedback`: package Planban feedback.

Codex invokes these as `/pb`, `/planban`, and so on. Claude Code prefixes the plugin
name: `/planban:pb`, `/planban:planban`, and so on.

Natural prompts remain first-class. Users can still say "Open my Planban board." or
mention `@planban` where the host supports plugin mentions.

## First Reads

When working inside a repository that uses Planban, read these before changing
roadmap state:

- `.planban/project.json`
- `.planban/agent-context.md`
- Any linked card `spec.md` or `plan.md` relevant to the requested work

The repo-local files are discovery files. The canonical live roadmap state for the
device is listed in `.planban/agent-context.md`, usually under
`~/.planban/repos/<repo-id>/roadmap.json`.

If `.planban/agent-context.md` says the board is online (or `.planban/online-board.json`
exists), the board lives at its online service, not in files on this machine. Read
and write it only through the Planban MCP tools or the CLI; local roadmap and Spec
files for an online board are a cache or backup, never the board.

## Owner-Facing Authoring

Before creating or materially editing a Title, Summary, Next action, Group objective,
Spec, or Plan, read `planban-house-style.md` completely and follow it. That reference
is the authority for lifecycle language, information placement, current-state
orientation, and lossless agent detail. Do not copy its full rules into prompts or
tool descriptions.

A status-only, priority-only, placement-only, or rank-only mutation does not require
the house-style reference unless the same change also edits owner-facing content.
Never rewrite historical evidence merely to make older content match the current
style.

## Product Constitution

Before creating or materially reshaping a Planban product feature, domain model,
workflow semantic, visible information hierarchy, platform or cloud behavior,
roadmap structure, onboarding, positioning, or agent guidance, read the repository
root `PRODUCT.md` completely. It is the public authority for Planban's product
definition, principles, boundaries, and feature-decision test.

Do not reload `PRODUCT.md` for routine Board operations, small current-state
corrections, or execution of an already accepted Plan. The constitution governs
product decisions; it must not become ceremony for ordinary use.

## Local Storage Model

Planban deliberately separates repo discovery from live local state:

- Repo-local discovery: `.planban/project.json` and `.planban/agent-context.md`
- Device-local roadmap: `~/.planban/repos/<repo-id>/roadmap.json`
- Device-local card docs: `~/.planban/repos/<repo-id>/items/<card-id>/spec.md` and `plan.md`

These paths hold local boards only. An online board's state lives at its service.

Do not create or prefer `ROADMAP.md`.

## Planban is an index, not storage

A Board holds only its own text: each card's fields, its Spec and Plan, and their
history. It never holds files. Everything else is a reference to where it lives.

- Never save a file into a card's folder under `~/.planban/repos/<repo-id>/items/`.
  Only Planban writes there, and only `spec.md` and `plan.md`.
- Keep evidence, screenshots, exports, logs and long reports where they belong: the
  project's repository, a shared drive, or a website. A file the owner should keep
  that has no home yet goes in the repository, for example under `docs/`, with the
  owner's agreement.
- Refer to a file from the card's Spec or Plan in one of three forms:
  - a GitHub link, such as `https://github.com/<owner>/<repo>/blob/main/docs/evidence/run.png`;
  - any other web address;
  - a local path labelled with its machine, such as `Mac mini: ~/Projects/app/renders/front.png`.
    The label matters: another machine, or a hosted board, cannot follow an unlabelled
    path.
- Do not paste a file into the text. Planban refuses writes that embed a file
  (`data:` addresses with a payload, long base64, binary content, or long lists of
  numbers standing in for bytes), Specs and Plans over 1 MB, and cards over 128 KB.
  The error says what was found and how to refer to it instead.

A card whose folder already holds files is flagged: tool results and the
session-start line name it, and the board shows a quiet "Holds files" note on it.
Planban refuses every change to that card until the files are moved out; reading it
still works. To tidy it, ask the owner where the files belong, then run
`planban_move_files_out` (or `planban move-files-out <card> --to <folder>`) with a
dry run first. It moves the files to that folder without overwriting or deleting
anything, and adds a Files section to the card's Spec that refers to each one where
it now lives.

### Online authority

Planban is free on a computer with no account. A board goes online only when its
owner chooses, with a free Planban account at https://app.planban.ai.

- **When to suggest it.** Suggest taking a board online only when the person wants
  to share it with someone, use it from another computer or a phone, or reach it
  from ChatGPT or claude.ai. Explain what changes, and let them decide; never take a
  board online, take it local, invite people, change roles or agent levels, revoke
  connections or create keys unless the person explicitly asks.
- **The web page.** Each online board has an address, `https://app.planban.ai/boards/<board>`,
  where people read and edit it in any browser, phone included. Offer it to people who
  use only ChatGPT or Claude, or want the board on another device. Card links from
  ChatGPT and claude.ai open the cited card there.
- **Taking it online.** Board settings, Take online, or
  `planban online login https://app.planban.ai` once per computer, then
  `planban online take-online https://app.planban.ai --cwd <project>`. The service
  address is required. Where no browser can open here (a remote, cloud or headless
  machine), add `--no-browser` to `login`: Planban prints a short code and an approval
  link. Give the person both; they open the link on any device where they're signed in
  (a phone works), check the code and tap Allow, and the login finishes by itself.
  `--device` does the same but also opens the link here when it can. A board goes online only when it is clean: Planban lists
  files and pictures to tidy before the transfer.
- **The project note.** Taking a board online leaves `.planban/online-board.json` in
  the project folder, for the owner to commit. On any machine where that note exists,
  the local copy becomes read-only: Planban refuses changes and says where the board
  lives. Do not retry or work around it; ask the owner to sign in and choose "Use the
  online board", or to keep the copy as a separate board.
- **Roles and agent levels.** Each person is an owner, editor or viewer, and chooses
  what their own agents may do: read, plan, or plan and complete. An agent never does
  more than its person. Planban enforces this at the service for every remote agent.
  On the person's own computer it relies on Planban's tools and command line saying
  they act for an agent, which they always do: an agent there holds the person's
  sign-in, so it must never act as the person. A refusal says which limit applies;
  tell the person and never work around it:
  - **Viewer:** the person can only read the board, so their agents can't change it
    either. Only the owner can make them an editor.
  - **Agent level:** the person's agents are limited to read or plan. The person can
    change it in People or with `planban online my-agents <level>`.
  - **Connection scope:** a key or app connection can reach only the boards and level
    it was given. The person can make a new one from Connections.
  - **Owner only:** inviting people, changing roles, taking the board local and
    deleting it are for the owner's own sign-in, never an agent.
- **Two version numbers.** Card and board edits pass `baseRevision`: the board's
  `revision` from your latest read (`--base-revision` on the command line). Spec and
  Plan writes pass the document's own version instead: `expectedMtimeMs`, the
  `mtimeMs` from reading that document (`--expected-mtime <mtimeMs>`, or `new` for a
  document that doesn't exist yet). They are different numbers; `write-doc` has no
  `--base-revision`. Serialize writes.
- **Conflicts.** An edit refused because something changed underneath it says who
  changed it and when, and includes what changed since you read (`conflict.changes`),
  the card as it is now (`conflict.card`) or the document as it is now with its new
  version (`conflict.document`), and the board's `currentRevision`. Then:
  1. Read what changed.
  2. Decide whether your change is still needed, needs adjusting given theirs, or is
     already covered.
  3. Apply only what is still needed, against the new version. For a Spec or Plan,
     write your change into the current text; never drop anyone else's edits.
  4. If you drop or change your edit, say so in your reply to the person (and in the
     card's summary or Plan when it matters later).

  Never just resend the same edit with a newer version, and never give up silently:
  a change must never quietly fail to happen.
- **What clashes.** On an online board, `baseRevision` means "the version I read".
  An edit is refused only if a field it touches (title, summary, next action, column,
  tags, blocked-by, each metadata key) changed since then; edits to other cards or
  other fields go through. Moves never clash: a card goes after the same neighbour, or
  to the end of the column if that neighbour has moved. A Spec or Plan is checked by
  its own version. Restoring the whole board still needs the current revision.
- **One section at a time.** `planban_read_doc` (`read-doc`) lists each section of a
  Spec or Plan with its own version. To change one section, use
  `planban_write_doc_section` (`write-doc-section`) with its heading and version: only
  that section is checked, so edits to other sections never clash. Prefer it on shared
  documents; whole-document writes keep the document's own check. A section edit that
  would change any other section, or the text before the first heading, is refused:
  write the whole document then. Link and footnote definitions apply to the whole
  document, so changing one can change how links elsewhere show.
- **Unresolved changes.** On an online board, an agent's refused edit is kept as an
  unresolved change on its card, so it is never lost. `planban_get_card` shows the
  card's own, and `planban_unresolved_changes` (`unresolved-changes`) lists the
  board's. Before editing a card, settle any that are waiting: save a reconsidered
  version of the same fields from the current revision, or drop it with
  `planban_drop_change` (`drop-change`) and a reason. Both go in the card's history.
  These are for agents; people don't see them on the board.
- **Working on a card.** On an online board, reading or editing a card marks you as
  working on it until 15 minutes after your last activity. `planban_get_card` says
  when someone else is ("Claude (Sam) is working on this card, started 4 minutes
  ago"). It is a heads-up, not a lock: avoid duplicating their work, and tell the
  person if you both need the same card. People see a small, quiet sign on it.
- **Retries.** If an edit's reply was lost, resend it unchanged with the same
  `idempotencyKey` (`--idempotency-key`): it applies once, and the result says it was
  a replay. A revised edit, such as one merged after a conflict, gets a new key.
- **Complete.** Every route that would put a card in Complete (moving it, creating
  it complete, restoring a version) needs `completionConfirmed: true`
  (`--completion-confirmed`), given only when a person on the board asked, confirmed
  after review, or waived review.
- **Limits.** A board holds up to 256 MB with its history, and each account can make
  up to 5,000 changes a day. Planban stays an index, not storage.
- **Signed out.** If Planban says this computer's sign-in is missing or has ended,
  ask the person to sign in again (the board page offers Sign in, or the printed
  `online login` command). Do not use local files instead.
- **Several accounts on one computer.** Several Planban accounts can be signed in at
  once, like the GitHub CLI. Each online board is linked on this computer to the
  account it uses, and every request for it uses that account, automatically, so
  agents in each project just work. `planban online accounts` lists the accounts, the
  default for new boards, and which boards use each. `planban online sign-in <url>`
  adds an account and makes it the default; others stay signed in. `planban online
  switch <url> --account <email>` changes only the default for new boards.
  `take-online` and `attach` take `--account <email>`. Never sign accounts in, out or
  switch them unless the person asks.
- **A board whose account isn't signed in.** If Planban says a board uses an account
  that isn't signed in on this computer, it names the account: ask the person to sign
  in as it (`planban online sign-in <url>`). Planban never uses another account's
  sign-in for that board. Don't retry, and don't use local files.
- **Never edit an online board's files.** Under `~/.planban`, an online board has a
  cache, automatic backups and the copy kept from before it went online. None of
  them is the board. Read and edit it only through Planban's tools or command line.

### Online lifecycle

Do any of these only when the person asks.

- **Sign out:** `planban online sign-out <url> --account <email>` signs one account out
  here and cuts off its connection; the others stay. Its boards say so until it signs
  in again. `planban online connections <url>` lists computers, apps and keys;
  `planban online revoke <url> <id>` cuts one off.
- **Invite and join:** the owner invites with Board settings, People, or
  `planban online invite --email <address> --role editor|viewer` (links last 7 days).
  The invited person opens the link in a browser, or runs `planban online join <link>`
  (add `--cwd <project>` to use the board in a project folder).
- **Use an online board in another project folder:** `planban online attach <url>
  <board> --cwd <project>`.
- **Take local:** the owner brings the board back to one computer with Board
  settings, Take local, or `planban online take-local`. On a shared board this removes
  everyone else and their agents, so it needs `--remove-others` and the person's
  clear agreement. A read-only online copy stays at app.planban.ai until the owner
  deletes it there (Board settings, Delete online copy).
- **Deleting an online board:** not possible from a computer. The owner takes it
  local, then deletes the online copy at app.planban.ai. `planban delete-board <board>
  --this-computer-only --yes` only removes it from this computer's list.
- **Backups:** every computer that uses an online board keeps an automatic backup.
  `planban online restore-backup --from <backup folder> --cwd <empty folder>
  --repo-id <new id>` makes a separate local board from one, with a new id and a
  title that says it is a copy restored from a backup; taking it online makes a
  second board.
- **Deleting an account:** by email to hello@planban.ai (the web page's profile menu,
  Delete account). It removes the boards the person owns, for everyone on them,
  within 30 days. Their edits on other people's boards stay, without their name.

### An older Planban on an online board

The online service keeps accepting older versions' actions, and new features are added
alongside existing ones. When a board uses something this Planban can't show, board
reads say "This board uses features your Planban doesn't have yet. Update to see
everything." When the service needs a newer Planban for an action, the action is
refused with a plain message saying so (error category `update_required`). Tell the
person once, in plain words, and suggest they update with Update on the board page
in Planban on their computer. Don't retry a refused action, and don't work around it.

### Tools on each surface

The local tools (the Planban plugin, through this computer) and the remote tools
(`https://app.planban.ai/mcp`, for ChatGPT, claude.ai and apps without the plugin)
share names and arguments for: list_boards, get_board, query_cards, get_card,
read_doc, create_card, create_cards, create_group, move_card, update_card,
write_doc, history, read_goals and suggest_goal_change. Differences:

- **Local only:** status, launch_board and move_files_out. Three more sets appear
  only when the person sets `PLANBAN_MCP_PROFILE` (comma-separated, or `full` for
  all): `admin` (archive, restore, duplicate and delete board), `maintenance`
  (export_flat_v1, reconstruct_hierarchy) and `legacy` (set_card_parent, an old alias
  of move_card). Local tools take `cwd` or `repoId`.
- **Both, for online boards:** unresolved_changes and drop_change.
- **Remote only:** search and fetch (for ChatGPT and claude.ai). Remote
  tools take `boardId`, from list_boards. Deleting cards and taking a board local are
  not available remotely.

Shared result contract, the same on both:

- Reads return the board's `revision`. `get_board` returns `boardId`, `title`,
  `revision` and `roadmapItems`; `query_cards` returns `matches` at the top level;
  `get_card` returns `card` and `ancestry`. Each surface may add fields of its own.
- Card and board edits return the new `revision` and what changed (`card`, `cards`
  or `group`); a Spec or Plan write returns `doc` with its new `mtimeMs`. Every edit
  also returns `boardUrl`, `boardUrlVerified` and `userReply`, with the link to give
  the person. A retried edit adds `replayed: true` (and `originalRevision` when the
  board has changed since).
- Failures keep their kind: `conflict` (with `currentRevision`), `validation`,
  `not_found`, `forbidden`, `signed_out`, `account_in_use`, `other_account` or
  `limit`. Local tools return them as a tool error with `structuredContent.error`;
  the command line prints `{"error": ...}` with `-o json`.

The `planban` command: Planban's messages print the exact command for this computer.
If `planban` isn't installed as a command, it is
`node "<Planban install folder>/bin/planban.mjs"`.

## Work Item Model

Use these terms consistently:

- **Item**: one independently trackable outcome. It may stand alone on the Main Board or be owned by one Group.
- **Group**: a root Work Item that groups Items. It has its own title, summary, evidence, Workflow Status, and Board Rank, while its Items have their own statuses and Group Ranks.
- **Placement**: whether an Item is on the Main Board or owned by a Group. Placement is independent of Workflow Status.
- **Rollup**: derived progress across a Group's direct Items. It does not set the Group's own Workflow Status.

The hierarchy is exactly one level: `Group → Item`. Groups cannot own
Groups, and Items never own Work Items or become Groups. A Group is
a distinct root Work Item with its own purpose and evidence. Its purpose may be supplied
at creation or refined later. Grouping two root Items collects a title and optional Group-level purpose, creates the Group, and places both Items inside it atomically;
their identities, context, Workflow Statuses, and history remain unchanged. Empty
Groups may also be created deliberately.

Create an Item for a concrete outcome that can be prioritized, completed, and
reviewed independently. Create a Group when several Items contribute to one
larger outcome and need their own internal priority/status list. Do not create a
Group merely to represent a label, category, or speculative future hierarchy.
Make this decision before creating the Work Item. If the proposed scope already
contains several independently deliverable outcomes, create the Group and its
Items rather than storing a latent backlog in one Item's Spec or Plan. Markdown
checklists in documents remain execution notes or evidence, not uncreated Work
Items.

When moving an Item into a Group, preserve its Workflow Status unless the
owner asks to change it and choose an explicit Group Rank in that status. Moving it
between Groups removes the old ownership and assigns the new Group Rank in one
mutation. Moving it to the Main Board removes ownership and assigns Board Rank. A
Group's Workflow Status remains explicit; its Rollup is supporting evidence, not an
automatic status transition.

## Board Opening

Opening a board is the same primary service for `/pb` and `/planban`:

1. If the current workspace/repo has `.planban/project.json`, open that repo's board.
2. Else if there is exactly one registered Planban board, open it.
3. Else open the all-boards selector.

Every successful board-open confirmation must include the exact verified board URL as a clickable Markdown link, regardless of whether in-app browser presentation succeeds. A bare “board opened” acknowledgement is never sufficient. The verified link is part of the durable response contract, while browser presentation is optional.

The Planban MCP tool whose name ends in `planban_launch_board` is the authority for
server lifecycle, service health, canonical board URL resolution, and URL
verification. Host browser presentation is a bounded optional step; it must never
redefine whether the board launched successfully.

Critical path:

1. Call `planban_launch_board` for the current `cwd`. A result with
   `serviceReady: true` and `urlVerified: true` is the successful launch; preserve
   its URL (also carried in `userReply.markdown`).
2. Make one bounded in-app presentation attempt through the adapter for this host
   under **Host adapters**. Hosts without an adapter skip this step.
3. Reply with the exact clickable verified URL whether or not presentation
   succeeded: `Planban is open: [Open the verified board](URL)` after a successful
   presentation, otherwise `Planban is running: [Open the verified board](URL)` plus
   at most one short degradation reason.

If `planban_launch_board` is not callable, use the host adapter's fallbacks. A host
without fallbacks runs the bundled launcher and uses the URL it prints:

```bash
node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo
```

Default board opening should optimize for the cold-start return-to-work case. The
Planban server may be stopped, the in-app browser may be closed, or the selected tab
may be stale, unrelated, or on an error page. Use an open-first flow: resolve the
board, present it once, and tell the user the board is open with the exact clickable
verified URL. After the board is visible, continue with a lightweight ready-next
warm-up for likely follow-up work: load broader Planban context, linked docs, or
Browser context then when useful. Do not put that work on the critical path. Always
return the verified URL. If browser presentation fails, also include at most one
useful reason from the adapter's structured `browser-presentation` diagnostic;
service/URL failures remain separate `service-url` failures.

For first-run or install verification, create or reuse the demo board:

```bash
node plugins/planban/scripts/launch-planban.mjs --demo
```

For first-run onboarding, create or reuse the demo board and open the tutorial:

```bash
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

## Host adapters

Use only the subsection for the host you are running in. Each adapter makes at most
one presentation attempt per board open or logical mutation batch.

### Codex desktop

Use the Planban browser opener module only as a bounded optional adapter for in-app
browser visibility, fresh-tab navigation, and presentation verification. The Node
REPL runtime can be sandboxed away from localhost networking, so browser
availability must never redefine whether the board launched successfully.

```js
const mod = await import("/absolute/path/to/codex-fast-open-planban.mjs");
const result = await mod.openUrlInCodexBrowser({
  url: "VERIFIED_URL_FROM_PLANBAN_LAUNCH_BOARD",
  urlVerified: true,
  serviceReady: true
});
nodeRepl.write(JSON.stringify(result));
```

Resolve the module path from the active Planban plugin root, preferably by scanning
`$CODEX_HOME/plugins/cache/planban/planban/*/scripts/codex-fast-open-planban.mjs`
and selecting the newest version. In source checkouts, use
`plugins/planban/scripts/codex-fast-open-planban.mjs`. Do not call
`browser.documentation()` before this fast
opener. Large Browser documentation payloads belong on the fallback/warm-up path, not
on the critical path for making the board visible.

Only the Node REPL `js` execution tool can run this browser opener. If Node REPL is not
callable yet, make at most one tool-discovery attempt for `node_repl js execute
JavaScript`. Do not call `js_reset`, `js_add_node_module_dir`, or any reset/setup-only
Node REPL tool for a plain open-board command. If `js` is still not callable after
that one discovery attempt, skip the Node REPL path and use the fallback route
immediately.

If the `node_repl` `js` call fails at the tool/runtime layer before JavaScript runs
(for example a missing sandbox metadata field, disabled Node REPL, permission bridge
failure, or MCP argument validation failure), classify this as "Codex browser bridge
unavailable". Do not spend more time on local Node invocations, Browser documentation,
Computer Use, Codex app UI automation, or repeated opener variations. Keep the board
launch result, return the clickable verified URL, and say that the board is running
but automatic in-app opening is unavailable.

Use `planban_launch_board` when it is available, then open the returned URL in the
Codex in-app browser through the current official Browser plugin/runtime. Do not
reuse a browser helper path copied from an older thread or older Codex app build.
If the Planban MCP tool is unavailable and Node REPL `js` is available, use
`openPlanbanBoardInCodexBrowser({ cwd, statusTimeoutMs: 800, launchTimeoutMs: 3500 })`
as a bounded fallback. Otherwise, run:

```bash
node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo
```

Do not use the OS URL handler, `open`, or an external browser as the first presentation
attempt when the user specifically wants the board visible beside the Codex thread.
The clickable verified URL is not merely a fallback: include it in the final reply
after every successful resolution, including when the in-app browser opened correctly.

Make the in-app browser visible and open a fresh in-app browser tab by default, then
verify the URL. Only reuse the selected tab when it is already exactly at the
resolved Planban URL.

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

## Roadmap Status Protocol

Follow this protocol exactly:

- Opening or linking an agent thread or session is not enough to change status.
- Planning, reading context, or discussing approach is not enough to change status.
- If the user asks an agent to start implementation, or you proceed to implementation
  work, move the card to In Progress when it is not already there.
- When agent-side implementation and verification are done, keep the card In Progress.
- At that point, update the summary and next action to say the work is ready for user
  review/testing.
- Move a card to Complete only when the user (on a shared board, a person on the
  board) explicitly asks, manually confirms completion after testing/review, or
  clearly waives user-side verification.
- Agent-side tests are evidence for readiness to review. They are not permission to
  self-complete the card.
- A landing is a card event: whoever merges a PR, pushes to a release branch or
  retires a branch updates every In Progress Item that names it, before reporting the
  landing.

## Goals

A board may have goals, most important first, plus context. Treat them as
judgement, not rules.

- When recommending or ranking work, prefer what serves the goals and say which goal
  in a few words. Higher goals usually win, but urgency, blockers, size and what the
  person asked can outweigh order.
- Work outside the goals is fine. Never refuse, delay or argue against work because
  no goal covers it. Don't tag or relabel cards by goal.
- Do what the person asked. Goals shape your suggestions, not their choices.
- When asked what's next or to review priorities, glance at recent board history. If
  chosen work keeps landing outside the goals, a goal has seen no work for weeks, or
  the person keeps picking differently from your goal-based suggestions (or a goal
  looks out of date), say so briefly in chat, with that evidence, and ask whether the
  goals still say what they want, offering to suggest a change to them. Ask even if
  you think the goals are right: their choices may mean the goals have moved. Leave one with
  `suggest_goal_change` only if they say yes, or if no person is in the conversation
  (an unattended run). Don't repeat a dismissed suggestion unless something new has
  happened.
- No goals: rank as usual, and don't mention goals. Don't ask for goals unless the
  person is planning priorities.

Board reads (`get_board`, `status`) list the goal statements when there are any;
`read_goals` returns the whole Goals page, with notes, context, suggestions waiting
and those dismissed in the last 30 days. Only people change goals. A suggestion made
with `suggest_goal_change` (after the person agreed, or in an unattended run) waits on
the Goals page for them to accept or dismiss; tell them it is there.

## Updating Roadmap State

When changing roadmap state:

- Serialize mutations for the same board. Do not run multiple roadmap writes in
  parallel.
- Preserve the existing repo-local and device-local storage boundaries.
- Update status, priority, summary, and next action so the card reflects the current
  phase of work.
- Update linked docs when the work changes the spec or plan.
- Create a separate plan doc only when the work is complex enough to need one.
- If a tool result shows stale signals for a card you own or touch, re-read it and fix
  it in the same mutation batch.
- A merged-PR signal clears only when the card's summary or next action changes to
  say what the merge means, or the card is completed. Touching the card or editing its
  metadata leaves it in place. A Spec or Plan over 100 KB is flagged too: rewrite it to
  the current state rather than appending.
- Card metadata edits are patches: the keys you send are set, a key sent as `null` is
  removed, other keys are kept, and `metadata: null` clears it all.

### Landing notes and the merge inbox

An Online Board whose owner linked a GitHub repository (`planban online github link
<owner/name>`) records merged pull requests itself, whichever computer is on:

- A merge that names a card, as `#123` (a pull request in the board's first linked
  repository), `owner/name#123` or its github.com address, in the summary, next action,
  metadata `prs` list or (for In Progress and Up Next cards) Spec, adds a dated
  **landing note** to that card: its
  `landings` list, which `get-card` and `planban_get_card` show (`landingNotes` reads them
  as sentences). The note never changes the person's text. Nobody edits it directly.
- The card's freshness then reads "Landed: needs a wrap-up". Write what the merge means
  into the summary or next action: what is now true, and what is next. That clears it;
  completing the card does too. Touching the card or editing its metadata doesn't.
- A merge that names no card goes to the board's **inbox**: `landingInbox` in
  `planban_get_board` (and `planban inbox`), counted in its attention section and the
  session-start line. For each one, write what it finished into the right card and
  assign it there (`planban_clear_landing` with `cardId`, or `planban clear-landing
  <owner/name#123> --card <id>`), or dismiss it with a reason when it needs no card,
  such as a release or dependency merge. Don't leave the inbox for the person: they
  don't see it.

### Post-mutation handoff

After a successful user-requested Planban creation or material mutation, wait until
the complete logical mutation sequence has finished, then resolve the verified Board
URL once: take it from the last mutation result's `userReply`, and call
`planban_launch_board` once only if that result has `boardUrlVerified: false`. Make
one bounded attempt to open or focus that URL through the adapter for this host under
**Host adapters**. Always include the exact verified URL as a clickable Markdown link
in the final response.

- Do not reopen the Board after every storage write in a multi-step mutation. One
  presentation attempt belongs to the logical mutation batch.
- An explicitly headless or background operation may skip browser presentation, but
  it should still return the verified clickable URL when URL resolution succeeds.
- Browser-presentation failure does not invalidate a successful mutation. Preserve
  the mutation result and return the verified link with at most one short degradation
  reason.
- Prefer a stable changed-Item URL when Planban supports one. Otherwise use the
  verified Board URL.

When Planban MCP tools are available, prefer them for structured board, card, and
document reads/writes. Use the command line when the tools are unavailable. Edit
board files directly only as a last resort, and only for a local board: never for an
online board, its cache, its backups or the copy kept from before it went online.

Prefer the Planban CLI or API when available. Example CLI operations from the Planban
repo (elsewhere, replace `npm run planban --` with the `planban` command described
under Online authority):

When an agent creates a Group, provide a concise Group objective by default. Omit it
only when the owner explicitly asks for no objective or when the larger outcome is
genuinely unresolved; do not invent a specific objective from weak context. The UI
may leave the objective blank and add or edit it later.

On an online board, add `--base-revision <revision>` to each card or board edit (the
`revision` from `get-card` or `query-cards`). `write-doc` takes the document's own
version instead: `--expected-mtime <mtimeMs>` (the `mtimeMs` from `read-doc`).

```bash
npm run planban -- status --cwd /path/to/repo -o json
npm run planban -- get-card <card-id> --cwd /path/to/repo -o json
npm run planban -- move-card <card-id> --status in-progress --cwd /path/to/repo -o json
npm run planban -- create-group "Larger outcome" --summary "Outcome these Items achieve together" --item <card-id> --item <card-id> --cwd /path/to/repo -o json
npm run planban -- update-card <group-id> --summary "Refined Group objective" --cwd /path/to/repo -o json
npm run planban -- move-card <card-id> --parent <group-id> --cwd /path/to/repo -o json
npm run planban -- move-card <card-id> --board --cwd /path/to/repo -o json
npm run planban -- read-doc <card-id> spec --cwd /path/to/repo -o json
npm run planban -- demo -o json
```

## Planban references

Copy Reference in the Board puts one line on the clipboard: `“<title>” · planban:<board>/<item>`. The `planban:` token is the identity; the quoted title is display context.

Reading a reference:

- `planban:<board>/<item>` names an Item or Group: `<board>` is the registered repo id and `<item>` is the card id. Resolve it with `planban_get_card` using `repoId` and `cardId`, or through the CLI `get-card`.
- `planban:<board>` names a Board. Resolve it with `planban_status` or `planban_get_board` using `repoId`.
- Trust the id over the title. If the resolved card's title differs from the quoted title, proceed with the id and mention the mismatch.

Writing a reference: when citing or handing off an Item in a reply, prompt, or document, use the same one-line form. Do not invent longer labelled formats or absolute paths.

## Agent handoff prompts

Planban handoff prompts for a new agent thread or session should include enough
context to begin without rediscovery:

- repository path
- board URL
- card id
- current status
- Group ancestry from root to direct parent, when present
- linked spec and plan doc paths
- launch token when present
- this status protocol

Do not depend on unresolved `@Planban` mentions for local MVP prompts. Say to use the
Planban plugin or skill if available.
