// The Evals area's state: eval runs, freezes, bisects and Multiplayer sim
// history read off this machine's disk through the daemon's /evals bridge.
// Private eval data, so it lives in memory only: not in inboxStore, not in the
// client sync registry, not in IndexedDB, not in localStorage
// (store/__tests__/evalsStore.guard.test.ts holds that line). A reload reads
// the disk again; the api child keeps its own index warm, so that is cheap.

import { create } from "zustand";
import type { ConvexReactClient } from "convex/react";
import type { EvalsRouteKey, EvalsResponse, EvalsUnavailableReason, HealthResponse } from "@codecast/shared/contracts/evalsApi";
import { lastDiscoveryFailure, type LoopbackUnreachableReason } from "../lib/terminal/endpoint";
import { getVaultEndpoint } from "../lib/vault/client";
import { EvalsRequestError, callEvals, evalsRequest, loopbackTransport, type EvalsArgs, type EvalsTransport } from "../lib/evals/client";
import { evalsFixtureMode, fixtureTransport, type EvalsFixtureMode } from "../lib/evals/fixtureTransport";

export type EvalsConnection = "idle" | "discovering" | "connected" | "no-daemon" | "no-checkout" | "child-crashed";

/** One cached answer, keyed by its request (evalsCacheKey). */
export interface EvalsResource<T = unknown> {
  data: T | null;
  error: string | null;
  status: number | null;
  loading: boolean;
  at: number;
}

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

/** The cache key for a request: its path and query, which is everything the answer depends on. */
export function evalsCacheKey<K extends EvalsRouteKey>(key: K, args: EvalsArgs<K>): string {
  const req = evalsRequest(key, args);
  const qs = new URLSearchParams(Object.entries(req.query).sort(([a], [b]) => a.localeCompare(b))).toString();
  return `${req.method} ${req.path}${qs ? `?${qs}` : ""}`;
}

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
  health: HealthResponse | null;
  resources: Record<string, EvalsResource>;

  connect: (convex: ConvexReactClient, opts?: { force?: boolean }) => Promise<void>;
  /** Calls one route; a failure that means the area cannot answer moves the connection with it. */
  call: <K extends EvalsRouteKey>(key: K, args: EvalsArgs<K>) => Promise<EvalsResponse<K>>;
  /** Fills resources[evalsCacheKey(key, args)]; a cached answer is kept unless forced. */
  load: <K extends EvalsRouteKey>(key: K, args: EvalsArgs<K>, opts?: { force?: boolean }) => Promise<void>;
  refreshHealth: () => Promise<void>;
  /** Drops cached answers whose key starts with a prefix ("GET /surface/settle"), or all. */
  invalidate: (prefix?: string) => void;
}

const fresh = (): Pick<EvalsState, "unreachableReason" | "unreachableDetail" | "stderr"> => ({ unreachableReason: "none", unreachableDetail: null, stderr: null });

export const useEvalsStore = create<EvalsState>()((set, get) => {
  const transport = () => {
    const t = get().transport;
    if (!t) throw new Error("the evals are not connected");
    return t;
  };

  return {
    connection: "idle",
    transport: null,
    fixture: "off",
    ...fresh(),
    health: null,
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
        set({ connection: "connected", health, ...fresh() });
      } catch (e) {
        set({ health: null, ...(classifyEvalsFailure(e) ?? { connection: "no-daemon", unreachableReason: "error", unreachableDetail: e instanceof Error ? e.message : String(e), stderr: null }) });
      }
    },

    call: async (key, args) => {
      try {
        return await callEvals(transport(), key, args);
      } catch (e) {
        const moved = classifyEvalsFailure(e);
        if (moved) set(moved);
        throw e;
      }
    },

    load: async (key, args, opts) => {
      const k = evalsCacheKey(key, args);
      const had = get().resources[k];
      if (had && (had.loading || (!opts?.force && had.data !== null))) return;
      set((s) => ({ resources: { ...s.resources, [k]: { data: had?.data ?? null, error: null, status: null, loading: true, at: had?.at ?? 0 } } }));
      try {
        const data = await get().call(key, args);
        set((s) => ({ resources: { ...s.resources, [k]: { data, error: null, status: 200, loading: false, at: Date.now() } } }));
      } catch (e) {
        const status = e instanceof EvalsRequestError ? e.status : null;
        set((s) => ({ resources: { ...s.resources, [k]: { data: had?.data ?? null, error: e instanceof Error ? e.message : String(e), status, loading: false, at: Date.now() } } }));
      }
    },

    refreshHealth: async () => {
      try {
        const health = await get().call("GET /health", {});
        set({ health });
      } catch {
        // call() already moved the connection when the failure is area-wide.
      }
    },

    invalidate: (prefix) =>
      set((s) => ({ resources: prefix ? Object.fromEntries(Object.entries(s.resources).filter(([k]) => !k.startsWith(prefix))) : {} })),
  };
});
