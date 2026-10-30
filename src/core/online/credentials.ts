import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defaultPlanbanRoot } from "../paths";
import { withBoardWriteLock } from "../persistence";
import { PlanbanValidationError } from "../boardOperations";

export interface OnlineCredentials {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  person?: string | undefined;
  /** The signed-in account's email, as the service last said (for showing who is signed in). */
  email?: string | undefined;
  /** When this computer saved the sign-in: of two for one account, the later is kept. */
  savedAt?: string | undefined;
}

/**
 * Several accounts per service on one computer, like the GitHub CLI (owner
 * decision, 15 October 2026): each keyed by the account's id at the service,
 * one of them the default for new boards. Each online board uses the account
 * its link on this computer names (boardLinks.ts), never another.
 */
export interface ServiceAccounts {
  default: string;
  accounts: Record<string, OnlineCredentials>;
}

interface StoredFile {
  version: 2;
  services: Record<string, ServiceAccounts>;
}

/** Version 1 kept one sign-in per service; it reads as that one account, the default. */
interface StoredFileV1 {
  version: 1;
  services: Record<string, OnlineCredentials>;
}

/**
 * What callers read: `services` is each service's default account (as before
 * several accounts existed), and `accounts` everything signed in.
 */
interface CredentialsFile {
  version: 2;
  services: Record<string, OnlineCredentials>;
  accounts: Record<string, ServiceAccounts>;
}

const accountKey = (credentials: OnlineCredentials) => credentials.person ?? `pending-${randomUUID()}`;

export function serviceUrl(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new PlanbanValidationError("Online Board URL must be an HTTPS origin (HTTP is allowed for loopback development).");
  }
  return url.origin;
}

export function credentialsRoot() {
  return join(defaultPlanbanRoot(), "online");
}

export function credentialsPath() {
  return join(credentialsRoot(), "credentials.json");
}

export function withCredentialsLock<T>(run: () => Promise<T>): Promise<T> {
  return withBoardWriteLock(credentialsRoot(), run);
}

async function readStored(): Promise<StoredFile> {
  try {
    const file = JSON.parse(await readFile(join(credentialsRoot(), "credentials.json"), "utf8")) as StoredFile | StoredFileV1;
    if (!file.services || typeof file.services !== "object") throw new Error("Invalid Online Board credentials file.");
    if (file.version === 2) return file;
    if (file.version !== 1) throw new Error("Invalid Online Board credentials file.");
    // Migrates on read; written as version 2 by the next save.
    const services: Record<string, ServiceAccounts> = {};
    for (const [url, credentials] of Object.entries(file.services)) {
      const key = credentials.person ?? "signed-in";
      services[url] = { default: key, accounts: { [key]: credentials } };
    }
    return { version: 2, services };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, services: {} };
    throw error;
  }
}

export async function readCredentials(): Promise<CredentialsFile> {
  const stored = await readStored();
  const services: Record<string, OnlineCredentials> = {};
  for (const [url, entry] of Object.entries(stored.services)) {
    const chosen = entry.accounts[entry.default] ?? Object.values(entry.accounts)[0];
    if (chosen) services[url] = chosen;
  }
  return { version: 2, services, accounts: stored.services };
}

/** One account's sign-in on a service, by the account's service id. */
export async function accountCredentials(url: string, person: string): Promise<OnlineCredentials | null> {
  return (await readStored()).services[serviceUrl(url)]?.accounts[person] ?? null;
}

async function changeStored(change: (file: StoredFile) => void | boolean) {
  return withCredentialsLock(async () => {
    const file = await readStored();
    const changed = change(file);
    if (changed !== false) await writeCredentialsFile(file);
    return changed !== false;
  });
}

/**
 * Saves a sign-in: as the account it is (replacing that account's older
 * sign-in), alongside any other accounts, and makes it the default for new
 * boards. With null, removes the default account (another becomes default).
 */
export async function saveCredentials(url: string, credentials: OnlineCredentials | null) {
  const key = serviceUrl(url);
  await changeStored((file) => {
    const entry = file.services[key] ?? { default: "", accounts: {} };
    if (credentials) {
      // The same sign-in saved again (a key signed in twice) stays one entry, under the id it already has.
      const same = Object.entries(entry.accounts).find(([, saved]) => saved.accessToken === credentials.accessToken);
      const id = credentials.person ?? same?.[0] ?? accountKey(credentials);
      for (const [other, saved] of Object.entries(entry.accounts)) if (other !== id && saved.accessToken === credentials.accessToken) delete entry.accounts[other];
      entry.accounts[id] = { ...(same?.[1] ?? {}), ...credentials, savedAt: new Date().toISOString() };
      entry.default = id;
      file.services[key] = entry;
    } else {
      delete entry.accounts[entry.default];
      const rest = Object.keys(entry.accounts);
      if (rest.length) file.services[key] = { default: rest[0]!, accounts: entry.accounts };
      else delete file.services[key];
    }
  });
}

