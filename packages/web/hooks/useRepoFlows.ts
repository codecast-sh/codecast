// A checkout's own flows, as the viewer's machines reported them (convex repoFlows.forCheckout): the flows `cast flow
// run` takes there ahead of the shipped ones of the same slug. The Ship picker mounts this while it is open.
import { useMemo } from "react";
import { makeFunctionReference } from "convex/server";
import { repositoryKeyOfRemote } from "@codecast/shared/contracts";
import type { RepoFlow } from "@codecast/shared/contracts/repoFlows";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

const FOR_CHECKOUT = makeFunctionReference<"query">("repoFlows:forCheckout");

export type RepoFlowsRow = { _id: string; root: string; repository: string; flows: RepoFlow[]; updated_at: number };

const NONE: RepoFlow[] = [];
const rowSig = (r: RepoFlowsRow) => `${r.root}|${r.updated_at}`;

/** The repository an origin remote names, the way a checkout reports its flows under it. */
export const repositoryOfRemote = (remote: string | null | undefined): string | null => repositoryKeyOfRemote(remote ?? undefined);

type SessionRows = { sessions?: Record<string, any>; conversations?: Record<string, any> };

/** A session's origin remote. A sessions row can lack it while the conversation row has it, so both are read. */
export function sessionRemoteOf(s: SessionRows, id: string): string | null {
  return s.sessions?.[id]?.git_remote_url ?? s.conversations?.[id]?.git_remote_url ?? null;
}

/** A session's checkout: its git top level, the key a checkout reports its flows under. */
export function sessionRootOf(s: SessionRows, id: string): string | null {
  return s.sessions?.[id]?.git_root ?? s.conversations?.[id]?.git_root ?? null;
}

/** Of the rows held for a checkout and its repository: the checkout's own, else the repository's newest report. */
export function checkoutRow(rows: ReadonlyArray<RepoFlowsRow>, root: string | null): RepoFlowsRow | null {
  return rows.find((r) => r.root === root) ?? [...rows].sort((a, b) => b.updated_at - a.updated_at)[0] ?? null;
}

/** The flows of the checkout at `root` (of `repository`), as `cast flow run` reads them there; none while unknown. */
export function useRepoFlows(root: string | null, repository: string | null): RepoFlow[] {
  useSyncCollection("repoFlows", FOR_CHECKOUT, root || repository ? { root, repository } : "skip");
  const where = useMemo(() => (r: RepoFlowsRow) => (!!root && r.root === root) || (!!repository && r.repository === repository), [root, repository]);
  const rows = useCollectionRows<RepoFlowsRow>("repoFlows", { where, sig: rowSig });
  return useMemo(() => checkoutRow(rows, root)?.flows ?? NONE, [rows, root]);
}
