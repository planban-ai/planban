// The screens only the web page has (Planban 2.0 plan, phase 4; approved
// mockup sections 5, 6, 7 and 9): Log in or sign up, the board list with its
// first-run checklist and waiting invitations, invitations, one-tap approval
// of an agent's sign-in, and the account menu.
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, Check, ChevronRight, Copy, Laptop, Loader2, Mail, Plus, Smartphone, Sparkles, Users } from "lucide-react";
import { ConnectionsModal, Modal, NewBoardModal } from "./onlineBoard";
import { pageFetch } from "./transport";
import { Wordmark } from "./Wordmark";
import {
  clearApproval, clearInvite, loadClerk, pendingApproval, pendingInvite, previewInvite, rememberAccount, rememberedAccount,
  safeNext, signInSettings, signOutWeb, startWebSession, type ClerkBrowser, type InvitePreview,
} from "./webAccount";

type Json = Record<string, unknown>;

/** The page's own routes on the web, answered by the hosted adapter. Errors carry the service's status and reason. */
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await pageFetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Planban-Client": "web" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json().catch(() => ({})) as Json;
  if (!response.ok) throw Object.assign(new Error(typeof json.error === "string" ? json.error : `Planban answered ${response.status}.`), { status: response.status, body: json });
  return json as T;
}

const statusOf = (error: unknown) => (error as { status?: number } | null)?.status;
const reasonOf = (error: unknown) => (error as { body?: Json } | null)?.body?.reason as string | undefined;

export function signInPath(next = `${window.location.pathname}${window.location.search}${window.location.hash}`) {
  return `/sign-in?next=${encodeURIComponent(next)}`;
}

/** Which web-only screen this address is, if any. */
export function webScreen(pathname = window.location.pathname): "sign-in" | "invite" | "approve" | null {
  if (pathname === "/sign-in") return "sign-in";
  if (pathname.startsWith("/invite/")) return "invite";
  if (pathname === "/approve") return "approve";
  return null;
}

function initials(account: { email: string | null; name: string | null } | null) {
  const source = account?.name?.trim() || account?.email?.split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "·";
}

/** The person's avatar, opening the account menu: who is signed in, Connections, and Sign out. */
export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = rememberedAccount();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    // Focus goes into the menu, onto its first item.
    items()[0]?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      list[(at + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? list[0] : list.at(-1))?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    }
  };
  async function signOut() {
    setError(null);
    try {
      await signOutWeb();
      window.location.assign("/sign-in");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }
  return (
    <div className="web-account" ref={ref}>
      <button ref={triggerRef} className="web-avatar" aria-label="Your account" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); setOpen(true); } }}>{initials(account)}</button>
      {open ? (
        <div className="web-account-menu" role="menu" aria-label="Your account" onKeyDown={onMenuKey}>
          {account?.email ? (
            <p className="web-account-who">{account.name ? <><b>{account.name}</b>{account.email}</> : <>Signed in as <b>{account.email}</b></>}</p>
          ) : null}
          <button role="menuitem" tabIndex={-1} onClick={() => { close(false); setConnections(true); }}>Connections</button>
          <button role="menuitem" tabIndex={-1} onClick={() => void signOut()}>Sign out</button>
          {error ? <p className="web-account-note" role="alert">{error}</p> : null}
          {/* Destructive, so set apart: last, below a divider, in red (owner feedback, 15 October 2026). */}
          <div className="web-account-divider" role="separator" />
          <button role="menuitem" tabIndex={-1} className="web-account-danger" onClick={() => { close(false); setDeleting(true); }}>Delete account</button>
        </div>
      ) : null}
      {connections ? <ConnectionsModal onClose={() => { setConnections(false); triggerRef.current?.focus(); }} /> : null}
      {deleting ? <DeleteAccountDialog email={account?.email ?? null} onClose={() => { setDeleting(false); triggerRef.current?.focus(); }} /> : null}
    </div>
  );
}

/**
 * Deleting an account is by email for 2.0 (owner request, 15 October 2026):
 * one quiet link in the profile menu, and this short dialog saying what goes.
 */
export function deleteAccountMailto(email: string | null) {
  const body = `Please delete my Planban account${email ? `: ${email}` : "."}\n`;
  return `mailto:hello@planban.ai?subject=${encodeURIComponent("Delete my Planban account")}&body=${encodeURIComponent(body)}`;
}

function DeleteAccountDialog({ email, onClose }: { email: string | null; onClose: () => void }) {
  return (
    <Modal eyebrow="Your account" title="Delete your account" onClose={onClose} className="web-delete-account"
      footer={<><button onClick={onClose}>Cancel</button><a className="web-danger-primary web-delete-account-email" href={deleteAccountMailto(email)} onClick={onClose}>Email hello@planban.ai</a></>}>
      <div className="online-board-section">
        <p className="web-delete-account-text">Deleting your account removes the boards you own, for everyone on them. Your edits on other people's boards stay, without your name. Email us and it's done within 30 days.</p>
      </div>
    </Modal>
  );
}

function AppHeader() {
  return (
    <header className="web-apphead">
      <a href="/" aria-label="Your boards"><Wordmark /></a>
      <span className="web-apphead-right"><AccountMenu /></span>
    </header>
  );
}

