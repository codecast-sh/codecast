// Feed the kit (teamKit.webListTeamKitItems) into the store's `teamKitItems`.
// Same cursor discipline as useSyncCapabilityBindings: the watermark resets on
// every load and workspace switch, advances only within a session.

import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useWorkspaceArgs, type WorkspaceArgs } from "./useWorkspaceArgs";
import { useWatchEffect } from "./useWatchEffect";

const CURSOR_REFRESH_MS = 60_000;

export function useSyncTeamKitWithArgs(wsArgs: WorkspaceArgs) {
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

  const result = useQueryNoThrow(
    api.teamKit.webListTeamKitItems,
    wsArgs === "skip" ? "skip" : { ...(cursor !== undefined ? { since: cursor } : {}) },
  ).data;
  const data = useMemo(() => (result === undefined ? undefined : { items: result.items ?? [] }), [result]);

  useConvexSync(
    data,
    useCallback(
      (d: { items: any[] }) => {
        syncTable("teamKitItems", d.items, { isDelta: true });
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

export function useSyncTeamKit() {
  return useSyncTeamKitWithArgs(useWorkspaceArgs());
}
