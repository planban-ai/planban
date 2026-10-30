import { PLANBAN_VERSION } from "./version";

/**
 * Planban on a computer and the online service, at different versions (owner decision,
 * 16 October 2026). The service keeps accepting older versions' actions, and new
 * features are added alongside existing ones. When a board uses something a computer's
 * Planban can't show, or an action needs a newer Planban, that Planban says so in plain
 * English and points at Update, instead of quietly showing less or failing with a raw error.
 *
 * Shared by the computer's client and the online service.
 */

/** Every request from a computer's Planban names its version here. */
export const PLANBAN_VERSION_HEADER = "X-Planban-Version";

/** The service's answer when an action needs a newer Planban. */
export const UPDATE_REQUIRED_CODE = "update_required";
export const UPDATE_REQUIRED_STATUS = 426;

/**
 * What a board can use that a Planban must know about to show it all, and the first
 * Planban that shows each. Add new ones; never remove one or change its version.
 */
export const BOARD_FEATURE_SINCE: Readonly<Record<string, string>> = { goals: "2.0.0" };

/** The board features a Planban of `version` can show. */
export function knownFeaturesFor(version: string): string[] {
  return Object.entries(BOARD_FEATURE_SINCE).filter(([, since]) => compareVersions(version, since) >= 0).map(([feature]) => feature);
}

/**
 * The earliest Planban each version-sensitive action accepts. An action not listed
 * accepts every version. Raise one only when an older version's request would now
 * do the wrong thing; prefer adding a new action alongside it.
 */
export const ACTION_MIN_VERSION: Readonly<Record<string, string>> = {};

/** The earliest Planban the service accepts at all. Requests without a version count as 1.0.0. */
export const MIN_CLIENT_VERSION = "1.0.0";

export const BEHIND_NOTICE = "This board uses features your Planban doesn't have yet. Update to see everything.";
/** How a person updates, for agents to pass on: the board page's Update opens the existing update flow. */
export const UPDATE_HOW = "Ask the person to update Planban: open the board in Planban on this computer and choose Update.";
export const UPDATE_REQUIRED_MESSAGE = "This board uses features your Planban doesn't have yet, so this can't be done from here. Update Planban, then try again.";

/** Compares two versions like 2.0.0 or 2.1.0-beta.1 by their numbers; anything unreadable counts as 0. */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string) => version.split(/[-+]/u)[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** The features a board uses, for its readers to compare with what they can show. */
export function boardFeatures(board: { hasGoals: boolean }): string[] {
  return board.hasGoals ? ["goals"] : [];
}

/** The features of `used` this Planban can't show. */
export function unknownFeatures(used: readonly string[] | undefined, version = PLANBAN_VERSION): string[] {
  const known = knownFeaturesFor(version);
  return (used ?? []).filter((feature) => !known.includes(feature));
}

/** Whether a request from `clientVersion` (null: it named none) may run `op`; the refusal message if not. */
export function refusedForVersion(clientVersion: string | null, op?: string,
  rules: { minimums?: Readonly<Record<string, string>>; floor?: string } = {}): string | null {
  const version = clientVersion?.trim() || "1.0.0";
  const minimum = op ? (rules.minimums ?? ACTION_MIN_VERSION)[op] : undefined;
  if (compareVersions(version, rules.floor ?? MIN_CLIENT_VERSION) < 0) return UPDATE_REQUIRED_MESSAGE;
  if (minimum && compareVersions(version, minimum) < 0) return UPDATE_REQUIRED_MESSAGE;
  return null;
}
