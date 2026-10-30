// Live updates on the web (Planban 2.0 plan, phase 2): the page's
// subscription to a board's revision, against the service's real live query,
// live-token route and browser sessions, and the fallback checks that run only
// while the socket stays down.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryService, withServiceEnv } from "./hosted-harness";
import { boardPath, cardPath } from "../src/web/apiPaths";
import { FALLBACK_AFTER_MS, FALLBACK_EVERY_MS, FALLBACK_MAX_MS, watchHostedBoard, type LiveConnection } from "../src/web/hostedLive";
import type { HostedAdapter } from "../src/web/hostedAdapter";

const CLOUD = "https://native-315.convex.cloud.example";

async function withLiveTokens<T>(run: () => Promise<T>): Promise<T> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), kid: "test" };
  const prior = { key: process.env.PLANBAN_LIVE_SIGNING_KEY, cloud: process.env.CONVEX_CLOUD_URL };
  process.env.PLANBAN_LIVE_SIGNING_KEY = JSON.stringify(jwk);
  process.env.CONVEX_CLOUD_URL = CLOUD;
  try {
    return await run();
  } finally {
    if (prior.key === undefined) delete process.env.PLANBAN_LIVE_SIGNING_KEY; else process.env.PLANBAN_LIVE_SIGNING_KEY = prior.key;
    if (prior.cloud === undefined) delete process.env.CONVEX_CLOUD_URL; else process.env.CONVEX_CLOUD_URL = prior.cloud;
  }
}

/** Waits (boundedly) for something the watcher does after an awaited step, such as signing a live token. */
async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 400 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), `timed out waiting: ${what}`);
}

/** The service calls the watcher has made that haven't answered yet (see slow()). */
const inFlight = new Set<Promise<unknown>>();

/** Waits until the watcher is idle: its service calls have answered and what follows them has run. */
const settle = async () => {
  for (;;) {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    if (!inFlight.size) return;
    await Promise.allSettled([...inFlight]);
  }
};

/** Timers the test moves forward by hand. */
function manualTimers() {
  let now = 0;
  let id = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    timers: {
      setTimeout: (run: () => void, ms: number) => { pending.set(++id, { at: now + ms, run }); return id; },
      clearTimeout: (handle: unknown) => { pending.delete(handle as number); },
    },
    pendingDelays: () => [...pending.values()].map((entry) => entry.at - now).sort((a, b) => a - b),
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].run();
        await settle();
      }
      now = until;
    },
  };
}

