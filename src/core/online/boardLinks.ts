// Which Planban account each online board uses on this computer (owner
// decision, 15 October 2026): several accounts can be signed in at once, and
// each board's link names one. Every request for that board uses that
// account's sign-in, never another's. Kept on this computer only (mode 600),
// never in a project's files and never sent anywhere.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PlanbanValidationError } from "../boardOperations";
import { credentialsRoot, serviceUrl, withCredentialsLock } from "./credentials";

export interface BoardLink {
  /** The account's id at the service. */
  person: string;
  email?: string | undefined;
  name?: string | undefined;
}

interface BoardLinksFile {
  version: 1;
  /** Keyed "<service>|<board id>". */
  boards: Record<string, BoardLink & { at: string }>;
}

const boardLinksPath = () => join(credentialsRoot(), "board-accounts.json");

/**
 * A missing file means no board is linked yet. A damaged one is refused
 * rather than read as empty: an empty list would let a board open as
 * whichever account is the default.
 */
async function readBoardLinks(): Promise<BoardLinksFile> {
  let text: string;
  try {
    text = await readFile(boardLinksPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, boards: {} };
    throw error;
  }
  let file: BoardLinksFile | null = null;
  try {
    file = JSON.parse(text) as BoardLinksFile;
  } catch {
    // Damaged: refused below.
  }
  const valid = file?.version === 1 && !!file.boards && typeof file.boards === "object" && !Array.isArray(file.boards)
    && Object.values(file.boards).every((link) => !!link && typeof link === "object" && typeof link.person === "string" && link.person.length > 0);
  if (!valid) {
    throw new PlanbanValidationError(`The list of which Planban account each online board uses on this computer is damaged (${boardLinksPath()}). `
      + "Move it aside, then open each board once, signed in as its account, and Planban links it again.");
  }
  return file!;
}

/** Links a board to the account that took it online, attached it, or first opened it. */
export async function recordBoardAccount(url: string, boardId: string, account: BoardLink | null) {
  await withCredentialsLock(async () => {
    const file = await readBoardLinks();
    // null removes the link (an explicit choice that turned out not to open the board).
    if (account) file.boards[`${serviceUrl(url)}|${boardId}`] = { ...account, at: new Date().toISOString() };
    else delete file.boards[`${serviceUrl(url)}|${boardId}`];
    const root = credentialsRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temp = join(root, `.board-accounts-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600);
      await rename(temp, boardLinksPath());
    } finally {
      await rm(temp, { force: true });
    }
  });
}

export async function boardAccount(url: string, boardId: string): Promise<BoardLink | null> {
  return (await readBoardLinks()).boards[`${serviceUrl(url)}|${boardId}`] ?? null;
}

/** Every board linked on this computer, for listing which boards use each account. */
export async function boardLinks(): Promise<Array<{ url: string; boardId: string } & BoardLink>> {
  return Object.entries((await readBoardLinks()).boards).map(([key, link]) => {
    const at = key.indexOf("|");
    return { url: key.slice(0, at), boardId: key.slice(at + 1), person: link.person, ...(link.email ? { email: link.email } : {}) };
  });
}

/** Boards linked to a sign-in saved before its account id was known now name that id. */
export async function relinkBoards(url: string, from: string, to: string) {
  if (from === to) return;
  await withCredentialsLock(async () => {
    const file = await readBoardLinks();
    let changed = false;
    for (const [key, link] of Object.entries(file.boards)) {
      if (key.startsWith(`${serviceUrl(url)}|`) && link.person === from) {
        file.boards[key] = { ...link, person: to };
        changed = true;
      }
    }
    if (!changed) return;
    const root = credentialsRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temp = join(root, `.board-accounts-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600);
      await rename(temp, boardLinksPath());
    } finally {
      await rm(temp, { force: true });
    }
  });
}
