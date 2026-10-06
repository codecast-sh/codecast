// The Evals area's state: eval runs, freezes, bisects and Multiplayer sim
// history read off this machine's disk through the daemon's /evals bridge.
// Private eval data, so it lives in memory only: not in inboxStore, not in the
// client sync registry, not in IndexedDB, not in localStorage
// (store/__tests__/evalsStore.guard.test.ts holds that line). A reload reads
// the disk again; the api child keeps its own index warm, so that is cheap.
//
// The store is the resource cache (@platform/evals/client's
// EvalsResourceCache, memory only by contract) that the area's provider
// (components/evals/host.tsx) hands its client, so when a load runs and what
// a failure keeps have one implementation. What stays here is codecast's:
// finding the daemon, the fixture world, and what a failure means for the
// whole area (onEvalsFailure, the provider's onFailure).

import { create } from "zustand";
import type { ConvexReactClient } from "convex/react";
import type { EvalsRoutes, EvalsUnavailableReason } from "@codecast/shared/contracts/evalsApi";
import { evalsCalls, EvalsRequestError, type CachedResource, type EvalsResourceCache, type EvalsTransport } from "@platform/evals/client";
import { lastDiscoveryFailure, type LoopbackUnreachableReason } from "../lib/terminal/endpoint";
import { getVaultEndpoint } from "../lib/vault/client";
import { loopbackTransport } from "../lib/evals/client";
import { evalsFixtureMode, fixtureTransport, type EvalsFixtureMode } from "../lib/evals/fixtureTransport";

export type EvalsConnection = "idle" | "discovering" | "connected" | "no-daemon" | "no-checkout" | "child-crashed";

/** Why the evals cannot answer, in words a person can act on. */
export const EVALS_UNAVAILABLE_WORDS: Record<Exclude<EvalsUnavailableReason, "child-crashed">, string> = {
  "no-bun": "bun is not on the daemon's PATH, so it cannot start the evals process.",
  "no-checkout": "EVALS_HOME/checkout.json is missing: ./evals writes it on every run.",
  "checkout-not-owned": "The checkout that EVALS_HOME/checkout.json names is not owned by this user.",
  "checkout-bad-header": "The checkout's ./evals script does not start with the known header.",
  "checkout-not-toplevel": "The checkout that EVALS_HOME/checkout.json names is not a git toplevel.",
  "checkout-no-entry": "The checkout has no packages/evals/src/index.ts.",
};

const CHECKOUT_REASONS = new Set<string>(Object.keys(EVALS_UNAVAILABLE_WORDS));

/** Codecast's routes' requests, cache keys and calls: the client's, typed by codecast's wider route table. */
export const { request: evalsRequest, cacheKey: evalsCacheKey, call: callEvals } = evalsCalls<EvalsRoutes>();

/** What a failed request means for the whole area, or null when it is that one request's problem. */
export function classifyEvalsFailure(e: unknown): Pick<EvalsState, "connection" | "unreachableReason" | "unreachableDetail" | "stderr"> | null {
  if (!(e instanceof EvalsRequestError)) {
    return { connection: "no-daemon", unreachableReason: "error", unreachableDetail: e instanceof Error ? e.message : String(e), stderr: null };
  }
  const reason = e.body.reason;
  if (e.status === 502 || reason === "child-crashed") return { connection: "child-crashed", unreachableReason: "none", unreachableDetail: e.body.error, stderr: e.body.stderr ?? [] };
  if (reason && CHECKOUT_REASONS.has(reason)) {
    // The daemon's own words name the checkout and what is wrong with it; the table covers a bare reason.
    const said = e.body.error?.trim();
    const detail = said ? `${said[0].toUpperCase()}${said.slice(1)}${/[.!?]$/.test(said) ? "" : "."}` : EVALS_UNAVAILABLE_WORDS[reason as keyof typeof EVALS_UNAVAILABLE_WORDS];
    return { connection: "no-checkout", unreachableReason: "none", unreachableDetail: detail, stderr: null };
  }
  // A 404 the child wrote names a missing id; one with no reason is a daemon without /evals.
  if (e.status === 404 && !reason) return { connection: "no-daemon", unreachableReason: "old-daemon", unreachableDetail: e.body.error, stderr: null };
  if (e.status === 401 || e.status === 403) return { connection: "no-daemon", unreachableReason: "refused", unreachableDetail: e.body.error, stderr: null };
  return null;
}