function manualVisibility() {
  let hidden = false;
  const listeners = new Set<() => void>();
  return {
    visibility: { hidden: () => hidden, onChange: (run: () => void) => { listeners.add(run); return () => listeners.delete(run); } },
    set(value: boolean) {
      hidden = value;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * The Convex client as the watcher sees it. Like Convex, it authenticates
 * with the page's token (refreshing it when it nears expiry) and evaluates the
 * service's real live:revision query as the token's connection.
 */
function fakeConvex(service: ReturnType<typeof memoryService>) {
  let fetchToken: (() => Promise<string | null>) | null = null;
  let onAuthChange: ((authenticated: boolean) => void) | null = null;
  let token: string | null = null;
  const watchers = new Set<{ boardId: string; onValue: (value: { revision: number }) => void; onError: (error: Error) => void }>();
  const states = new Set<(state: { isWebSocketConnected: boolean }) => void>();
  const fake = { closed: false, closes: 0, urls: [] as string[] };
  const subject = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).sub as string;
  const makeConnection = (): LiveConnection => ({
    watchRevision(boardId, onValue, onError) {
      const entry = { boardId, onValue, onError };
      watchers.add(entry);
      return () => watchers.delete(entry);
    },
    setAuth(fetcher, onChange) {
      fetchToken = fetcher;
      onAuthChange = onChange;
    },
    subscribeToConnectionState(onState) {
      states.add(onState);
      return () => states.delete(onState);
    },
    async close() {
      fake.closed = true;
      fake.closes += 1;
      watchers.clear();
    },
  });
  return {
    fake,
    connect: async (url: string) => {
      fake.urls.push(url);
      fake.closed = false;
      return makeConnection();
    },
    /** Convex refused the token it was given. */
    reject() {
      onAuthChange!(false);
    },
    /** The socket opened or dropped. */
    socket(connected: boolean) {
      for (const state of states) state({ isWebSocketConnected: connected });
    },
    /** Convex asks for a (new) token, as it does on connecting and before one expires. */
    async refreshAuth() {
      token = await fetchToken!();
      if (!token) onAuthChange!(false);
      return token;
    },
    /** A change committed: every subscription's query runs again. */
    async push() {
      if (!token) await this.refreshAuth();
      if (!token) return;
      for (const watcher of [...watchers]) {
        try {
          watcher.onValue(await service.liveRevision(subject(token), watcher.boardId) as { revision: number });
        } catch (error) {
          watcher.onError(error as Error);
        }
      }
    },
    subject: () => (token ? subject(token) : null),
  };
}

async function ownerWithBoard() {
  const service = memoryService();
  const owner = await service.signIn("user_owner");
  const created = await service.browserSend(owner.token)("/api/v1/boards", { method: "POST", headers: { "X-Planban-Client": "web", "Content-Type": "application/json" }, body: JSON.stringify({ title: "Live board" }) });
  const { boardId } = await created.json() as { boardId: string };
  return { service, owner, boardId, adapter: slow(service.adapterFor(owner.token)) };
}

/**
 * Live tokens and revision checks take real time, as on a slow machine, and
 * settle() waits for them. So no test can pass by assuming one has answered
 * already, as a test on a fast machine might.
 */
function slow(adapter: HostedAdapter) {
  const tracked = <T,>(call: () => Promise<T>) => {
    const answer = new Promise((resolve) => setTimeout(resolve, 20)).then(call);
    inFlight.add(answer);
    void answer.finally(() => inFlight.delete(answer)).catch(() => undefined);
    return answer;
  };
  const liveToken = adapter.liveToken.bind(adapter);
  const revision = adapter.revision.bind(adapter);
  adapter.liveToken = () => tracked(liveToken);
  adapter.revision = (boardId) => tracked(() => revision(boardId));
  return adapter;
}

async function edit(adapter: HostedAdapter, boardId: string, title: string) {
  const state = await (await adapter.fetch(boardPath(boardId, "/state"))).json() as { roadmap: { revision: number } };
  const response = await adapter.fetch(boardPath(boardId, "/cards"), { method: "POST", body: JSON.stringify({ title, baseRevision: state.roadmap.revision }) });
  assert.equal(response.status, 200);
  return (await response.json() as { roadmap: { revision: number } }).roadmap.revision;
}

function watch(adapter: HostedAdapter, boardId: string, convex: ReturnType<typeof fakeConvex>, extra: Partial<Parameters<typeof watchHostedBoard>[0]> = {}) {
  const revisions: number[] = [];
  const lost: Error[] = [];
  const watcher = watchHostedBoard({
    boardId,
    knownRevision: 1,
    liveToken: () => adapter.liveToken(),
    revision: (id) => adapter.revision(id),
    onRevision: (revision) => revisions.push(revision),
    onLost: (error) => lost.push(error),
    connect: convex.connect,
    ...extra,
  });
  return { watcher, revisions, lost };
}

test("a committed change arrives as the board's new revision, once, over the service's own address", async () => {
  await withServiceEnv(() => withLiveTokens(async () => {
    const { service, owner, boardId, adapter } = await ownerWithBoard();
    const convex = fakeConvex(service);
    const { watcher, revisions, lost } = watch(adapter, boardId, convex, { timers: manualTimers().timers, visibility: manualVisibility().visibility });
    await until(() => convex.fake.urls.length >= 1, "the live connection");
    assert.deepEqual(convex.fake.urls, [CLOUD], "straight to Convex, not through the Worker");
    convex.socket(true);
    await convex.push();
    assert.deepEqual(revisions, [], "the revision already shown doesn't reload the board");
    assert.equal(convex.subject(), owner.connectionId, "the token acts as this browser's own session");
    const revision = await edit(adapter, boardId, "New card");
    await convex.push();
    await convex.push();
    assert.deepEqual(revisions, [revision]);
    assert.deepEqual(lost, []);
    watcher.close();
    await settle();
    assert.equal(convex.fake.closed, true);
  }));
});

test("removed from the board: the subscription ends, and reloading shows the board is gone", async () => {
  await withServiceEnv(() => withLiveTokens(async () => {
    const { service, owner, boardId, adapter } = await ownerWithBoard();
    // People join after they've signed in to Planban.
    const editor = slow(service.adapterFor((await service.signIn("user_editor")).token));
    await service.browserSend(owner.token)(`/api/v1/boards/${boardId}/members`, { method: "POST", headers: { "X-Planban-Client": "web", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "user_editor", role: "editor" }) });
    const convex = fakeConvex(service);
    const { lost } = watch(editor, boardId, convex, { timers: manualTimers().timers, visibility: manualVisibility().visibility });
    await until(() => convex.fake.urls.length >= 1, "the live connection");
    convex.socket(true);
    await convex.push();
    assert.deepEqual(lost, []);
    const removed = await adapter.fetch(boardPath(boardId, "/online/members/user_editor/remove"), { method: "POST", body: "{}" });
    assert.equal(removed.status, 200);
    await convex.push();
    await settle();
    assert.equal(lost.length, 1);
    assert.equal(convex.fake.closed, true, "the watcher stops for good");
    const reload = await editor.fetch(boardPath(boardId, "/state"));
    assert.equal(reload.status, 404);
  }));
});

test("a revoked browser session ends the subscription, and the board shows signed out", async () => {
  await withServiceEnv(() => withLiveTokens(async () => {
    const { service, boardId, adapter } = await ownerWithBoard();
    const laptop = slow(service.adapterFor((await service.signIn("user_owner")).token));
    const convex = fakeConvex(service);
    const { lost } = watch(laptop, boardId, convex, { timers: manualTimers().timers, visibility: manualVisibility().visibility });
    await until(() => convex.fake.urls.length >= 1, "the live connection");
    convex.socket(true);
    await convex.push();
    // Sign out other devices, from the first browser.
    const revoked = await adapter.fetch("/api/online/connections/revoke-others", { method: "POST", body: "{}" });
    assert.deepEqual(await revoked.json(), { revoked: 1, complete: true });
    await convex.push();
    await settle();
    assert.equal(lost.length, 1);
    const reload = await laptop.fetch(boardPath(boardId, "/state"));
    assert.equal(reload.status, 401);
    assert.equal((await reload.json() as { signInNeeded?: string }).signInNeeded !== undefined, true);
  }));
});

test("token expiry: a new token comes only while the browser session lasts", async () => {
  await withServiceEnv(() => withLiveTokens(async () => {
    const { service, owner, boardId, adapter } = await ownerWithBoard();
    const convex = fakeConvex(service);
    const { revisions, lost } = watch(adapter, boardId, convex, { timers: manualTimers().timers, visibility: manualVisibility().visibility });
    await until(() => convex.fake.urls.length >= 1, "the live connection");
    convex.socket(true);
    await convex.push();
    // Convex asks again before each 5-minute token expires; the session is still good.
    assert.match((await convex.refreshAuth()) ?? "", /^[\w-]+\.[\w-]+\.[\w-]+$/);
    const revision = await edit(adapter, boardId, "Still live");
    await convex.push();
    assert.deepEqual(revisions, [revision]);
    // The browser's 7 days are up: the next token is refused and watching ends.
    const row = service.rows.find((entry) => entry._id === owner.connectionId);
    row.expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal(await convex.refreshAuth(), null);
    assert.ok(lost.length >= 1);
    assert.equal(convex.fake.closed, true);
    const reload = await adapter.fetch(boardPath(boardId, "/state"));
    assert.equal(reload.status, 401, "the board shows signed out");
  }));
});

test("fallback checks start only after the socket stays down, back off, pause in hidden tabs, and stop on reconnect", async () => {
  await withServiceEnv(() => withLiveTokens(async () => {
    const { service, boardId, adapter } = await ownerWithBoard();
    const convex = fakeConvex(service);
    const clock = manualTimers();
    const tab = manualVisibility();
    let checks = 0;
    const { revisions } = watch(adapter, boardId, convex, {
      timers: clock.timers, visibility: tab.visibility,
      revision: (id) => { checks += 1; return adapter.revision(id); },
    });
    await until(() => convex.fake.urls.length >= 1, "the live connection");
    // Never connected yet: nothing for the first 15 seconds.
    await clock.advance(FALLBACK_AFTER_MS - 1);
    assert.equal(checks, 0);
    convex.socket(true);
    await clock.advance(60_000);
    assert.equal(checks, 0, "a connected socket needs no checks");

    convex.socket(false);
    await clock.advance(FALLBACK_AFTER_MS - 1);
    assert.equal(checks, 0, "a brief drop doesn't start checks");
    await clock.advance(1);
    assert.equal(checks, 1);
    assert.deepEqual(clock.pendingDelays(), [FALLBACK_EVERY_MS * 2], "nothing changed, so the next check backs off");
    await clock.advance(FALLBACK_EVERY_MS * 2);
    assert.equal(checks, 2);
    assert.deepEqual(clock.pendingDelays(), [FALLBACK_EVERY_MS * 4]);

    const revision = await edit(adapter, boardId, "Changed while offline");
    await clock.advance(FALLBACK_EVERY_MS * 4);
    assert.equal(checks, 3);
    assert.deepEqual(revisions, [revision]);
    assert.deepEqual(clock.pendingDelays(), [FALLBACK_EVERY_MS], "a change resets the pace");

    // Hidden: no checks at all; visible again: one at once.
    tab.set(true);
    await clock.advance(FALLBACK_MAX_MS * 3);
    assert.equal(checks, 3, "the check that was due finds the tab hidden and waits");
    const paused = checks;
    await clock.advance(FALLBACK_MAX_MS * 3);
    assert.equal(checks, paused);
    tab.set(false);
    await settle();
    assert.equal(checks, paused + 1);

    convex.socket(true);
    const before = checks;
    await clock.advance(FALLBACK_MAX_MS * 3);
    assert.equal(checks, before, "reconnected: checks stop");
    assert.deepEqual(clock.pendingDelays(), []);
  }));
});

test("without live updates configured, the page checks every 15 seconds; a removal found by a check ends watching", async () => {
  await withServiceEnv(async () => {
    const { service, owner, boardId, adapter } = await ownerWithBoard();
    // People join after they've signed in to Planban.
    const viewer = slow(service.adapterFor((await service.signIn("user_viewer")).token));
    await service.browserSend(owner.token)(`/api/v1/boards/${boardId}/members`, { method: "POST", headers: { "X-Planban-Client": "web", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "user_viewer", role: "viewer" }) });
    assert.equal(await viewer.liveToken(), null);
    const convex = fakeConvex(service);
    const clock = manualTimers();
    const { revisions, lost } = watch(viewer, boardId, convex, { timers: clock.timers, visibility: manualVisibility().visibility });
    await settle();
    assert.deepEqual(convex.fake.urls, [], "no socket to open");
    assert.deepEqual(clock.pendingDelays(), [FALLBACK_EVERY_MS]);
    const revision = await edit(adapter, boardId, "Seen by checking");
    await clock.advance(FALLBACK_EVERY_MS);
    assert.deepEqual(revisions, [revision]);
    await adapter.fetch(boardPath(boardId, "/online/members/user_viewer/remove"), { method: "POST", body: "{}" });
    await clock.advance(FALLBACK_MAX_MS);
    assert.equal(lost.length, 1);
    assert.deepEqual(clock.pendingDelays(), [], "no more checks");
    assert.equal((await viewer.fetch(cardPath(boardId, "x", "/docs/spec"))).status, 404);
  });
});

