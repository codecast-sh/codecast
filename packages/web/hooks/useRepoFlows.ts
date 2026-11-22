// A repository's own flows, as the viewer's checkouts of it reported them (convex repoFlows.mine): the flows `cast flow
// run` takes there ahead of the shipped ones of the same slug. The Ship picker mounts this while it is open.
import { useMemo } from "react";
import { makeFunctionReference } from "convex/server";
import { repositoryKeyOfRemote } from "@codecast/shared/contracts";
import type { RepoFlow } from "@codecast/shared/contracts/repoFlows";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

const MINE = makeFunctionReference<"query">("repoFlows:mine");

type RepoFlowsRow = { _id: string; repository: string; flows: RepoFlow[]; updated_at: number };

const NONE: RepoFlow[] = [];
const rowSig = (r: RepoFlowsRow) => `${r.repository}|${r.updated_at}`;

/** The repository an origin remote names, the way a checkout reports its flows under it. */
export const repositoryOfRemote = (remote: string | null | undefined): string | null => repositoryKeyOfRemote(remote ?? undefined);

/** The flows the viewer's checkouts of `repository` reported; none while unknown or for no repository. */
export function useRepoFlows(repository: string | null): RepoFlow[] {
  useSyncCollection("repoFlows", MINE, repository ? {} : "skip");
  const where = useMemo(() => (r: RepoFlowsRow) => r.repository === repository, [repository]);
  const rows = useCollectionRows<RepoFlowsRow>("repoFlows", { where, sig: rowSig });
  return rows[0]?.flows ?? NONE;
}
