// Org health — store-fed singleton (docs/architecture/org-staffing.md S3).
// Mirrors useSyncOrgTree: the staffing pane paints the flags from the cached
// snapshot; the feeder replaces it as the server recomputes. Scoped by the
// active team pointer; absent = the personal workspace.
//
// The feeder reads the FANNED path the CLI reads (orgHealth.healthReport, an
// action that gives the decision ladder and the task read their own query
// budgets before the core part runs), not the single process org.health
// query: on a large workspace the complete open task set plus the session
// scan is past what one query may read (4096 rows), and the pane's flags and
// summary would fail exactly on the busiest workspace. One computation on the
// server (computeOrgHealth) serves both; nothing here defines a flag. An
// action cannot be subscribed to, so the feeder asks on mount, on every
// workspace switch, and on a cadence, and hands each answer to syncTable the
// way a live query's push would land. Every consumer of a workspace shares
// that one read (holdHealth below), so a second surface costs nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useFeederError } from "./useSyncCollection";
import { isMissingFunctionError } from "./useSyncOrgTree";
import type { OrgHealth } from "../components/org/orgStaffingTypes";

const api = _api as any;

/** Health is computed on read; a minute between reads keeps the badges
 *  current without a query's cost on every scope event. */
export const ORG_HEALTH_REFRESH_MS = 60_000;

/** Convex's verdict when the websocket drops while an action is running; the
 *  client reconnects on its own but does not resend the action. */
export const ACTION_CONNECTION_LOST = "Connection lost while action was in flight";
export const RECONNECT_RETRY_DELAY_MS = 2_000;

/**
 * A read-only action asked again, once, after the socket dropped under it.
 * The report is idempotent, so a second ask costs one more computation and
 * nothing else; without it every reconnect (a laptop lid, an idle server
 * closing the socket) surfaced as a feeder error for a read the next cadence
 * tick would have repeated anyway.
 */
export async function callWithReconnectRetry<T>(call: () => Promise<T>, delayMs = RECONNECT_RETRY_DELAY_MS): Promise<T> {
  try {
    return await call();
  } catch (e: unknown) {
    if (!(e instanceof Error) || !e.message.includes(ACTION_CONNECTION_LOST)) throw e;
    await new Promise((r) => setTimeout(r, delayMs));
    return call();
  }
}

/**
 * One shared read per workspace key. The map, a role sheet and anything else
 * that shows health all mount this hook; without sharing, each instance armed
 * its own interval and asked the action on mount, so a sheet opened over the
 * map doubled the backend's work. An entry lives while at least one instance
 * holds the key: it owns the one interval, the in-flight ask that late mounts
 * join, and the ready/error state every instance renders. It is dropped when
 * the last holder leaves, because the store keeps a single orgHealth snapshot
 * and a workspace that has been away needs a fresh read when it comes back.
 */
type HealthSnap = { ready: boolean; error?: Error };
type HealthEntry = {
  refs: number;
  args: Record<string, unknown>;
  ask: (args: Record<string, unknown>) => Promise<unknown>;
  inFlight: Promise<void> | null;
  lastOk: number;
  snap: HealthSnap;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
};
const entries = new Map<string, HealthEntry>();
const COLD: HealthSnap = { ready: false };

function setSnap(entry: HealthEntry, snap: HealthSnap) {
  entry.snap = snap;
  for (const listener of entry.listeners) listener();
}

function readHealth(key: string): Promise<void> {
  const entry = entries.get(key);
  if (!entry) return Promise.resolve();
  if (entry.inFlight) return entry.inFlight;
  const run = (async () => {
    try {
      const result = await callWithReconnectRetry(() => entry.ask(entry.args));
      // A key whose last holder left mid-read no longer owns the singleton.
      if (entries.get(key) !== entry) return;
      if (result) useInboxStore.getState().syncTable("orgHealth", result);
      entry.lastOk = Date.now();
      setSnap(entry, { ready: true });
    } catch (e: unknown) {
      if (entries.get(key) !== entry) return;
      setSnap(entry, { ready: entry.snap.ready, error: e instanceof Error ? e : new Error(String(e)) });
    } finally {
      entry.inFlight = null;
    }
  })();
  entry.inFlight = run;
  return run;
}

function holdHealth(key: string, args: Record<string, unknown>, ask: HealthEntry["ask"]): () => void {
  let entry = entries.get(key);
  if (!entry) {
    entry = { refs: 0, args, ask, inFlight: null, lastOk: 0, snap: COLD, listeners: new Set(), timer: null };
    entries.set(key, entry);
  }
  entry.ask = ask;
  entry.refs++;
  if (!entry.timer) entry.timer = setInterval(() => void readHealth(key), ORG_HEALTH_REFRESH_MS);
  // A fresh answer or a read already under way serves this mount too.
  if (!entry.inFlight && Date.now() - entry.lastOk >= ORG_HEALTH_REFRESH_MS) void readHealth(key);
  const held = entry;
  return () => {
    held.refs--;
    if (held.refs > 0) return;
    if (held.timer) clearInterval(held.timer);
    if (entries.get(key) === held) entries.delete(key);
  };
}

function subscribeHealth(key: string, listener: () => void): () => void {
  const entry = entries.get(key);
  if (!entry) return () => {};
  entry.listeners.add(listener);
  return () => { entry.listeners.delete(listener); };
}

export function useSyncOrgHealth(enabled = true): { health: OrgHealth | null; ready: boolean; error?: Error; missing: boolean; refresh: () => Promise<void> } {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const teamArg = !enabled ? "skip" : !activeTeamId ? {} : isConvexId(activeTeamId) ? { team_id: activeTeamId } : "skip";
  const key = teamArg === "skip" ? "" : `ws:${activeTeamId ?? "personal"}`;
  const report = useAction(api.orgHealth.healthReport);
  // The read is keyed on the workspace alone: the action handle rides in a
  // ref so its identity can never restart the read loop.
  const reportRef = useRef(report);
  reportRef.current = report;
  const [snap, setLocalSnap] = useState<{ key: string; snap: HealthSnap }>({ key: "", snap: COLD });

  // eslint-disable-next-line no-restricted-syntax -- holds the workspace's shared read while mounted, rearmed when the key changes
  useEffect(() => {
    if (!key) return;
    const release = holdHealth(key, teamArg as Record<string, unknown>, (args) => reportRef.current(args));
    const sync = () => setLocalSnap({ key, snap: entries.get(key)?.snap ?? COLD });
    const unsubscribe = subscribeHealth(key, sync);
    sync();
    return () => { unsubscribe(); release(); };
    // teamArg is derived from key; key is the identity of the workspace read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refresh = useCallback((): Promise<void> => (key ? readHealth(key) : Promise.resolve()), [key]);
  const current = snap.key === key ? snap.snap : COLD;
  useFeederError("orgHealth.healthReport", current.error);
  const health = useInboxStore((s) => s.orgHealth);
  return { health, ready: current.ready, error: current.error, missing: isMissingFunctionError(current.error), refresh };
}
