// Only the newest request for each kind of thing, for the thing on screen,
// may change what the page shows. An earlier request that answers late (after
// switching card or version and back, or after Try again) is ignored.
export function latestRequestGate<Kind extends string>() {
  let counter = 0;
  const latest = new Map<Kind, number>();
  return {
    /** Starts a request for this kind and the identity on screen; returns its check. */
    begin(kind: Kind, identity: string, onScreen: () => string) {
      const id = ++counter;
      latest.set(kind, id);
      return () => latest.get(kind) === id && onScreen() === identity;
    },
  };
}
