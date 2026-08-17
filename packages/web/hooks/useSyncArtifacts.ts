// Published pages (artifacts) — store-fed. listForWeb is the complete visible
// set; rows have no server _id, so they are keyed by slug.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection, keyRowsBy } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

const api = _api as any;

const selectArtifacts = (data: any) => keyRowsBy(data?.artifacts, "slug");

export function useSyncArtifacts(enabled = true) {
  return useSyncCollection("artifacts", api.artifacts.listForWeb, enabled ? {} : "skip", { select: selectArtifacts });
}

const artifactSig = (a: any) =>
  `${a.title}|${a.version}|${a.updated_at}|${a.views ?? 0}|${a.comments_open ?? 0}|${a.has_thumb ? 1 : 0}|${a.expires_at ?? ""}|${a.has_password ? 1 : 0}|${a.email_gate ? 1 : 0}|${a.edit_mode ?? ""}|${a.mine ? 1 : 0}`;
const newestFirst = (a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0);

/** Reader: every visible artifact, newest first. */
export function useArtifacts(): { artifacts: any[]; ready: boolean } {
  const { ready } = useSyncArtifacts();
  const artifacts = useCollectionRows<any>("artifacts", { sig: artifactSig, sort: newestFirst });
  return { artifacts, ready };
}
