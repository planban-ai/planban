import { Command, CommanderError, Option } from "commander";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ensureDemoBoard } from "./core/demo";
import { archiveBoard, deleteBoard, duplicateBoard, listAllBoards, restoreBoard } from "./core/registry";
import {
  getStatus,
  initializeProject,
  loadState,
  dropChange,
  clearLanding,
  moveCard,
  unresolvedChanges,
  readDoc,
  readDocSections,
  writeDocSection,
  setCardParent,
  cardAncestry,
  writeDoc,
  createCard,
  createCards,
  createGroup,
  updateCard,
  exportFlatVersion1,
  reconstructHierarchy,
  readManifest,
  readGoals,
  readGoalsBlock,
  suggestGoalChange,
} from "./core/storage";
import { goalsPageText } from "./core/goals";
import { PLANBAN_STATUSES, type PlanbanStatus } from "./core/types";
import { queryWorkItems, workItemQueryFromSearchParams } from "./core/workItemQuery";
import { friendlyPath } from "./core/indexCheck";
import { expandHome } from "./core/paths";
import { moveFilesOut, type MoveFilesOutResult } from "./core/moveFilesOut";
import { buildUpdateCommandPlan, runPlanbanUpdate } from "./core/updateRunner";
import { updatePreflight } from "./core/updatePreflight";
import { PLANBAN_VERSION } from "./core/version";
import { startServer } from "./server/server";
import { listAccounts, rememberIdentity, switchAccount } from "./core/online/accounts";
import { errorReport } from "./core/errorReport";
import { onlineLogin } from "./core/online/login";
import { onlineStatus } from "./core/online/credentials";
import { createKey, listConnections, onlineLogout, revokeConnection } from "./core/online/connections";
import { invitePeople, joinBoard, listPeople, setMyAgents } from "./core/online/people";
import { gitHubLinkStatus, linkGitHubRepo, unlinkGitHubRepo } from "./core/online/github";
import { inboxForAgents, parseLandingRef } from "./core/landings";
import { attachOnline, exportOnline, keepLocalCopy, keepSeparateBoard, restoreBackup, stopTakeOnline, takeLocal, takeOnline } from "./core/online/transfers";

function cwdOption(value: string | undefined) {
  return resolve(value ?? process.cwd());
}

function print(value: unknown, options: { output?: string }) {
  if (options.output === "json") {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  if (typeof value === "string") process.stdout.write(value + "\n");
  else process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function requireStatus(value: string): PlanbanStatus {
  if (!PLANBAN_STATUSES.includes(value as PlanbanStatus)) {
    throw new Error(`Invalid status "${value}". Expected one of: ${PLANBAN_STATUSES.join(", ")}`);
  }
  return value as PlanbanStatus;
}

function requireCreatePosition(value: string): "top" | "bottom" {
  if (value !== "top" && value !== "bottom") {
    throw new Error('Invalid position. Expected "top" or "bottom".');
  }
  return value;
}

function parseBooleanOption(value: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new Error('Invalid boolean. Expected "true" or "false".');
  }
  return value === "true";
}

function parseRevisionOption(value: string): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error("Invalid revision. Expected a non-negative integer.");
  }
  return revision;
}

function parsePositiveInteger(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error("Expected a positive integer.");
  return number;
}

function collectOption(value: string, previous: string[] = []) {
  return [...previous, value];
}

function parseMetadataJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--metadata-json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function readStdin(): Promise<string> {
  return new Promise((resolveRead, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveRead(data));
    process.stdin.on("error", reject);
  });
}

const program = new Command();
program.name("planban").description("Agent-native planning board for Codex and Claude Code: local by default, online when you share a board").version(PLANBAN_VERSION);

const online = program.command("online").description("Sign in and move boards between local and online authority");
online.command("sign-in <url>").description("add a Planban account on this computer, for example: sign-in https://app.planban.ai; other accounts stay signed in, and this one becomes the default for new boards")
  // Development-only sign-in on a local backend; hidden from help.
  .addOption(new Option("--access <scope>", "with --dev-user: connection access").choices(["all", "board"]).default("all").hideHelp())
  .addOption(new Option("--boards <id>", "with --dev-user: the one board the connection reaches").hideHelp())
  .addOption(new Option("--dev-user <id>", "development sign-in on a local Online Board backend").hideHelp())
  .option("--key-env <name>", "sign in with a personal access key held in this environment variable")
  .option("--device", "sign in by approving a link on any signed-in device, computer or phone")
  .option("--no-browser", "print the approval link instead of opening a browser (for remote or headless machines)")
  // Kept so older scripts still run: adding an account no longer replaces another.
  .addOption(new Option("--switch-account", "no longer needed: signing in adds an account").hideHelp())
  .action(async (url, options) => print(await onlineLogin(url, {
    ...options,
    // Without a browser here, approve by link on any device: a loopback callback can't reach a remote machine.
    ...(options.browser === false ? { printOnly: true } : {}),
  }), {}));