/**
 * Removes one account's sign-in from this computer; the default moves to
 * another if it was this one. Given the sign-in being signed out, it removes
 * only that one: a newer sign-in of the same account meanwhile stays.
 */
export async function removeAccount(url: string, person: string, accessToken?: string) {
  const key = serviceUrl(url);
  let removed: OnlineCredentials | null = null;
  await changeStored((file) => {
    const entry = file.services[key];
    // By the sign-in itself when given, wherever it is filed now (an old one may have moved under its real id meanwhile).
    if (accessToken !== undefined) person = Object.entries(entry?.accounts ?? {}).find(([, saved]) => saved.accessToken === accessToken)?.[0] ?? "";
    if (!entry?.accounts[person]) return false;
    removed = entry.accounts[person]!;
    delete entry.accounts[person];
    const rest = Object.keys(entry.accounts);
    if (!rest.length) delete file.services[key];
    else if (entry.default === person) entry.default = rest[0]!;
  });
  return removed as OnlineCredentials | null;
}

/** Makes an account the default for boards taken online or attached from now on; boards already linked keep theirs. */
export async function setDefaultAccount(url: string, person: string) {
  const key = serviceUrl(url);
  return changeStored((file) => {
    const entry = file.services[key];
    if (!entry?.accounts[person]) return false;
    entry.default = person;
  });
}

/**
 * Adds facts about a sign-in (who it is) only if that same sign-in is still
 * saved: a slow answer about an earlier sign-in never lands on a newer one.
 * A sign-in saved before its account was known moves under that account.
 */
export async function updateSignedIn(url: string, accessToken: string, facts: Pick<OnlineCredentials, "person" | "email">) {
  const key = serviceUrl(url);
  // Every id the sign-in was filed under until now (none if it is no longer saved), so its boards can follow it.
  let filedAs: string[] = [];
  await changeStored((file) => {
    const entry = file.services[key];
    const found = entry && Object.entries(entry.accounts).find(([, credentials]) => credentials.accessToken === accessToken);
    if (!entry || !found) return false;
    const [id, current] = found;
    const updated = { ...current, ...Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)) } as OnlineCredentials;
    const newId = updated.person ?? id;
    // Every entry holding this same sign-in becomes the one.
    const merged = Object.entries(entry.accounts).filter(([, saved]) => saved.accessToken === accessToken).map(([other]) => other);
    for (const other of merged) delete entry.accounts[other];
    filedAs = merged;
    // Of two sign-ins for one account, the one saved later is kept (one with no time saved is the older).
    const other = entry.accounts[newId];
    if (!other || (other.savedAt ?? "") <= (updated.savedAt ?? "")) entry.accounts[newId] = updated;
    if (merged.includes(entry.default)) entry.default = newId;
  });
  return filedAs;
}

async function writeCredentialsFile(file: StoredFile) {
  const root = credentialsRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = join(root, `.credentials-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, join(root, "credentials.json"));
  } finally {
    await rm(temp, { force: true });
  }
}

/** Every account signed in here, per service, with the default marked: emails, never tokens. */
export async function onlineStatus() {
  const { accounts } = await readCredentials();
  return Object.entries(accounts).map(([url, entry]) => {
    const fallback = entry.accounts[entry.default] ?? Object.values(entry.accounts)[0];
    return {
      // The email a person recognises, not the service's id for them (owner request, 15 October 2026).
      url, signedInAs: fallback?.email ?? null, expiresAt: fallback?.expiresAt ?? null,
      accounts: Object.entries(entry.accounts).map(([id, credentials]) => ({ email: credentials.email ?? null, default: id === entry.default })),
    };
  });
}

/** A signed-in account on a service, by its email or id; refuses, saying how to sign in, if it isn't signed in here. */
export async function chosenAccount(url: string, account: string): Promise<OnlineCredentials> {
  return (await chosenAccountEntry(url, account)).credentials;
}

/** As chosenAccount, with the id the sign-in is filed under here (which an old sign-in may lack in its own record). */
export async function chosenAccountEntry(url: string, account: string): Promise<{ id: string; credentials: OnlineCredentials }> {
  const entry = (await readStored()).services[serviceUrl(url)];
  const wanted = account.trim().toLowerCase();
  const found = Object.entries(entry?.accounts ?? {}).find(([id, credentials]) => id === account || credentials.email?.toLowerCase() === wanted);
  if (!found) throw new PlanbanValidationError(`${account} isn't signed in to ${serviceUrl(url)} on this computer. Sign in as it first: planban online sign-in ${serviceUrl(url)}`);
  return { id: found[0], credentials: found[1] };
}

/** The sign-in of the account with this service id, if it is signed in here. */
export async function signedInAs(url: string, person: string | undefined) {
  return person ? accountCredentials(url, person) : null;
}
