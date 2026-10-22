// The Convex client in store shots mode (./flag): no socket ever opens. The
// few queries screens still subscribe to directly answer from the Acme world;
// every other watch stays loading, and mutations and actions resolve null.
// Modeled on the homepage film's stub (packages/web heroFly convexStub.ts).

import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { CAPTIONS, CURRENT_USER } from "./world";
import { useInboxStore } from "@codecast/web/store/inboxStore";

const noop = () => {};

// Reply suggestions anchored on whatever the conversation's tail is now.
function SUGGESTIONS(args: any) {
  const msgs = useInboxStore.getState().messages[args?.conversation_id] ?? [];
  const tail = [...msgs].reverse().find((m: any) => (m.role === "user" || m.role === "assistant") && m.content?.trim() && !m.tool_results?.length);
  if (!tail || tail.role !== "assistant") return null;
  return {
    anchor_message_uuid: tail.message_uuid ?? tail._id,
    suggestions: [
      "Ship it, and open the PR against main with the migration in its own commit",
      "Run the full test suite first",
      "Why did the retry path need a lock?",
    ],
  };
}

const ANSWERS: Record<string, (args?: unknown) => unknown> = {
  "composerSuggestions:getComposerSuggestions": SUGGESTIONS,
  "transcripts:getLive": () => CAPTIONS(Date.now()),
  "calls:getMyCalls": () => ({ incoming: [], outgoing: [], membership: null }),
  "users:getCurrentUser": () => CURRENT_USER(Date.now()),
};

function watch(query: unknown, args?: unknown) {
  let name = "";
  try {
    name = getFunctionName(query as never);
  } catch {}
  const answer = ANSWERS[name];
  return {
    onUpdate: () => noop,
    localQueryResult: () => (answer ? answer(args) : undefined),
    localQueryLogs: () => undefined,
    journal: () => undefined,
  };
}

const methods: Record<string, unknown> = {
  watchQuery: watch,
  watchPaginatedQuery: watch,
  query: async (q: unknown, a?: unknown) => watch(q, a).localQueryResult() ?? null,
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
