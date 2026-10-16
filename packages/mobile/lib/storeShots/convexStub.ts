// The Convex client in store shots mode (./flag): no socket ever opens. The
// few queries screens still subscribe to directly answer from the Acme world;
// every other watch stays loading, and mutations and actions resolve null.
// Modeled on the homepage film's stub (packages/web heroFly convexStub.ts).

import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { CAPTIONS, CURRENT_USER } from "./world";

const noop = () => {};

const ANSWERS: Record<string, () => unknown> = {
  "transcripts:getLive": () => CAPTIONS(Date.now()),
  "calls:getMyCalls": () => ({ incoming: [], outgoing: [], membership: null }),
  "users:getCurrentUser": () => CURRENT_USER(Date.now()),
};

function watch(query: unknown) {
  let name = "";
  try {
    name = getFunctionName(query as never);
  } catch {}
  const answer = ANSWERS[name];
  return {
    onUpdate: () => noop,
    localQueryResult: () => (answer ? answer() : undefined),
    localQueryLogs: () => undefined,
    journal: () => undefined,
  };
}

const methods: Record<string, unknown> = {
  watchQuery: watch,
  watchPaginatedQuery: watch,
  query: async (q: unknown) => watch(q).localQueryResult() ?? null,
  mutation: async () => null,
  action: async () => null,
  prewarmQuery: noop,
  connectionState: () => ({ hasInflightRequests: false, isWebSocketConnected: true, timeOfOldestInflightRequest: null, hasEverConnected: true, connectionCount: 1, connectionRetries: 0, inflightMutations: 0, inflightActions: 0 }),
  subscribeToConnectionState: () => noop,
  setAuth: noop,
  clearAuth: noop,
  close: async () => {},
  url: "https://shots.invalid",
  // Convex Auth namespaces its token storage by this.
  address: "https://shots.invalid",
};

export const storeShotsConvex = new Proxy(methods, {
  // `then` stays undefined so the stub is never mistaken for a promise.
  get: (target, key) => (typeof key !== "string" || key === "then" ? undefined : key in target ? target[key] : noop),
}) as unknown as ConvexReactClient;
