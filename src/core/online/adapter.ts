import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { agentContextPath, defaultPlanbanRoot, manifestPath } from "../paths";
import { normalizeRoadmap, PlanbanNotFoundError, PlanbanValidationError } from "../boardOperations";
import { boardAccount, findBoardAccount, recordBoardAccountAs, withIdentity } from "./accounts";
import { readCredentials } from "./credentials";
import type { PlanbanProjectManifest, PlanbanResolvedState, PlanbanRoadmap } from "../types";
import { refreshBackup } from "./backup";
import { boardPath, onlineRequest } from "./client";
import { serviceUrl } from "./credentials";
import { BEHIND_NOTICE, unknownFeatures } from "../clientVersion";

export type OnlineStorage = Extract<NonNullable<PlanbanProjectManifest["storage"]>, { kind: "online" }>;

export function onlineCacheRoot(storage: OnlineStorage) {
  const service = createHash("sha256").update(serviceUrl(storage.url)).digest("hex").slice(0, 16);
  return join(defaultPlanbanRoot(), "online", "cache", service, `id-${encodeURIComponent(storage.boardId)}`);
}

export function onlineState(cwd: string, manifest: PlanbanProjectManifest, roadmap: PlanbanRoadmap): PlanbanResolvedState {
  if (manifest.storage?.kind !== "online") throw new Error("Expected an Online Board.");
  const planningRoot = onlineCacheRoot(manifest.storage);
  return { cwd, manifestPath: manifestPath(cwd), agentContextPath: agentContextPath(cwd), planningRoot,
    roadmapPath: join(planningRoot, "snapshot.json"), manifest, roadmap: normalizeRoadmap(roadmap) };
}

// The features each online board uses, as its last read said (16 October 2026), so the
// notice that this Planban can't show them all survives edits, which don't repeat them.
const boardFeaturesSeen = new Map<string, string[]>();
const featuresKey = (storage: OnlineStorage) => `${serviceUrl(storage.url)}\n${storage.boardId}`;

function withBehindNotice(state: PlanbanResolvedState, storage: OnlineStorage) {
  const unknown = unknownFeatures(boardFeaturesSeen.get(featuresKey(storage)));
  if (unknown.length) state.planbanBehind = { notice: BEHIND_NOTICE, features: unknown };
  return state;
}

export async function loadOnlineState(cwd: string, manifest: PlanbanProjectManifest) {
  if (manifest.storage?.kind !== "online") throw new Error("Expected an Online Board.");
  const storage = manifest.storage;
  // A board not yet linked here is opened with the default account, pinned, and linked to that same account.
  const linked = await boardAccount(storage.url, storage.boardId);
  const unlinkedDefault = linked ? undefined : (await readCredentials()).services[serviceUrl(storage.url)];
  const pinned = unlinkedDefault ? await withIdentity(storage.url, unlinkedDefault) : undefined;
  type BoardRead = { roadmap: PlanbanRoadmap; features?: string[] };
  const { roadmap, features } = await onlineRequest<BoardRead>(storage.url, boardPath(storage.boardId), undefined, pinned ? { credentials: pinned } : {}).catch(async (error: unknown) => {
    // "Not found" for a board not yet linked here may mean another signed-in account is the one.
    if (error instanceof PlanbanNotFoundError) return findBoardAccount<BoardRead>(storage.url, storage.boardId, boardPath(storage.boardId), error);
    throw error;
  });
  if (pinned?.person && !(await boardAccount(storage.url, storage.boardId))) {
    await recordBoardAccountAs(storage.url, storage.boardId, pinned).catch(() => undefined);
  }
  void refreshBackup(manifest.storage.url, manifest.storage.boardId);
  // Features a newer Planban added to this board, which this one can't show.
  boardFeaturesSeen.set(featuresKey(storage), features ?? []);
  return withBehindNotice(onlineState(cwd, manifest, roadmap), storage);
}

/**
 * The retry key a request to the board page came with. Online operations made
 * on its behalf use it, so a retried request is recognised by the service too,
 * wherever its first attempt was recorded (a move online may come in between).
 */
const requestKeys = new AsyncLocalStorage<{ key: string; used: number }>();

export function withRequestIdempotencyKey<T>(key: string | undefined, run: () => Promise<T>): Promise<T> {
  return key ? requestKeys.run({ key, used: 0 }, run) : run();
}

/** The request's key for its first online operation, and one derived from it for each after. */
function requestKey(): string | undefined {
  const request = requestKeys.getStore();
  if (!request) return undefined;
  request.used += 1;
  return request.used === 1 ? request.key : `${request.key}#${request.used}`;
}

export async function onlineOperation<T>(cwd: string, manifest: PlanbanProjectManifest, op: string, input: { cwd: string; idempotencyKey?: string | undefined }) {
  if (manifest.storage?.kind !== "online") throw new Error("Expected an Online Board.");
  const { cwd: _cwd, idempotencyKey, ...rest } = input as { cwd: string; idempotencyKey?: string | undefined; actor?: unknown };
  // As on a local board, an edit that doesn't say who made it is the person's
  // own (the board page); agent tools always say "agent", so the service
  // applies the person's agent setting and the completion rule to them.
  const body = { ...rest, actor: rest.actor ?? "user" };
  // One key per logical edit: a retry after a lost response cannot apply it twice.
  const response = await onlineRequest<{ roadmap: PlanbanRoadmap; result: T; replayed?: boolean; originalRevision?: number }>(manifest.storage.url, boardPath(manifest.storage.boardId, `/ops/${op}`), body,
    { idempotencyKey: idempotencyKey ?? requestKey() ?? randomUUID() });
  // Every machine that changes an Online Board keeps a local backup of it.
  void refreshBackup(manifest.storage.url, manifest.storage.boardId);
  const state = withBehindNotice(onlineState(cwd, manifest, response.roadmap), manifest.storage);
  if (response.replayed) state.onlineReplay = { replayed: true, ...(response.originalRevision === undefined ? {} : { originalRevision: response.originalRevision }) };
  return { state, result: response.result };
}

export function refuseOnline(operation: string): never {
  throw new PlanbanValidationError(`${operation} is not yet available for Online Boards.`);
}