online.command("login <url>").description("same as sign-in")
  // Development-only sign-in on a local backend; hidden from help.
  .addOption(new Option("--access <scope>", "with --dev-user: connection access").choices(["all", "board"]).default("all").hideHelp())
  .addOption(new Option("--boards <id>", "with --dev-user: the one board the connection reaches").hideHelp())
  .addOption(new Option("--dev-user <id>", "development sign-in on a local Online Board backend").hideHelp())
  .option("--key-env <name>", "sign in with a personal access key held in this environment variable")
  .option("--device", "sign in by approving a link on any signed-in device, computer or phone")
  .option("--no-browser", "print the approval link instead of opening a browser (for remote or headless machines)")
  // Kept so older scripts still run: adding an account no longer replaces another.
  .addOption(new Option("--switch-account", "no longer needed: signing in adds an account").hideHelp())
  .action(async (url, options) => print(await onlineLogin(url, {
    ...options,
    // Without a browser here, approve by link on any device: a loopback callback can't reach a remote machine.
    ...(options.browser === false ? { printOnly: true } : {}),
  }), {}));
for (const name of ["sign-out", "logout"]) {
  online.command(`${name} <url>`).description(name === "logout" ? "same as sign-out" : "sign one account out on this computer and revoke its connection; its boards say so until it signs in again")
    .option("--account <email>", "which account, when several are signed in")
    .action(async (url, options) => print(await onlineLogout(url, { account: options.account }), options));
}
online.command("accounts").description("the accounts signed in on this computer, the default for new boards, and which boards use each")
  .action(async (options) => print(await listAccounts(), options));
online.command("switch <url>").description("change the default account for boards taken online or attached from now on; boards already linked keep theirs")
  .requiredOption("--account <email>", "a signed-in account")
  .action(async (url, options) => print(await switchAccount(url, options.account), options));
online.command("connections <url>").description("list this person's machines, agents and keys")
  .action(async (url) => print(await listConnections(url), {}));
online.command("revoke <url> <connectionId>").description("cut off a machine, agent or key at once")
  .action(async (url, connectionId) => print(await revokeConnection(url, connectionId), {}));
const keys = online.command("keys").description("personal access keys");
keys.command("create <url>").requiredOption("--board <id>", "the one board the key reaches")
  .addOption(new Option("--level <level>", "what the key may do").choices(["read", "plan", "complete"]).makeOptionMandatory())
  .requiredOption("--name <name>", "a name to recognise the key by")
  .option("--expires-days <days>", "days until the key stops working", (value) => Number(value))
  .action(async (url, options) => {
    const created = await createKey(url, { boardId: options.board, level: options.level, name: options.name, expiresInDays: options.expiresDays });
    process.stderr.write("Copy this key now. Planban keeps only a fingerprint of it and cannot show it again.\n");
    print(created, {});
  });
online.command("status").description("which Planban Online services this computer is signed in to, and as whom").action(async () => {
  // Sign-ins from before emails were kept: ask the service once, quietly.
  const before = await onlineStatus();
  for (const service of before) if (!service.signedInAs) await rememberIdentity(service.url, 1).catch(() => undefined);
  print(await onlineStatus(), {});
});
online.command("take-online <url>").description("take this project's board online, for example to https://app.planban.ai; it must hold no files").option("--cwd <path>", "project directory")
  .option("--account <email>", "as this signed-in account (the default otherwise); the board uses it from now on")
  .action(async (url, options) => print(await takeOnline(url, cwdOption(options.cwd), { account: options.account }), options));
online.command("stop-take-online").description("stop an unfinished take-online; the board stays on this machine").option("--cwd <path>", "project directory")
  .action(async (options) => print(await stopTakeOnline(cwdOption(options.cwd)), {}));
const onlineBoardOf = async (cwd: string) => {
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled || manifest.storage?.kind !== "online") throw new Error("This project does not point to an Online Board.");
  return manifest.storage;
};
online.command("export").description("save a copy of this project's online board, with its history, to a file").option("--cwd <path>", "project directory").requiredOption("--out <file>", "bundle destination")
  .action(async (options) => {
    await exportOnline(cwdOption(options.cwd), options.out);
    print({ exported: resolve(options.out) }, {});
  });
online.command("take-local").description("bring this project's online board back to this computer, with its history").option("--cwd <path>", "project directory")
  .option("--remove-others", "on a shared board: confirm that everyone else and their agents lose access")
  .action(async (options) => print(await takeLocal(cwdOption(options.cwd), { removeOthers: !!options.removeOthers }), {}));
online.command("attach <url> <boardId>").description("use an online board in this project folder on this computer").requiredOption("--cwd <path>", "project directory")
  .option("--replace-stale-copy", "set aside this project's out-of-date local copy of the board")
  .option("--account <email>", "use the board as this signed-in account (the default otherwise)")
  .action(async (url, boardId, options) => print(await attachOnline(url, boardId, cwdOption(options.cwd), { replaceStaleCopy: !!options.replaceStaleCopy, account: options.account }), options));
online.command("restore-backup").description("make a new local board from a backup this computer kept of an online board").requiredOption("--from <folder>", "backup folder: .../latest or .../daily/<date>")
  .requiredOption("--cwd <path>", "empty project directory").requiredOption("--repo-id <id>", "id for the restored local board")
  .action(async (options) => print(await restoreBackup(options.from, cwdOption(options.cwd), options.repoId), {}));
online.command("invite").description("invite someone to this project's online board; the link works for 7 days")
  .option("--cwd <path>", "project directory")
  .addOption(new Option("--role <role>", "what they may do").choices(["editor", "viewer"]).default("viewer"))
  .option("--email <address>", "an invite for one person, by email")
  .action(async (options) => print(await invitePeople(cwdOption(options.cwd), { role: options.role, ...(options.email ? { email: options.email } : {}) }), {}));
