// The web page's browser session (Planban 2.0 plan, "Sessions and security"):
// after Clerk sign-in, the page sends its Clerk session token in the
// Authorization header to POST /web/session and gets the browser cookie back.
// Also what the screens around sign-in need: the public sign-in settings, the
// invitation preview, sign-out, and where to go afterwards.
import { clerkScriptUrls } from "../core/clerkPins";
import { CLERK_APPEARANCE, CLERK_LOCALIZATION } from "./clerkLook";

const HEADERS = { "X-Planban-Client": "web", "Content-Type": "application/json" } as const;

export interface SignInSettings {
  publishableKey: string;
  frontendApi: string;
}

/** Clerk's public settings for this service, or null when sign-in isn't set up here. */
export async function signInSettings(): Promise<SignInSettings | null> {
  const response = await fetch("/web/config", { headers: { "X-Planban-Client": "web" }, credentials: "same-origin" });
  if (!response.ok) throw new Error("Planban couldn't load sign-in. Try again in a moment.");
  const body = await response.json() as { signIn?: SignInSettings | null };
  return body.signIn ?? null;
}

/** Exchanges a Clerk session token for this browser's Planban session. */
export async function startWebSession(clerkToken: string): Promise<void> {
  const response = await fetch("/web/session", { method: "POST", headers: { ...HEADERS, Authorization: `Bearer ${clerkToken}` }, credentials: "same-origin", body: "{}" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? "Sign-in didn't finish. Try again.");
  }
}

/** Ends this browser's session here and at Clerk. Throws if the service didn't confirm it, so the page never claims a sign-out that didn't happen. */
export async function signOutWeb(): Promise<void> {
  const response = await fetch("/web/signout", { method: "POST", headers: HEADERS, credentials: "same-origin", body: "{}" })
    .catch(() => { throw new Error("Couldn't reach Planban to sign out. Check your connection and try again."); });
  if (!response.ok) throw new Error("Planban couldn't sign you out just now. Try again.");
  forgetAccount();
}

export type InvitePreview =
  | { state: "valid"; boardTitle: string; role: "editor" | "viewer"; inviterName: string; forEmail: boolean; expiresAt: string }
  | { state: "unknown" | "used" | "cancelled" | "expired" | "unavailable" };

export async function previewInvite(token: string): Promise<InvitePreview> {
  const response = await fetch("/web/invite", { method: "POST", headers: HEADERS, credentials: "same-origin", body: JSON.stringify({ token }) });
  if (!response.ok) throw new Error("Planban couldn't read this invitation. Try again in a moment.");
  return await response.json() as InvitePreview;
}

/** Only a path on this site: never another address, so a link can't send someone elsewhere after signing in. */
export function safeNext(value: string | null | undefined, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  try {
    const url = new URL(value, "https://planban.invalid");
    // A card link's "#card=..." survives signing in; nothing else in the address does more than a path.
    return url.origin === "https://planban.invalid" ? `${url.pathname}${url.search}${url.hash.startsWith("#card=") ? url.hash : ""}` : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Secrets that arrive in the address (an invitation's token, a sign-in
 * request to approve) are moved into this tab's session storage at once and
 * the visible address replaced, so they never travel in a redirect, a later
 * request's Referer or the browser history.
 */
const INVITE_KEY = "planban.web.invite";
const APPROVE_KEY = "planban.web.approve";

export function captureAddressSecrets(location: Location = window.location, history: History = window.history) {
  const invite = /^\/invite\/([^/?#]+)/.exec(location.pathname);
  if (invite?.[1] && invite[1] !== "pending") {
    sessionStorage.setItem(INVITE_KEY, decodeURIComponent(invite[1]));
    history.replaceState(null, "", "/invite/pending");
  }
  if (location.pathname === "/approve" && location.hash.startsWith("#request=")) {
    sessionStorage.setItem(APPROVE_KEY, decodeURIComponent(location.hash.slice("#request=".length)));
    history.replaceState(null, "", "/approve");
  }
}

export const pendingInvite = () => sessionStorage.getItem(INVITE_KEY);
export const pendingApproval = () => sessionStorage.getItem(APPROVE_KEY);
export const clearInvite = () => sessionStorage.removeItem(INVITE_KEY);
export const clearApproval = () => sessionStorage.removeItem(APPROVE_KEY);

/** Who is signed in on this browser, as Clerk said at sign-in: shown on screen only, never sent anywhere. */
export interface WebAccount {
  email: string | null;
  name: string | null;
}
const ACCOUNT_KEY = "planban.web.account";

export function rememberAccount(account: WebAccount) {
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
}

export function rememberedAccount(): WebAccount | null {
  try {
    const value = JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null") as WebAccount | null;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function forgetAccount() {
  localStorage.removeItem(ACCOUNT_KEY);
}

/** The pieces of Clerk's browser library the sign-in page uses. */
export interface ClerkBrowser {
  load(options: Record<string, unknown>): Promise<void>;
  session?: { status?: string; getToken(): Promise<string | null> } | null;
  user?: { primaryEmailAddress?: { emailAddress?: string } | null; fullName?: string | null } | null;
  addListener(listener: (resources: { session?: { status?: string } | null }) => void): () => void;
  mountSignIn(element: HTMLElement, props: Record<string, unknown>): void;
  unmountSignIn(element: HTMLElement): void;
  signOut(): Promise<void>;
}

function loadScript(src: string, attributes: Record<string, string> = {}) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CSS.escape(src)}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") resolve();
      else existing.addEventListener("load", () => resolve(), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.crossOrigin = "anonymous";
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    script.addEventListener("load", () => {
      script.dataset.loaded = "1";
      resolve();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("Sign-in couldn't load. Check your connection and try again.")), { once: true });
    document.head.append(script);
  });
}

/** Loads Clerk's pinned browser library and components, the same versions the consent page uses. */
export async function loadClerk(settings: SignInSettings): Promise<ClerkBrowser> {
  const urls = clerkScriptUrls(settings.frontendApi);
  await loadScript(urls.ui);
  await loadScript(urls.js, { "data-clerk-publishable-key": settings.publishableKey });
  const globals = window as unknown as { Clerk?: ClerkBrowser; __internal_ClerkUICtor?: unknown };
  if (!globals.Clerk) throw new Error("Sign-in couldn't load. Try again.");
  // No telemetry: the page's security policy refuses it, and it tells nobody anything they need.
  await globals.Clerk.load({ ui: { ClerkUI: globals.__internal_ClerkUICtor }, telemetry: { disabled: true }, appearance: CLERK_APPEARANCE, localization: CLERK_LOCALIZATION });
  return globals.Clerk;
}
