// The board page's Online Board controls (owner decision 15): where a board
// lives, Board settings with Take online and Take local, and sign-in. A local
// board's status is read from files on this machine only; nothing here
// contacts the online service for a local board unless the person asks to
// move it, or this machine has signed in and the board is an older copy.
import { randomUUID } from "node:crypto";
import type express from "express";
import { PlanbanValidationError } from "../core/boardOperations";
import { requestedMemberRole } from "../core/memberRoles";
import { readManifest, resolvePlanningRoot } from "../core/storage";
import { boardCredentials, boardPath, onlineRequest, requireCredentials } from "../core/online/client";
import { readCredentials, serviceUrl } from "../core/online/credentials";
import { knownStaleCopy } from "../core/online/copyCheck";
import { onlineLogin } from "../core/online/login";
import { AccountInUseError, boardAccount, liveAccount, rememberIdentity } from "../core/online/accounts";

/** Services this server has already asked for a missing email. */
const askedWho = new Set<string>();
import {
  attachOnline, keepSeparateBoard, moveState, previewTakeOnline, othersOnBoard, PlanbanConfirmationNeeded, PlanbanTakeOnlineStopped, takeLocal, takeOnline, type MoveProgress,
} from "../core/online/transfers";
import { planbanCommand } from "../core/command";

/** The working default address for Planban Online (owner decision 13). */
const DEFAULT_SERVICE = "https://app.planban.ai";

/** What a failed move left behind, for the page to explain accurately. */
export interface MoveOutcome {
  /** Nothing changed and nothing is left over. */
  unchanged: boolean;
  /** Where the board is now. */
  location: "local" | "online";
  /** What to tell the person, in plain words. */
  message: string;
  /** What "Try again" would do, if it helps. */
  retry: string | null;
}

