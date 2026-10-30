// Signing out, the connection list and personal access keys, from this machine.
import { PlanbanValidationError } from "../boardOperations";
import { boardCredentials, onlineRequest } from "./client";
import { chosenAccount, readCredentials, removeAccount, serviceUrl } from "./credentials";
import { planbanCommand } from "../command";

/**
 * Signing out revokes this machine's connection on the service (owner
 * decision 7), then forgets it here. If the service cannot be reached, the
 * local sign-in is still removed and the result says the hosted connection
 * remains until it is revoked from another signed-in machine.
 */
export async function onlineLogout(urlInput: string, options: { account?: string | undefined } = {}) {
  const url = serviceUrl(urlInput);
  const entry = (await readCredentials()).accounts[url];
  if (!entry) return { url, signedOut: true, revoked: false, note: "This machine was not signed in." };
  // Several accounts can be signed in: signing out is of one, named when there is more than one.
  const signedIn = Object.entries(entry.accounts);
  if (!options.account && signedIn.length > 1) {
    throw new PlanbanValidationError(`Several accounts are signed in to ${url} here (${signedIn.map(([, credentials]) => credentials.email ?? "an account").join(", ")}). Say which to sign out: --account <email>.`);
  }
  const credentials = options.account ? await chosenAccount(url, options.account) : signedIn[0]![1];
  const person = signedIn.find(([, candidate]) => candidate.accessToken === credentials.accessToken)![0];
  let revoked = false;
  let note: string | undefined;
  try {
    await onlineRequest(url, "/api/v1/connections/self/revoke", {}, { signal: AbortSignal.timeout(10_000), credentials });
    revoked = true;
  } catch (error) {
    note = `The service could not be reached (${error instanceof Error ? error.message : String(error)}). This machine's connection stays active until you revoke it with ${planbanCommand()} online revoke from another signed-in machine.`;
  }
  // Only the sign-in that was revoked: if the account signed in again meanwhile, that newer one stays.
  const removed = await removeAccount(url, person, credentials.accessToken);
  if (!removed && !note) note = `${credentials.email ?? "This account"} signed in again here while signing out, so the newer sign-in stays.`;
  // Its boards stay linked to it, and say so if opened here, until it signs in again.
  return { url, signedOut: true, account: credentials.email ?? null, revoked, ...(note ? { note } : {}) };
}

export async function listConnections(urlInput: string) {
  return onlineRequest<{ connections: unknown[] }>(serviceUrl(urlInput), "/api/v1/connections");
}

export async function revokeConnection(urlInput: string, connectionId: string) {
  if (!connectionId.trim()) throw new PlanbanValidationError("Name the connection to revoke.");
  return onlineRequest(serviceUrl(urlInput), `/api/v1/connections/${encodeURIComponent(connectionId)}/revoke`, {});
}

/** Creates a personal access key. The key is in the result once and is never shown again. */
export async function createKey(urlInput: string, input: { boardId: string; level: "read" | "plan" | "complete"; name: string; expiresInDays?: number | undefined }) {
  // A key for a board is made by the board's own account.
  const credentials = await boardCredentials(urlInput, input.boardId);
  return onlineRequest<{ id: string; key: string; name: string; boardId: string; level: string; expiresAt?: string }>(serviceUrl(urlInput), "/api/v1/keys", input, { credentials });
}
