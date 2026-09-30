/**
 * The Convex client the hero hands to every real component it renders. Every
 * query watch stays loading forever and never notifies, mutations and actions
 * resolve null, and no socket opens. So a view that still subscribes somewhere
 * (a pill's enrichment, an image url, a prefetch) renders its honest loading
 * state instead of reading the visitor's data or throwing into a boundary.
 *
 * Anything convex/react reaches for that is not listed resolves to a no-op
 * through the proxy, so a newer convex release cannot make the hero throw.
 */

import type { ConvexReactClient } from "convex/react";

const noop = () => {};

function loadingWatch() {
  return {
    onUpdate: () => noop,
    localQueryResult: () => undefined,
    localQueryLogs: () => undefined,
    journal: () => undefined,
  };
}

const methods: Record<string, unknown> = {
  watchQuery: loadingWatch,
  watchPaginatedQuery: loadingWatch,
  query: async () => null,
  mutation: async () => null,
  action: async () => null,
  prewarmQuery: noop,
  connectionState: () => ({ hasInflightRequests: false, isWebSocketConnected: false, timeOfOldestInflightRequest: null, hasEverConnected: false, connectionCount: 0, connectionRetries: 0, inflightMutations: 0, inflightActions: 0 }),
  subscribeToConnectionState: () => noop,
  setAuth: noop,
  clearAuth: noop,
  close: async () => {},
  url: "https://hero.invalid",
};

export const heroConvexStub = new Proxy(methods, {
  // `then` stays undefined so the stub is never mistaken for a promise.
  get: (target, key) => (typeof key !== "string" || key === "then" ? undefined : key in target ? target[key] : noop),
}) as unknown as ConvexReactClient;
