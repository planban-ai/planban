/** The Convex address for live updates: HTTPS, or plain HTTP only on this computer. */
export function checkedConvexUrl(value: string) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
    throw new Error("Online Board live updates need an HTTPS address.");
  }
  return url.href.replace(/\/$/, "");
}