online.command("join <link>").description("join a board from an invite link, signed in as yourself")
  .option("--cwd <path>", "also use the board in this project folder")
  .action(async (link, options) => print(await joinBoard(link, options.cwd ? { cwd: cwdOption(options.cwd) } : {}), {}));
online.command("people").description("who is on this project's online board, their roles, and what their agents may do")
  .option("--cwd <path>", "project directory")
  .action(async (options) => print(await listPeople(cwdOption(options.cwd)), {}));
online.command("my-agents <level>").description("choose what your own agents may do on this board: read, plan or complete")
  .option("--cwd <path>", "project directory")
  .action(async (level, options) => {
    if (!["read", "plan", "complete"].includes(level)) throw new Error("level must be read, plan or complete.");
    print(await setMyAgents(cwdOption(options.cwd), level), {});
  });
const github = online.command("github").description("link GitHub repositories, so this Online Board records merged pull requests itself");
github.command("link <repo>").description("link owner/name: adds a webhook with the GitHub CLI (gh) signed in here; needs admin access to the repository")
  .option("--cwd <path>", "project directory")
  .action(async (repo, options) => print(await linkGitHubRepo(cwdOption(options.cwd), repo), {}));
github.command("unlink <repo>").description("stop recording owner/name's merges, and remove its webhook from GitHub")
  .option("--cwd <path>", "project directory")
  .action(async (repo, options) => print(await unlinkGitHubRepo(cwdOption(options.cwd), repo), {}));
github.command("status").description("the repositories linked to this board, and the last delivery from each")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => print(await gitHubLinkStatus(cwdOption(options.cwd)), options));
online.command("keep-local-copy").description("keep an older copy of an online board as a separate board; this project then uses the online board")
  .requiredOption("--cwd <path>", "project directory")
  .option("--title <title>", "name for the separate board")
  .option("--new-id <id>", "id for the separate board")
  .option("--in-this-project", "instead, keep using the separate board in this project (its agents follow it, not the online board)")
  .action(async (options) => {
    if (options.inThisProject) {
      if (!options.newId) throw new Error("--in-this-project needs --new-id.");
      print(await keepLocalCopy(cwdOption(options.cwd), options.newId, options.title), {});
    } else {
      print(await keepSeparateBoard(cwdOption(options.cwd), { title: options.title, newId: options.newId }), {});
    }
  });

program
  .command("init")
  .option("--cwd <path>", "project directory")
  .option("--title <title>", "project title")
  .option("--repo-id <id>", "stable repo id")
  .option("--no-agents", "do not update AGENTS.md")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    print(
      await initializeProject({
        cwd: cwdOption(options.cwd),
        title: options.title,
        repoId: options.repoId,
        updateAgents: options.agents,
      }),
      options,
    );
  });

program
  .command("status")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const status = await getStatus(cwdOption(options.cwd));
    // The goal statements only, when the board has goals.
    const goals = status.initialized ? await readGoalsBlock(status.cwd) : null;
    print({ ...status, ...(goals ? { goals } : {}) }, options);
  });

program
  .command("update")
  .description("inspect whether this local Planban install can update safely")
  .option("--dry-run", "inspect only; do not update files")
  .option("--execute", "run the direct local update when preflight allows it")
  .option("--runtime-root <path>", "Planban install/runtime root")
  .option("--current-board-url <url>", "board URL to reopen after update")
  .option("--target-version <version>", "target Planban version")
  .option("--target-ref <ref>", "target Git ref")
  .option("--target-commit <sha>", "target Git commit")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    if (options.execute && options.dryRun) {
      throw new Error("Use either --dry-run or --execute, not both.");
    }
    if (!options.execute) {
      const preflight = await updatePreflight({
        runtimeRoot: resolve(options.runtimeRoot ?? process.cwd()),
      });
      print({
        ...preflight,
        commandPlan: buildUpdateCommandPlan(preflight, {
          schemaVersion: 1,
          version: options.targetVersion ?? PLANBAN_VERSION,
          pluginVersion: options.targetVersion ?? PLANBAN_VERSION,
          mcpVersion: options.targetVersion ?? PLANBAN_VERSION,
          storageSchemaVersion: 2,
          minimumStorageSchemaVersion: 2,
          publishedAt: new Date().toISOString(),
          sourceUrl: "https://github.com/planban-ai/planban",
          releaseNotesUrl: `https://github.com/planban-ai/planban/releases/tag/v${options.targetVersion ?? PLANBAN_VERSION}`,
          targetRef: options.targetRef,
          targetCommit: options.targetCommit,
          summary: "Planban update",
          updatePrompt: "Update Planban.",
        }),
      }, options);
      return;
    }
    const snapshot = await runPlanbanUpdate({
      runtimeRoot: resolve(options.runtimeRoot ?? process.cwd()),
      currentBoardUrl: options.currentBoardUrl,
      latest: {
        schemaVersion: 1,
        version: options.targetVersion ?? PLANBAN_VERSION,
        pluginVersion: options.targetVersion ?? PLANBAN_VERSION,
        mcpVersion: options.targetVersion ?? PLANBAN_VERSION,
        storageSchemaVersion: 2,
        minimumStorageSchemaVersion: 2,
        publishedAt: new Date().toISOString(),
        sourceUrl: "https://github.com/planban-ai/planban",
        releaseNotesUrl: `https://github.com/planban-ai/planban/releases/tag/v${options.targetVersion ?? PLANBAN_VERSION}`,
        targetRef: options.targetRef,
        targetCommit: options.targetCommit,
        summary: "Planban update",
        updatePrompt: "Update Planban.",
      },
    });
    print(snapshot, options);
    if (snapshot.status === "failed") process.exitCode = 1;
  });

