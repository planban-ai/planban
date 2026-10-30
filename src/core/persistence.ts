import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { PlanbanBoardMovedError, PlanbanConflictError } from "./boardOperations";

export const LOCK_DIR = ".planban-write.lock";
const IDEMPOTENCY_FILE = ".idempotency.json";
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 2 * 60 * 1000;
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX_RECORDS = 500;

const heldLocks = new AsyncLocalStorage<Set<string>>();

interface IdempotencyRecord {
  key: string;
  scope: string;
  fingerprint: string;
  createdAt: string;
  completedAt?: string | undefined;
  response?: unknown;
}

interface IdempotencyStore {
  version: 1;
  records: IdempotencyRecord[];
}

export class PlanbanIdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanIdempotencyConflictError";
  }
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fsyncDirectory(path: string) {
  try {
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort across platforms and filesystems.
  }
}

/** True for a temporary file atomicWriteFile is writing: ".<name>.<pid>.<time>.<uuid>.tmp". */
export function isAtomicWriteTemp(name: string): boolean {
  return /^\..+\.\d+\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(name);
}

export async function atomicWriteFile(path: string, contents: string | Uint8Array) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  let handle = await open(tempPath, "w");
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    await rename(tempPath, path);
    await fsyncDirectory(directory);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function appendLineDurably(path: string, line: string) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.writeFile(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/*
 * Board write lock.
 *
 * Processes of this version take turns through a queue of uniquely named
 * ticket files (Lamport's bakery algorithm on the file system): a waiter
 * announces that it is choosing, takes the next number, and enters when no
 * live process is still choosing and no live ticket is ahead of it. Every
 * file has its own unique name and is only ever removed by its owner or once
 * its owner's process has gone, so recovering from a killed process can
 * never remove someone else's newer file. A live process is never pushed out,
 * however long it holds the lock.
 *
 * The queue's winner also takes the original single lock directory, with the
 * original rules, so older Planban versions writing the same board are still
 * excluded. Only the queue's winner touches that directory, so processes of
 * this version never race each other for it.
 */
export const QUEUE_DIR = ".planban-write.queue";

interface LockOwner {
  pid?: number;
  token?: string;
  /** When the owner joined the queue or took the lock. */
  at?: string;
  createdAt?: string;
  /** The owner's command line, to say which process holds a board. */
  command?: string;
  /** Written by the queue's winner: removable at once if its process has gone. */
  queue?: boolean;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function processIsAlive(pid: unknown): boolean | null {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : true;
  }
}

interface QueueEntry {
  name: string;
  kind: "choosing" | "ticket";
  number: number;
  id: string;
}

function parseEntry(name: string): QueueEntry | null {
  const choosing = /^choosing-([a-f0-9-]{36})\.json$/.exec(name);
  if (choosing) return { name, kind: "choosing", number: 0, id: choosing[1]! };
  const ticket = /^ticket-(\d{12})-([a-f0-9-]{36})\.json$/.exec(name);
  if (ticket) return { name, kind: "ticket", number: Number(ticket[1]), id: ticket[2]! };
  return null;
}

/** Live entries of the queue; entries of processes that have gone are removed (their names are unique). */
async function liveEntries(queue: string): Promise<QueueEntry[]> {
  const live: QueueEntry[] = [];
  for (const name of await readdir(queue).catch(() => [] as string[])) {
    const entry = parseEntry(name);
    if (!entry) continue;
    const owner = await readJsonFile<LockOwner>(join(queue, name));
    // An unreadable entry is still being written, unless it has stayed
    // unreadable for ten seconds (its writer died mid-write).
    const abandoned = !owner && Date.now() - ((await stat(join(queue, name)).catch(() => null))?.mtimeMs ?? Date.now()) > 10_000;
    if (abandoned || (owner && processIsAlive(owner.pid) === false)) {
      await rm(join(queue, name), { force: true });
      continue;
    }
    live.push(entry);
  }
  return live;
}

const ahead = (a: QueueEntry, b: QueueEntry) => a.number < b.number || (a.number === b.number && a.id < b.id);

/** After this long waiting for a board, say which process holds it. */
const LOCK_NOTICE_MS = 5_000;

function lockWaitLimitMs() {
  const configured = Number(process.env.PLANBAN_LOCK_WAIT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
}

function ownCommand() {
  return [basename(process.argv0), ...process.argv.slice(1)].join(" ").slice(0, 300);
}

/** The holder's command line: as it recorded it, or as the system reports it (older versions). */
function commandOf(owner: LockOwner): string | null {
  if (owner.command) return owner.command;
  if (typeof owner.pid !== "number" || process.platform === "win32") return null;
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(owner.pid)], { encoding: "utf8", timeout: 1000 }).trim().slice(0, 300) || null;
  } catch {
    return null;
  }
}

