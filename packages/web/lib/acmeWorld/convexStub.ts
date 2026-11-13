// The Convex client both fixture modes hand the app (the phone's store shots,
// the web docs shots): no socket ever opens. The few queries screens still
// subscribe to directly answer from the Acme world (./world); every other
// watch stays loading, and mutations and actions resolve null unless the world
// answers them by name, so nothing reaches a server. Modeled on the homepage film's stub (web heroFly
// convexStub.ts). Mobile's Metro reaches this file, so imports stay relative.

import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { ACME_PARTS } from "./parts";
import { CAPTIONS, CURRENT_USER } from "./world";

const noop = () => {};

/** The stub's deployment address: never resolves, and namespaces Convex Auth's token storage. */
export const ACME_CONVEX_ADDRESS = "https://shots.invalid";

/** Answers by function name ("module:function"), computed at read time. */
export type AcmeAnswers = Record<string, (args: any) => unknown>;

export const ACME_ANSWERS: AcmeAnswers = {
  "transcripts:getLive": () => CAPTIONS(Date.now()),
  "calls:getMyCalls": () => ({ incoming: [], outgoing: [], membership: null }),
  "users:getCurrentUser": () => CURRENT_USER(Date.now()),
  ...Object.assign({}, ...ACME_PARTS.map((p) => p.answers ?? {})),
};

export function createAcmeConvex(answers: AcmeAnswers = ACME_ANSWERS): ConvexReactClient {
  // One value per query and arguments: a subscription reads its result on
  // every render and must get the same object back while nothing changed.
  const memo = new Map<string, unknown>();
  // Every query a screen asked for, with whether the world answered it: what a
  // new fixture screen needs (`__acmeAsked` from a console).
  const asked = new Map<string, boolean>();
  (globalThis as any).__acmeAsked = asked;
  const answerOf = (fn: unknown) => {
    try {
      return answers[getFunctionName(fn as never)];
    } catch {
      return undefined;
    }
  };
  const watch = (query: unknown, args?: unknown) => {
    let name = "";
    try {
      name = getFunctionName(query as never);
    } catch {}
    const answer = answers[name];
    asked.set(name, !!answer);
    const read = () => {
      if (!answer) return undefined;
      const key = `${name}|${JSON.stringify(args ?? {})}`;
      if (!memo.has(key)) memo.set(key, answer(args ?? {}));
      return memo.get(key);
    };
    return {
      onUpdate: () => noop,
      localQueryResult: read,
      localQueryLogs: () => undefined,
      journal: () => undefined,
    };
  };
  const methods: Record<string, unknown> = {
    watchQuery: watch,
    watchPaginatedQuery: watch,
    query: async (q: unknown, args?: unknown) => watch(q, args).localQueryResult() ?? null,
    // A write the world answers by name (a command id a screen then watches) gets
    // that answer, unmemoized; every other write resolves null.
    mutation: async (m: unknown, args?: unknown) => answerOf(m)?.(args ?? {}) ?? null,
    action: async (a: unknown, args?: unknown) => answerOf(a)?.(args ?? {}) ?? null,
    prewarmQuery: noop,
    connectionState: () => ({ hasInflightRequests: false, isWebSocketConnected: true, timeOfOldestInflightRequest: null, hasEverConnected: true, connectionCount: 1, connectionRetries: 0, inflightMutations: 0, inflightActions: 0 }),
    subscribeToConnectionState: () => noop,
    // Reports the fixture viewer as signed in without ever asking for a token,
    // so the auth layer never tries to refresh one against a server.
    setAuth: (_fetchToken: unknown, onChange?: (authenticated: boolean) => void) => onChange?.(true),
    clearAuth: noop,
    close: async () => {},
    url: ACME_CONVEX_ADDRESS,
    // Convex Auth namespaces its token storage by this.
    address: ACME_CONVEX_ADDRESS,
  };
  return new Proxy(methods, {
    // `then` stays undefined so the stub is never mistaken for a promise.
    get: (target, key) => (typeof key !== "string" || key === "then" ? undefined : key in target ? target[key] : noop),
  }) as unknown as ConvexReactClient;
}