/** Log in or sign up (approved mockup section 5): Clerk's own sign-in, then this browser's Planban session. */
export function SignInPage() {
  const next = safeNext(new URLSearchParams(window.location.search).get("next"));
  // Why the person is here, when it isn't simply arriving: their sign-in ended, or a link to a board.
  const reason = new URLSearchParams(window.location.search).get("ended") === "1"
    ? "Your sign-in ended after 7 days. Log in again to carry on where you were."
    : next.startsWith("/boards/") ? "Log in to open the board you followed a link to." : null;
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "finishing" | "unavailable" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const clerkRef = useRef<ClerkBrowser | null>(null);
  const finishing = useRef(false);
  // Clerk keeps its step in the address's fragment: empty on the first step.
  const [step, setStep] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setStep(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const firstStep = step === "" || step === "#" || step === "#/";
  // Clerk's own check before creating an account shows no text inside our layout; say what's happening.
  const checking = step.includes("protect-check");

  const finish = useCallback(async (clerk: ClerkBrowser) => {
    if (finishing.current) return;
    finishing.current = true;
    setStatus("finishing");
    try {
      const token = await clerk.session?.getToken();
      if (!token) throw new Error("Sign-in didn't finish. Try again.");
      await startWebSession(token);
      rememberAccount({ email: clerk.user?.primaryEmailAddress?.emailAddress ?? null, name: clerk.user?.fullName ?? null });
      window.location.assign(next);
    } catch (error) {
      finishing.current = false;
      setMessage(error instanceof Error ? error.message : String(error));
      setStatus("error");
    }
  }, [next]);

  useEffect(() => {
    let cancelled = false;
    let stopListening: (() => void) | null = null;
    void (async () => {
      try {
        const settings = await signInSettings();
        if (cancelled) return;
        if (!settings) return setStatus("unavailable");
        const clerk = await loadClerk(settings);
        if (cancelled) return;
        clerkRef.current = clerk;
        if (clerk.session?.status === "active") return void finish(clerk);
        setStatus("ready");
        stopListening = clerk.addListener(({ session }) => {
          if (session?.status === "active") void finish(clerk);
        });
        if (mountRef.current) {
          clerk.mountSignIn(mountRef.current, {
            withSignUp: true,
            // GitHub sends people back here, which then finishes on its own.
            forceRedirectUrl: window.location.href,
            signUpForceRedirectUrl: window.location.href,
          });
        }
      } catch (error) {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      stopListening?.();
      const element = mountRef.current;
      if (element && clerkRef.current) clerkRef.current.unmountSignIn(element);
    };
  }, [finish]);

  async function startAgain() {
    // A sign-in Planban won't accept any more (for example after Sign out other devices) needs a fresh one.
    await clerkRef.current?.signOut().catch(() => undefined);
    window.location.reload();
  }

  return (
    <main className="web-screen">
      <header className="web-apphead">
        <a href="https://planban.ai" aria-label="Planban"><Wordmark /></a>
        <span className="web-apphead-right"><a className="web-apphead-link" href="https://planban.ai">planban.ai</a></span>
      </header>
      <div className="web-signin-layout">
      {/* What Planban online is, beside the form (owner feedback, 15 October 2026: the bare form felt "v bare bones"). */}
      <section className="web-signin-intro" aria-labelledby="signin-pitch">
        <img className="web-signin-mark" src="/assets/card-stack-black.svg" alt="" width="40" height="40" />
        <h2 id="signin-pitch">One board for you and your agents.</h2>
        <p>Planban online keeps a board where everyone can reach it: the people you work with, your phone, and ChatGPT and Claude.</p>
        <ul>
          <li><Users size={15} aria-hidden="true" /> Share a board, and choose who can edit it</li>
          <li><Smartphone size={15} aria-hidden="true" /> Open it in any browser, on any device</li>
          <li><Bot size={15} aria-hidden="true" /> Your agents read it and keep it up to date</li>
        </ul>
        <p className="web-signin-local">Planban on your computer stays free, with no account. <a href="https://planban.ai">See how it works</a></p>
      </section>
      <div className="web-signin">
        {/* Clerk shows each step's own title once it's ready (see clerkLook.ts). */}
        {status === "ready" ? null : (
          <>
            <h1 className="web-h">Log in or sign up</h1>
            <p className="web-sub">Free. Your boards stay private until you share them.</p>
          </>
        )}
        {reason && firstStep ? <p className="web-note web-signin-reason">{reason}</p> : null}
        {status === "unavailable" ? <p className="web-note" role="alert">Sign-in isn't available here yet.</p> : null}
        <div ref={mountRef} className="web-clerk" hidden={status !== "ready"} />
        {status === "ready" && checking ? <p className="web-muted" role="status"><Loader2 size={14} className="spin" /> Checking this browser before creating your account…</p> : null}
        {status === "loading" || status === "finishing" ? <p className="web-muted" role="status"><Loader2 size={14} className="spin" /> {status === "loading" ? "Loading sign-in…" : "Signing you in…"}</p> : null}
        {status === "error" ? (
          <div className="web-note" role="alert">
            <p>{message}</p>
            <button className="web-button" onClick={() => void startAgain()}>Sign in again</button>
          </div>
        ) : null}
        {firstStep ? (
          <>
            <p className="web-signin-note">We'll email you a code. No password.</p>
            <p className="web-signin-note">New here? The same steps create your account.</p>
          </>
        ) : null}
      </div>
      </div>
    </main>
  );
}

interface ListedBoard {
  repoId: string;
  title: string;
  online?: { role: "owner" | "editor" | "viewer"; authority: string; lastChangedAt: string; people?: number; needYou?: number; ownerName?: string };
}

const ROLE = { owner: "Owner", editor: "Editor", viewer: "Viewer" } as const;

function changedAgo(at: string | undefined) {
  if (!at) return "";
  const then = Date.parse(at);
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "changed just now";
  if (minutes < 60) return `changed ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `changed ${hours} hour${hours === 1 ? "" : "s"} ago`;
  if (hours < 48) return "changed yesterday";
  return `changed ${new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

function BoardRow({ board, onOpen }: { board: ListedBoard; onOpen: () => void }) {
  const online = board.online;
  const owned = online?.role === "owner";
  const others = Math.max(0, (online?.people ?? 1) - 1);
  const who = owned ? (others ? `You and ${others} other${others === 1 ? "" : "s"}` : "Only you") : `Shared by ${online?.ownerName ?? "someone"}`;
  const away = online && online.authority !== "online";
  return (
    <button className="web-row" onClick={onOpen}>
      <span className="web-row-main">
        <b>{board.title}</b>
        <small>{away ? "Taken back to a computer · read-only here" : [who, changedAgo(online?.lastChangedAt)].filter(Boolean).join(" · ")}</small>
      </span>
      {owned && online?.needYou ? <span className="web-needs">{online.needYou} need you</span> : null}
      {online ? <span className="web-role">{ROLE[online.role]}</span> : null}
      <ChevronRight size={16} className="web-row-arrow" aria-hidden="true" />
    </button>
  );
}

interface WaitingInvite { id: string; boardTitle: string; role: "editor" | "viewer"; inviterName: string }
const DISMISSED_KEY = "planban.web.notNow";

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="web-prompt">
      <span>{text}</span>
      <button onClick={() => void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>
        {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
      </button>
    </div>
  );
}

/** What the service already knows about how someone came to Planban online; nothing new is collected. */
export interface WelcomeSignals {
  invites: number;
  /** A computer signed in to this account and still allowed. */
  computer: { name: string; lastUsedAt: string } | null;
  /** Boards they own here: online, or copies of ones taken back. */
  ownsBoards: boolean;
  /** ChatGPT or Claude signed this account in. */
  appConnected: boolean;
}

export type WelcomeView = "question" | "computer" | "fresh" | "invited";

/**
 * Where a new person starts (owner decision, 15 October 2026): use what is
 * known, and ask only when nothing is. Invitations first; then a computer or
 * boards of their own (they came from the app); otherwise the question,
 * worded for ChatGPT or Claude when one of those signed them in.
 */
export function welcomeStart(signals: WelcomeSignals): WelcomeView {
  if (signals.invites > 0) return "invited";
  if (signals.computer || signals.ownsBoards) return "computer";
  return "question";
}

function ago(at: string) {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hour${hours === 1 ? "" : "s"} ago` : new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function Watching({ children }: { children: React.ReactNode }) {
  return <p className="web-watching" role="status"><span className="web-watching-dot" aria-hidden="true" />{children}</p>;
}

function Choice({ icon, title, body, onClick }: { icon: React.ReactNode; title: string; body: string; onClick: () => void }) {
  return (
    <button className="web-choice" onClick={onClick}>
      <span className="web-choice-icon" aria-hidden="true">{icon}</span>
      <span className="web-choice-text"><b>{title}</b><small>{body}</small></span>
      <ChevronRight size={16} className="web-row-arrow" aria-hidden="true" />
    </button>
  );
}

/** The welcome a new account sees (approved 15 October 2026), in place of Your boards until they move on. */
function Welcome({ view, setView, signals, owned, invites, putOff, busy, onJoin, onNotNow, onSelectBoard, onCreated, onDone }: {
  view: WelcomeView; setView: (view: WelcomeView | null) => void; signals: WelcomeSignals; owned: ListedBoard[]; invites: WaitingInvite[]; putOff: string[]; busy: string | null;
  onJoin: (invite: WaitingInvite) => void; onNotNow: (invite: WaitingInvite) => void; onSelectBoard: (repoId: string) => void; onCreated: (repoId: string) => void; onDone: () => void;
}) {
  const account = rememberedAccount();
  const first = account?.name?.split(/\s+/)[0];
  // Moving between views puts focus on the new heading; arrivals are announced.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current !== view) headingRef.current?.focus();
    shownView.current = view;
  }, [view]);
  const [announcement, setAnnouncement] = useState("");
  const seen = useRef({ computer: signals.computer?.name ?? null, boards: owned.length, invites: invites.length });
  useEffect(() => {
    const before = seen.current;
    const news = [
      signals.computer && !before.computer ? `${signals.computer.name} is signed in.` : "",
      owned.length > before.boards ? (owned.length - before.boards === 1 ? `${owned[owned.length - 1]?.title ?? "A board"} is online.` : `${owned.length - before.boards} boards are online.`) : "",
      invites.length > before.invites ? (invites.length - before.invites === 1 ? "A new invitation arrived." : `${invites.length - before.invites} new invitations arrived.`) : "",
    ].filter(Boolean).join(" ");
    if (news) setAnnouncement(news);
    seen.current = { computer: signals.computer?.name ?? null, boards: owned.length, invites: invites.length };
  }, [signals.computer, owned, invites.length]);
  const live = <p className="visually-hidden" aria-live="polite">{announcement}</p>;
  const origin = window.location.origin;
  const mcp = `${origin}/mcp`;
  // Back to where they started, whenever they've moved away from it.
  const start = welcomeStart(signals);
  const back = view !== start ? <button className="web-back" onClick={() => setView(start === "question" ? "question" : null)}>‹ Back</button> : null;
  const elsewhere = (
    <p className="web-foot">
      {view !== "computer" ? <><button className="web-link" onClick={() => setView("computer")}>Also using Planban on your computer?</button><br /></> : null}
      {view !== "fresh" ? <><button className="web-link" onClick={() => setView("fresh")}>Starting something new? Make a board here</button><br /></> : null}
      {view !== "invited" ? <><button className="web-link" onClick={() => setView("invited")}>Invited to a board? Find it</button><br /></> : null}
      <button className="web-link" onClick={onDone}>Go to Your boards</button>
    </p>
  );

  if (view === "invited") {
    return (
      <section className="web-welcome" aria-labelledby="welcome-title">
        {live}
        {back}
        <h1 id="welcome-title" className="web-h" tabIndex={-1} ref={headingRef}>{invites.length ? (invites.length === 1 ? "You've been invited to a board" : "You've been invited to boards") : "Find your invitation"}</h1>
        <p className="web-sub">{invites.length ? "Join to open it straight away." : "Invitations come by email, from the board's owner."}</p>
        {invites.length ? (
          <div className="web-panel">
            {invites.map((invite) => (
              <div className="web-invite-row" key={invite.id}>
                <span className="web-row-main"><b>{invite.boardTitle}</b><small>{invite.inviterName} invited you as {invite.role === "editor" ? "an editor" : "a viewer"}{putOff.includes(invite.id) ? " · put off for now" : ""}</small></span>
                <button className="web-button dark" disabled={busy !== null} onClick={() => onJoin(invite)}>{busy === invite.id ? <Loader2 size={13} className="spin" /> : null}Join</button>
                {putOff.includes(invite.id) ? null : (
                  // Putting off the last one still waiting moves on to where they'd otherwise start.
                  <button className="web-button ghost" disabled={busy !== null} onClick={() => { onNotNow(invite); if (signals.invites <= 1) setView(null); }}>Not now</button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="web-panel web-card">
            <b>No invitation for {account?.email ?? "this address"} yet</b>
            <p className="web-muted-text">Open the link in your invitation email. If it went to another address, log in with that one, or ask the owner to invite this one. Invitations appear here by themselves.</p>
            <Watching>Watching for invitations…</Watching>
          </div>
        )}
        {elsewhere}
      </section>
    );
  }

  if (view === "computer") {
    // Ticked only while a computer is signed in now; boards alone don't prove that.
    const known = signals.computer;
    const boardList = owned.length ? (
      <div className="web-welcome-boards">
        <p className="web-welcome-boards-head">On Planban online now</p>
        {owned.map((board) => (
          <div className="web-welcome-board" key={board.repoId}>
            <span className="web-row-main"><b>{board.title}</b><small>{board.online?.authority === "online" ? `online · ${changedAgo(board.online.lastChangedAt)}` : "a read-only copy; the board itself is back on a computer"}</small></span>
            {board.online?.authority === "online"
              ? <button className="web-button" onClick={() => onSelectBoard(board.repoId)}>Open</button>
              : <span className="web-role">Read-only copy</span>}
          </div>
        ))}
      </div>
    ) : null;
    return (
      <section className="web-welcome" aria-labelledby="welcome-title">
        {live}
        {back}
        <h1 id="welcome-title" className="web-h" tabIndex={-1} ref={headingRef}>Bring your boards online</h1>
        <p className="web-sub">{known ? "Your computer is signed in. Now each project's board."
          : owned.length ? "Sign your computer in to bring more of your boards here. This page follows along by itself."
          : "Two steps, both on your computer. This page follows along by itself."}</p>
        <ol className="web-steps">
          <li className={`web-step ${known ? "done" : ""}`}>
            <span className="web-step-box" aria-hidden="true">{known ? <Check size={11} /> : null}</span>
            <div>
              <b>{known ? "Computer signed in" : "Sign your computer in"}</b>
              {known ? <small>{known.name} · last used {ago(known.lastUsedAt)}</small> : (
                <>
                  <small>In Codex or Claude Code on that computer, paste:</small>
                  <CopyLine text={`Sign this computer in to Planban online: planban online login ${origin} --no-browser`} />
                  <small>It shows a link and a code. Open the link here or on your phone, check the code and tap Allow.</small>
                  <Watching>Waiting for a computer to sign in…</Watching>
                </>
              )}
            </div>
          </li>
          <li className={`web-step ${known ? "" : "web-step-later"}`}>
            <span className="web-step-box" aria-hidden="true" />
            <div>
              <b>Take each project's board online</b>
              {known ? (
                <>
                  <small>In each project, ask your agent:</small>
                  <CopyLine text="Take this project's Planban board online" />
                  <small>Or in the Planban app on your computer: Board settings, then Take online. Boards appear here as they arrive.</small>
                  {boardList}
                  <Watching>Watching for more boards…</Watching>
                </>
              ) : <><small>Next, once your computer is signed in.</small>{boardList}</>}
            </div>
          </li>
        </ol>
        <p className="web-foot">Planban only sees a board once you take it online; the boards on your computer stay private until then.</p>
        {elsewhere}
      </section>
    );
  }

  if (view === "fresh") {
    return (
      <section className="web-welcome" aria-labelledby="welcome-title">
        {live}
        {back}
        <h1 id="welcome-title" className="web-h" tabIndex={-1} ref={headingRef}>Start your first board</h1>
        <p className="web-sub">One board per project works best. You can invite people once it's made.</p>
        <FirstBoard onCreated={onCreated} />
        <div className="web-panel web-card">
          <b>Then let your agents work on it</b>
          <small className="web-muted-text">ChatGPT or Claude: add a connector with this address, then click Allow.</small>
          <CopyLine text={mcp} />
          <small className="web-muted-text">Codex or Claude Code: paste this.</small>
          <CopyLine text="Install Planban from planban-ai/planban and open my board" />
        </div>
        {elsewhere}
      </section>
    );
  }

  const app = signals.appConnected;
  return (
    <section className="web-welcome" aria-labelledby="welcome-title">
        {live}
      {app ? <p className="web-connected"><Check size={14} aria-hidden="true" /> <span><b>ChatGPT or Claude is connected to your account.</b> It can read and update the boards you have here.</span></p> : null}
      <h1 id="welcome-title" className="web-h" tabIndex={-1} ref={headingRef}>{first ? `Welcome to Planban, ${first}` : "Welcome to Planban"}</h1>
      <p className="web-sub">{app ? "Where are your plans now?" : "Tell us where you're starting from, and we'll get your boards here."}</p>
      <div className="web-choices">
        <Choice icon={<Laptop size={17} />} title={app ? "In Planban on my computer" : "I already use Planban on my computer"}
          body={app ? "Bring them online so your AI app can see them too." : "Bring the boards you have in Codex or Claude Code online, to share them or open them anywhere."} onClick={() => setView("computer")} />
        <Choice icon={<Sparkles size={17} />} title={app ? "Nowhere yet" : "I'm starting something new"}
          body={app ? "Start a board here; your AI app can fill it in with you." : "Make an empty board here and connect your agents to it."} onClick={() => setView("fresh")} />
        <Choice icon={<Mail size={17} />} title={app ? "On a board someone shared" : "Someone invited me"}
          body="Find the board you were invited to." onClick={() => setView("invited")} />
      </div>
      <p className="web-foot">Planban works on your computer without an account too. <a className="web-link" href="https://planban.ai">What's online for?</a></p>
    </section>
  );
}

/** Name the first board right on the welcome page. */
function FirstBoard({ onCreated }: { onCreated: (repoId: string) => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { board } = await call<{ board: { repoId: string } }>("/api/boards", { title: title.trim() });
      onCreated(board.repoId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  }
  return (
    <form className="web-panel web-card web-first-board" onSubmit={(event) => { event.preventDefault(); if (title.trim() && !busy) void create(); }}>
      <label htmlFor="first-board-name">What's the project called?</label>
      <input id="first-board-name" value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} autoComplete="off" />
      <button className="web-button dark" type="submit" disabled={busy || !title.trim()}>{busy ? <Loader2 size={13} className="spin" /> : null}Create board</button>
      {error ? <p className="web-note" role="alert">{error}</p> : null}
    </form>
  );
}

/** Your boards (approved mockup section 7), with waiting invitations at the top. */
export function HostedDashboard({ boards, onSelectBoard, onBoardsChanged }: { boards: ListedBoard[]; onSelectBoard: (repoId: string) => void; onBoardsChanged: () => Promise<void> }) {
  const [newBoard, setNewBoard] = useState(false);
  const [invites, setInvites] = useState<WaitingInvite[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(() => JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? "[]") as string[]);
  const [connections, setConnections] = useState<Array<{ kind: string; name: string; lastUsedAt: string; active?: boolean }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owned = boards.filter((board) => board.online?.role === "owner");
  const shared = boards.filter((board) => board.online && board.online.role !== "owner");
  // The welcome stays until the person moves on to Your boards (kept for this browser).
  const [welcomeDone, setWelcomeDone] = useState(() => localStorage.getItem("planban.web.stepsHidden") === "1");
  const [chosen, setChosen] = useState<WelcomeView | null>(null);
  const finishWelcome = () => {
    localStorage.setItem("planban.web.stepsHidden", "1");
    setWelcomeDone(true);
  };

  // One check at a time; a failed answer keeps what was known, and repeated failures slow the checks.
  const checking = useRef(false);
  const failures = useRef(0);
  const nextCheck = useRef(0);
  const recheck = useCallback(async () => {
    if (checking.current || Date.now() < nextCheck.current) return;
    checking.current = true;
    try {
      const [waiting, listed] = await Promise.all([
        call<{ invitations: WaitingInvite[] }>("/api/online/invites").catch(() => null),
        call<{ connections?: Array<{ kind: string; name: string; lastUsedAt: string; active?: boolean }> }>("/api/online/connections").catch(() => null),
      ]);
      if (waiting) setInvites(waiting.invitations);
      if (listed) setConnections(listed.connections ?? []);
      else setConnections((known) => known ?? []);
      failures.current = waiting && listed ? 0 : failures.current + 1;
      nextCheck.current = failures.current ? Date.now() + Math.min(60_000, 5_000 * 2 ** failures.current) : 0;
    } finally {
      checking.current = false;
    }
  }, []);
  const showing = invites.filter((invite) => !dismissed.includes(invite.id));
  const welcoming = !welcomeDone && shared.length === 0;
  useEffect(() => {
    void recheck();
    const onFocus = () => { if (!document.hidden) void recheck(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    // While welcoming, the page follows along: a computer signing in, boards arriving, an invitation.
    const timer = welcoming ? window.setInterval(() => {
      if (document.hidden) return;
      void recheck();
      void onBoardsChanged();
    }, 5_000) : undefined;
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      if (timer) window.clearInterval(timer);
    };
  }, [recheck, welcoming, onBoardsChanged]);

  async function join(invite: WaitingInvite) {
    setBusy(invite.id);
    setError(null);
    try {
      const joined = await call<{ boardId: string; title: string }>(`/api/online/invites/${encodeURIComponent(invite.id)}/accept`, {});
      announceJoined(joined.title);
      await onBoardsChanged();
      onSelectBoard(joined.boardId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  }
  const notNow = (invite: WaitingInvite) => {
    const next = [...dismissed, invite.id];
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    setDismissed(next);
  };

  const computer = (connections ?? []).filter((row) => row.kind === "machine" && row.active !== false)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))[0];
  const signals: WelcomeSignals = {
    invites: showing.length,
    computer: computer ? { name: computer.name, lastUsedAt: computer.lastUsedAt } : null,
    ownsBoards: owned.length > 0,
    appConnected: (connections ?? []).some((row) => row.kind === "oauth" && row.active !== false),
  };
  const view = chosen ?? welcomeStart(signals);

  return (
    <main className="web-screen">
      <AppHeader />
      <div className="web-wrap">
        {welcoming ? (
          connections === null ? <p className="web-muted" role="status"><Loader2 size={14} className="spin" /> One moment…</p> : (
            <Welcome view={view} setView={setChosen} signals={signals} owned={owned} invites={invites} putOff={dismissed} busy={busy}
              onJoin={(invite) => void join(invite)} onNotNow={notNow} onSelectBoard={onSelectBoard} onDone={finishWelcome}
              onCreated={(repoId) => { finishWelcome(); void onBoardsChanged().then(() => onSelectBoard(repoId)); }} />
          )
        ) : (
          <>
            {invites.length > showing.length ? (
              <p className="web-foot"><button className="web-link" onClick={() => { sessionStorage.removeItem(DISMISSED_KEY); setDismissed([]); }}>Show {invites.length - showing.length === 1 ? "the invitation" : `${invites.length - showing.length} invitations`} you put off</button></p>
            ) : null}
            {showing.map((invite) => (
              <div className="web-banner" key={invite.id}>
                <span><b>{invite.inviterName} invited you to {invite.boardTitle}</b> as {invite.role === "editor" ? "an editor" : "a viewer"}.</span>
                <span className="web-banner-actions">
                  <button className="web-button dark" disabled={busy !== null} onClick={() => void join(invite)}>{busy === invite.id ? <Loader2 size={13} className="spin" /> : null}Join</button>
                  <button className="web-button ghost" disabled={busy !== null} onClick={() => notNow(invite)}>Not now</button>
                </span>
              </div>
            ))}
            <div className="web-secthead">
              <h1 className="web-h">Your boards</h1>
              <button className="web-button dark" onClick={() => setNewBoard(true)}><Plus size={14} /> <span className="web-wide-only">New board</span><span className="web-narrow-only">New</span></button>
            </div>
            {owned.length ? <div className="web-panel">{owned.map((board) => <BoardRow key={board.repoId} board={board} onOpen={() => onSelectBoard(board.repoId)} />)}</div> : null}
            {shared.length ? (
              <>
                <div className="web-secthead"><h2>Shared with you</h2></div>
                <div className="web-panel">{shared.map((board) => <BoardRow key={board.repoId} board={board} onOpen={() => onSelectBoard(board.repoId)} />)}</div>
              </>
            ) : null}
            {!owned.length && !shared.length ? <p className="web-foot">No boards here yet. Make one with New board, or take one online from the Planban app on your computer.</p> : null}
            {owned.length ? <p className="web-foot">Boards on your computer stay there. To add one here, open it in the Planban app and choose Take online.</p> : null}
            {!shared.length ? <p className="web-foot"><button className="web-link" onClick={() => { localStorage.removeItem("planban.web.stepsHidden"); setChosen(null); setWelcomeDone(false); }}>Show the getting-started steps</button></p> : null}
          </>
        )}
        {error ? <p className="web-note" role="alert">{error}</p> : null}
      </div>
      {newBoard ? <NewBoardModal onClose={() => setNewBoard(false)} onCreated={(repoId) => {
        setNewBoard(false);
        void onBoardsChanged().then(() => onSelectBoard(repoId));
      }} /> : null}
    </main>
  );
}

const JOINED_KEY = "planban.web.joined";
export function announceJoined(title: string) {
  sessionStorage.setItem(JOINED_KEY, title);
}

/** "You joined Northfold", once, on the board just joined. */
export function JoinedNote() {
  const [title] = useState(() => {
    const value = sessionStorage.getItem(JOINED_KEY);
    sessionStorage.removeItem(JOINED_KEY);
    return value;
  });
  const [shown, setShown] = useState(Boolean(title));
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(false), 5000);
    return () => window.clearTimeout(timer);
  }, [shown]);
  return shown && title ? <div className="web-toast" role="status">You joined {title}</div> : null;
}

const roleSentence = (role: "editor" | "viewer") => role === "editor"
  ? "you can change cards, Specs and Plans, and mark work complete"
  : "you can read the board, its Specs and Plans and its history";

/** From an invitation link to the board (approved mockup section 9). */
export function InvitePage({ onOpenBoard }: { onOpenBoard: (boardId: string) => void }) {
  const [token] = useState(pendingInvite);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [outcome, setOutcome] = useState<{ kind: "member"; boardId: string; title: string } | { kind: "refused"; reason: string | undefined; sentTo?: string | undefined; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const account = rememberedAccount();

  /** Joins: only ever from the person's own tap on Join. */
  const join = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    try {
      const joined = await call<{ boardId: string; title: string; alreadyMember: boolean }>("/api/online/invites/accept", { token });
      if (joined.alreadyMember) {
        setOutcome({ kind: "member", boardId: joined.boardId, title: joined.title });
        return;
      }
      clearInvite();
      announceJoined(joined.title);
      onOpenBoard(joined.boardId);
    } catch (error) {
      if (statusOf(error) === 401) return setSignedIn(false);
      setOutcome({ kind: "refused", reason: reasonOf(error), sentTo: (error as { body?: Json }).body?.sentTo as string | undefined, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }, [token, onOpenBoard]);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      const [shown, me] = await Promise.all([
        previewInvite(token).catch(() => ({ state: "unknown" as const })),
        call("/api/online/me").then(() => true, (error) => (statusOf(error) === 401 ? false : null)),
      ]);
      // Someone already on the board sees "You're already on this board", whatever state the invitation is in. Reads only.
      if (me) {
        const member = await call<{ member: boolean; boardId?: string; title?: string }>("/api/online/invites/membership", { token }).catch(() => null);
        if (member?.member && member.boardId) setOutcome({ kind: "member", boardId: member.boardId, title: member.title ?? "This board" });
      }
      setPreview(shown);
      setSignedIn(me);
    })();
  }, [token]);

  async function switchAccount() {
    try {
      await signOutWeb();
      window.location.assign(signInPath("/invite/pending"));
    } catch (failure) {
      window.alert(failure instanceof Error ? failure.message : String(failure));
    }
  }

  const card = (title: string, body: ReactNode, actions?: ReactNode) => (
    <main className="web-screen">
      <AppHeaderMaybe signedIn={signedIn === true} />
      <div className="web-wrap narrow">
        <section className="web-panel web-card web-invite" aria-labelledby="invite-title">
          <p className="web-eyebrow">Invitation</p>
          <h1 id="invite-title" className="web-h">{title}</h1>
          {body}
          {actions ? <div className="web-actions">{actions}</div> : null}
        </section>
      </div>
    </main>
  );

  if (!token) return card("This invitation link is incomplete", <p className="web-sub">Open the link from your email again, or ask the person who invited you for a new one.</p>);
  if (!preview || signedIn === null && preview.state === "valid") return card("Opening your invitation…", <p className="web-muted"><Loader2 size={14} className="spin" /> One moment.</p>);
  if (outcome?.kind === "member") {
    return card("You're already on this board", <p className="web-sub">{outcome.title} is in your boards.</p>,
      <button className="web-button dark" onClick={() => { clearInvite(); onOpenBoard(outcome.boardId); }}>Open {outcome.title}</button>);
  }
  const reason = outcome?.kind === "refused" ? outcome.reason : preview.state === "valid" ? undefined : preview.state;
  if (reason === "wrong_email") {
    return card("This invitation is for another email",
      <p className="web-sub">It was sent to {outcome?.kind === "refused" && outcome.sentTo ? outcome.sentTo : "a different address"}. Log in with that address, or ask for a new invitation.</p>,
      <button className="web-button" onClick={() => void switchAccount()}>Log in with another account</button>);
  }
  if (reason === "expired") return card("This invitation has expired", <p className="web-sub">Invitations last 7 days. Ask the person who invited you for a new one.</p>);
  if (reason === "cancelled" || reason === "used") return card("This invitation was cancelled", <p className="web-sub">Ask the person who invited you if you still need access.</p>);
  if (reason === "unavailable") return card("This board isn't online at the moment", <p className="web-sub">Ask the person who invited you.</p>);
  if (preview.state !== "valid") return card("This invitation link doesn't work", <p className="web-sub">Check you opened the whole link from your email, or ask for a new invitation.</p>);
  if (outcome?.kind === "refused") return card("Couldn't join", <p className="web-note" role="alert">{outcome.message}</p>);

  const body = <p className="web-sub">You'll join as {preview.role === "editor" ? "an Editor" : "a Viewer"}: {roleSentence(preview.role)}.</p>;
  if (!signedIn) {
    return card(`${preview.inviterName} invited you to ${preview.boardTitle}`, <>{body}<p className="web-muted">Log in or sign up to join. It's free.</p></>,
      <button className="web-button dark" onClick={() => window.location.assign(signInPath("/invite/pending"))}>Log in or sign up</button>);
  }
  return card(`${preview.inviterName} invited you to ${preview.boardTitle}`,
    <>{body}{account?.email ? <p className="web-signed-in">Signed in as <b>{account.email}</b></p> : null}</>,
    <button className="web-button dark" disabled={busy} onClick={() => void join()}>{busy ? <Loader2 size={13} className="spin" /> : null}Join {preview.boardTitle}</button>);
}

function AppHeaderMaybe({ signedIn }: { signedIn: boolean }) {
  return signedIn ? <AppHeader /> : <header className="web-apphead"><a href="/" aria-label="Planban"><Wordmark /></a></header>;
}

/** One-tap approval of an agent's sign-in (Spec point 16): who is asking, the code to compare, Allow or Deny. */
export function ApprovePage() {
  // Read once: answering clears the stored request, and the page still shows the outcome.
  const [note] = useState(pendingApproval);
  const [state, setState] = useState<"loading" | "signed-out" | "waiting" | "ended" | "allowed" | "denied" | "error">("loading");
  const [request, setRequest] = useState<{ clientName: string; permission: string; userCode: string; expiresAt: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!note) return;
    void call<{ state: "waiting" | "ended"; clientName?: string; permission?: string; userCode?: string; expiresAt?: string }>("/api/online/device/preview", { request: note }).then((shown) => {
      if (shown.state !== "waiting") return setState("ended");
      setRequest({ clientName: shown.clientName!, permission: shown.permission!, userCode: shown.userCode!, expiresAt: shown.expiresAt! });
      setState("waiting");
    }, (error) => {
      if (statusOf(error) === 401) return setState("signed-out");
      setMessage(error instanceof Error ? error.message : String(error));
      setState("error");
    });
  }, [note]);

  async function decide(decision: "allow" | "deny") {
    setBusy(true);
    try {
      const result = await call<{ state: "allowed" | "denied" | "ended" }>("/api/online/device/decide", { request: note, decision });
      clearApproval();
      setState(result.state);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setState("error");
    } finally {
      setBusy(false);
    }
  }

  const frame = (title: string, body: ReactNode, actions?: ReactNode) => (
    <main className="web-screen">
      <AppHeaderMaybe signedIn={state !== "signed-out"} />
      <div className="web-wrap narrow">
        <section className="web-panel web-card" aria-labelledby="approve-title">
          <p className="web-eyebrow">Sign-in request</p>
          <h1 id="approve-title" className="web-h">{title}</h1>
          {body}
          {actions ? <div className="web-actions">{actions}</div> : null}
        </section>
      </div>
    </main>
  );

  if (!note) return frame("This approval link is incomplete", <p className="web-sub">Ask the agent to show its sign-in link again.</p>);
  if (state === "loading") return frame("Checking the request…", <p className="web-muted"><Loader2 size={14} className="spin" /> One moment.</p>);
  if (state === "signed-out") {
    return frame("Log in to answer this request", <p className="web-sub">An agent asked to use your Planban account. Log in on this device to see who is asking, then Allow or Deny.</p>,
      <button className="web-button dark" onClick={() => window.location.assign(signInPath("/approve"))}>Log in</button>);
  }
  if (state === "ended") return frame("This request has ended", <p className="web-sub">Requests last 10 minutes and can be answered once. Ask the agent to start again.</p>);
  if (state === "allowed") return frame("Allowed", <p className="web-sub">You can go back to {request?.clientName ?? "the agent"}. It signs in by itself in a moment.</p>);
  if (state === "denied") return frame("Denied", <p className="web-sub">{request?.clientName ?? "The agent"} can't use your account. Nothing else changed.</p>);
  if (state === "error" || !request) return frame("Couldn't answer this request", <p className="web-note" role="alert">{message}</p>);
  return frame(`Allow ${request.clientName}?`, (
    <>
      <p className="web-sub">{request.clientName} is asking to use your Planban account: {request.permission}</p>
      <div className="web-code-compare">
        <span>Check that the agent shows this code</span>
        <b>{request.userCode}</b>
      </div>
      <p className="web-muted">Only allow it if you started this. Your board permissions still apply, and you can cut it off any time from Connections.</p>
    </>
  ), (
    <>
      <button className="web-button" disabled={busy} onClick={() => void decide("deny")}>Deny</button>
      <button className="web-button dark" disabled={busy} onClick={() => void decide("allow")}>{busy ? <Loader2 size={13} className="spin" /> : null}Allow</button>
    </>
  ));
}