export function describeLockHolder(planningRoot: string, owner: LockOwner | null, gaveUp = false): string {
  const next = gaveUp ? "then run this command again" : "and Planban carries on by itself";
  if (!owner || typeof owner.pid !== "number") return `Another Planban process is writing the board at ${planningRoot}.${gaveUp ? " Try again once it has finished." : ""}`;
  const command = commandOf(owner);
  const since = owner.at ?? owner.createdAt;
  const stop = process.platform === "win32" ? `taskkill /PID ${owner.pid} /F` : `kill ${owner.pid}   (or, if it does not exit, kill -9 ${owner.pid})`;
  return [
    `The board at ${planningRoot} is held by process ${owner.pid}${command ? ` (${command})` : ""}${since ? `, since ${since}` : ""}.`,
    `If that process is stuck, stop it (${stop}), ${next}.`,
  ].join("\n");
}

/** A write that could not get the board in time. Nothing was changed. */
export class PlanbanBoardBusyError extends PlanbanConflictError {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanBoardBusyError";
  }
}

/**
 * Watches one wait for a board. After a few seconds it says who holds the
 * board and how to free it; past the limit (PLANBAN_LOCK_WAIT_MS, one
 * minute by default) it gives up with that explanation instead of waiting
 * silently, so a CLI command or an agent's MCP call reports a stuck process.
 */
class LockWait {
  private readonly started = Date.now();
  private noticed = false;

  /**
   * One wait for one board, shared by both stages of taking it. `giveUp` is
   * set only for a write's outermost lock, before anything has been
   * written, so "nothing was changed" is always true when it gives up; a
   * lock taken part-way through an operation waits instead.
   */
  constructor(private readonly planningRoot: string, private readonly giveUp: boolean) {}

  async check(holder: () => Promise<LockOwner | null>) {
    const waited = Date.now() - this.started;
    const limit = lockWaitLimitMs();
    if (this.giveUp && waited >= limit) {
      throw new PlanbanBoardBusyError(`Gave up after waiting ${Math.round(waited / 1000)} seconds; nothing was changed.\n${describeLockHolder(this.planningRoot, await holder(), true)}`);
    }
    if (!this.noticed && waited >= LOCK_NOTICE_MS) {
      this.noticed = true;
      process.stderr.write(`Waiting for another Planban process to finish writing.\n${describeLockHolder(this.planningRoot, await holder())}\n`);
    }
  }
}

/**
 * Who is actually holding the board: an older Planban version holding the
 * original lock directory, or else the process at the front of the queue.
 */
async function currentHolder(planningRoot: string, front: LockOwner | null): Promise<LockOwner | null> {
  const legacy = await readJsonFile<LockOwner>(join(planningRoot, LOCK_DIR, "owner.json"));
  if (legacy && legacy.token !== front?.token && processIsAlive(legacy.pid) !== false) return legacy;
  const at = legacy?.createdAt ?? front?.at;
  return legacy && front && legacy.token === front.token && at ? { ...front, at } : front;
}

