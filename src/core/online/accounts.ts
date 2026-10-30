// Which Planban account this computer is signed in as, for each service, and
// which account each of its online boards belongs to (owner request, 15
// October 2026). One account per service address is signed in at a time, so
// a board taken online under another account can't open until that account
// signs in again; with these facts the app can say so plainly. Everything
// here is kept on this computer (mode 600), never in a project's files.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PlanbanConflictError } from "../boardOperations";
import { OnlineAuthenticationError, onlineRequest, requireCredentials } from "./client";
import { accountCredentials, chosenAccount, chosenAccountEntry, readCredentials, serviceUrl, setDefaultAccount, updateSignedIn, type OnlineCredentials } from "./credentials";
import { boardLinks, relinkBoards } from "./boardLinks";

export interface OnlineAccount {
  /** The account's id at the service. */
  person: string;
  email?: string | undefined;
  name?: string | undefined;
}

interface Me {
  userId: string;
  person?: { name?: string; email?: string };
}

/** The account signed in to `url` on this computer, as last recorded (no network). */
export async function signedInAccount(url: string): Promise<OnlineAccount | null> {
  const credentials = (await readCredentials()).services[serviceUrl(url)];
  if (!credentials?.person) return null;
  return { person: credentials.person, ...(credentials.email ? { email: credentials.email } : {}) };
}

/**
 * After signing in: asks the service who this is and keeps the email beside
 * the sign-in. The profile is filled in just after sign-in, so the email may
 * take a moment to appear. Every request uses the sign-in as it was when this
 * started, and the answer is kept only if that sign-in is still the saved one.
 */
export async function rememberIdentity(url: string, attempts = 4): Promise<Me & { account: OnlineAccount }> {
  const credentials = await requireCredentials(url);
  const ask = () => onlineRequest<Me>(url, "/api/v1/me", undefined, { credentials });
  let me = await ask();
  for (let attempt = 1; attempt < attempts && !me.person?.email; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    me = await ask();
  }
  await fileUnder(url, credentials, me);
  return { ...me, account: { person: me.userId, ...(me.person?.email ? { email: me.person.email } : {}), ...(me.person?.name ? { name: me.person.name } : {}) } };
}

/** Files a sign-in under the account the service says it is; boards linked to its earlier id follow it. */
async function fileUnder(url: string, credentials: OnlineCredentials, me: Me) {
  const filedAs = await updateSignedIn(url, credentials.accessToken, { person: me.userId, ...(me.person?.email ? { email: me.person.email } : {}) });
  // An old sign-in may have had no id of its own until now, or been saved twice.
  for (const id of filedAs) if (id !== me.userId) await relinkBoards(url, id, me.userId).catch(() => undefined);
}

/**
 * A sign-in pinned for an operation, with its account id: one saved by an
 * older Planban without its id asks the service first, so the board can be
 * linked to the account it really is.
 */
export async function withIdentity(url: string, credentials: OnlineCredentials): Promise<OnlineCredentials> {
  if (credentials.person) return credentials;
  const me = await onlineRequest<Me>(url, "/api/v1/me", undefined, { credentials });
  await fileUnder(url, credentials, me);
  return { ...credentials, person: me.userId, ...(me.person?.email ? { email: me.person.email } : credentials.email ? { email: credentials.email } : {}) };
}

/**
 * The account signed in to `url` here, or null when nothing is signed in or
 * the service says that sign-in has ended (so nothing is lost by signing in
 * again). When the service can't be asked, the saved sign-in still counts:
 * a passing failure must not let a new sign-in replace it unannounced.
 */
export async function liveAccount(url: string): Promise<OnlineAccount | null> {
  const stored = (await readCredentials()).services[serviceUrl(url)];
  if (!stored) return null;
  const saved: OnlineAccount = { person: stored.person ?? "unknown", ...(stored.email ? { email: stored.email } : {}) };
  try {
    const me = await onlineRequest<Me>(url, "/api/v1/me", undefined, { credentials: stored });
    return { person: me.userId, ...(me.person?.email ?? stored.email ? { email: me.person?.email ?? stored.email } : {}) };
  } catch (error) {
    if (error instanceof OnlineAuthenticationError) return null;
    return saved;
  }
}

