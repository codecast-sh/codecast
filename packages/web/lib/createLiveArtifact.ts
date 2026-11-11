// Create a board, sheet or dashboard in one step and open it. Every place that
// creates things (the header's New, the palette's Create group) calls this, so
// a new artifact always gets its product's seed (a sheet's first tab) and a
// title the person can rename in place.
import { artifactSpec, type ArtifactType } from "@codecast/shared/artifacts";
import { useInboxStore } from "../store/inboxStore";

export type WorkspaceStamp = { workspace: "team"; team_id: string } | { workspace: "personal" } | Record<string, never>;

export async function createLiveArtifact(type: ArtifactType, stamp: WorkspaceStamp, navigate: (href: string) => void): Promise<string | null> {
  const store = useInboxStore.getState() as any;
  const spec = artifactSpec(type);
  const res = await store.createDoc({ title: `Untitled ${spec.label.toLowerCase()}`, content: "", doc_type: type, ...stamp }, { version: 1, kind: "navigate" });
  const id: string | undefined = res?.row?._id ?? res?.id ?? res?._id;
  if (!id) return null;
  const seed = spec.seed?.() ?? [];
  if (seed.length) void store.applyLiveOps(id, "main", seed);
  navigate(`/docs/${id}`);
  return id;
}