async function enterQueue(queue: string, id: string, wait: LockWait): Promise<string> {
  await mkdir(queue, { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, token: id, at: new Date().toISOString(), command: ownCommand() }) + "\n";
  const choosing = join(queue, `choosing-${id}.json`);
  let ticket: string | null = null;
  try {
    await writeFile(choosing, owner, { flag: "wx" });
    const highest = Math.max(0, ...(await liveEntries(queue)).filter((entry) => entry.kind === "ticket").map((entry) => entry.number));
    const mine: QueueEntry = { name: `ticket-${String(highest + 1).padStart(12, "0")}-${id}.json`, kind: "ticket", number: highest + 1, id };
    ticket = join(queue, mine.name);
    await writeFile(ticket, owner, { flag: "wx" });
    await rm(choosing, { force: true });
    for (;;) {
      const entries = await liveEntries(queue);
      const blockers = entries.filter((entry) => entry.id !== id && (entry.kind === "choosing" || ahead(entry, mine)));
      if (blockers.length === 0) return ticket;
      await wait.check(async () => {
        const first = blockers.filter((entry) => entry.kind === "ticket").sort((a, b) => (ahead(a, b) ? -1 : 1))[0] ?? blockers[0]!;
        return currentHolder(dirname(queue), await readJsonFile<LockOwner>(join(queue, first.name)));
      });
      await sleep(LOCK_RETRY_MS);
    }
  } catch (error) {
    // A failure part-way must not leave this live process's entries blocking others.
    await rm(choosing, { force: true }).catch(() => undefined);
    if (ticket) await rm(ticket, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The original lock directory, for older Planban versions writing the same board. */
async function takeLegacyLock(lockPath: string, token: string, wait: LockWait) {
  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token, queue: true, createdAt: new Date().toISOString(), command: ownCommand() }) + "\n", "utf8");
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info) {
        const owner = await readJsonFile<LockOwner>(join(lockPath, "owner.json"));
        // Left by a queue winner whose process has gone: no other process of
        // this version can be using it, so it is removed at once.
        const deadWinner = owner?.queue === true && processIsAlive(owner.pid) === false;
        // Anything else follows the original rule: stale after two minutes unchanged.
        if (deadWinner || Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
      }
      await wait.check(() => readJsonFile<LockOwner>(join(lockPath, "owner.json")));
      await sleep(LOCK_RETRY_MS);
    }
  }
}

export interface BoardLockOptions {
  /**
   * Give up (PlanbanBoardBusyError) after PLANBAN_LOCK_WAIT_MS instead of
   * waiting for as long as the holder needs. Honoured only when no other
   * board lock is held, so it applies before anything has been written.
   */
  giveUp?: boolean;
}

export async function withBoardWriteLock<T>(planningRootInput: string, callback: () => Promise<T>, options: BoardLockOptions = {}): Promise<T> {
  const planningRoot = resolve(planningRootInput);
  const activeLocks = heldLocks.getStore();
  if (activeLocks?.has(planningRoot)) return callback();

  await mkdir(planningRoot, { recursive: true });
  const lockPath = join(planningRoot, LOCK_DIR);
  const token = randomUUID();
  const wait = new LockWait(planningRoot, !!options.giveUp && !activeLocks?.size);
  const ticket = await enterQueue(join(planningRoot, QUEUE_DIR), token, wait);
  try {
    await takeLegacyLock(lockPath, token, wait);
  } catch (error) {
    await rm(ticket, { force: true });
    throw error;
  }

  const nextLocks = new Set(activeLocks ?? []);
  nextLocks.add(planningRoot);
  // A long hold (a large Take Online) keeps the original lock's time current,
  // so older versions never treat it as stale.
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => undefined);
  }, 30_000);
  heartbeat.unref();
  try {
    return await heldLocks.run(nextLocks, callback);
  } finally {
    clearInterval(heartbeat);
    if ((await readJsonFile<LockOwner>(join(lockPath, "owner.json")))?.token === token) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(ticket, { force: true });
  }
}

function idempotencyPath(planningRoot: string) {
  return join(planningRoot, IDEMPOTENCY_FILE);
}

