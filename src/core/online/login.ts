import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultPlanbanRoot } from "../paths";
import { spawn } from "node:child_process";
import { urlOpener } from "../openUrl";
import { serviceUrl, saveCredentials } from "./credentials";
import { onlineRequest } from "./client";
import { rememberIdentity } from "./accounts";
import { readCredentials } from "./credentials";
import { PlanbanValidationError } from "../boardOperations";
import { PLANBAN_VERSION_HEADER } from "../clientVersion";
import { PLANBAN_VERSION } from "../version";

// Sign-in requests name this Planban's version too, like every other request (16 October 2026).
const fetch: typeof globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set(PLANBAN_VERSION_HEADER, PLANBAN_VERSION);
  return globalThis.fetch(input, { ...init, headers });
};

export interface LoginOptions {
  /** Development sign-in only: a connection limited to one board. */
  access?: "all" | "board" | undefined;
  boards?: string | undefined;
  openBrowser?: ((url: string) => Promise<void>) | undefined;
  /** Development sign-in, offered only by a local Online Board backend. */
  devUser?: string | undefined;
  /** Sign in with a personal access key held in this environment variable. */
  keyEnv?: string | undefined;
  /**
   * One-tap approval: show a link (and the code to compare) that a signed-in
   * person approves on any device. The link opens in this computer's browser
   * unless printOnly is set.
   */
  device?: boolean | undefined;
  printOnly?: boolean | undefined;
  /**
   * Sign in even though another account is signed in to this service on this
   * computer: that account is signed out here (owner request, 15 October 2026).
   */
  switchAccount?: boolean | undefined;
  /** Tests only: how long to wait between checks, instead of the service's interval (at least 5 seconds). */
  pollIntervalMs?: number | undefined;
}

