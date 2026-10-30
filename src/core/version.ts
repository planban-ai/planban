export const PLANBAN_VERSION = "2.0.0";
export const PLANBAN_PLUGIN_VERSION = "2.0.0";
export const PLANBAN_MCP_VERSION = "2.0.0";
export const PLANBAN_STORAGE_SCHEMA_VERSION = 2;
export const PLANBAN_UPDATE_MANIFEST_URL =
  "https://raw.githubusercontent.com/planban-ai/planban/main/release/latest.json";

export interface PlanbanVersionInfo {
  version: string;
  pluginVersion: string;
  mcpVersion: string;
  storageSchemaVersion: number;
  sourceUrl: string;
}

export interface PlanbanUpdateManifest {
  schemaVersion: 1;
  version: string;
  pluginVersion: string;
  mcpVersion: string;
  storageSchemaVersion: number;
  minimumStorageSchemaVersion: number;
  publishedAt: string;
  sourceUrl: string;
  releaseNotesUrl: string;
  targetRef?: string;
  targetCommit?: string;
  summary: string;
  updatePrompt: string;
  postUpdateRoute?: "tutorial" | "board" | "board-with-changelog";
  tutorialVersion?: number;
  showTutorialWhenUpdatingFromBefore?: string;
  changelogTitle?: string;
  changelogSummary?: string;
}

function versionParts(version: string) {
  const core = version.trim().replace(/^v/u, "").split(/[+-]/u)[0] ?? "0";
  return core.split(".").map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
}

export function compareVersions(left: string, right: string) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

export function currentVersionInfo(): PlanbanVersionInfo {
  return {
    version: PLANBAN_VERSION,
    pluginVersion: PLANBAN_PLUGIN_VERSION,
    mcpVersion: PLANBAN_MCP_VERSION,
    storageSchemaVersion: PLANBAN_STORAGE_SCHEMA_VERSION,
    sourceUrl: "https://github.com/planban-ai/planban",
  };
}
