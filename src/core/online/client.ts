import { PlanbanConflictError, PlanbanNotFoundError, PlanbanValidationError } from "../boardOperations";
import { accountCredentials, readCredentials, serviceUrl, type OnlineCredentials } from "./credentials";
import { boardAccount } from "./boardLinks";
import { planbanCommand } from "../command";
import { PlanbanEditConflictError, type ConflictDetails } from "../conflicts";
import { PLANBAN_VERSION_HEADER, UPDATE_REQUIRED_MESSAGE, UPDATE_REQUIRED_STATUS } from "../clientVersion";
import { PLANBAN_VERSION } from "../version";

export class OnlineAuthenticationError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 401,
    /** For a missing or ended sign-in: the service to sign in to, and which of the two it was. */
    public readonly signIn?: { url: string; reason: "missing" | "expired"; account?: string | null },
  ) {
    super(message);
    this.name = "OnlineAuthenticationError";
  }
}

/** The service needs a newer Planban for this (16 October 2026). Its message is plain and points at Update. */
export class PlanbanUpdateRequiredError extends Error {
  readonly statusCode = UPDATE_REQUIRED_STATUS;
  constructor(message = UPDATE_REQUIRED_MESSAGE) {
    super(message);
    this.name = "PlanbanUpdateRequiredError";
  }
}

/** The service refused this connection the action (a viewer, an agent's level, or an owner-only step). Its message says which, and what to do. */
export class PlanbanForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = "PlanbanForbiddenError";
  }
}

function loginRequired(url: string, reason: "missing" | "expired", account?: string | null) {
  if (account !== undefined) {
    const who = account ?? "the Planban account it was linked to";
    const state = reason === "expired" ? "whose sign-in on this computer has ended" : "which isn't signed in on this computer";
    return new OnlineAuthenticationError(`This board uses ${who}, ${state}. Sign in as ${who}: ${planbanCommand()} online sign-in ${url}`, 401, { url, reason, account: account ?? null });
  }
  return new OnlineAuthenticationError(`Online Board sign-in expired or is missing. Run ${planbanCommand()} online sign-in ${url}.`, 401, { url, reason });
}

/**
 * The sign-in for a board's own account, for /api/v1/boards/<id>/… requests.
 * A board linked to an account that isn't signed in here is refused, naming
 * that account; it never falls back to another account's sign-in.
 */
async function linkedAccount(url: string, path: string, post = false): Promise<{ credentials: OnlineCredentials; email: string | null } | null> {
  const match = /^\/api\/v1\/boards\/([^/?]+)/u.exec(path);
  // POST /api/v1/boards/import makes a new board; any other path naming "import" is a board of that name.
  if (!match || (post && path === "/api/v1/boards/import")) return null;
  const link = await boardAccount(url, decodeURIComponent(match[1]!));
  if (!link) return null;
  const credentials = await accountCredentials(url, link.person);
  if (!credentials) throw loginRequired(url, "missing", link.email ?? null);
  return { credentials, email: credentials.email ?? link.email ?? null };
}

/**
 * The sign-in a board's requests use, for requests about the board that
 * aren't under its own path (who am I, live updates, keys): its own
 * account's, or the default's while it has no link here.
 */
export async function boardCredentials(url: string, boardId: string): Promise<OnlineCredentials> {
  return (await linkedAccount(serviceUrl(url), `/api/v1/boards/${encodeURIComponent(boardId)}`))?.credentials ?? requireCredentials(url);
}

export async function requireCredentials(url: string): Promise<OnlineCredentials> {
  const credentials = (await readCredentials()).services[serviceUrl(url)];
  if (!credentials) throw loginRequired(url, "missing");
  return credentials;
}

export interface OnlineRequestOptions {
  signal?: AbortSignal;
  /**
   * Sent as Idempotency-Key. A request that fails on the network is retried
   * once with the same key and body, so the service applies it at most once.
   */
  idempotencyKey?: string;
  /** Overall time limit for one attempt; 30 seconds unless set. */
  timeoutMs?: number;
  /**
   * Use exactly these credentials rather than whatever is saved now, so that
   * several requests are sure to act as one account even if someone signs in
   * as another meanwhile.
   */
  credentials?: OnlineCredentials;
}