async function keyLogin(url: string, variable: string) {
  const key = process.env[variable];
  if (!key) throw new PlanbanValidationError(`Environment variable ${variable} is empty.`);
  if (!/^pbk_[A-Za-z0-9_-]{20,}$/.test(key)) throw new PlanbanValidationError(`Environment variable ${variable} does not hold a Planban personal access key.`);
  // Keys do not refresh; they last until revoked or until their expiry.
  await saveCredentials(url, { clientId: "key", accessToken: key, refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z" });
  return { url, signedIn: true, identity: await rememberIdentity(url) };
}

/**
 * A machine that has just signed in checks every local board it holds, so a
 * copy of a board that went online while this machine was signed out is
 * caught now rather than at its next edit.
 */
async function staleCopiesAfterSignIn() {
  const { listBoards } = await import("../registry");
  const { readManifest, resolvePlanningRoot } = await import("../storage");
  const boards = new Map<string, { planningRoot: string; repoId: string }>();
  for (const board of await listBoards()) {
    const manifest = await readManifest(board.cwd).catch(() => null);
    if (manifest?.enabled && manifest.storage?.kind !== "online") boards.set(resolvePlanningRoot(manifest), { planningRoot: resolvePlanningRoot(manifest), repoId: manifest.repoId });
  }
  // Board folders copied onto this machine may not be in its board list yet.
  const repos = join(defaultPlanbanRoot(), "repos");
  for (const name of await readdir(repos).catch(() => [] as string[])) {
    const planningRoot = join(repos, name);
    if (boards.has(planningRoot) || await stat(join(planningRoot, "ONLINE-BOARD.txt")).then(() => true, () => false)) continue;
    const roadmap = await readFile(join(planningRoot, "roadmap.json"), "utf8").then((text) => JSON.parse(text), () => null);
    if (roadmap?.project?.id) boards.set(planningRoot, { planningRoot, repoId: roadmap.project.id });
  }
  const { scanLocalCopies } = await import("./copyCheck");
  const found = await scanLocalCopies([...boards.values()]);
  return found.length ? { staleLocalCopies: found.map(({ repoId, stale }) => ({ repoId, onlineBoard: stale.boardId, url: stale.url, unsyncedChanges: stale.unsyncedChanges.length })) } : {};
}

async function devLogin(url: string, options: LoginOptions) {
  const response = await fetch(`${url}/dev/token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      userId: options.devUser, clientName: "Planban CLI",
      ...(options.access === "board" ? { boards: [options.boards] } : {}),
    }),
  });
  if (response.status !== 201) throw new PlanbanValidationError("This Online Board service does not offer development sign-in.");
  const { token } = await response.json() as { token: string };
  // Development tokens do not expire or refresh; signing out revokes them.
  await saveCredentials(url, { clientId: "dev", accessToken: token, refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z", person: options.devUser });
  return { url, signedIn: true, identity: await rememberIdentity(url), ...await staleCopiesAfterSignIn() };
}

async function openBrowser(url: string, signal: AbortSignal) {
  const { command, args } = urlOpener(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const abort = () => {
      // Release only the owned opening command, never the user's browser.
      child.kill("SIGKILL"); child.unref(); reject(signal.reason);
    };
    child.on("error", (error) => { signal.removeEventListener("abort", abort); reject(error); });
    child.on("exit", (code) => { signal.removeEventListener("abort", abort); code === 0 ? resolve() : reject(new Error("Could not open the Planban sign-in page.")); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("Missing sign-in response.");
  let text = "", size = 0; const decoder = new TextDecoder("utf-8", { fatal: true });
  try { while (true) { const { done, value } = await reader.read(); if(done) break; size += value.byteLength; if(size > 8192) throw new Error("Sign-in response is too large."); text += decoder.decode(value, { stream: true }); } text += decoder.decode(); return JSON.parse(text); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

interface SignInConfig {
  issuer: string;
  cliClientId: string;
  redirectPorts: number[];
  scope: string;
}

function httpsOrLoopback(value: string, what: string) {
  const parsed = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new Error(`${what} must use HTTPS.`);
  return parsed;
}

/** Where to sign in: the service names its sign-in server, whose metadata gives the endpoints. */
async function signInEndpoints(url: string) {
  const discovery = await fetch(`${url}/.well-known/planban.json`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!discovery.ok) throw new Error("This Online Board service did not say how to sign in.");
  const config = (await discovery.json() as { signIn?: SignInConfig }).signIn;
  if (!config?.issuer || !config.cliClientId || !config.redirectPorts?.length) {
    throw new PlanbanValidationError("This Online Board service has no browser sign-in yet. On a local development backend use --dev-user.");
  }
  const issuer = httpsOrLoopback(config.issuer, "The sign-in server").origin;
  if (issuer !== url || config.cliClientId !== "planban-cli" || config.scope !== "planban:machine") throw new Error("This service must use explicit Planban machine authorization. Update it before signing in.");
  const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("The sign-in server's details could not be loaded.");
  const metadata = await response.json() as Record<string, unknown>;
  if (String(metadata.issuer ?? "").replace(/\/+$/, "") !== issuer) throw new Error("The sign-in server's details name a different server.");
  const endpoint = (name: string, required = true) => {
    const value = metadata[name];
    if (typeof value !== "string" || new URL(value).origin !== issuer) {
      if (!required) return null;
      throw new Error(`The sign-in server's ${name} must belong to it.`);
    }
    return value;
  };
  if (!(metadata.code_challenge_methods_supported as string[] | undefined)?.includes("S256")) throw new Error("The sign-in server does not support PKCE.");
  if (metadata.authorization_response_iss_parameter_supported !== true) throw new Error("The sign-in server must identify itself in its callback.");
  return {
    issuer, clientId: config.cliClientId, ports: config.redirectPorts, scope: config.scope,
    start: endpoint("planban_machine_start_endpoint")!, cancel: endpoint("planban_machine_cancel_endpoint")!, authorize: endpoint("authorization_endpoint")!, token: endpoint("token_endpoint")!, revoke: endpoint("revocation_endpoint", false),
    device: endpoint("device_authorization_endpoint", false),
  };
}

/** Listens for the sign-in callback on the first free registered loopback port. */
async function callbackListener(ports: number[], state: string, issuer: string, waiting: () => boolean) {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Attach a handler immediately so an early timeout is never unhandled.
  void code.catch(() => undefined);
  const listener = createServer((req, res) => {
    const callback = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!waiting() || callback.pathname !== "/callback" || callback.searchParams.get("state") !== state
      || callback.searchParams.getAll("state").length !== 1 || callback.searchParams.getAll("iss").length !== 1 || callback.searchParams.get("iss") !== issuer) {
      res.writeHead(400).end("Invalid sign-in callback.");
      return;
    }
    const received = callback.searchParams.get("code");
    if (!received || callback.searchParams.getAll("code").length !== 1 || callback.searchParams.has("error")) {
      res.writeHead(400).end("Sign-in was not completed.");
      rejectCode(new Error(`Planban sign-in was not completed${callback.searchParams.get("error") ? ` (${callback.searchParams.get("error")})` : ""}.`));
      return;
    }
    res.end("Signed in to Planban. You can close this window.");
    resolveCode(received);
  });
  for (const port of ports) {
    const listening = await new Promise<boolean>((resolve) => {
      listener.once("error", () => resolve(false));
      listener.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (listening) {
      return {
        redirectUri: `http://127.0.0.1:${port}/callback`, code, fail: rejectCode,
        async close() {
          listener.closeAllConnections();
          await new Promise<void>((resolve) => listener.close(() => resolve()));
        },
      };
    }
  }
  throw new Error(`Planban sign-in needs one of these local ports free: ${ports.join(", ")}.`);
}

/**
 * Explicit service consent uses Clerk only to prove the human identity.
 * Bound PKCE redemption directly issues this machine's own Planban token,
 * independently revoked on sign-out or after 90 days unused. No provider
 * access or refresh credentials are exchanged or retained.
 */
/**
 * Signs this computer in as an account. Several accounts can be signed in at
 * once (owner decision, 15 October 2026): a new one is added beside the
 * others and becomes the default for boards taken online or attached from
 * now on; boards already linked keep their own account.
 */
export async function onlineLogin(urlInput: string, options: LoginOptions = {}) {
  const url = serviceUrl(urlInput);
  // Only for the note below; a damaged credentials file is reported by the sign-in itself.
  const before = (await readCredentials().catch(() => null))?.accounts[url];
  const result = await signIn(url, options) as { identity?: { account?: { email?: string; person?: string } } } & Record<string, unknown>;
  const added = result.identity?.account;
  const others = Object.entries(before?.accounts ?? {}).filter(([id]) => id !== added?.person).map(([, credentials]) => credentials.email ?? "another account");
  if (!others.length) return result;
  return {
    ...result,
    note: `Added ${added?.email ?? "this account"} beside ${others.join(", ")}, which ${others.length === 1 ? "stays" : "stay"} signed in here. Boards linked to ${others.length === 1 ? "it" : "them"} keep using ${others.length === 1 ? "it" : "them"}; boards you take online or attach from now on use ${added?.email ?? "this account"} (change with planban online switch).`,
  };
}

async function signIn(urlInput: string, options: LoginOptions) {
  const url = serviceUrl(urlInput);
  if (options.access === "board" && !options.boards?.trim()) throw new PlanbanValidationError("Board access requires --boards.");
  if (!options.devUser && (options.access === "board" || options.boards)) {
    throw new PlanbanValidationError("--access board and --boards apply only to development sign-in (--dev-user). Signing in through the browser gives this machine your full access; limit AI apps and keys from your connections instead.");
  }
  if (options.devUser) return devLogin(url, options);
  if (options.keyEnv) return keyLogin(url, options.keyEnv);
  const server = await signInEndpoints(url);
  if (options.device || options.printOnly) return deviceLogin(url, server, options);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  let deadline = 0, launch = "", redeemedToken = "", saved = false;
  const callback = await callbackListener(server.ports, state, server.issuer, () => deadline > performance.now());
  const controller = new AbortController();
  const ended = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
  void ended.catch(() => undefined);
  const stop = (reason: Error) => { controller.abort(reason); callback.fail(reason); };
  const interrupted = () => stop(new Error("Planban sign-in was interrupted."));
  process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const within = <T>(operation: Promise<T>) => Promise.race([operation, ended]);
  const checkDeadline = () => { if (performance.now() >= deadline || controller.signal.aborted) throw new Error("Planban sign-in timed out. Run login again."); };
  try {
    const start = await within(fetch(server.start, {
      method: "POST", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      body: new URLSearchParams({ client_id: server.clientId, redirect_uri: callback.redirectUri, scope: server.scope,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: url, state,
        // Ask for the stateless start (a signed launch note, stored nowhere); an older service ignores this.
        stateless: "1" }),
    }));
    const lease = await within(boundedJson(start)) as { launch?: string; launchUrl?: string; serverNow?: number; expiresAt?: number };
    const remaining = Number(lease.expiresAt) - Number(lease.serverNow);
    if (!start.ok || !Number.isSafeInteger(lease.expiresAt) || !Number.isSafeInteger(lease.serverNow) || !(remaining > 0 && remaining <= 300_000) || !(/^pbl_[A-Za-z0-9_-]{43}$/.test(lease.launch ?? "") || (/^pbn_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(lease.launch ?? "") && lease.launch!.length <= 7000)) || lease.launchUrl !== `${server.issuer}/oauth/machine/launch?launch=${lease.launch}`) throw new Error("The service did not issue a valid bounded sign-in request.");
    launch = lease.launch!;
    // The reply arrives after serverNow. Waiting its remaining duration from receipt
    // is an upper bound on service expiry, independent of the local wall clock.
    deadline = performance.now() + remaining;
    timeout = setTimeout(() => stop(new Error("Planban sign-in timed out. Run login again.")), remaining);
    await within(Promise.race([options.openBrowser ? options.openBrowser(lease.launchUrl!) : openBrowser(lease.launchUrl!, controller.signal), callback.code.then(() => undefined)]));
    const code = await within(callback.code);
    checkDeadline();
    const exchanged = await within(fetch(server.token, {
      method: "POST", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(30_000, Math.max(1, Math.floor(deadline - performance.now()))))]),
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: server.clientId, code_verifier: verifier, redirect_uri: callback.redirectUri, resource: url }),
    }));
    const tokens = await within(boundedJson(exchanged).catch(() => ({}))) as { access_token?: string; refresh_token?: string; token_type?: string; scope?: string; user_id?: string };
    if (!exchanged.ok || !/^pbm_[A-Za-z0-9_-]{43}$/.test(tokens.access_token ?? "") || tokens.token_type !== "Bearer" || tokens.scope !== "planban:machine" || tokens.refresh_token) throw new Error("The sign-in server did not issue this machine's own Planban sign-in. Run login again.");
    redeemedToken = tokens.access_token!;
    checkDeadline();
    await saveCredentials(url, { clientId: "machine", accessToken: redeemedToken, refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z", ...(tokens.user_id ? { person: tokens.user_id } : {}) });
    saved = true;
    return { url, signedIn: true, identity: await rememberIdentity(url), ...await staleCopiesAfterSignIn() };
  } finally {
    clearTimeout(timeout);
    controller.abort(new Error("The sign-in attempt ended."));
    process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
    await callback.close();
    if (!saved && launch) {
      // Bounded proof-owned cancellation cannot revoke a consumed independent machine.
      await fetch(server.cancel, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000), body: new URLSearchParams({ launch, code_verifier: verifier }) }).catch(() => undefined);
    }
    if (!saved && redeemedToken && server.revoke) {
      await fetch(server.revoke, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000), body: new URLSearchParams({ client_id: server.clientId, token: redeemedToken }) }).catch(() => undefined);
    }
  }
}