program
  .command("demo")
  .description("create or reuse the local Planban Demo board")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    print(await ensureDemoBoard(), options);
  });

program
  .command("list-boards")
  .description("list registered Planban boards")
  .option("--include-archived", "include archived boards")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const boards = await listAllBoards();
    print(options.includeArchived ? boards : boards.filter((board) => !board.archivedAt), options);
  });

program
  .command("archive-board")
  .description("archive a whole Planban board without deleting its local planning state")
  .argument("<repoId>")
  .option("-o, --output <format>", "output format")
  .action(async (repoId, options) => {
    print(await archiveBoard(repoId), options);
  });

program
  .command("restore-board")
  .description("restore an archived Planban board")
  .argument("<repoId>")
  .option("-o, --output <format>", "output format")
  .action(async (repoId, options) => {
    print(await restoreBoard(repoId), options);
  });

program
  .command("duplicate-board")
  .description("duplicate a whole Planban board into a new local Planban board")
  .argument("<sourceRepoId>")
  .option("--repo-id <id>", "repo id for the duplicated board")
  .option("--title <title>", "title for the duplicated board")
  .option("-o, --output <format>", "output format")
  .action(async (sourceRepoId, options) => {
    print(await duplicateBoard({ sourceRepoId, repoId: options.repoId, title: options.title }), options);
  });

program
  .command("delete-board")
  .description("delete a whole Planban board after creating a timestamped local backup")
  .argument("<repoId>")
  .option("--yes", "confirm deletion")
  .option("--this-computer-only", "for an online board: only remove it from this computer; it stays online for everyone")
  .option("-o, --output <format>", "output format")
  .action(async (repoId, options) => {
    if (!options.yes) throw new Error("Refusing to delete a board without --yes");
    print(await deleteBoard(repoId, { thisComputerOnly: options.thisComputerOnly === true }), options);
  });

program
  .command("serve")
  .option("--cwd <path>", "project directory")
  .option("--port <port>", "port", "4317")
  .option("--no-vite", "serve built static files instead of Vite middleware")
  .action(async (options) => {
    const server = await startServer({
      cwd: cwdOption(options.cwd),
      port: Number(options.port),
      useVite: options.vite,
    });
    process.stdout.write(`Planban listening at ${server.url}\n`);
    await new Promise(() => {
      // Keep the CLI process alive while the HTTP server owns the terminal.
    });
  });

program
  .command("list-cards")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const state = await loadState(cwdOption(options.cwd));
    print(state.roadmap.roadmapItems, options);
  });

program
  .command("query-cards")
  .description("search and filter Work Items without changing roadmap state")
  .option("--search <text>", "search id, title, summary, next action, and tags")
  .option("--projection <projection>", "main, group, or flattened")
  .option("--group <cardId>", "selected Group for Group projection or scope")
  .addOption(new Option("--programme <cardId>", "deprecated alias for --group").hideHelp())
  .option("--scope <scope>", "projection, root, owned, leaf, or selected-group")
  .option("--group-role <role>", "any, group, or item-only")
  .addOption(new Option("--programme-role <role>", "deprecated alias for --group-role").hideHelp())
  .option("--status <status>", "Workflow Status filter; repeat for multiple", collectOption, [])
  .option("--blocked <state>", "any, blocked, or unblocked")
  .option("--tag <tag>", "tag filter; repeat for multiple", collectOption, [])
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const params = new URLSearchParams();
    if (options.search) params.set("q", options.search);
    if (options.projection) params.set("projection", options.projection);
    if (options.group ?? options.programme) params.set("groupId", options.group ?? options.programme);
    if (options.scope) params.set("scope", options.scope);
    if (options.groupRole ?? options.programmeRole) params.set("groupRole", options.groupRole ?? options.programmeRole);
    for (const status of options.status) params.append("status", status);
    if (options.blocked) params.set("blocked", options.blocked);
    for (const tag of options.tag) params.append("tag", tag);
    const state = await loadState(cwdOption(options.cwd));
    print({ revision: state.roadmap.revision, ...queryWorkItems(state.roadmap.roadmapItems, workItemQueryFromSearchParams(params)) }, options);
  });

program
  .command("get-card")
  .argument("<cardId>")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, options) => {
    const state = await loadState(cwdOption(options.cwd));
    const card = state.roadmap.roadmapItems.find((item) => item.id === cardId);
    if (!card) throw new Error(`Card not found: ${cardId}`);
    // The board's revision travels with the card, for --base-revision on the next edit.
    print({ revision: state.roadmap.revision, ...card, ancestry: cardAncestry(state.roadmap, cardId) }, options);
  });

