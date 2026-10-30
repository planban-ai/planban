// One web bundle serves two places (Planban 2.0 plan, "How the page talks to
// the service"). On a computer the page is served by the local Planban server
// at a loopback address; on the web it is served from the online service's
// own address. What only makes sense on a computer is switched off there.

export interface PageCapabilities {
  /** The page talks to the online service through the hosted adapter, not a local server. */
  hosted: boolean;
  /** Project folders: a board's folder on disk, opening it, archiving and deleting its files. */
  projectFolders: boolean;
  /** Starting local agents and Codex threads from a card or from feedback. */
  localAgents: boolean;
  /** Planban updates for the installed app. */
  updates: boolean;
  /** The tutorial and its demo board. */
  tutorial: boolean;
  /** Take online and Take local: moving a board between this computer and the service. */
  moveBoards: boolean;
  /** Checking whether a local board is an older copy of an online one. */
  olderCopyCheck: boolean;
  /** Live agent activity, which local agents report to the local server. */
  agentActivity: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Hosted unless the page came from a loopback address: the local server only
 * ever listens there. `forced` ("1" or "0") lets a development build try
 * either mode.
 */
export function isHostedLocation(location: { hostname: string }, forced?: string): boolean {
  if (forced === "1") return true;
  if (forced === "0") return false;
  return !LOOPBACK.has(location.hostname.toLowerCase());
}

export function capabilitiesFor(hosted: boolean): PageCapabilities {
  const local = !hosted;
  return {
    hosted,
    projectFolders: local,
    localAgents: local,
    updates: local,
    tutorial: local,
    moveBoards: local,
    olderCopyCheck: local,
    agentActivity: local,
  };
}

const forced = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_PLANBAN_HOSTED;

export const capabilities: PageCapabilities = capabilitiesFor(
  typeof window !== "undefined" && isHostedLocation(window.location, forced),
);
