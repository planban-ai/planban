// The hosted transport (Planban 2.0 plan, "How the page talks to the
// service"). The board page keeps calling its own routes; on the web this
// adapter answers them from the online service's /api/v1, in the shapes the
// local server answers with. The route table below is the written contract:
// for each page route, what the page sends, what the service is asked, and
// what the page gets back. Anything not in the table is a computer-only
// feature and is refused without contacting the service.
//
// Edits:
// - carry the baseRevision the person saw, exactly as the page sent it;
// - Spec and Plan writes carry the expectedMtimeMs the page read, never a
//   fresher one, and return the service's result.doc unchanged;
// - each logical edit has one service-compatible Idempotency-Key, and a retry
//   after a lost response resends that key with the byte-identical body, so
//   the service applies it at most once and returns the original result.
//
// Errors come back in the page's shape, { error: message }, with the service's
// code and, for conflicts, currentRevision. A service validation error (400)
// becomes the page's 422; a missing or ended browser session (401) carries
// signInNeeded, so the page shows its signed-out screen.
import type { PlanbanRoadmap } from "../core/types";
import { boardOnlyStaleness, type StalenessSignal } from "../core/staleness";

/** One request to the online service, at a path under its own address. */
export type ServiceSend = (path: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface HostedAdapterOptions {
  /** The service's public address, which is also the page's own. */
  origin: string;
  /** How requests reach the service; the browser's fetch by default. */
  send?: ServiceSend;
  /** The pause before resending an edit whose response was lost. */
  retryDelayMs?: number;
  /** How long one attempt may take before it counts as lost (20 seconds unless set). */
  attemptTimeoutMs?: number;
}

export type BoardRole = "owner" | "editor" | "viewer";

/** A board as the hosted page knows it: what the local server's state carries, plus the person's role. */
export interface HostedBoardState {
  cwd: string;
  manifestPath: string;
  agentContextPath: string;
  planningRoot: string;
  roadmapPath: string;
  manifest: { version: 1; repoId: string; enabled: true; storage: { kind: "online"; url: string; boardId: string } };
  roadmap: PlanbanRoadmap;
  hosted: { boardId: string; role: BoardRole | null; authority: string | null };
  onlineReplay?: { replayed: true; originalRevision?: number };
  staleness?: { cards: Record<string, StalenessSignal[]>; notes?: string[] };
}

/**
 * Freshness from the board alone: the web page has no git or GitHub, so merges come only from the
 * landing notes a board with a linked GitHub repository records itself, and a note says when a card
 * names a pull request nothing checks. The board shows the notes that need a person.
 */
function pageStaleness(roadmap: PlanbanRoadmap, repos: { linkedRepos: string[]; homeRepo: string | null } = { linkedRepos: [], homeRepo: null }) {
  const { cards, notes } = boardOnlyStaleness(roadmap.roadmapItems, Date.now(), [], repos.linkedRepos, repos.homeRepo);
  return { cards, ...(notes?.length ? { notes } : {}) };
}

export interface LiveToken {
  token: string;
  expiresAt: string;
  convexUrl: string;
}

/** A service answer that was not a success. */
export class HostedServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "HostedServiceError";
  }
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/** One key per logical edit, in the form the service accepts: letters, digits, _ and -. */
export function newIdempotencyKey(): string {
  return `web_${crypto.randomUUID()}`;
}

export const WEB_ONLY_MESSAGE = "This part of Planban works only in the app on your computer.";

interface PageReply {
  status: number;
  body: unknown;
}

interface Route {
  method: string;
  /** Page path segments after /api/; ":name" captures one segment. */
  pattern: string[];
  handle: (params: Record<string, string>, request: PageRequest) => Promise<PageReply>;
}

interface PageRequest {
  url: URL;
  body: Record<string, unknown>;
  key: string;
  signal?: AbortSignal;
}

const reply = (body: unknown, status = 200): PageReply => ({ status, body });
const refuse = (status: number, error: string): PageReply => reply({ error }, status);

function serviceBoard(boardId: string, suffix = "") {
  return `/api/v1/boards/${encodeURIComponent(boardId)}${suffix}`;
}

