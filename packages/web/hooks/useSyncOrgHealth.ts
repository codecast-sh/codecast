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
// way a live query's push would land.
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

export function useSyncOrgHealth(enabled = true): { health: OrgHealth | null; ready: boolean; error?: Error; missing: boolean; refresh: () => Promise<void> } {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const teamArg = !enabled ? "skip" : !activeTeamId ? {} : isConvexId(activeTeamId) ? { team_id: activeTeamId } : "skip";
  const key = teamArg === "skip" ? "" : `ws:${activeTeamId ?? "personal"}`;
  const report = useAction(api.orgHealth.healthReport);
  // The read is keyed on the workspace alone: the action handle rides in a
  // ref so its identity can never restart the read loop.
  const reportRef = useRef(report);
  reportRef.current = report;
  const syncTable = useInboxStore((s) => s.syncTable);
  const [state, setState] = useState<{ key: string; ready: boolean; error?: Error }>({ key: "", ready: false });

  const refresh = useCallback(async (): Promise<void> => {
    if (!key) return;
    try {
      const result = await callWithReconnectRetry(() => reportRef.current(teamArg as Record<string, unknown>));
      if (result) syncTable("orgHealth", result);
      setState({ key, ready: true });
    } catch (e: unknown) {
      setState((prev) => ({ key, ready: prev.key === key && prev.ready, error: e instanceof Error ? e : new Error(String(e)) }));
    }
    // teamArg is derived from key; key is the identity of the workspace read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, syncTable]);

  // eslint-disable-next-line no-restricted-syntax -- owns its own refresh interval, rearmed when the key changes
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const run = () => { if (!cancelled) void refresh(); };
    run();
    const timer = setInterval(run, ORG_HEALTH_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [key, refresh]);

  const current = state.key === key ? state : { key, ready: false, error: undefined };
  useFeederError("orgHealth.healthReport", current.error);
  const health = useInboxStore((s) => s.orgHealth);
  return { health, ready: current.ready, error: current.error, missing: isMissingFunctionError(current.error), refresh };
}
