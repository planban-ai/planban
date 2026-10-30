// Live updates for an Online Board through a Convex subscription: the service
// pushes the board's revision the moment a change commits, so a watching board
// server needs no polling. Loaded only for Online Boards.
import { PlanbanNotFoundError } from "../boardOperations";
import { boardCredentials, onlineRequest } from "./client";
import { checkedConvexUrl } from "./convexUrl";

interface LiveToken {
  token: string;
  expiresAt: string;
  convexUrl: string;
}

export interface LiveWatch {
  close(): Promise<void>;
}

/**
 * Subscribes to a board's revision. Returns null when the service does not
 * offer live updates, so the caller can fall back to occasional checks.
 */
export async function watchRevision(
  serviceUrl: string,
  boardId: string,
  onRevision: (revision: number) => void,
  onError: (error: Error) => void,
): Promise<LiveWatch | null> {
  // As the board's own account, looked up again at each renewal.
  const fetchToken = async () => onlineRequest<LiveToken>(serviceUrl, "/api/v1/live-token", {}, { credentials: await boardCredentials(serviceUrl, boardId) });
  let first: LiveToken;
  try {
    first = await fetchToken();
  } catch (error) {
    if (error instanceof PlanbanNotFoundError) return null;
    throw error;
  }
  const { ConvexClient } = await import("convex/browser");
  const client = new ConvexClient(checkedConvexUrl(first.convexUrl), { unsavedChangesWarning: false });
  let pending: string | null = first.token;
  client.setAuth(async () => {
    if (pending) {
      const token = pending;
      pending = null;
      return token;
    }
    try {
      return (await fetchToken()).token;
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  });
  const unsubscribe = client.onUpdate(
    "live:revision" as never,
    { boardId } as never,
    (value: { revision: number }) => onRevision(value.revision),
    (error: Error) => onError(error),
  );
  return {
    async close() {
      unsubscribe();
      await client.close();
    },
  };
}