function historyVersion(value: string): number | null {
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

const docKind = (value: string) => (value === "spec" || value === "plan" ? value : null);
/** Segments the service would refuse; refused here first, so they never look like a sign-in problem. */
const unsafeId = (value: string) => value === "." || value === ".." || value.includes("/") || value.includes("\\");

export function createHostedAdapter(options: HostedAdapterOptions) {
  const origin = options.origin.replace(/\/+$/, "");
  const send: ServiceSend = options.send ?? ((path, init) => fetch(`${origin}${path}`, {
    ...init,
    credentials: "same-origin",
    redirect: "error",
  }));
  const retryDelayMs = options.retryDelayMs ?? 500;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 20_000;
  /** The person's role on each board, from the last time the service said. */
  const roles = new Map<string, { role: BoardRole | null; authority: string | null }>();
  // The GitHub repositories each board links, from its last read: their merges show on the page.
  const linked = new Map<string, { linkedRepos: string[]; homeRepo: string | null }>();

  /**
   * Calls the service. A request that fails on the network is resent once
   * only when that is safe: reads, and edits with an Idempotency-Key, which
   * go again with the same key and the same bytes.
   */
  async function call(method: "GET" | "POST", path: string, body?: unknown, extra: { key?: string; signal?: AbortSignal } = {}): Promise<Response> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      "X-Planban-Client": "web",
      ...(text === undefined ? {} : { "Content-Type": "application/json" }),
      ...(extra.key ? { "Idempotency-Key": extra.key } : {}),
    };
    // The whole answer is read inside each attempt: a connection that drops
    // while the body arrives is a lost response too, and is resent the same way.
    // Each attempt has its own time limit: a request that stalls (one was seen on staging) is lost, not pending forever.
    const attempt = async () => {
      const limit = AbortSignal.timeout(attemptTimeoutMs);
      const signal = extra.signal ? AbortSignal.any([extra.signal, limit]) : limit;
      const response = await send(path, { method, headers, ...(text === undefined ? {} : { body: text }), signal });
      const answer = await response.text();
      const empty = response.status === 204 || response.status === 205 || response.status === 304;
      return new Response(empty ? null : answer, { status: response.status, headers: response.headers });
    };
    try {
      return await attempt();
    } catch (error) {
      if ((method !== "GET" && !extra.key) || extra.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      return attempt();
    }
  }

  /** The page's error shape for a service refusal. */
  async function pageError(response: Response): Promise<PageReply> {
    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    const data = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : {};
    const message = typeof data.message === "string" ? data.message
      : typeof payload.error === "string" ? payload.error
        : `Planban Online answered ${response.status}.`;
    const body: Record<string, unknown> = { error: message };
    if (typeof data.code === "string") body.code = data.code;
    if (typeof data.currentRevision === "number") body.currentRevision = data.currentRevision;
    // A refused edit: what changed, by whom, and the current value or document, so the page can show theirs beside yours.
    if (data.conflict && typeof data.conflict === "object") body.conflict = data.conflict;
    // Invitations say why they can't be used, so the page can show the matching screen.
    if (typeof data.reason === "string") body.reason = data.reason;
    if (typeof data.sentTo === "string") body.sentTo = data.sentTo;
    if (response.status === 401) {
      body.signInNeeded = origin;
      body.signedOut = "missing";
    }
    return reply(body, response.status === 400 ? 422 : response.status);
  }

  /** Reads a service answer: its JSON on success, or the page's error. */
  async function read<T>(response: Response): Promise<{ ok: true; value: T } | { ok: false; reply: PageReply }> {
    if (!response.ok) return { ok: false, reply: await pageError(response) };
    return { ok: true, value: await response.json() as T };
  }

  async function get<T>(path: string, request?: PageRequest) {
    return read<T>(await call("GET", path, undefined, request?.signal ? { signal: request.signal } : {}));
  }

  function boardState(boardId: string, roadmap: PlanbanRoadmap): HostedBoardState {
    const known = roles.get(boardId);
    return {
      cwd: "",
      manifestPath: "",
      agentContextPath: "",
      planningRoot: "",
      roadmapPath: "",
      manifest: { version: 1, repoId: boardId, enabled: true, storage: { kind: "online", url: origin, boardId } },
      roadmap,
      hosted: { boardId, role: known?.role ?? null, authority: known?.authority ?? null },
    };
  }

  /** Runs one board operation; the page gets the board as it is after it. */
  async function op(boardId: string, name: string, input: Record<string, unknown>, request: PageRequest) {
    // A browser session is always the person, never their agent, so the page's edits are recorded as theirs.
    const response = await call("POST", serviceBoard(boardId, `/ops/${encodeURIComponent(name)}`), { ...input, actor: "user" }, { key: request.key, ...(request.signal ? { signal: request.signal } : {}) });
    return read<{ roadmap: PlanbanRoadmap; result: Record<string, unknown> | undefined; replayed?: boolean; originalRevision?: number }>(response);
  }

  async function opState(boardId: string, name: string, input: Record<string, unknown>, request: PageRequest, withResult = false): Promise<PageReply> {
    const outcome = await op(boardId, name, input, request);
    if (!outcome.ok) return outcome.reply;
    const { roadmap, result, replayed, originalRevision } = outcome.value;
    const state: HostedBoardState & Record<string, unknown> = { ...boardState(boardId, roadmap), staleness: pageStaleness(roadmap, linked.get(boardId)), ...(withResult && result ? result : {}) };
    if (replayed) state.onlineReplay = { replayed: true, ...(originalRevision === undefined ? {} : { originalRevision }) };
    return reply(state);
  }

  /** Fields the page sends that the service must not see. */
  function edit(body: Record<string, unknown>, fields: Record<string, unknown>) {
    const { cwd: _cwd, idempotencyKey: _key, ...rest } = body;
    return { ...rest, ...fields };
  }

  async function loadBoard(boardId: string, request?: PageRequest): Promise<PageReply> {
    const board = await get<{ roadmap: PlanbanRoadmap; authority?: string; role?: BoardRole; linkedRepos?: string[]; homeRepo?: string }>(serviceBoard(boardId), request);
    if (!board.ok) return board.reply;
    roles.set(boardId, { role: board.value.role ?? roles.get(boardId)?.role ?? null, authority: board.value.authority ?? null });
    linked.set(boardId, { linkedRepos: board.value.linkedRepos ?? [], homeRepo: board.value.homeRepo ?? null });
    return reply({ ...boardState(boardId, board.value.roadmap), staleness: pageStaleness(board.value.roadmap, linked.get(boardId)) });
  }

  const routes: Route[] = [
    // The page's start-up check: on the web there is always somewhere to go.
    { method: "GET", pattern: ["status"], handle: async () => reply({ initialized: true, currentRepoId: null }) },

    // Every board this person can open, with the dashboard's summary of each.
    {
      method: "GET", pattern: ["boards"], handle: async (_params, request) => {
        const listed = await get<{ boards: Array<Record<string, unknown> & { boardId: string; title: string; role: BoardRole; authority: string; lastChangedAt: string }> }>("/api/v1/boards", request);
        if (!listed.ok) return listed.reply;
        for (const board of listed.value.boards) roles.set(board.boardId, { role: board.role, authority: board.authority });
        return reply({
          currentRepoId: null,
          boards: listed.value.boards.map((board) => ({
            repoId: board.boardId, title: board.title, cwd: "", planningRoot: "", roadmapPath: "", manifestPath: "",
            lastOpenedAt: board.lastChangedAt, updatedAt: board.lastChangedAt, online: board,
          })),
        });
      },
    },

    // New board: an empty online board owned by the person (within their board limits).
    {
      method: "POST", pattern: ["boards"], handle: async (_params, request) => {
        const created = await read<{ boardId: string; title: string; revision: number }>(await call("POST", "/api/v1/boards", { title: typeof request.body.title === "string" ? request.body.title : "" }, request.signal ? { signal: request.signal } : {}));
        if (!created.ok) return created.reply;
        roles.set(created.value.boardId, { role: "owner", authority: "online" });
        return reply({ board: { repoId: created.value.boardId, title: created.value.title } });
      },
    },

    // Live updates come from the service's own subscription (hostedLive.ts), never this poll.
    { method: "GET", pattern: ["live"], handle: async () => reply({ liveVersion: 0, stateVersion: 0, boardsVersion: 0, activityVersion: 0, activities: [] }) },

    // The board: GET /boards/:id; the page's state.
    { method: "GET", pattern: ["boards", ":board", "state"], handle: async ({ board }, request) => loadBoard(board!, request) },

    // Creating: createCard, createGroup and createCards; the state carries what was created.
    { method: "POST", pattern: ["boards", ":board", "cards"], handle: async ({ board }, request) => opState(board!, "createCard", edit(request.body, {}), request, true) },
    { method: "POST", pattern: ["boards", ":board", "groups"], handle: async ({ board }, request) => opState(board!, "createGroup", groupInput(request.body), request, true) },
    { method: "POST", pattern: ["boards", ":board", "programmes"], handle: async ({ board }, request) => opState(board!, "createGroup", groupInput(request.body), request, true) },
    { method: "POST", pattern: ["boards", ":board", "cards", "batch"], handle: async ({ board }, request) => opState(board!, "createCards", edit(request.body, {}), request, true) },
    { method: "POST", pattern: ["boards", ":board", "cards", "reorder"], handle: async ({ board }, request) => opState(board!, "reorderCards", edit(request.body, {}), request) },

    // Changing a card: updateCard, moveCard, setCardParent; complete, archive and restore are moves.
    { method: "PATCH", pattern: ["boards", ":board", "cards", ":card"], handle: async ({ board, card }, request) => opState(board!, "updateCard", edit(request.body, { cardId: card }), request) },
    { method: "POST", pattern: ["boards", ":board", "cards", ":card", "move"], handle: async ({ board, card }, request) => opState(board!, "moveCard", edit(request.body, { cardId: card }), request) },
    {
      method: "POST", pattern: ["boards", ":board", "cards", ":card", "parent"], handle: async ({ board, card }, request) =>
        opState(board!, "setCardParent", { cardId: card, parentId: request.body.parentId ?? null, baseRevision: request.body.baseRevision }, request),
    },
    ...(["complete", "archive", "restore"] as const).map((action): Route => ({
      method: "POST", pattern: ["boards", ":board", "cards", ":card", action], handle: async ({ board, card }, request) =>
        opState(board!, "moveCard", { cardId: card, status: action === "complete" ? "complete" : action === "archive" ? "archived" : "pending", baseRevision: request.body.baseRevision }, request),
    })),
    { method: "DELETE", pattern: ["boards", ":board", "cards", ":card"], handle: async ({ board, card }, request) => opState(board!, "deleteArchivedCard", { cardId: card, baseRevision: request.body.baseRevision }, request) },

    // Spec and Plan: read as the service stores them; a write states the stamp the page read.
    {
      method: "GET", pattern: ["boards", ":board", "cards", ":card", "docs", ":kind"], handle: async ({ board, card, kind }, request) => {
        if (!docKind(kind!)) return refuse(404, "Unknown doc kind");
        const doc = await get(serviceBoard(board!, `/docs/${encodeURIComponent(card!)}/${kind}`), request);
        return doc.ok ? reply(doc.value) : doc.reply;
      },
    },
    {
      method: "PUT", pattern: ["boards", ":board", "cards", ":card", "docs", ":kind"], handle: async ({ board, card, kind }, request) => {
        if (!docKind(kind!)) return refuse(404, "Unknown doc kind");
        const expected = request.body.expectedMtimeMs;
        const outcome = await op(board!, "writeDoc", {
          cardId: card, kind, markdown: typeof request.body.markdown === "string" ? request.body.markdown : "",
          // Exactly what the page read: a stamp, or null for a new document. Never reread here.
          expectedMtimeMs: typeof expected === "number" || expected === null ? expected : undefined,
        }, request);
        if (!outcome.ok) return outcome.reply;
        return reply(outcome.value.result?.doc);
      },
    },

    // Goals: the page reads them, and people change them or decide an agent's suggestion.
    {
      method: "GET", pattern: ["boards", ":board", "goals"], handle: async ({ board }, request) => {
        const goals = await get<{ page: Record<string, unknown>; revision: number }>(serviceBoard(board!, "/goals"), request);
        return goals.ok ? reply({ ...goals.value.page, revision: goals.value.revision }) : goals.reply;
      },
    },
    {
      method: "POST", pattern: ["boards", ":board", "goals"], handle: async ({ board }, request) => {
        const outcome = await op(board!, "editGoals", { edit: request.body.edit, baseRevision: request.body.baseRevision }, request);
        if (!outcome.ok) return outcome.reply;
        const result = outcome.value.result as { page: Record<string, unknown>; revision: number };
        return reply({ ...result.page, revision: result.revision });
      },
    },
    {
      method: "POST", pattern: ["boards", ":board", "goals", "suggestions", ":suggestion"], handle: async ({ board, suggestion }, request) => {
        const outcome = await op(board!, "decideGoalSuggestion", { suggestionId: suggestion, decision: request.body.decision, baseRevision: request.body.baseRevision }, request);
        if (!outcome.ok) return outcome.reply;
        const result = outcome.value.result as { page: Record<string, unknown>; revision: number };
        return reply({ ...result.page, revision: result.revision });
      },
    },

    // History: the list, a version as page state, and an old Spec or Plan.
    {
      method: "GET", pattern: ["boards", ":board", "history"], handle: async ({ board }, request) => {
        const history = await get(serviceBoard(board!, "/history"), request);
        return history.ok ? reply(history.value) : history.reply;
      },
    },
    {
      method: "GET", pattern: ["boards", ":board", "history", ":version"], handle: async ({ board, version }, request) => {
        const at = historyVersion(version!);
        if (!at) return refuse(422, "Invalid history version");
        const snapshot = await get<{ roadmap: PlanbanRoadmap }>(serviceBoard(board!, `/history/${at}`), request);
        return snapshot.ok ? reply(boardState(board!, snapshot.value.roadmap)) : snapshot.reply;
      },
    },
    {
      method: "GET", pattern: ["boards", ":board", "history", ":version", "cards", ":card", "docs", ":kind"], handle: async ({ board, version, card, kind }, request) => {
        const at = historyVersion(version!);
        if (!at || !docKind(kind!)) return refuse(422, "Invalid history document request");
        const doc = await get(serviceBoard(board!, `/history/${at}/cards/${encodeURIComponent(card!)}/docs/${kind}`), request);
        return doc.ok ? reply(doc.value) : doc.reply;
      },
    },

    // Restores: restoreBoard, restoreCard and restoreDoc, each from the revision the person saw.
    {
      method: "POST", pattern: ["boards", ":board", "history", ":version", "restore-board"], handle: async ({ board, version }, request) => {
        const at = historyVersion(version!);
        if (!at) return refuse(422, "Invalid history version");
        return opState(board!, "restoreBoard", edit(request.body, { version: at }), request);
      },
    },
    {
      method: "POST", pattern: ["boards", ":board", "history", ":version", "cards", ":card", "restore"], handle: async ({ board, version, card }, request) => {
        const at = historyVersion(version!);
        if (!at) return refuse(422, "Invalid history version");
        return opState(board!, "restoreCard", edit(request.body, { version: at, cardId: card }), request);
      },
    },
    {
      method: "POST", pattern: ["boards", ":board", "history", ":version", "cards", ":card", "docs", ":kind", "restore"], handle: async ({ board, version, card, kind }, request) => {
        const at = historyVersion(version!);
        if (!at || !docKind(kind!)) return refuse(422, "Invalid history document restore request");
        const outcome = await op(board!, "restoreDoc", edit(request.body, { version: at, cardId: card, kind }), request);
        if (!outcome.ok) return outcome.reply;
        // Like the local server: the restored document as it now is.
        const doc = await get(serviceBoard(board!, `/docs/${encodeURIComponent(card!)}/${kind}`), request);
        return doc.ok ? reply(doc.value) : doc.reply;
      },
    },

    // Board settings: where the board lives (always online here) and who is on it.
    {
      method: "GET", pattern: ["boards", ":board", "online"], handle: async ({ board }, request) => {
        const [members, me] = await Promise.all([
          get<{ members: Array<{ userId: string; role: string }> }>(serviceBoard(board!, "/members"), request),
          get<{ userId: string }>("/api/v1/me", request),
        ]);
        // A refusal (signed out, not on this board) is the page's error, never a quiet success.
        if (!members.ok) return members.reply;
        if (!me.ok) return me.reply;
        const people = members.value.members.map((member) => ({ ...member, you: member.userId === me.value.userId }));
        const readOnlyCopy = roles.get(board!)?.authority === "returned-local";
        return reply({ location: "online", signedIn: [origin], defaultService: origin, job: null, url: origin, boardId: board, people, ...(readOnlyCopy ? { readOnlyCopy } : {}) });
      },
    },
    // The owner deletes a board's read-only online copy (owner decision (a), 15 October 2026).
    { method: "POST", pattern: ["boards", ":board", "online", "delete-copy"], handle: async ({ board }, request) => passPost(serviceBoard(board!, "/delete-copy"), { confirmTitle: String(request.body.confirmTitle ?? "") }, request) },
    { method: "GET", pattern: ["boards", ":board", "online", "people"], handle: async ({ board }, request) => passGet(serviceBoard(board!, "/people"), request) },
    { method: "POST", pattern: ["boards", ":board", "online", "people", "me", "agents"], handle: async ({ board }, request) => passPost(serviceBoard(board!, "/people/me/agents"), { level: request.body.level }, request) },
    { method: "GET", pattern: ["boards", ":board", "online", "invites"], handle: async ({ board }, request) => passGet(serviceBoard(board!, "/invites"), request) },
    {
      method: "POST", pattern: ["boards", ":board", "online", "invites"], handle: async ({ board }, request) => passPost(serviceBoard(board!, "/invites"), {
        role: request.body.role ?? "viewer",
        ...(typeof request.body.email === "string" && request.body.email.trim() ? { email: request.body.email } : {}),
      }, request),
    },
    { method: "POST", pattern: ["boards", ":board", "online", "invites", ":invite", "revoke"], handle: async ({ board, invite }, request) => passPost(serviceBoard(board!, `/invites/${encodeURIComponent(invite!)}/revoke`), {}, request) },
    {
      method: "POST", pattern: ["boards", ":board", "online", "members", ":user", ":action"], handle: async ({ board, user, action }, request) => {
        if (action !== "role" && action !== "remove") return refuse(404, WEB_ONLY_MESSAGE);
        return passPost(serviceBoard(board!, `/members/${encodeURIComponent(user!)}/${action}`), action === "role" ? { role: request.body.role } : {}, request);
      },
    },

    // The signed-in person, invitations waiting for them, and joining.
    { method: "GET", pattern: ["online", "me"], handle: async (_params, request) => passGet("/api/v1/me", request) },
    { method: "GET", pattern: ["online", "invites"], handle: async (_params, request) => passGet("/api/v1/invites", request) },
    {
      method: "POST", pattern: ["online", "invites", "accept"], handle: async (_params, request) =>
        passPost("/api/v1/invites/accept", { token: typeof request.body.token === "string" ? request.body.token : "" }, request),
    },
    {
      // Reads only: whether the person is already on the invitation's board. Never joins.
      method: "POST", pattern: ["online", "invites", "membership"], handle: async (_params, request) =>
        passPost("/api/v1/invites/membership", { token: typeof request.body.token === "string" ? request.body.token : "" }, request),
    },
    { method: "POST", pattern: ["online", "invites", ":invite", "accept"], handle: async ({ invite }, request) => passPost(`/api/v1/invites/${encodeURIComponent(invite!)}/accept`, {}, request) },

    // One-tap approval of an agent's sign-in, from the link it showed.
    {
      method: "POST", pattern: ["online", "device", ":action"], handle: async ({ action }, request) => {
        if (action !== "preview" && action !== "decide") return refuse(404, WEB_ONLY_MESSAGE);
        const note = typeof request.body.request === "string" ? request.body.request : "";
        return passPost(`/api/v1/device/${action}`, action === "decide" ? { request: note, decision: request.body.decision } : { request: note }, request);
      },
    },

    // Access keys for cloud and headless agents, shown once.
    {
      method: "POST", pattern: ["online", "keys"], handle: async (_params, request) => passPost("/api/v1/keys", {
        name: request.body.name, boardId: request.body.boardId, level: request.body.level,
        ...(request.body.expiresInDays === undefined ? {} : { expiresInDays: request.body.expiresInDays }),
      }, request),
    },

    // Connections, under the person's account.
    {
      method: "GET", pattern: ["online", "connections"], handle: async (_params, request) => {
        const listed = await get<Record<string, unknown>>("/api/v1/connections", request);
        return listed.ok ? reply({ signedIn: true, url: origin, ...listed.value }) : listed.reply;
      },
    },
    {
      // The service revokes in batches; repeat until it says it's done, and say plainly if it isn't.
      method: "POST", pattern: ["online", "connections", "revoke-others"], handle: async (_params, request) => {
        let revoked = 0;
        for (let round = 0; round < 50; round += 1) {
          const batch = await read<{ revoked: number; registrations: number; more: boolean }>(await call("POST", "/api/v1/connections/revoke-others", {}, request.signal ? { signal: request.signal } : {}));
          if (!batch.ok) return revoked ? reply({ revoked, complete: false }) : batch.reply;
          revoked += batch.value.revoked + batch.value.registrations;
          if (!batch.value.more) return reply({ revoked, complete: true });
        }
        return reply({ revoked, complete: false });
      },
    },
    {
      method: "POST", pattern: ["online", "connections", ":connection", ":action"], handle: async ({ connection, action }, request) => {
        if (action !== "revoke" && action !== "access") return refuse(404, WEB_ONLY_MESSAGE);
        return passPost(`/api/v1/connections/${encodeURIComponent(connection!)}/${action}`, action === "access" ? { level: request.body.level } : {}, request);
      },
    },
  ];

  function groupInput(body: Record<string, unknown>) {
    const { deliverableIds, ...rest } = edit(body, {});
    return rest.itemIds === undefined && deliverableIds !== undefined ? { ...rest, itemIds: deliverableIds } : rest;
  }

  async function passGet(path: string, request: PageRequest) {
    const value = await get(path, request);
    return value.ok ? reply(value.value) : value.reply;
  }

  async function passPost(path: string, body: unknown, request: PageRequest) {
    const value = await read(await call("POST", path, body, request.signal ? { signal: request.signal } : {}));
    return value.ok ? reply(value.value) : value.reply;
  }

  function match(method: string, segments: string[]) {
    for (const route of routes) {
      if (route.method !== method || route.pattern.length !== segments.length) continue;
      const params: Record<string, string> = {};
      if (route.pattern.every((part, index) => {
        if (part.startsWith(":")) {
          params[part.slice(1)] = segments[index]!;
          return true;
        }
        return part === segments[index];
      })) return { route, params };
    }
    return null;
  }

  async function answer(path: string, init: RequestInit = {}): Promise<PageReply> {
    const url = new URL(path, `${origin}/`);
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return refuse(404, WEB_ONLY_MESSAGE);
    let segments: string[];
    try {
      segments = url.pathname.slice("/api/".length).split("/").map(decodeURIComponent);
    } catch {
      return refuse(422, "This address is not valid.");
    }
    if (segments.some((segment) => segment === "" || unsafeId(segment))) return refuse(422, "This card has an unsafe id.");
    const method = (init.method ?? "GET").toUpperCase();
    const found = match(method, segments);
    if (!found) return refuse(404, WEB_ONLY_MESSAGE);
    let body: Record<string, unknown> = {};
    if (typeof init.body === "string" && init.body.trim()) {
      try {
        const parsed = JSON.parse(init.body) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        return refuse(422, "The request body must be JSON.");
      }
    }
    const supplied = new Headers(init.headers).get("Idempotency-Key");
    const key = supplied && KEY_PATTERN.test(supplied) ? supplied : newIdempotencyKey();
    return found.route.handle(found.params, { url, body, key, ...(init.signal ? { signal: init.signal } : {}) });
  }

  return {
    origin,
    /** The page's fetch, answered from the service. Resolves like fetch; rejects only when the network does. */
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      const { status, body } = await answer(path, init);
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    },
    /** A short-lived token for the live-update subscription, or null when the service has none. */
    async liveToken(): Promise<LiveToken | null> {
      const response = await call("POST", "/api/v1/live-token", {});
      // The service answers 404 when it has no live updates configured.
      if (response.status === 404) return null;
      if (!response.ok) throw await serviceError(response);
      return await response.json() as LiveToken;
    },
    /** The board's current revision: the fallback check while the live connection is down. */
    async revision(boardId: string): Promise<number> {
      const response = await call("GET", serviceBoard(boardId, "/changes"));
      if (!response.ok) throw await serviceError(response);
      return (await response.json() as { revision: number }).revision;
    },
  };

  async function serviceError(response: Response) {
    const failure = (await pageError(response)).body as { error: string; code?: string };
    return new HostedServiceError(failure.error, response.status, failure.code ?? null);
  }
}

export type HostedAdapter = ReturnType<typeof createHostedAdapter>;