export async function onlineRequest<T>(urlInput: string, path: string, body?: unknown, options: OnlineRequestOptions = {}): Promise<T> {
  return (await authorizedResponse(urlInput, path, body, options)).json() as Promise<T>;
}

/** Raw bytes sent with PUT (one part of an attachment upload). Safe to repeat. */
class RawBody {
  constructor(readonly bytes: Uint8Array) {}
}

export async function putBytes<T>(urlInput: string, path: string, bytes: Uint8Array): Promise<T> {
  return (await authorizedResponse(urlInput, path, new RawBody(bytes), { timeoutMs: 5 * 60_000 })).json() as Promise<T>;
}

/** A GET whose answer is a file. */
export async function requestBytes(urlInput: string, path: string): Promise<Uint8Array> {
  const response = await authorizedResponse(urlInput, path, undefined, { timeoutMs: 10 * 60_000 });
  return new Uint8Array(await response.arrayBuffer());
}

async function authorizedResponse(urlInput: string, path: string, body: unknown, options: OnlineRequestOptions): Promise<Response> {
  const url = serviceUrl(urlInput);
  // Machine sign-ins, keys and development sign-ins do not expire by time or
  // refresh; when the service stops accepting one, the person signs in again.
  // A board's requests use the account its link on this computer names, never another (several can be signed in).
  const linked = options.credentials ? null : await linkedAccount(url, path, body !== undefined);
  const credentials = options.credentials ?? linked?.credentials ?? await requireCredentials(url);
  const raw = body instanceof RawBody;
  const payload = body === undefined ? undefined : raw ? new Blob([body.bytes as Uint8Array<ArrayBuffer>]) : JSON.stringify(body);
  const send = () => fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : raw ? "PUT" : "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`, "Content-Type": raw ? "application/octet-stream" : "application/json",
      [PLANBAN_VERSION_HEADER]: PLANBAN_VERSION,
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    ...(payload === undefined ? {} : { body: payload }),
    redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]) : AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  // Reads and keyed writes are safe to repeat after a network failure.
  const retryable = body === undefined || raw || !!options.idempotencyKey;
  const request = async () => {
    try {
      return await send();
    } catch (error) {
      if (!retryable || options.signal?.aborted) throw error;
      // The pause before the retry ends early if the caller's time is up.
      await new Promise<void>((resolve) => {
        const stop = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { options.signal?.removeEventListener("abort", stop); resolve(); }, 500);
        options.signal?.addEventListener("abort", stop, { once: true });
      });
      if (options.signal?.aborted) throw error;
      return send();
    }
  };
  const response = await request();
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message = payload.error?.message ?? `Online Board request failed (${response.status}).`;
    if (response.status === 409) {
      // A refused edit carries what changed, by whom, and the current card or document.
      if (payload.error?.conflict) throw new PlanbanEditConflictError(message, payload.error.conflict as ConflictDetails);
      const error = new PlanbanConflictError(message);
      Object.assign(error, { currentRevision: payload.currentRevision ?? payload.error?.currentRevision });
      throw error;
    }
    if (response.status === 400) throw new PlanbanValidationError(message);
    if (response.status === 404) throw new PlanbanNotFoundError(message);
    if (response.status === 401) throw loginRequired(url, "expired", linked?.email);
    if (response.status === 403) throw new PlanbanForbiddenError(message);
    if (response.status === UPDATE_REQUIRED_STATUS) throw new PlanbanUpdateRequiredError(payload.error?.message);
    // A daily limit (owner decision 18): kept as 429 so the board page and agents see a limit, not a failure.
    if (response.status === 429) throw Object.assign(new Error(message), { name: "OnlineLimitError", statusCode: 429 });
    throw new Error(message);
  }
  return response;
}

export function boardPath(boardId: string, suffix = "") {
  return `/api/v1/boards/${encodeURIComponent(boardId)}${suffix}`;
}