test("a first live connection that fails for a moment is tried again, and checks run meanwhile", async () => {
  await withServiceEnv(() => withLiveTokens(async () => {
    const { service, boardId, adapter } = await ownerWithBoard();
    const convex = fakeConvex(service);
    const clock = manualTimers();
    let tokenRequests = 0;
    let offline = true;
    let checks = 0;
    const { lost } = watch(adapter, boardId, convex, {
      timers: clock.timers, visibility: manualVisibility().visibility,
      liveToken: async () => {
        tokenRequests += 1;
        if (offline) throw new TypeError("Failed to fetch");
        return adapter.liveToken();
      },
      revision: (id) => { checks += 1; return adapter.revision(id); },
    });
    await settle();
    assert.equal(tokenRequests, 1);
    assert.deepEqual(convex.fake.urls, []);
    offline = false;
    await clock.advance(FALLBACK_EVERY_MS);
    assert.ok(checks >= 1, "checks run while there is no socket");
    assert.equal(tokenRequests, 2, "the live connection is tried again");
    await until(() => convex.fake.urls.length === 1, "the live connection");
    assert.deepEqual(convex.fake.urls, [CLOUD]);
    convex.socket(true);
    assert.deepEqual(lost, []);
  }));
});

test("a token renewal that fails for a moment is not taken as signing out; watching carries on", async () => {
  await withServiceEnv(() => withLiveTokens(async () => {
    const { service, boardId, adapter } = await ownerWithBoard();
    const convex = fakeConvex(service);
    const clock = manualTimers();
    let offline = false;
    const { revisions, lost } = watch(adapter, boardId, convex, {
      timers: clock.timers, visibility: manualVisibility().visibility,
      liveToken: async () => {
        if (offline) throw new TypeError("Failed to fetch");
        return adapter.liveToken();
      },
    });
    await until(() => convex.fake.urls.length === 1, "the live connection");
    convex.socket(true);
    await convex.push();
    offline = true;
    assert.equal(await convex.refreshAuth(), null);
    await settle();
    assert.deepEqual(lost, [], "a network blip is not a signed-out browser");
    assert.equal(convex.fake.closed, true, "the old connection is dropped");
    offline = false;
    const revision = await edit(adapter, boardId, "Seen after the blip");
    await clock.advance(FALLBACK_MAX_MS);
    assert.ok(revisions.includes(revision), "checks or the new connection pick the change up");
    await until(() => convex.fake.urls.length === 2, "the live connection starts again");
    assert.deepEqual(lost, []);
  }));
});

