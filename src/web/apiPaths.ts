export function boardPath(repoId: string, path: string) {
  return `/api/boards/${encodeURIComponent(repoId)}${path}`;
}

/** Keep imported identities in a single URL segment, never URL structure. */
export function cardPath(repoId: string, cardId: string, path = "", version?: number) {
  // WHATWG URL parsing normalizes even percent-encoded standalone dots.
  if (cardId === "." || cardId === "..") throw new Error("This card has an unsafe id.");
  const history = version === undefined ? "" : `/history/${encodeURIComponent(String(version))}`;
  return boardPath(repoId, `${history}/cards/${encodeURIComponent(cardId)}${path}`);
}

/** The card a board address opens ("/boards/<id>#card=<card>", as ChatGPT and Claude link to it), if any. */
export function cardIdFromHash(hash: string): string | null {
  if (!hash.startsWith("#card=")) return null;
  try {
    const id = decodeURIComponent(hash.slice("#card=".length));
    return id && id !== "." && id !== ".." && !id.includes("/") ? id : null;
  } catch {
    return null;
  }
}

/** The card a link should open on this board: one that's on it, or none. */
export function linkedCardOnBoard(hash: string, cardIds: Iterable<string>): string | null {
  const cardId = cardIdFromHash(hash);
  if (!cardId) return null;
  for (const id of cardIds) if (id === cardId) return cardId;
  return null;
}

/** An online board's own address on the web page, for "Open on the web" in the installed app. */
export function boardWebAddress(serviceUrl: string, boardId: string): string {
  return `${serviceUrl.replace(/\/+$/u, "")}/boards/${encodeURIComponent(boardId)}`;
}