export interface MoveJob {
  id: string;
  repoId: string;
  kind: "take-online" | "take-local";
  status: "running" | "succeeded" | "failed" | "stopped";
  progress: MoveProgress | null;
  error: string | null;
  outcome: MoveOutcome | null;
  /** After a move: how to commit (or commit the removal of) the project's online note, if the project is in git. */
  noteCommit: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface Deps {
  resolveBoardCwd: (repoId: string) => Promise<string>;
  /** Tells watching pages that boards or a board's state changed. */
  changed: (repoId: string) => void;
}

/** The service a board would go online to: the configured one, the only one this machine signed in to, or the default. */
async function defaultService() {
  if (process.env.PLANBAN_ONLINE_URL) return serviceUrl(process.env.PLANBAN_ONLINE_URL);
  const services = Object.keys((await readCredentials()).services);
  return services.length === 1 ? services[0]! : DEFAULT_SERVICE;
}

/** Explains a stopped or failed move from where the board actually stands. */
function describeOutcome(kind: MoveJob["kind"], state: Awaited<ReturnType<typeof moveState>> | null, frozenOnline: boolean | null = null): MoveOutcome {
  if (!state) return { unchanged: false, location: kind === "take-online" ? "local" : "online", message: "Planban could not read where this board stands now. Open Board settings again in a moment.", retry: null };
  const { location, unfinished } = state;
  if (kind === "take-online") {
    if (location === "online") return { unchanged: false, location, message: "The board is online. The last step, refreshing this Mac's backup copy, did not finish; it happens again automatically.", retry: null };
    if (!unfinished) return { unchanged: true, location, message: "Nothing has changed. The board is still on this Mac, you and your agents can keep editing, and the partial online copy has been removed.", retry: "Take online" };
    if (unfinished.phase === "committed") return { unchanged: false, location, message: "The board reached your Planban account, but this Mac has not switched to it yet. Try again to finish; nothing is lost either way.", retry: "Finish taking it online" };
    // Shut here before the commit: whether the commit landed is unknown, so nobody can edit it on this Mac.
    if (unfinished.phase === "sealing" || unfinished.phase === "sealed") return { unchanged: false, location, message: "The board is paused on this Mac, so nobody can change it here. Planban could not confirm whether it reached your Planban account. Try again to finish the move, or stop it to put the board back on this Mac as it was.", retry: "Continue" };
    return { unchanged: false, location, message: "The board is still on this Mac and nothing on it has changed, but the partial online copy could not be removed yet. Try again to continue the move, or stop it to remove the partial copy.", retry: "Continue" };
  }
  if (location === "local") return { unchanged: false, location, message: "The board is on this Mac. The online copy was not told the move finished yet; that happens the next time this Mac reaches it.", retry: null };
  if (!unfinished || unfinished.phase === "fencing") {
    // Only the service knows whether the freeze happened before the error.
    if (frozenOnline === false) return { unchanged: true, location, message: "Nothing has changed. The board is still online, and nobody's access has been touched.", retry: "Take local" };
    if (frozenOnline === null) return { unchanged: false, location, message: "The board is still online here, but Planban could not confirm with the online service whether the move started. If it did, the online board is read-only and everyone else's access has been removed. Try again to finish or to find out.", retry: "Try again" };
  }
  return { unchanged: false, location, message: "The online board is now read-only and everyone else's access has been removed, but the copy to this Mac did not finish. Try again to finish bringing it here.", retry: "Finish taking it local" };
}

export function registerOnlineRoutes(app: express.Express, deps: Deps) {
  const jobs = new Map<string, MoveJob & { controller?: AbortController; done?: Promise<void> }>();
  /** Boards whose move is being prepared: taken before any waiting, so two tabs cannot start two moves. */
  const reserved = new Set<string>();
  const claim = (repoId: string) => {
    if (reserved.has(repoId) || running(repoId)) return false;
    reserved.add(repoId);
    return true;
  };
  const signIns = new Map<string, { link: string | null; done: boolean; error: string | null }>();

  const publicJob = (job: MoveJob & { controller?: AbortController }): MoveJob => {
    const { controller: _controller, ...rest } = job;
    return rest;
  };
  const running = (repoId: string) => [...jobs.values()].find((job) => job.repoId === repoId && job.status === "running");

  app.get("/api/boards/:repoId/online", async (req, res, next) => {
    try {
      const repoId = req.params.repoId;
      const cwd = await deps.resolveBoardCwd(repoId);
      const manifest = await readManifest(cwd);
      let services = (await readCredentials()).services;
      // A sign-in from before emails were kept: for an online board (a local
      // board never contacts the service), ask once per run of this server.
      const online = manifest?.storage?.kind === "online" ? manifest.storage.url : null;
      if (online && services[online] && !services[online].email && !askedWho.has(online)) {
        askedWho.add(online);
        await rememberIdentity(online, 1).catch(() => undefined);
        services = (await readCredentials()).services;
      }
      const signedIn = Object.keys(services);
      const job = [...jobs.values()].filter((entry) => entry.repoId === repoId).at(-1);
      // Who each service is signed in as here, for "Signed in as" (owner request, 15 October 2026).
      const accounts = Object.fromEntries(Object.entries(services).map(([url, credentials]) => [url, credentials.email ?? null]));
      // An online board's own account (several can be signed in), from its link on this computer.
      const link = manifest?.storage?.kind === "online" ? await boardAccount(manifest.storage.url, manifest.storage.boardId).catch(() => null) : null;
      const base = { signedIn, accounts, ...(link ? { account: link.email ?? null } : {}), defaultService: await defaultService(), job: job ? publicJob(job) : null };
      if (manifest?.storage?.kind !== "online") {
        const stale = manifest?.enabled ? await knownStaleCopy(resolvePlanningRoot(manifest), cwd, manifest.repoId) : null;
        res.json({ ...base, location: running(repoId)?.kind === "take-online" ? "moving" : "local", stale });
        return;
      }
      const { url, boardId } = manifest.storage;
      // People on the board, for Board settings. A failure here (signed out,
      // offline) still shows where the board lives.
      // "You" is the board's own account, which may not be this computer's default.
      const people = await boardCredentials(url, boardId).then((credentials) => Promise.all([
        onlineRequest<{ members: Array<{ userId: string; role: string }> }>(url, boardPath(boardId, "/members"), undefined, { credentials }),
        onlineRequest<{ userId: string }>(url, "/api/v1/me", undefined, { credentials }),
      ])).then(([{ members }, me]) => members.map((member) => ({ ...member, you: member.userId === me.userId })), () => null);
      res.json({ ...base, location: "online", url, boardId, people });
    } catch (error) {
      next(error);
    }
  });

  /** People on an online board and who last changed each card; nothing for a local board. */
  app.get("/api/boards/:repoId/online/people", async (req, res, next) => {
    try {
      const manifest = await readManifest(await deps.resolveBoardCwd(req.params.repoId));
      if (manifest?.storage?.kind !== "online") {
        res.json({ shared: false, people: [], cards: {} });
        return;
      }
      res.json(await onlineRequest(manifest.storage.url, boardPath(manifest.storage.boardId, "/people")));
    } catch (error) {
      next(error);
    }
  });

  /** What your own agents may do on this online board. */
  app.post("/api/boards/:repoId/online/people/me/agents", async (req, res, next) => {
    try {
      const manifest = await readManifest(await deps.resolveBoardCwd(req.params.repoId));
      if (manifest?.storage?.kind !== "online") {
        res.status(409).json({ error: "This board is on this Mac; its agents are the ones on this Mac." });
        return;
      }
      res.json(await onlineRequest(manifest.storage.url, boardPath(manifest.storage.boardId, "/people/me/agents"), { level: req.body?.level }));
    } catch (error) {
      next(error);
    }
  });

  /** Calls the service for an online board on the page's behalf; a local board has no people to manage. */
  async function forOnlineBoard(repoId: string) {
    const manifest = await readManifest(await deps.resolveBoardCwd(repoId));
    if (manifest?.storage?.kind !== "online") throw new PlanbanValidationError("Take this board online to invite people.");
    return manifest.storage;
  }
  const relay = (handler: (req: express.Request) => Promise<unknown>) => async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      res.json(await handler(req));
    } catch (error) {
      next(error);
    }
  };

  app.get("/api/boards/:repoId/online/invites", relay(async (req) => {
    const { url, boardId } = await forOnlineBoard(String(req.params.repoId));
    return onlineRequest(url, boardPath(boardId, "/invites"));
  }));
  app.post("/api/boards/:repoId/online/invites", relay(async (req) => {
    const role = requestedMemberRole(req.body?.role, "viewer");
    if (!role) throw new PlanbanValidationError("role must be viewer or editor.");
    const { url, boardId } = await forOnlineBoard(String(req.params.repoId));
    return onlineRequest(url, boardPath(boardId, "/invites"), {
      role,
      ...(typeof req.body?.email === "string" && req.body.email.trim() ? { email: req.body.email } : {}),
    });
  }));
  app.post("/api/boards/:repoId/online/invites/:inviteId/revoke", relay(async (req) => {
    const { url, boardId } = await forOnlineBoard(String(req.params.repoId));
    return onlineRequest(url, boardPath(boardId, `/invites/${encodeURIComponent(String(req.params.inviteId))}/revoke`), {});
  }));
  app.post("/api/boards/:repoId/online/members/:userId/:action", relay(async (req) => {
    const { url, boardId } = await forOnlineBoard(String(req.params.repoId));
    const action = req.params.action === "remove" ? "remove" : "role";
    return onlineRequest(url, boardPath(boardId, `/members/${encodeURIComponent(String(req.params.userId))}/${action}`), action === "role" ? { role: req.body?.role } : {});
  }));

  /** Your connections (owner decision 15: they live under your account, not a board). */
  app.get("/api/online/connections", relay(async () => {
    const url = await defaultService();
    const command = planbanCommand();
    if (!(await readCredentials()).services[url]) return { signedIn: false, url, command, connections: [] };
    return { signedIn: true, url, command, ...await onlineRequest<object>(url, "/api/v1/connections") };
  }));
  /** Cut off every other machine, agent, key and Claude registration, in the service's batches. */
  app.post("/api/online/connections/revoke-others", relay(async () => {
    const url = await defaultService();
    // Every batch acts as the account that started, even if someone signs in
    // as another account on this machine meanwhile.
    const credentials = await requireCredentials(url);
    let revoked = 0;
    for (let round = 0; round < 50; round += 1) {
      const result = await onlineRequest<{ revoked: number; registrations: number; more: boolean }>(url, "/api/v1/connections/revoke-others", {}, { credentials });
      revoked += result.revoked + result.registrations;
      if (!result.more) return { revoked, complete: true };
    }
    return { revoked, complete: false };
  }));
  app.post("/api/online/connections/:id/:action", relay(async (req) => {
    const url = await defaultService();
    const action = req.params.action === "access" ? "access" : req.params.action === "restore" ? "restore" : "revoke";
    return onlineRequest(url, `/api/v1/connections/${encodeURIComponent(String(req.params.id))}/${action}`, action === "access" ? { level: req.body?.level } : {});
  }));

  function startJob(repoId: string, kind: MoveJob["kind"], run: (job: MoveJob & { controller?: AbortController }) => Promise<unknown>) {
    const job: MoveJob & { controller?: AbortController } = {
      id: randomUUID(), repoId, kind, status: "running", progress: null, error: null, outcome: null, noteCommit: null, startedAt: new Date().toISOString(), finishedAt: null,
    };
    jobs.set(job.id, job);
    (job as { done?: Promise<void> }).done = run(job).then((result) => {
      job.noteCommit = (result as { onlineNote?: { commit?: string | null } } | undefined)?.onlineNote?.commit ?? null;
      job.status = "succeeded";
    }, async (error: unknown) => {
      const cwd = await deps.resolveBoardCwd(repoId).catch(() => null);
      const state = cwd ? await moveState(cwd).catch(() => null) : null;
      // For Take Local, ask the service whether the board was frozen.
      let frozenOnline: boolean | null = null;
      if (kind === "take-local" && cwd && state?.location === "online") {
        const manifest = await readManifest(cwd).catch(() => null);
        if (manifest?.storage?.kind === "online") {
          frozenOnline = await onlineRequest<{ authority: string }>(manifest.storage.url, boardPath(manifest.storage.boardId))
            .then((board) => board.authority !== "online", () => null);
        }
      }
      // The explanation is ready before the move is reported as ended.
      job.outcome = describeOutcome(kind, state, frozenOnline);
      job.error = error instanceof Error ? error.message : String(error);
      job.status = error instanceof PlanbanTakeOnlineStopped ? "stopped" : "failed";
    }).finally(() => {
      job.finishedAt = new Date().toISOString();
      delete job.controller;
      deps.changed(repoId);
    });
    return job;
  }

  /** Errors that need the person's say-so come back with what they would agree to. */
  function refuse(res: express.Response, error: unknown) {
    if (error instanceof PlanbanConfirmationNeeded) {
      res.status(409).json({ error: error.message, confirmationNeeded: error.summary });
      return true;
    }
    return false;
  }

  /** Whether this board is clean enough to go online, and what is in the way (read from this machine only). */
  app.get("/api/boards/:repoId/online/conversion", relay(async (req) => previewTakeOnline(await deps.resolveBoardCwd(String(req.params.repoId)))));

  app.post("/api/boards/:repoId/online/take-online", async (req, res, next) => {
    try {
      const repoId = req.params.repoId;
      if (!claim(repoId)) {
        res.status(409).json({ error: "This board is already moving." });
        return;
      }
      try {
        const cwd = await deps.resolveBoardCwd(repoId);
        const url = serviceUrl(typeof req.body?.url === "string" && req.body.url ? req.body.url : await defaultService());
        if (!(await readCredentials()).services[url]) {
          res.status(401).json({ error: "Sign in to Planban Online first.", signInNeeded: url });
          return;
        }
        const job = startJob(repoId, "take-online", (entry) => {
          entry.controller = new AbortController();
          return takeOnline(url, cwd, { signal: entry.controller.signal, onProgress: (progress) => { entry.progress = progress; } });
        });
        deps.changed(repoId);
        res.status(202).json(publicJob(job));
      } finally {
        reserved.delete(repoId);
      }
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/online/take-local", async (req, res, next) => {
    try {
      const repoId = req.params.repoId;
      if (!claim(repoId)) {
        res.status(409).json({ error: "This board is already moving." });
        return;
      }
      try {
        const cwd = await deps.resolveBoardCwd(repoId);
        const manifest = await readManifest(cwd);
        if (manifest?.storage?.kind !== "online") {
          res.status(409).json({ error: "This board is already on this machine." });
          return;
        }
        // Say who loses access before anything happens; takeLocal checks again.
        const removeOthers = req.body?.removeOthers === true;
        const others = await othersOnBoard(manifest.storage.url, manifest.storage.boardId);
        // The confirmation covers exactly the people the page showed.
        const expected = Array.isArray(req.body?.expectedOthers) ? new Set(req.body.expectedOthers.map(String)) : null;
        const unchanged = expected !== null && expected.size === others.length && others.every((person) => expected.has(person.userId));
        if (others.length && (!removeOthers || !unchanged)) {
          res.status(409).json({ error: "Taking this board back removes everyone else's access.", confirmationNeeded: { removes: others } });
          return;
        }
        const job = startJob(repoId, "take-local", (entry) => takeLocal(cwd, { expectedOthers: others.map((person) => person.userId), onProgress: (progress) => { entry.progress = progress; } }));
        deps.changed(repoId);
        res.status(202).json(publicJob(job));
      } finally {
        reserved.delete(req.params.repoId);
      }
    } catch (error) {
      if (refuse(res, error)) return;
      next(error);
    }
  });

  /** An older copy (owner decision 15): use the online board in this project instead. */
  app.post("/api/boards/:repoId/online/use-online", async (req, res, next) => {
    if (!claim(req.params.repoId)) {
      res.status(409).json({ error: "This board is already moving." });
      return;
    }
    try {
      const cwd = await deps.resolveBoardCwd(req.params.repoId);
      const manifest = await readManifest(cwd);
      const stale = manifest?.enabled && manifest.storage?.kind !== "online" ? await knownStaleCopy(resolvePlanningRoot(manifest), cwd, manifest.repoId) : null;
      if (!stale) {
        res.status(409).json({ error: "This board is not an older copy of an online board." });
        return;
      }
      if (stale.signInNeeded) {
        res.status(401).json({ error: `Sign in to ${stale.url} first.`, signInNeeded: stale.url });
        return;
      }
      const result = await attachOnline(stale.url, stale.boardId, cwd, { replaceStaleCopy: true });
      deps.changed(req.params.repoId);
      res.json(result);
    } catch (error) {
      next(error);
    } finally {
      reserved.delete(req.params.repoId);
    }
  });

  /** An older copy: keep it as its own board; this project follows the online board. */
  app.post("/api/boards/:repoId/online/keep-separate", async (req, res, next) => {
    if (!claim(req.params.repoId)) {
      res.status(409).json({ error: "This board is already moving." });
      return;
    }
    try {
      const cwd = await deps.resolveBoardCwd(req.params.repoId);
      const title = typeof req.body?.title === "string" ? req.body.title : undefined;
      const result = await keepSeparateBoard(cwd, title ? { title } : {});
      deps.changed(req.params.repoId);
      res.json(result);
    } catch (error) {
      next(error);
    } finally {
      reserved.delete(req.params.repoId);
    }
  });

  app.post("/api/boards/:repoId/online/stop", async (req, res) => {
    const job = running(req.params.repoId);
    if (!job || job.kind !== "take-online" || !job.controller) {
      res.status(409).json({ error: "Nothing to stop: only a Take Online that has not finished can be stopped." });
      return;
    }
    job.controller.abort();
    res.status(202).json(publicJob(job));
  });

  app.get("/api/boards/:repoId/online/job/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.repoId !== req.params.repoId) {
      res.status(404).json({ error: "Move not found." });
      return;
    }
    res.json(publicJob(job));
  });

  /**
   * Starts the browser sign-in. The page opens the returned link itself; the
   * sign-in finishes in the background when the browser comes back.
   */
  app.post("/api/online/sign-in", async (req, res, next) => {
    try {
      const requested = typeof req.body?.url === "string" && req.body.url ? serviceUrl(req.body.url) : null;
      // A board's own files name its service, so a page may only start sign-in for a service
      // this computer already trusts: Planban's, the configured one, or one it is signed in to.
      const trusted = new Set([serviceUrl(DEFAULT_SERVICE), await defaultService(), ...Object.keys((await readCredentials()).services)]);
      if (requested && !trusted.has(requested)) {
        throw new PlanbanValidationError(`This board is on ${new URL(requested).host}, which this computer hasn't signed in to before. If you trust it, sign in from a terminal: ${planbanCommand()} online login ${requested}`);
      }
      const url = requested ?? await defaultService();
      // Another account still signed in here: the page asks first (owner request, 15 October 2026).
      if (req.body?.switchAccount !== true) {
        const current = await liveAccount(url);
        if (current) {
          const refusal = new AccountInUseError(url, current);
          res.status(409).json({ error: refusal.message, accountInUse: { url, email: current.email ?? null } });
          return;
        }
      }
      const id = randomUUID();
      const entry = { link: null as string | null, done: false, error: null as string | null };
      signIns.set(id, entry);
      const linkReady = new Promise<void>((resolve) => {
        void onlineLogin(url, {
          switchAccount: true,
          openBrowser: async (link) => {
            entry.link = link;
            resolve();
          },
        }).then(() => {
          entry.done = true;
        }, (error: unknown) => {
          entry.error = error instanceof Error ? error.message : String(error);
          resolve();
        });
      });
      await linkReady;
      if (!entry.link) {
        res.status(502).json({ error: entry.error ?? "Sign-in could not start." });
        return;
      }
      res.status(202).json({ id, url, link: entry.link });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/online/sign-in/:id", (req, res) => {
    const entry = signIns.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Sign-in not found." });
      return;
    }
    res.json({ done: entry.done, error: entry.error });
  });

  return {
    /**
     * Before the server stops: a Take Online still copying is stopped (its
     * partial online copy is removed), and every move gets a moment to reach
     * a point its record can resume from. Anything still running then
     * resumes from that record next time.
     */
    async dispose(timeoutMs = 2000) {
      const active = [...jobs.values()].filter((job) => job.status === "running");
      for (const job of active) job.controller?.abort();
      await Promise.race([
        Promise.allSettled(active.map((job) => job.done)),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
      ]);
    },
  };
}
