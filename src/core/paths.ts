import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export const PROTOCOL_DIR = ".planban";
export const MANIFEST_FILE = "project.json";
export const AGENT_CONTEXT_FILE = "agent-context.md";
export const ROADMAP_FILE = "roadmap.json";
export const EVENTS_FILE = "events.ndjson";
export const INDEX_FILE = "index.json";
export const HISTORY_DIR = "history";
export const HISTORY_INDEX_FILE = "index.json";

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

export function defaultPlanbanRoot(): string {
  return process.env.PLANBAN_HOME ? resolve(expandHome(process.env.PLANBAN_HOME)) : join(homedir(), ".planban");
}

export function registryPath(): string {
  return join(defaultPlanbanRoot(), INDEX_FILE);
}

export function boardBackupsRoot(): string {
  return join(defaultPlanbanRoot(), "backups", "boards");
}

export function detachedBoardsRoot(): string {
  return join(defaultPlanbanRoot(), "detached");
}

export function detachedBoardCwd(repoId: string): string {
  return join(detachedBoardsRoot(), slugify(repoId));
}

export function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export class PlanbanPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanPathError";
  }
}

export function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const relativeTarget = relative(resolvedRoot, resolvedTarget);
  return relativeTarget === "" || (!relativeTarget.startsWith("..") && !isAbsolute(relativeTarget));
}

export function resolveInsideRoot(root: string, childPath: string, label = "path"): string {
  if (!childPath.trim()) throw new PlanbanPathError(`${label} must not be empty.`);
  if (isAbsolute(childPath)) {
    throw new PlanbanPathError(`${label} must be relative and stay inside the planning root.`);
  }

  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(resolvedRoot, childPath);
  if (!isPathInsideRoot(resolvedRoot, resolvedTarget) || resolvedTarget === resolvedRoot) {
    throw new PlanbanPathError(`${label} must stay inside the planning root.`);
  }
  return resolvedTarget;
}

export function defaultRepoId(cwd: string): string {
  return slugify(basename(resolve(cwd)));
}

export function protocolDir(cwd: string): string {
  return join(resolve(cwd), PROTOCOL_DIR);
}

export function manifestPath(cwd: string): string {
  return join(protocolDir(cwd), MANIFEST_FILE);
}

export function agentContextPath(cwd: string): string {
  return join(protocolDir(cwd), AGENT_CONTEXT_FILE);
}

export function defaultPlanningRoot(repoId: string): string {
  return join(defaultPlanbanRoot(), "repos", repoId);
}

export function roadmapPath(planningRoot: string): string {
  return join(planningRoot, ROADMAP_FILE);
}

/**
 * What Take Online leaves at a board's local roadmap.json once the board is
 * online. Planban 1.x cannot parse it, so each of its reads and writes fails
 * instead of using the retired copy, and its error quotes it in full
 * ('Unexpected token 'R', "Restart: Planban 2.0" is not valid JSON'). That
 * error shows at most 20 characters, so this must stay that short. Its
 * presence also stops 1.x `init` from putting a fresh, empty board there.
 */
export const RETIRED_ROADMAP = "Restart: Planban 2.0";

/** True when this roadmap.json is the marker Take Online left behind. */
export async function isRetiredRoadmap(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== RETIRED_ROADMAP.length) return false;
  return (await readFile(path, "utf8").catch(() => "")) === RETIRED_ROADMAP;
}

/** A local board's live roadmap is there: present, and not the marker of a board that moved online. */
export async function hasLiveRoadmap(planningRoot: string): Promise<boolean> {
  const path = roadmapPath(planningRoot);
  return await stat(path).then(() => true, () => false) && !(await isRetiredRoadmap(path));
}

export function eventsPath(planningRoot: string): string {
  return join(planningRoot, EVENTS_FILE);
}

export function itemRoot(planningRoot: string, itemId: string): string {
  return join(planningRoot, "items", slugify(itemId));
}

export function historyRoot(planningRoot: string): string {
  return join(planningRoot, HISTORY_DIR);
}

export function historyIndexPath(planningRoot: string): string {
  return join(historyRoot(planningRoot), HISTORY_INDEX_FILE);
}

export function historyVersionRoot(planningRoot: string, version: number): string {
  return join(historyRoot(planningRoot), `v${String(version).padStart(4, "0")}`);
}

export function historyRoadmapPath(planningRoot: string, version: number): string {
  return join(historyVersionRoot(planningRoot, version), ROADMAP_FILE);
}

/**
 * Document bodies a version holds without naming them in its entry, kept by
 * card id and kind. Only Take Local writes it: online history pruning carries
 * the body that still applies onto the first kept version.
 */
export function historyCarriedDocsPath(planningRoot: string, version: number): string {
  return join(historyVersionRoot(planningRoot, version), "carried-docs.json");
}

export function historyDocPath(planningRoot: string, version: number, cardId: string, kind: "spec" | "plan"): string {
  return join(historyVersionRoot(planningRoot, version), "docs", slugify(cardId), `${kind}.md`);
}