test("a subscription error while the service still lets the person in starts the connection again", async () => {
  await withServiceEnv(() => withLiveTokens(async () => {
    const { service, boardId, adapter } = await ownerWithBoard();
    const convex = fakeConvex(service);
    const clock = manualTimers();
    let failQuery = false;
    const realRevision = service.liveRevision;
    service.liveRevision = async (...args: Parameters<typeof realRevision>) => {
      if (failQuery) throw new Error("Unauthenticated: the token was not ready");
      return realRevision(...args);
    };
    const { lost } = watch(adapter, boardId, convex, { timers: clock.timers, visibility: manualVisibility().visibility });
    await until(() => convex.fake.urls.length >= 1, "the live connection");
    convex.socket(true);
    failQuery = true;
    await convex.push();
    await settle();
    assert.deepEqual(lost, [], "the service says the board is still readable");
    failQuery = false;
    await clock.advance(FALLBACK_EVERY_MS);
    await until(() => convex.fake.urls.length === 2, "the live connection starts again");
  }));
});

test("a slow check about an old connection never closes the connection that replaced it", async () => {
  await withServiceEnv(() => withLiveTokens(async () => {
    const { service, boardId, adapter } = await ownerWithBoard();
    const convex = fakeConvex(service);
    const clock = manualTimers();
    let hold: ((value: number) => void) | null = null;
    const { lost } = watch(adapter, boardId, convex, {
      timers: clock.timers, visibility: manualVisibility().visibility,
      revision: (id) => hold === null && checksHeld ? new Promise<number>((resolve) => { hold = resolve; }) : adapter.revision(id),
    });
    let checksHeld = false;
    await until(() => convex.fake.urls.length >= 1, "the live connection");
    convex.socket(true);
    await convex.push();
    // The subscription fails; the check that follows is slow.
    checksHeld = true;
    const realRevision = service.liveRevision;
    service.liveRevision = async () => { throw new Error("subscription failed"); };
    await convex.push();
    service.liveRevision = realRevision;
    checksHeld = false;
    // Meanwhile the token is refused, and a new connection starts and works.
    convex.reject();
    await clock.advance(FALLBACK_EVERY_MS);
    await until(() => convex.fake.urls.length === 2, "the new connection");
    convex.socket(true);
    const closesBefore = convex.fake.closes;
    hold!(1);
    await settle();
    assert.equal(convex.fake.closes, closesBefore, "the new connection stays open");
    assert.deepEqual(lost, []);
  }));
});