program
  .command("move-card")
  .argument("<cardId>")
  .option("--status <status>", "target status")
  .option("--parent <cardId>", "move this Item into an existing Group")
  .option("--board", "move to the main board")
  .option("--after <cardId>", "place after a sibling in the target status")
  .option("--first", "place first in the target ownership and status scope")
  .option("--completion-confirmed", "a person on the board asked for, confirmed or waived review of completing this card (required to put a card in complete)")
  .option("--base-revision <revision>", "roadmap revision for stale-write protection (required for Online Boards)", parseRevisionOption)
  .option("--cwd <path>", "project directory")
  .option("--idempotency-key <key>", "online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores); reuse it only to retry the same edit after a lost reply")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, options) => {
    if (options.parent && options.board) throw new Error("Choose at most one of --parent or --board.");
    if (options.after && options.first) throw new Error("Choose at most one of --after or --first.");
    if (!options.status && !options.parent && !options.board && !options.after && !options.first) {
      throw new Error("Provide --status, --parent, --board, --after, or --first.");
    }
    print(
      await moveCard({
        cwd: cwdOption(options.cwd),
        cardId,
        status: options.status ? requireStatus(options.status) : undefined,
        parentId: options.parent ? options.parent : options.board ? null : undefined,
        afterId: options.after ? options.after : options.first ? null : undefined,
        baseRevision: options.baseRevision,
        actor: "agent", idempotencyKey: options.idempotencyKey,
        completionConfirmed: options.completionConfirmed === true,
      }),
      options,
    );
  });

program
  .command("update-card")
  .argument("<cardId>")
  .option("--title <title>", "replace the card title")
  .option("--summary <summary>", "replace the card summary or Group objective")
  .option("--clear-summary", "clear the card summary or Group objective")
  .option("--next-action <nextAction>", "replace the next action")
  .option("--clear-next-action", "clear the next action")
  .option("--tag <tag>", "replacement tag; repeat for multiple tags", collectOption)
  .option("--blocked-by <cardId>", "replace the blocking card")
  .option("--clear-blocked-by", "clear the blocking card")
  .option("--metadata-json <json>", "set metadata keys from a JSON object; a key set to null is removed")
  .option("--clear-metadata", "clear card metadata")
  .option("--base-revision <revision>", "roadmap revision for stale-write protection (required for Online Boards)", parseRevisionOption)
  .option("--cwd <path>", "project directory")
  .option("--idempotency-key <key>", "online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores); reuse it only to retry the same edit after a lost reply")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, options) => {
    if (options.summary !== undefined && options.clearSummary) throw new Error("Choose at most one of --summary or --clear-summary.");
    if (options.nextAction !== undefined && options.clearNextAction) throw new Error("Choose at most one of --next-action or --clear-next-action.");
    if (options.blockedBy !== undefined && options.clearBlockedBy) throw new Error("Choose at most one of --blocked-by or --clear-blocked-by.");
    if (options.metadataJson !== undefined && options.clearMetadata) throw new Error("Choose at most one of --metadata-json or --clear-metadata.");
    if (options.title === undefined
      && options.summary === undefined && !options.clearSummary
      && options.nextAction === undefined && !options.clearNextAction
      && options.tag === undefined
      && options.blockedBy === undefined && !options.clearBlockedBy
      && options.metadataJson === undefined && !options.clearMetadata) {
      throw new Error("Provide a card field to update.");
    }
    print(await updateCard({
      cwd: cwdOption(options.cwd),
      cardId,
      title: options.title,
      summary: options.clearSummary ? null : options.summary,
      nextAction: options.clearNextAction ? null : options.nextAction,
      tags: options.tag,
      blockedBy: options.clearBlockedBy ? null : options.blockedBy,
      metadata: options.clearMetadata ? null : options.metadataJson !== undefined ? parseMetadataJson(options.metadataJson) : undefined,
      baseRevision: options.baseRevision,
      actor: "agent", idempotencyKey: options.idempotencyKey,
    }), options);
  });

program
  .command("set-card-parent")
  .description("Deprecated compatibility alias; use move-card --parent or --board")
  .argument("<cardId>")
  .option("--parent <cardId>", "move this Item into a root Group")
  .option("--board", "move to the main board")
  .option("--base-revision <revision>", "roadmap revision for stale-write protection (required for Online Boards)", parseRevisionOption)
  .option("--cwd <path>", "project directory")
  .option("--idempotency-key <key>", "online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores); reuse it only to retry the same edit after a lost reply")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, options) => {
    if ((options.parent ? 1 : 0) + (options.board ? 1 : 0) !== 1) {
      throw new Error("Choose exactly one of --parent or --board.");
    }
    print(await setCardParent({
      cwd: cwdOption(options.cwd),
      cardId,
      parentId: options.board ? null : options.parent,
      baseRevision: options.baseRevision,
      actor: "agent", idempotencyKey: options.idempotencyKey,
    }), options);
  });