/** Signing in while another account is signed in adds one: the page asks first, saying so. */
export class AccountInUseError extends PlanbanConflictError {
  constructor(readonly url: string, readonly account: OnlineAccount, howToContinue?: string) {
    const who = account.email ?? account.name ?? "another account";
    super(`This computer is signed in as ${who}. Signing in another account adds it: ${who} stays signed in, and boards that use ${who} keep using it. Boards you take online or attach from now on use the new account.${howToContinue ? ` ${howToContinue}` : ""}`);
    this.name = "AccountInUseError";
  }
}

// --- which account each online board uses: boardLinks.ts ---------------------
export { boardAccount, recordBoardAccount } from "./boardLinks";
import { boardAccount, recordBoardAccount } from "./boardLinks";

/**
 * Notes the board under the account that used it: the sign-in `pinned` at the
 * start of the operation (see withIdentity). It is that account's board even
 * if the account signed in again or out meanwhile; signed out, the board says
 * so rather than opening as another account.
 */
export async function recordBoardAccountAs(url: string, boardId: string, pinned: OnlineCredentials) {
  if (!pinned.person) throw new Error("A board's account is linked only once its id is known.");
  const email = (await accountCredentials(url, pinned.person))?.email ?? pinned.email;
  await recordBoardAccount(url, boardId, { person: pinned.person, ...(email ? { email } : {}) });
}



/** Turns "not found" into "another account's board" when this computer's own records say so. */
/**
 * A board with no link on this computer that the default account can't
 * open: another signed-in account may be the one (a board attached before
 * several accounts existed). The first that opens it is linked to it, so
 * later requests go straight to it; otherwise the "not found" stands.
 */
export async function findBoardAccount<T>(url: string, boardId: string, path: string, error: unknown): Promise<T> {
  if (await boardAccount(url, boardId)) throw error;
  const entry = (await readCredentials()).accounts[serviceUrl(url)];
  for (const [person, credentials] of Object.entries(entry?.accounts ?? {})) {
    if (person === entry!.default) continue;
    try {
      const found = await onlineRequest<T>(url, path, undefined, { credentials });
      // Linked to the account it really is: an old sign-in learns its id first.
      await recordBoardAccountAs(url, boardId, await withIdentity(url, credentials));
      return found;
    } catch {
      // Not this account's board either.
    }
  }
  throw error;
}

/**
 * Every account signed in here, per service, with the default marked and the
 * boards that use each (from this computer's links; emails, never tokens).
 */
export async function listAccounts() {
  const { accounts } = await readCredentials();
  const links = await boardLinks();
  const { listBoards } = await import("../registry");
  const { readManifest } = await import("../storage");
  // A linked board's name here, from the projects registered on this computer.
  const names = new Map<string, string>();
  for (const board of await listBoards().catch(() => [])) {
    const manifest = await readManifest(board.cwd).catch(() => null);
    if (manifest?.storage?.kind === "online") names.set(`${manifest.storage.url}|${manifest.storage.boardId}`, board.title);
  }
  return Object.entries(accounts).map(([url, entry]) => ({
    url,
    accounts: Object.entries(entry.accounts).map(([person, credentials]) => ({
      email: credentials.email ?? null,
      default: person === entry.default,
      boards: links.filter((link) => link.url === url && link.person === person).map((link) => ({ boardId: link.boardId, title: names.get(`${url}|${link.boardId}`) ?? null })),
    })),
  }));
}

/** Makes a signed-in account the default for boards taken online or attached from now on. */
export async function switchAccount(url: string, account: string) {
  const { id, credentials } = await chosenAccountEntry(url, account);
  if (!await setDefaultAccount(url, id)) throw new PlanbanConflictError(`${account} was signed out meanwhile. Sign in as it again: planban online sign-in ${serviceUrl(url)}`);
  return { url: serviceUrl(url), default: credentials.email ?? null, note: "Boards already linked keep their own account; this changes only which account new boards use." };
}
