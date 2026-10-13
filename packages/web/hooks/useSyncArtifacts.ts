// Published pages (artifacts) — store-fed. listForWeb is the complete visible
// set; rows have no server _id, so they are keyed by slug.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection, keyRowsBy } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useMemo } from "react";
import { useActiveWorkspaceKey } from "./useWorkspaceCollection";
import { inWorkspace } from "../lib/workspaceScope";

const api = _api as any;

const selectArtifacts = (data: any) => keyRowsBy(data?.artifacts, "slug");

export function useSyncArtifacts(enabled = true) {
  return useSyncCollection("artifacts", api.artifacts.listForWeb, enabled ? {} : "skip", { select: selectArtifacts });
}

const artifactSig = (a: any) =>
  `${a.title}|${a.version}|${a.updated_at}|${a.views ?? 0}|${a.comments_open ?? 0}|${a.has_thumb ? 1 : 0}|${a.expires_at ?? ""}|${a.has_password ? 1 : 0}|${a.email_gate ? 1 : 0}|${a.edit_mode ?? ""}|${a.mine ? 1 : 0}|${a.workspace ?? ""}`;
const newestFirst = (a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0);

/** Reader: the visible artifacts in the active workspace, newest first. Each
 *  row carries the workspace listForWeb derived for it. */
export function useArtifacts(): { artifacts: any[]; ready: boolean } {
  const { ready } = useSyncArtifacts();
  const key = useActiveWorkspaceKey();
  const where = useMemo(() => (a: any) => inWorkspace(a, key), [key]);
  const artifacts = useCollectionRows<any>("artifacts", { where, sig: artifactSig, sort: newestFirst });
  return { artifacts, ready };
}