/**
 * One-tap approval (Planban 2.0): ask for a code, show the approval link and
 * the code to compare, open the link in this computer's browser unless asked
 * not to, and wait while the person approves on any signed-in device.
 */
async function deviceLogin(url: string, server: Awaited<ReturnType<typeof signInEndpoints>>, options: LoginOptions) {
  if (!server.device) throw new PlanbanValidationError("This Online Board service can't approve sign-ins by link yet. Update it, or sign in on a computer with a browser.");
  const asked = await fetch(server.device, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({ client_id: server.clientId, scope: server.scope, resource: url }),
  });
  const code = await boundedJson(asked).catch(() => ({})) as { device_code?: string; user_code?: string; verification_uri_complete?: string; expires_in?: number; interval?: number };
  const link = code.verification_uri_complete ?? "";
  if (!asked.ok || !/^pbv_[A-Za-z0-9_-]{43}$/.test(code.device_code ?? "") || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code.user_code ?? "")
    || !link.startsWith(`${server.issuer}/approve#request=`) || !Number.isSafeInteger(code.expires_in) || !(code.expires_in! > 0 && code.expires_in! <= 600)) {
    throw new Error("The service did not issue a valid sign-in link.");
  }
  process.stderr.write(`To sign this computer in to Planban, open this link on any device where you're signed in, check the code is ${code.user_code}, and choose Allow:\n${link}\n`);
  if (!options.printOnly) {
    const opening = options.openBrowser ? options.openBrowser(link) : openBrowser(link, AbortSignal.timeout(10_000));
    await opening.catch(() => undefined);
  }
  const deadline = Date.now() + code.expires_in! * 1000;
  let interval = options.pollIntervalMs ?? Math.max(5, Number(code.interval) || 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const polled = await fetch(server.token, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code!, client_id: server.clientId, resource: url }),
    }).catch(() => null);
    if (!polled) continue;
    const tokens = await boundedJson(polled).catch(() => ({})) as { access_token?: string; token_type?: string; scope?: string; user_id?: string; error?: string };
    if (tokens.error === "authorization_pending") continue;
    if (tokens.error === "slow_down") { interval += 5000; continue; }
    if (tokens.error === "access_denied") throw new Error("The sign-in was denied.");
    if (!polled.ok || !/^pbm_[A-Za-z0-9_-]{43}$/.test(tokens.access_token ?? "") || tokens.token_type !== "Bearer" || tokens.scope !== "planban:machine") throw new Error("The sign-in link expired or failed. Run login again.");
    await saveCredentials(url, { clientId: "machine", accessToken: tokens.access_token!, refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z", ...(tokens.user_id ? { person: tokens.user_id } : {}) });
    return { url, signedIn: true, identity: await rememberIdentity(url), ...await staleCopiesAfterSignIn() };
  }
  throw new Error("The sign-in link expired before anyone approved it. Run login again.");
}
