// What each deploy card a Deploys page shows carried, line by line (deployRefs.deployLines): its listed commits'
// lines added and removed, pull request and branch. The page feeds them into the `deployLines` detail collection, one
// card at a time, and reads them back from the store, so a card seen before paints its +/− at once. A teamDeploys row
// lists the commits without them (lib/detailRows: list rows are thin). The reader pins what it shows against the cap.
import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { cachedAt, pinDetailRows } from "../lib/detailRows";
import type { DeployLine } from "../lib/deploys/board";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";
import { useWatchEffect } from "./useWatchEffect";

/** A deploy's lines as the store holds them, keyed by the deploy's id (the teamDeploys row's key). */
export type DeployLinesRow = { _id: string; rows: DeployLine[]; _cachedAt?: number };

/** How one deployLines answer lands in the store, stamped with when it was last fed (the cap evicts the oldest). */
export function deployLinesRows(deployId: string, answer: { rows: DeployLine[] } | null | undefined): DeployLinesRow[] | undefined {
  if (!answer) return undefined;
  const prev = (useInboxStore.getState() as { deployLines?: Record<string, DeployLinesRow> }).deployLines?.[deployId];
  return [{ _id: deployId, rows: answer.rows, _cachedAt: cachedAt(prev, Date.now()) }];
}

/** Feeder: one deploy's lines, by the deploy's id. Mounted for each card a page shows. */
export function useSyncDeployLines(deployId: string) {
  const feed = useMemo(() => ({ select: (answer: { rows: DeployLine[] } | null | undefined) => deployLinesRows(deployId, answer) }), [deployId]);
  return useSyncCollection("deployLines", (api as any).deployRefs.deployLines, entityIdArgs("deploy_id", deployId), feed);
}

/** Reader: the lines the store holds for these deploys, by deploy id; a deploy not read yet is absent ("—"). */
export function useDeployLines(deployIds: ReadonlyArray<string>): ReadonlyMap<string, ReadonlyArray<DeployLine>> {
  const key = [...new Set(deployIds)].sort().join(",");
  useWatchEffect(() => (key ? pinDetailRows("deployLines", key.split(",")) : undefined), [key]);
  const held = useInboxStore((s) => (s as { deployLines?: Record<string, DeployLinesRow> }).deployLines);
  return useMemo(() => {
    const out = new Map<string, ReadonlyArray<DeployLine>>();
    for (const id of key ? key.split(",") : []) { const row = held?.[id]; if (row) out.set(id, row.rows); }
    return out;
  }, [held, key]);
}