async function readIdempotencyStore(planningRoot: string): Promise<IdempotencyStore> {
  try {
    const parsed = JSON.parse(await readFile(idempotencyPath(planningRoot), "utf8")) as Partial<IdempotencyStore>;
    return {
      version: 1,
      records: Array.isArray(parsed.records) ? parsed.records as IdempotencyRecord[] : [],
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return { version: 1, records: [] };
    throw error;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "idempotencyKey")
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

export function idempotencyFingerprint(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

async function writeIdempotencyStore(planningRoot: string, store: IdempotencyStore) {
  await atomicWriteFile(idempotencyPath(planningRoot), JSON.stringify(store, null, 2) + "\n");
}

function pruneIdempotencyRecords(records: IdempotencyRecord[]) {
  const cutoff = Date.now() - IDEMPOTENCY_RETENTION_MS;
  return [...records]
    .filter((record) => Date.parse(record.createdAt) >= cutoff)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, IDEMPOTENCY_MAX_RECORDS)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

/**
 * Copies the board's completed retry records to where the board will be kept
 * next (Take Online), so a request applied just before the move and sent
 * again afterwards returns its saved answer instead of applying twice.
 * Records already there are kept. Safe to repeat.
 */
export async function carryIdempotencyRecords(fromRoot: string, toRoot: string) {
  const completed = (await readIdempotencyStore(fromRoot)).records.filter((record) => "response" in record);
  if (!completed.length) return;
  await withBoardWriteLock(toRoot, async () => {
    const store = await readIdempotencyStore(toRoot);
    const known = new Set(store.records.map((record) => `${record.scope}\n${record.key}`));
    const carried = completed.filter((record) => !known.has(`${record.scope}\n${record.key}`));
    if (carried.length) await writeIdempotencyStore(toRoot, { version: 1, records: pruneIdempotencyRecords([...store.records, ...carried]) });
  });
}

export async function runIdempotentBoardMutation<T>(input: {
  planningRoot: string;
  idempotencyKey?: string | undefined;
  scope: string;
  fingerprint: string;
  /**
   * Checked once the board is held, before the key is looked up or claimed:
   * false when the board moved while this waited, so the key belongs with the
   * board's new home (PlanbanBoardMovedError; nothing is recorded here).
   */
  stillHere?: () => Promise<boolean>;
  run: () => Promise<T>;
}): Promise<{ replayed: boolean; value: T }> {
  return withBoardWriteLock(input.planningRoot, async () => {
    if (input.stillHere && !(await input.stillHere())) throw new PlanbanBoardMovedError();
    const key = input.idempotencyKey?.trim();
    if (!key) return { replayed: false, value: await input.run() };

    const store = await readIdempotencyStore(input.planningRoot);
    const existing = store.records.find((record) => record.key === key && record.scope === input.scope);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) {
        throw new PlanbanIdempotencyConflictError("Idempotency key was already used with a different request.");
      }
      if (!("response" in existing)) {
        throw new PlanbanIdempotencyConflictError("Idempotent mutation is already in progress.");
      }
      return { replayed: true, value: existing.response as T };
    }

    const pendingRecord: IdempotencyRecord = {
      key,
      scope: input.scope,
      fingerprint: input.fingerprint,
      createdAt: new Date().toISOString(),
    };
    await writeIdempotencyStore(input.planningRoot, {
      version: 1,
      records: pruneIdempotencyRecords([...store.records, pendingRecord]),
    });

    try {
      const value = await input.run();
      const latestStore = await readIdempotencyStore(input.planningRoot);
      const completedRecord: IdempotencyRecord = {
        ...pendingRecord,
        completedAt: new Date().toISOString(),
        response: JSON.parse(JSON.stringify(value)) as unknown,
      };
      const records = pruneIdempotencyRecords([
        ...latestStore.records.filter((record) => !(record.key === key && record.scope === input.scope)),
        completedRecord,
      ]);
      await writeIdempotencyStore(input.planningRoot, { version: 1, records });
      return { replayed: false, value };
    } catch (error) {
      const latestStore = await readIdempotencyStore(input.planningRoot);
      await writeIdempotencyStore(input.planningRoot, {
        version: 1,
        records: latestStore.records.filter((record) => !(record.key === key && record.scope === input.scope)),
      });
      throw error;
    }
  }, { giveUp: true });
}
