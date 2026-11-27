// A merged pull request's or main commit's reach toward production
// (deploys.md DP16): deployReach.get fed into the `deployReach` collection,
// read back from the store. Null from the server (an open pull request, a
// repository with no deploy targets, a change that touches none, a viewer who
// lost access) removes the row, so the reader draws nothing. The collection is
// capped like the detail collections (lib/detailRows): the reader pins its row.
import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { DeployReach } from "@codecast/shared/contracts/deployReach";
import { useInboxStore } from "../store/inboxStore";
import { cachedAt, pinDetailRows } from "../lib/detailRows";
import { useSyncCollection } from "./useSyncCollection";
import { useWatchEffect } from "./useWatchEffect";

export type DeployReachRow = DeployReach & { _id: string; ref: string; _cachedAt?: number };

/**
 * How one ref's answer lands in the store: its row, stamped with when it was
 * last fed (the cap evicts the oldest), or none at all. An answer is the whole
 * truth about its ref, so a null drops the row the store held for it.
 */
export function deployReachFeed(ref: string) {
  return {
    select: (row: DeployReachRow | null) =>
      row ? [{ ...row, _cachedAt: cachedAt(useInboxStore.getState().deployReach?.[row._id] as DeployReachRow | undefined, Date.now()) }] : [],
    dropAbsent: (row: { _id: string }) => row._id === ref,
  };
}

/** The reach of `ref` (`owner/repo#N` or `owner/repo@sha`); `feed` false reads only what another surface fed. */
export function useDeployReach(ref: string | null, feed = true): DeployReachRow | undefined {
  return useDeployReachRead(ref, feed).reach;
}

/**
 * The reach of `ref`, and whether the server has answered for it since this surface mounted (`ready`). Until then the
 * row is what an earlier visit cached: a deploy since may have taken the change live, so a surface that would claim
 * where it is not live yet (a run stopped at Deploy) says it is reading instead.
 */
export function useDeployReachRead(ref: string | null, feed = true): { reach: DeployReachRow | undefined; ready: boolean } {
  const opts = useMemo(() => (ref ? deployReachFeed(ref) : undefined), [ref]);
  const { ready, error } = useSyncCollection("deployReach", api.deployReach.get, ref && feed ? { ref } : "skip", opts);
  useWatchEffect(() => (ref ? pinDetailRows("deployReach", [ref]) : undefined), [ref]);
  const row = useInboxStore((s) => (ref ? (s.deployReach?.[ref] as DeployReachRow | undefined) : undefined));
  // A change that touches no target has no reach (the server answers null; a row without targets is the same).
  return { reach: row?.targets?.length ? row : undefined, ready: !ref || !feed || ready || !!error };
}
