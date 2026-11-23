// The names a deploy's push added and dropped (deploys.get `adds`, `drops`),
// fed into the `deployDetails` detail collection by the surface that opens the
// deploy and read back from the store. A teamDeploys row carries only their
// counts (lib/detailRows: list rows are thin). The reader pins its row against
// the collection's cap.
import { api } from "@codecast/convex/convex/_generated/api";
import type { DeployView } from "@codecast/shared/contracts/deploys";
import { useInboxStore } from "../store/inboxStore";
import { cachedAt, pinDetailRows } from "../lib/detailRows";
import { useSyncCollection } from "./useSyncCollection";
import { useWatchEffect } from "./useWatchEffect";

/** A deploy's names as the store holds them, keyed by the deploy's id (the teamDeploys row's key). */
export type DeployDetailRow = { _id: string; adds: string[]; drops: string[]; _cachedAt?: number };

/** How one deploys.get answer lands in the store: its names, stamped with when they were last fed (the cap evicts the oldest). */
export function deployDetailRows(view: Pick<DeployView, "_id" | "adds" | "drops"> | null | undefined): DeployDetailRow[] | undefined {
  if (!view) return undefined;
  const prev = useInboxStore.getState().deployDetails?.[view._id] as DeployDetailRow | undefined;
  return [{ _id: view._id, adds: view.adds ?? [], drops: view.drops ?? [], _cachedAt: cachedAt(prev, Date.now()) }];
}

const FEED = { select: deployDetailRows };

/** Feeder: one deploy's names by its short id. Pass a ref only while the deploy is open and its row counts names. */
export function useSyncDeployDetail(shortId: string | null | undefined) {
  return useSyncCollection("deployDetails", api.deploys.get, shortId ? { ref: shortId } : "skip", FEED);
}

/** A deploy's names from the store; undefined until a surface has opened it. A mounted reader holds its row against the cap. */
export function useDeployDetail(id: string | undefined): DeployDetailRow | undefined {
  useWatchEffect(() => (id ? pinDetailRows("deployDetails", [id]) : undefined), [id]);
  return useInboxStore((s) => (id ? (s.deployDetails?.[id] as DeployDetailRow | undefined) : undefined));
}
