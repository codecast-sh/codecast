import { useCallback } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

export interface HarnessChangeRow {
  _id: string;
  device_id: string;
  at: number;
  file: string;
  action: "created" | "modified" | "removed";
  what: string;
  why: string;
  automatic: boolean;
  version: string;
  bytes_before: number;
  bytes_after: number;
}

const newestFirst = (a: HarnessChangeRow, b: HarnessChangeRow) => b.at - a.at;
const rowSig = (r: HarnessChangeRow) => r._id;

/**
 * The change history of one device's agent harness (Settings > Harness),
 * newest first. The feed fills the `harnessChanges` collection and the list
 * paints from it, so a device you looked at before shows its history at once.
 */
export function useHarnessChanges(deviceId: string | null): { rows: HarnessChangeRow[]; ready: boolean } {
  const { ready } = useSyncCollection(
    "harnessChanges",
    api.harnessChanges.listForDevice,
    deviceId ? { device_id: deviceId, limit: 100 } : "skip",
  );
  const where = useCallback((r: HarnessChangeRow) => r.device_id === deviceId, [deviceId]);
  const rows = useCollectionRows<HarnessChangeRow>("harnessChanges", { where, sig: rowSig, sort: newestFirst });
  return { rows, ready };
}
