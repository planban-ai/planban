export const PLANBAN_STATUSES = [
  "in-progress",
  "up-next",
  "pending",
  "complete",
  "archived",
] as const;

export type PlanbanStatus = (typeof PLANBAN_STATUSES)[number];

export interface PlanbanProjectManifest {
  version: 1;
  repoId: string;
  enabled: boolean;
  storage?: {
    kind: "local";
    root?: string | undefined;
  } | {
    kind: "online";
    url: string;
    boardId: string;
  } | undefined;
}

export interface PlanbanProject {
  id: string;
  title: string;
  status: string;
  description: string;
  tags: string[];
}

export interface PlanbanColumn {
  id: PlanbanStatus;
  label: string;
}

export interface PlanbanRoadmapItem {
  id: string;
  title: string;
  status: PlanbanStatus;
  priority: number | null;
  summary: string | null;
  nextAction: string | null;
  tags: string[];
  icon: string | null;
  blockedBy: string | null;
  specDoc: string | null;
  planDoc: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  /**
   * When the card last noted progress: its summary or next action changed, or it was completed.
   * A merged PR it names is flagged until then; touches and metadata edits leave it alone.
   * Absent on cards written before Planban 2.0, where updatedAt stands in.
   */
  progressNotedAt?: string | null | undefined;
  isGroup: boolean;
  parentId: string | null;
  boardRank: number | null;
  groupRank: number | null;
  metadata?: Record<string, unknown>;
  /**
   * Landing notes: pull requests that merged naming this card, newest first, recorded by the
   * GitHub integration of an Online Board. Never written by people or agents directly.
   */
  landings?: PlanbanLanding[] | undefined;
}

/** A merged pull request, as a landing note on a card or an item in the board's inbox. */
export interface PlanbanLanding {
  /** "owner/name", as GitHub spells it. */
  repo: string;
  number: number;
  title: string;
  mergedAt: string;
  url: string;
  /** When Planban recorded it. */
  recordedAt: string;
  /**
   * Set when GitHub hadn't confirmed the link that reported it: the name of the person who set
   * the link up, whose word it is. Absent when GitHub's own confirmed webhook reported it.
   */
  reportedThrough?: string | undefined;
}

export interface PlanbanRoadmap {
  version: 1 | 2;
  writerVersion: number;
  revision: number;
  updatedAt: string;
  project: PlanbanProject;
  columns: PlanbanColumn[];
  roadmapItems: PlanbanRoadmapItem[];
  /**
   * Merged pull requests from a linked GitHub repository that named no card, newest first.
   * Agents assign each to a card or dismiss it; people never see the list.
   */
  landingInbox?: PlanbanLanding[] | undefined;
}

export interface PlanbanResolvedState {
  /**
   * Online Boards only: set when a retried edit was recognised as already
   * applied. The result is the original; the roadmap is the current one when
   * the roadmap as it was right after the edit is no longer available.
   */
  onlineReplay?: { replayed: true; originalRevision?: number } | undefined;
  /**
   * Online Boards only: the board uses features this Planban can't show
   * (16 October 2026). The notice is for people and agents alike.
   */
  planbanBehind?: { notice: string; features: string[] } | undefined;
  cwd: string;
  manifestPath: string;
  agentContextPath: string;
  planningRoot: string;
  roadmapPath: string;
  manifest: PlanbanProjectManifest;
  roadmap: PlanbanRoadmap;
}

export interface PlanbanDocPayload {
  cardId: string;
  kind: "spec" | "plan";
  path: string | null;
  exists: boolean;
  markdown: string;
  mtimeMs: number | null;
  /** An online write retried with the same idempotency key: applied once, earlier. */
  replayed?: true | undefined;
  originalRevision?: number | undefined;
}

export type PlanbanHistoryActor = "user" | "agent" | "import" | "system";

export interface PlanbanHistoryDocRef {
  cardId: string;
  kind: "spec" | "plan";
  path: string | null;
}

export interface PlanbanHistoryEntry {
  version: number;
  roadmapRevision: number;
  createdAt: string;
  actor: PlanbanHistoryActor;
  operation: string;
  summary: string;
  affectedCards: string[];
  affectedDocs: PlanbanHistoryDocRef[];
}

export interface PlanbanHistoryIndex {
  version: 1;
  latestVersion: number;
  retention: {
    boardVersions: number;
    cardVersions: number;
    documentVersions: number;
    hourlyDays: number;
    maxAgeDays: number;
  };
  entries: PlanbanHistoryEntry[];
}

export interface PlanbanHistoryPayload {
  currentVersion: number;
  retention: PlanbanHistoryIndex["retention"];
  entries: PlanbanHistoryEntry[];
}

export interface PlanbanBoardRecord {
  repoId: string;
  title: string;
  cwd: string;
  planningRoot: string;
  roadmapPath: string;
  manifestPath: string;
  kind?: "project" | "demo";
  archivedAt?: string | null;
  lastOpenedAt: string;
  updatedAt: string;
}

export interface PlanbanBoardRegistry {
  version: 1;
  boards: PlanbanBoardRecord[];
}