test("tokens refused again and again back off instead of retrying every 15 seconds", async () => {
  await withServiceEnv(() => withLiveTokens(async () => {
    const { service, boardId, adapter } = await ownerWithBoard();
    const convex = fakeConvex(service);
    const clock = manualTimers();
    watch(adapter, boardId, convex, { timers: clock.timers, visibility: manualVisibility().visibility });
    await until(() => convex.fake.urls.length >= 1, "the live connection");
    const delays: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      // Each refusal goes to the connection that is current at the time; an
      // older one's is ignored, so wait for the new one to start first.
      await until(() => convex.fake.urls.length === round + 1, `connection ${round + 1}`);
      convex.socket(true);
      convex.reject();
      await settle();
      // Left pending: the fallback check, which starts after 15 seconds, and the next connection's start.
      const pending = clock.pendingDelays();
      assert.equal(pending.length, 2, `round ${round}: ${pending}`);
      assert.equal(pending[0], FALLBACK_AFTER_MS);
      delays.push(pending[1]!);
      await clock.advance(pending[1]!);
    }
    await until(() => convex.fake.urls.length === 5, "connection 5");
    assert.deepEqual(delays, [FALLBACK_EVERY_MS, FALLBACK_EVERY_MS * 2, FALLBACK_EVERY_MS * 4, FALLBACK_EVERY_MS * 8]);
  }));
});
