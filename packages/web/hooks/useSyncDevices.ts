// The viewer's device roster (listDevices) — store-fed. Every surface that
// shows a device chip mounts the feeder; the store keeps the roster warm and
// persisted for boot, and flips machineRosterLive on the first live push so
// the path-seeding gate never trusts a stale cache.
import { useCallback } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";

const api = _api as any;

export function useSyncDevices(enabled = true): { ready: boolean } {
  const { data } = useQueryNoThrow(api.devices.listDevices, enabled ? {} : "skip");
  const setMachineRoster = useInboxStore((s) => s.setMachineRoster);
  useConvexSync(data, useCallback((rows: any) => { if (Array.isArray(rows)) setMachineRoster(rows); }, [setMachineRoster]));
  return { ready: data !== undefined };
}

/** The roster for the path-seeding gate: only once a live push has landed
 *  this page load; empty (permissive) before. */
export function liveMachineRoster(s: { machineRoster: any[]; machineRosterLive: boolean }): any[] {
  return s.machineRosterLive ? s.machineRoster : [];
}
