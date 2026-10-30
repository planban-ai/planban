// Live updates on the web (Planban 2.0 plan, "Traffic budget"). The page
// subscribes to the board's revision straight from Convex over its WebSocket,
// not through the Worker, and the local page's 200 ms poll is off. Only after
// the socket has stayed disconnected does a fallback check run: every 15
// seconds, backing off while nothing changes, and paused in hidden tabs.
//
// A subscription that ends for good (signed out, the sign-in revoked or
// expired, removed from the board) stops everything and tells the page, which
// reloads the board to show why.
import { checkedConvexUrl } from "../core/online/convexUrl";
import { HostedServiceError, type LiveToken } from "./hostedAdapter";

export const FALLBACK_AFTER_MS = 15_000;
export const FALLBACK_EVERY_MS = 15_000;
export const FALLBACK_MAX_MS = 120_000;

/** The part of the Convex client the watcher uses. */
export interface LiveConnection {
  watchRevision(boardId: string, onValue: (value: { revision: number }) => void, onError: (error: Error) => void): () => void;
  setAuth(fetchToken: () => Promise<string | null>, onChange: (authenticated: boolean) => void): void;
  subscribeToConnectionState(onState: (state: { isWebSocketConnected: boolean }) => void): () => void;
  close(): Promise<void>;
}

export interface HostedLiveOptions {
  boardId: string;
  /** The revision the page already shows, so the first update doesn't reload it. */
  knownRevision?: number;
  liveToken(): Promise<LiveToken | null>;
  revision(boardId: string): Promise<number>;
  onRevision(revision: number): void;
  /** The live connection ended for good; the page reloads the board to find out why. */
  onLost(error: Error): void;
  connect?(convexUrl: string): Promise<LiveConnection>;
  timers?: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  visibility?: { hidden(): boolean; onChange(run: () => void): () => void };
}

/** Refusals that mean the person can no longer watch this board, as opposed to a network blip. */
export function endsWatching(error: unknown): boolean {
  return error instanceof HostedServiceError && (error.status === 401 || error.status === 403 || error.status === 404);
}

async function convexConnection(convexUrl: string): Promise<LiveConnection> {
  const { ConvexClient } = await import("convex/browser");
  const client = new ConvexClient(checkedConvexUrl(convexUrl), { unsavedChangesWarning: false });
  return {
    watchRevision: (boardId, onValue, onError) => client.onUpdate("live:revision" as never, { boardId } as never, onValue as never, onError),
    setAuth: (fetchToken, onChange) => client.setAuth(async () => (await fetchToken()) ?? null, onChange),
    subscribeToConnectionState: (onState) => client.subscribeToConnectionState(onState),
    close: () => client.close(),
  };
}

const browserVisibility = {
  hidden: () => typeof document !== "undefined" && document.hidden,
  onChange(run: () => void) {
    document.addEventListener("visibilitychange", run);
    return () => document.removeEventListener("visibilitychange", run);
  },
};