program
  .command("create-card")
  .argument("<title>")
  .option("--status <status>", "initial status")
  .option("--summary <summary>", "card summary")
  .option("--next-action <nextAction>", "next action")
  .option("--tag <tag>", "tag to attach; repeat for multiple tags", collectOption, [])
  .option("--metadata-json <json>", "metadata object as JSON")
  .option("--spec-file <path>", "read initial spec markdown from a file")
  .option("--plan-file <path>", "read initial plan markdown from a file and attach a plan doc")
  .option("--position <position>", "insert at top or bottom of the target status column")
  .option("--after <cardId>", "insert after another card in the target status column")
  .option("--parent <cardId>", "create inside a Group")
  .option("--completion-confirmed", "a person on the board asked for, confirmed or waived review of completing this card (required to put a card in complete)")
  .option("--base-revision <revision>", "roadmap revision for stale-write protection (required for Online Boards)", parseRevisionOption)
  .option("--cwd <path>", "project directory")
  .option("--idempotency-key <key>", "online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores); reuse it only to retry the same edit after a lost reply")
  .option("-o, --output <format>", "output format")
  .action(async (title, options) => {
    print(
      await createCard({
        cwd: cwdOption(options.cwd),
        title,
        status: options.status ? requireStatus(options.status) : undefined,
        summary: options.summary,
        nextAction: options.nextAction,
        tags: options.tag,
        metadata: options.metadataJson ? parseMetadataJson(options.metadataJson) : undefined,
        specMarkdown: options.specFile ? readFileSync(resolve(options.specFile), "utf8") : undefined,
        planMarkdown: options.planFile ? readFileSync(resolve(options.planFile), "utf8") : undefined,
        position: options.position ? requireCreatePosition(options.position) : undefined,
        afterId: options.after,
        parentId: options.parent,
        baseRevision: options.baseRevision,
        actor: "agent", idempotencyKey: options.idempotencyKey,
        completionConfirmed: options.completionConfirmed === true,
      }),
      options,
    );
  });

function configureCreateGroupCommand(command: Command) {
  return command
    .argument("<title>")
    .option("--summary <summary>", "Group objective; agents should normally provide one unless explicitly asked not to")
    .option("--next-action <nextAction>", "next action")
    .option("--status <status>", "initial Group status")
    .option("--item <cardId>", "root Item to place inside; repeat for multiple Items", collectOption, [])
    .addOption(new Option("--deliverable <cardId>", "deprecated alias for --item").argParser(collectOption).default([]).hideHelp())
    .option("--anchor <cardId>", "initial Item whose Main Board position the Group takes")
    .option("--spec-file <path>", "read initial Group spec markdown from a file")
    .option("--plan-file <path>", "read initial Group plan markdown from a file")
    .option("--completion-confirmed", "a person on the board asked for, confirmed or waived review of completing this card (required to put a card in complete)")
    .option("--base-revision <revision>", "roadmap revision for stale-write protection (required for Online Boards)", parseRevisionOption)
    .option("--idempotency-key <key>", "online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores); reuse it only to retry the same edit after a lost reply")
    .option("--cwd <path>", "project directory")
    .option("-o, --output <format>", "output format")
    .action(async (title, options) => {
      print(await createGroup({
        cwd: cwdOption(options.cwd),
        title,
        summary: options.summary,
        nextAction: options.nextAction,
        status: options.status ? requireStatus(options.status) : undefined,
        itemIds: [...options.item, ...options.deliverable],
        anchorId: options.anchor,
        specMarkdown: options.specFile ? readFileSync(resolve(options.specFile), "utf8") : undefined,
        planMarkdown: options.planFile ? readFileSync(resolve(options.planFile), "utf8") : undefined,
        baseRevision: options.baseRevision,
        actor: "agent", idempotencyKey: options.idempotencyKey,
        completionConfirmed: options.completionConfirmed === true,
      }), options);
    });
}

configureCreateGroupCommand(program.command("create-group"));
configureCreateGroupCommand(program.command("create-programme", { hidden: true }));

program
  .command("create-cards")
  .requiredOption("--title <title>", "title to create; repeat for multiple cards", collectOption, [])
  .option("--status <status>", "initial status")
  .option("--parent <cardId>", "create inside a Group")
  .option("--completion-confirmed", "a person on the board asked for, confirmed or waived review of completing this card (required to put a card in complete)")
  .option("--base-revision <revision>", "roadmap revision for stale-write protection (required for Online Boards)", parseRevisionOption)
  .option("--cwd <path>", "project directory")
  .option("--idempotency-key <key>", "online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores); reuse it only to retry the same edit after a lost reply")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    print(await createCards({
      cwd: cwdOption(options.cwd), titles: options.title,
      status: options.status ? requireStatus(options.status) : undefined,
      parentId: options.parent, baseRevision: options.baseRevision,
      actor: "agent", idempotencyKey: options.idempotencyKey, completionConfirmed: options.completionConfirmed === true,
    }), options);
  });

for (const [command, status] of [
  ["complete-card", "complete"],
  ["archive-card", "archived"],
  ["restore-card", "pending"],
] as const) {
  program
    .command(command)
    .argument("<cardId>")
    .option("--base-revision <revision>", "roadmap revision for stale-write protection (required for Online Boards)", parseRevisionOption)
    .option("--completion-confirmed", "for complete-card: a person on the board asked for, confirmed or waived review of completing it")
    .option("--idempotency-key <key>", "online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores); reuse it only to retry the same edit after a lost reply")
    .option("--cwd <path>", "project directory")
    .option("-o, --output <format>", "output format")
    .action(async (cardId, options) => {
      print(await moveCard({
        cwd: cwdOption(options.cwd), cardId, status, baseRevision: options.baseRevision,
        actor: "agent", idempotencyKey: options.idempotencyKey, completionConfirmed: options.completionConfirmed === true,
      }), options);
    });
}

