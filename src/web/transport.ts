// The page's one way to reach Planban: the local server on a computer, and on
// the web the hosted adapter, which answers the same routes from the online
// service. Both of the page's fetch wrappers go through here.
import { capabilities } from "./capabilities";
import { createHostedAdapter, type HostedAdapter } from "./hostedAdapter";

export const hostedAdapter: HostedAdapter | null = capabilities.hosted ? createHostedAdapter({ origin: window.location.origin }) : null;

export function pageFetch(path: string, init?: RequestInit): Promise<Response> {
  return hostedAdapter ? hostedAdapter.fetch(path, init) : fetch(path, init);
}