interface EvalsState {
  connection: EvalsConnection;
  transport: EvalsTransport | null;
  fixture: EvalsFixtureMode;
  unreachableReason: LoopbackUnreachableReason;
  unreachableDetail: string | null;
  /** The crashed child's last stderr lines. */
  stderr: string[] | null;
  /** The cached answers by cache key: the client's resource cache (evalsResourceCache). */
  resources: Record<string, CachedResource>;

  connect: (convex: ConvexReactClient, opts?: { force?: boolean }) => Promise<void>;
}

const fresh = (): Pick<EvalsState, "unreachableReason" | "unreachableDetail" | "stderr"> => ({ unreachableReason: "none", unreachableDetail: null, stderr: null });

/** The resources slice as the client's cache: what the area's provider keeps its answers in. */
export const evalsResourceCache: EvalsResourceCache = {
  get: (key) => useEvalsStore.getState().resources[key],
  set: (key, value) => useEvalsStore.setState((s) => ({ resources: { ...s.resources, [key]: value } })),
  subscribe: (key, fn) => useEvalsStore.subscribe((s, prev) => s.resources[key] !== prev.resources[key] && fn()),
  clear: (pred) => useEvalsStore.setState((s) => ({ resources: pred ? Object.fromEntries(Object.entries(s.resources).filter(([k]) => !pred(k))) : {} })),
};

/** A failed call that means the area cannot answer moves the connection with it; a one-off miss stays its page's. */
export function onEvalsFailure(e: unknown): void {
  const moved = classifyEvalsFailure(e);
  if (moved) useEvalsStore.setState(moved);
}

export const useEvalsStore = create<EvalsState>()((set, get) => {
  return {
    connection: "idle",
    transport: null,
    fixture: "off",
    ...fresh(),
    resources: {},

    connect: async (convex, opts) => {
      const fixture = evalsFixtureMode();
      // A retry keeps the answers already read: a slow or restarted daemon does not make them wrong, and each page
      // reloads its own. Only a switch between the fixture world and the disk drops them.
      set({ connection: "discovering", fixture, ...(fixture !== get().fixture ? { resources: {} } : {}) });
      let t: EvalsTransport;
      if (fixture === "no-daemon") {
        set({ connection: "no-daemon", transport: null, unreachableReason: "no-devices", unreachableDetail: "EVALS_FIXTURE=no-daemon", stderr: null });
        return;
      }
      if (fixture !== "off") t = await fixtureTransport(fixture);
      else {
        const endpoint = await getVaultEndpoint(convex, opts);
        if (!endpoint) {
          set({ connection: "no-daemon", transport: null, unreachableReason: lastDiscoveryFailure(), unreachableDetail: null, stderr: null });
          return;
        }
        t = loopbackTransport(endpoint);
      }
      set({ transport: t });
      try {
        const health = await callEvals(t, "GET /health", {});
        // The views read /health from the cache: the answer that proved the connection is their first.
        evalsResourceCache.set(evalsCacheKey("GET /health", {}), { data: health, error: null, status: 200, loading: false, at: Date.now() });
        set({ connection: "connected", ...fresh() });
      } catch (e) {
        set({ ...(classifyEvalsFailure(e) ?? { connection: "no-daemon", unreachableReason: "error", unreachableDetail: e instanceof Error ? e.message : String(e), stderr: null }) });
      }
    },
  };
});