program
  .command("write-doc-section")
  .description("replace one section of a Spec or Plan by its heading, or add one; only that section is checked, so edits to other sections never clash")
  .argument("<cardId>")
  .argument("<kind>")
  .requiredOption("--heading <text>", "the section's heading text, without the #s")
  .requiredOption("--expected-section-version <version|new>", "the section's version from read-doc (sections), or new for a new section")
  .option("--occurrence <n>", "which section with this heading (0 for the first), when headings repeat", (value) => Number(value))
  .option("--after <heading>", "for a new section: the heading to put it after")
  .option("--file <path>", "read the section from a file instead of stdin (it starts with its heading line)")
  .option("--idempotency-key <key>", "online boards: reuse only to retry the same edit after a lost reply")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, kind, options) => {
    if (kind !== "spec" && kind !== "plan") throw new Error("kind must be spec or plan");
    const markdown = options.file ? readFileSync(options.file, "utf8") : await readStdin();
    const expected = String(options.expectedSectionVersion).trim();
    print(await writeDocSection({
      cwd: cwdOption(options.cwd), cardId, kind, heading: options.heading, expectedSectionVersion: expected === "new" ? null : expected,
      markdown, occurrence: options.occurrence, after: options.after, actor: "agent", idempotencyKey: options.idempotencyKey,
    }), options);
  });

program
  .command("unresolved-changes")
  .description("on an online board: agents' edits refused because something they touched changed since, still waiting")
  .option("--card <cardId>", "only this card's")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => print(await unresolvedChanges({ cwd: cwdOption(options.cwd), cardId: options.card }), options));

program
  .command("drop-change")
  .description("on an online board: drop an unresolved change that is no longer needed, with the reason, into the card's history")
  .argument("<changeId>")
  .requiredOption("--reason <reason>", "why it is dropped, in a sentence")
  .requiredOption("--base-revision <revision>", "roadmap revision you last read", parseRevisionOption)
  .option("--idempotency-key <key>", "reuse only to retry the same drop after a lost reply")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (changeId, options) => print(await dropChange({ cwd: cwdOption(options.cwd), changeId, reason: options.reason, baseRevision: options.baseRevision, actor: "agent", idempotencyKey: options.idempotencyKey }), options));

program
  .command("inbox")
  .description("on an Online Board with a linked GitHub repository: merged pull requests that named no card, waiting to be assigned or dismissed")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const state = await loadState(cwdOption(options.cwd));
    print({ revision: state.roadmap.revision, landingInbox: inboxForAgents(state.roadmap.landingInbox) }, options);
  });

program
  .command("clear-landing")
  .description("take a merge out of the inbox: assign it to the card it finished (--card), or dismiss it (--dismiss)")
  .argument("<pullRequest>", "the merge as owner/name#123, as the inbox lists it")
  .option("--card <cardId>", "the card it finished; it gets the merge as a landing note")
  .option("--dismiss", "it needs no card")
  .option("--reason <reason>", "why it is dismissed, in a sentence")
  .option("--idempotency-key <key>", "reuse only to retry the same change after a lost reply")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (pullRequest, options) => {
    const ref = parseLandingRef(pullRequest);
    if (!ref) throw new Error("Name the merge as owner/name#123, as the inbox lists it.");
    if (!options.card === !options.dismiss) throw new Error("Say either --card <cardId> or --dismiss.");
    const state = await clearLanding({ cwd: cwdOption(options.cwd), ...ref, cardId: options.card, reason: options.reason, actor: "agent", idempotencyKey: options.idempotencyKey });
    print({ revision: state.roadmap.revision, inboxLeft: state.roadmap.landingInbox?.length ?? 0, ...(options.card ? { card: state.roadmap.roadmapItems.find((item) => item.id === options.card) } : {}) }, options);
  });

program
  .command("goals")
  .description("the board's Goals page: goals in order with notes, context, suggestions waiting and recently dismissed, retired goals")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const result = await readGoals({ cwd: cwdOption(options.cwd) });
    print(options.output === "json" ? { ...result.page, revision: result.revision } : goalsPageText(result.page), options);
  });

program
  .command("suggest-goal-change")
  .description("leave one suggested change to the goals, with the evidence, for the person to accept or dismiss; ask them in chat first and use this only if they agree, or in an unattended run; only people change goals")
  .requiredOption("--kind <kind>", "add, reword, reorder or retire")
  .option("--goal <goal>", "reword, reorder, retire: the goal's number or id")
  .option("--statement <text>", "add, reword: the goal in one line")
  .option("--notes <text>", "add, reword: optional notes")
  .option("--position <n>", "add, reorder: where it goes, 1 for the top")
  .requiredOption("--reason <reason>", "why, with evidence the person can check")
  .option("--idempotency-key <key>", "reuse only to retry the same suggestion after a lost reply")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const result = await suggestGoalChange({
      cwd: cwdOption(options.cwd), reason: options.reason, agentName: process.env.PLANBAN_AGENT_NAME, idempotencyKey: options.idempotencyKey,
      change: { kind: options.kind, goal: options.goal, statement: options.statement, notes: options.notes, position: options.position },
    });
    print(options.output === "json" ? result : result.notAdded ?? `Suggested to ${result.page.suggestions.at(-1)?.summary}. It waits at the top of the Goals page for the person to accept or dismiss.`, options);
  });

program
  .command("read-doc")
  .argument("<cardId>")
  .argument("<kind>")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, kind, options) => {
    if (kind !== "spec" && kind !== "plan") throw new Error("kind must be spec or plan");
    // With each section's own version, for write-doc-section.
    print(await readDocSections({ cwd: cwdOption(options.cwd), cardId, kind }), options);
  });