export function watchHostedBoard(options: HostedLiveOptions): { close(): void } {
  const timers = options.timers ?? { setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as number) };
  const visibility = options.visibility ?? browserVisibility;
  let closed = false;
  /** The live connection, and what to undo when it is dropped. */
  let connection: LiveConnection | null = null;
  const connectionCleanups: Array<() => void> = [];
  const cleanups: Array<() => void> = [];
  let lastRevision: number | null = options.knownRevision ?? null;
  /** True while there is no working socket: never connected, or disconnected. */
  let socketDown = true;
  let fallbackTimer: unknown = null;
  let fallbackDelay = FALLBACK_EVERY_MS;
  let checking = false;
  /** Retrying the live connection itself, after it could not start or stopped authenticating. */
  let startTimer: unknown = null;
  let startDelay = FALLBACK_EVERY_MS;

  const seen = (revision: number) => {
    if (closed) return false;
    const changed = revision !== lastRevision;
    lastRevision = revision;
    if (changed) options.onRevision(revision);
    return changed;
  };

  function dropConnection() {
    for (const cleanup of connectionCleanups.splice(0)) cleanup();
    const ending = connection;
    connection = null;
    void ending?.close().catch(() => undefined);
  }

  function stop() {
    closed = true;
    for (const timer of [fallbackTimer, startTimer]) if (timer !== null) timers.clearTimeout(timer);
    fallbackTimer = null;
    startTimer = null;
    dropConnection();
    for (const cleanup of cleanups.splice(0)) cleanup();
  }

  function lost(error: Error) {
    if (closed) return;
    stop();
    options.onLost(error);
  }

  /**
   * Something went wrong that only the service can judge. Its own answer
   * decides: signed out, revoked or removed ends watching; anything else is
   * temporary, so the page keeps checking and the live connection starts again.
   */
  async function confirm(error: Error, stillCurrent: () => boolean) {
    if (!stillCurrent()) return;
    try {
      seen(await options.revision(options.boardId));
    } catch (refusal) {
      if (endsWatching(refusal)) return lost(refusal as Error);
    }
    if (endsWatching(error)) return lost(error);
    // A newer connection may have started meanwhile; this answer is only about the old one.
    if (stillCurrent()) retryLater();
  }

  /** The live connection is unavailable for now: check occasionally, and try it again with backoff. */
  function retryLater() {
    if (closed) return;
    dropConnection();
    socketState(false);
    if (startTimer !== null) return;
    startTimer = timers.setTimeout(() => {
      startTimer = null;
      void start();
    }, startDelay);
    startDelay = Math.min(startDelay * 2, FALLBACK_MAX_MS);
  }

  function schedule(ms: number) {
    if (closed || fallbackTimer !== null) return;
    fallbackTimer = timers.setTimeout(() => {
      fallbackTimer = null;
      void check();
    }, ms);
  }

  /** One fallback check, while the socket is down and the tab is visible. */
  async function check() {
    if (closed || !socketDown || checking) return;
    // A hidden tab waits; becoming visible checks at once.
    if (visibility.hidden()) return;
    checking = true;
    try {
      const changed = seen(await options.revision(options.boardId));
      fallbackDelay = changed ? FALLBACK_EVERY_MS : Math.min(fallbackDelay * 2, FALLBACK_MAX_MS);
    } catch (error) {
      if (endsWatching(error)) return lost(error as Error);
      fallbackDelay = Math.min(fallbackDelay * 2, FALLBACK_MAX_MS);
    } finally {
      checking = false;
    }
    if (socketDown) schedule(fallbackDelay);
  }

  function socketState(connected: boolean) {
    if (closed) return;
    if (connected) {
      socketDown = false;
      fallbackDelay = FALLBACK_EVERY_MS;
      if (fallbackTimer !== null) timers.clearTimeout(fallbackTimer);
      fallbackTimer = null;
      return;
    }
    if (socketDown && fallbackTimer !== null) return;
    socketDown = true;
    // Only a socket that stays down starts the checks.
    schedule(FALLBACK_AFTER_MS);
  }

  cleanups.push(visibility.onChange(() => {
    if (closed || visibility.hidden() || !socketDown) return;
    if (fallbackTimer !== null) timers.clearTimeout(fallbackTimer);
    fallbackTimer = null;
    void check();
  }));

  async function start() {
    if (closed) return;
    let first: LiveToken | null;
    try {
      first = await options.liveToken();
    } catch (error) {
      if (endsWatching(error)) return lost(error as Error);
      // The service is unreachable for now.
      return retryLater();
    }
    if (closed) return;
    if (!first) {
      // This service offers no live updates: the occasional check is all there is.
      socketDown = true;
      schedule(FALLBACK_EVERY_MS);
      return;
    }
    let live: LiveConnection;
    try {
      live = await (options.connect ?? convexConnection)(first.convexUrl);
    } catch {
      return retryLater();
    }
    if (closed) {
      void live.close().catch(() => undefined);
      return;
    }
    connection = live;
    const current = () => !closed && connection === live;
    let pending: string | null = first.token;
    live.setAuth(async () => {
      if (pending) {
        const token = pending;
        pending = null;
        return token;
      }
      // Tokens last minutes; each new one is checked against the browser session.
      try {
        return (await options.liveToken())?.token ?? null;
      } catch (error) {
        if (endsWatching(error) && current()) lost(error as Error);
        return null;
      }
    }, (authenticated) => {
      if (!current()) return;
      if (authenticated) startDelay = FALLBACK_EVERY_MS;
      // No token now: a failed renewal ends watching above; anything else starts again.
      else retryLater();
    });
    // Counted as down until the socket says it's connected, so one that never connects still gets checks.
    socketState(false);
    connectionCleanups.push(live.subscribeToConnectionState((state) => {
      if (current()) socketState(state.isWebSocketConnected);
    }));
    connectionCleanups.push(live.watchRevision(options.boardId, (value) => {
      if (!current()) return;
      // An answer from the subscription proves the connection works; restarts begin again at the short pause.
      startDelay = FALLBACK_EVERY_MS;
      seen(value.revision);
    }, (error) => {
      if (current()) void confirm(error, current);
    }));
  }

  void start();
  return { close: stop };
}
