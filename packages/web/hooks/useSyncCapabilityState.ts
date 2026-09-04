// Sync the fleet capability mirror into the store.
//
// Shaped on useSyncTasks deliberately, minus everything the mirror does not
// need: no origin badges, no active-session overlay, no reconcile crawl — the
// whole fleet is bounded (scope cap × device count), so the live channel IS
// the complete answer and a delta cursor only trims the reactive payload.
//
// The `since` watermark resets on every load and workspace switch, exactly as
// useSyncTasks does and for the same reason: a delta on cold start silently
// misses whatever the cache lacks. The floor is re-established every time; the
// cursor only advances within a session.

import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useWorkspaceArgs, type WorkspaceArgs } from "./useWorkspaceArgs";

import { useWatchEffect } from "./useWatchEffect";
/** How often the in-session cursor may advance. Reports change on heartbeat
 *  cadence, so a minute keeps the reactive window a beat or two wide. */
const CURSOR_REFRESH_MS = 60_000;

export function useSyncCapabilityStateWithArgs(wsArgs: WorkspaceArgs) {
  const syncTable = useInboxStore((s) => s.syncTable);

  const wsKey = wsArgs === "skip" ? "skip" : JSON.stringify(wsArgs);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const lastSeen = useRef<number | undefined>(undefined);
  const lastWsKey = useRef<string>(wsKey);
  if (lastWsKey.current !== wsKey) {
    lastWsKey.current = wsKey;
    if (cursor !== undefined) setCursor(undefined);
    lastSeen.current = undefined;
  }

  const result = useQuery(
    api.capabilityState.webList,
    wsArgs === "skip" ? "skip" : { ...(cursor !== undefined ? { since: cursor } : {}) },
  );

  const data = useMemo(() => {
    if (result === undefined) return undefined;
    return { items: result.items ?? [], truncated: !!result.truncated };
  }, [result]);

  useConvexSync(
    data,
    useCallback(
      (d: { items: any[] }) => {
        // Delta overlay, never a prune: a `since` page carries only what
        // changed, and wiping the rest would erase the fleet every minute.
        syncTable("capabilityState", d.items, { isDelta: true });
        for (const row of d.items) {
          if (typeof row?.reported_at === "number") {
            lastSeen.current = Math.max(lastSeen.current ?? 0, row.reported_at);
          }
        }
      },
      [syncTable],
    ),
  );

  // The header chip: loading only while the FIRST answer is pending.
  useWatchEffect(() => {
    useInboxStore.getState().setLiveLoading("capabilityState", wsArgs !== "skip" && result === undefined);
    return () => useInboxStore.getState().setLiveLoading("capabilityState", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirrors useSyncTasks: re-run on resolution flips only
  }, [result === undefined, wsArgs === "skip"]);

  // Advance the cursor within this session only — trims the reactive payload,
  // never persisted, resets on load.
  useWatchEffect(() => {
    const timer = setInterval(() => {
      if (lastSeen.current !== undefined && lastSeen.current !== cursor) {
        setCursor(lastSeen.current);
      }
    }, CURSOR_REFRESH_MS);
    return () => clearInterval(timer);
  }, [cursor]);
}

/** The app-shell entry point; mobile wraps the WithArgs variant in five lines
 *  the way packages/mobile does for tasks. */
export function useSyncCapabilityState() {
  return useSyncCapabilityStateWithArgs(useWorkspaceArgs());
}


/* ==========================================================================
 * Bindings — the user's wishes, synced beside the mirror
 * ========================================================================== */

/**
 * The bindings sync rides the same shape as the mirror. Cursor discipline is
 * identical and the reason is identical: a delta on cold start silently
 * misses what the cache lacks.
 */
export function useSyncCapabilityBindingsWithArgs(wsArgs: WorkspaceArgs) {
  const syncTable = useInboxStore((s) => s.syncTable);
  const wsKey = wsArgs === "skip" ? "skip" : JSON.stringify(wsArgs);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const lastSeen = useRef<number | undefined>(undefined);
  const lastWsKey = useRef<string>(wsKey);
  if (lastWsKey.current !== wsKey) {
    lastWsKey.current = wsKey;
    if (cursor !== undefined) setCursor(undefined);
    lastSeen.current = undefined;
  }

  const result = useQuery(
    api.capabilityBindings.webListBindings,
    wsArgs === "skip" ? "skip" : { ...(cursor !== undefined ? { since: cursor } : {}) },
  );
  const data = useMemo(() => (result === undefined ? undefined : { items: result.items ?? [] }), [result]);

  useConvexSync(
    data,
    useCallback(
      (d: { items: any[] }) => {
        syncTable("capabilityBindings", d.items, { isDelta: true });
        for (const row of d.items) {
          if (typeof row?.updated_at === "number") {
            lastSeen.current = Math.max(lastSeen.current ?? 0, row.updated_at);
          }
        }
      },
      [syncTable],
    ),
  );

  useWatchEffect(() => {
    const timer = setInterval(() => {
      if (lastSeen.current !== undefined && lastSeen.current !== cursor) setCursor(lastSeen.current);
    }, CURSOR_REFRESH_MS);
    return () => clearInterval(timer);
  }, [cursor]);
}

export function useSyncCapabilityBindings() {
  return useSyncCapabilityBindingsWithArgs(useWorkspaceArgs());
}