program
  .command("write-doc")
  .argument("<cardId>")
  .argument("<kind>")
  .option("--cwd <path>", "project directory")
  .option("--file <path>", "read markdown from a file instead of stdin")
  .option("--expected-mtime <mtimeMs|new>", "the document version this edit is based on: mtimeMs from read-doc, or new for a document that doesn't exist yet (required for Online Boards)")
  .option("--idempotency-key <key>", "online boards: a key for this edit (8 to 100 letters, digits, dashes or underscores); reuse it only to retry the same edit after a lost reply")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, kind, options) => {
    if (kind !== "spec" && kind !== "plan") throw new Error("kind must be spec or plan");
    let expectedMtimeMs: number | null | undefined;
    if (options.expectedMtime !== undefined) {
      const raw = String(options.expectedMtime).trim();
      expectedMtimeMs = raw === "new" ? null : Number(raw);
      if (expectedMtimeMs !== null && (!raw || !Number.isFinite(expectedMtimeMs))) throw new Error("--expected-mtime is the mtimeMs value from read-doc, or new");
    }
    const markdown = options.file ? readFileSync(options.file, "utf8") : await readStdin();
    print(await writeDoc({ cwd: cwdOption(options.cwd), cardId, kind, markdown, actor: "agent", ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}), ...(expectedMtimeMs === undefined ? {} : { expectedMtimeMs }) }), options);
  });

function describeMoveFilesOut(result: MoveFilesOutResult) {
  if (result.alreadyClean) return `Card ${result.cardId} holds no files in its folder. Nothing to move.`;
  const where = friendlyPath(result.destination);
  const lines = result.dryRun
    ? [`Dry run: nothing has changed. ${result.moves.length} file${result.moves.length === 1 ? "" : "s"} would move from card ${result.cardId} to ${where}:`]
    : [`Moved ${result.moves.length} file${result.moves.length === 1 ? "" : "s"} from card ${result.cardId} to ${where}, and added a Files section to its Spec. The card can be changed again.`];
  if (result.dryRun) {
    lines.push(...result.moves.map((move) => `  ${move.from} -> ${friendlyPath(move.to)}`));
    if (result.conflicts.length) {
      lines.push("", "These already exist there, and Planban never overwrites a file, so the move would be refused:", ...result.conflicts.map((path) => `  ${friendlyPath(path)}`));
    }
    lines.push("", "This section would be added to the end of the card's Spec:", "", result.specSection);
  }
  return lines.join("\n");
}

program
  .command("move-files-out")
  .description("move the files in a card's folder out of Planban, and refer to them from its Spec")
  .argument("<cardId>")
  .requiredOption("--to <folder>", "folder to move the files to, such as a folder in the project's repository")
  .option("--dry-run", "show what would move without changing anything")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (cardId, options) => {
    const result = await moveFilesOut({
      cwd: cwdOption(options.cwd),
      cardId,
      to: resolve(expandHome(options.to)),
      dryRun: options.dryRun === true,
    });
    print(options.output === "json" ? result : describeMoveFilesOut(result), options);
  });

program
  .command("export-flat-v1")
  .requiredOption("--export-id <id>", "stable name for the recoverable export")
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    print(await exportFlatVersion1({ cwd: cwdOption(options.cwd), exportId: options.exportId, actor: "agent" }), options);
  });

program
  .command("reconstruct-hierarchy")
  .requiredOption("--file <path>", "JSON file containing { groups: [{ id, childIds }] }")
  .requiredOption("--base-revision <revision>", "roadmap revision for stale-write protection (required for Online Boards)", parseRevisionOption)
  .option("--cwd <path>", "project directory")
  .option("-o, --output <format>", "output format")
  .action(async (options) => {
    const payload = JSON.parse(readFileSync(resolve(options.file), "utf8")) as {
      groups?: Array<{ id: string; childIds: string[] }>;
      programmes?: Array<{ id: string; childIds: string[] }>;
    };
    print(await reconstructHierarchy({
      cwd: cwdOption(options.cwd), groups: payload.groups ?? payload.programmes ?? [], baseRevision: options.baseRevision, actor: "agent",
    }), options);
  });

// Every command takes -o json, the online ones included (their results are JSON already).
const everyCommand = (command: Command): Command[] => [command, ...command.commands.flatMap(everyCommand)];
for (const command of everyCommand(online)) {
  if (!command.options.some((option) => option.long === "--output")) command.option("-o, --output <format>", "output format");
}

/** Whether this run asked for JSON output, however the option was written. */
function wantsJson(argv: string[]) {
  return argv.some((arg, index) => arg === "--output=json" || arg === "-ojson" || ((arg === "-o" || arg === "--output") && argv[index + 1] === "json"));
}

// Argument mistakes (a missing argument, an unknown option) reach the handler
// below instead of exiting at once, so a JSON caller gets them as JSON too.
for (const command of everyCommand(program)) command.exitOverride();

program.parseAsync().catch((error: unknown) => {
  if (error instanceof CommanderError) {
    // Help and --version end here too, successfully. Commander has already printed its message.
    if (error.exitCode === 0) return;
    if (wantsJson(process.argv)) process.stdout.write(JSON.stringify({ error: { category: "validation", message: error.message.replace(/^error: /u, "") } }, null, 2) + "\n");
    process.exitCode = error.exitCode;
    return;
  }
  // A JSON caller gets the failure as JSON too: its kind, message and details (agent-surface audit).
  if (wantsJson(process.argv)) process.stdout.write(JSON.stringify({ error: errorReport(error) }, null, 2) + "\n");
  process.stderr.write(`${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 1;
});
