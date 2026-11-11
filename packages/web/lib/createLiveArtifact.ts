// Create a board, sheet or dashboard in one step and open it. Every place that
// creates things (the header's New, the palette's Create group) calls this, so
// a new artifact always gets its product's seed (a sheet's first tab) and a
// title the person can rename in place.
import { artifactSpec, fromElement, type ArtifactOp, type ArtifactType } from "@codecast/shared/artifacts";
import { docRows, sendLiveOps } from "../components/live/useLiveArtifact";
import { useInboxStore } from "../store/inboxStore";

export type WorkspaceStamp = { workspace: "team"; team_id: string } | { workspace: "personal" } | Record<string, never>;

/** What a new artifact starts from: its product's seed, or a template's title and elements. */
export type LiveStart = { title?: string; ops?: ArtifactOp[] };

export async function createLiveArtifact(type: ArtifactType, stamp: WorkspaceStamp, navigate: (href: string) => void, start?: LiveStart): Promise<string | null> {
  const store = useInboxStore.getState() as any;
  const spec = artifactSpec(type);
  const res = await store.createDoc({ title: start?.title ?? `Untitled ${spec.label.toLowerCase()}`, content: "", doc_type: type, ...stamp }, { version: 1, kind: "navigate" });
  const id: string | undefined = res?.row?._id ?? res?.id ?? res?._id;
  if (!id) return null;
  const ops = start?.ops ?? spec.seed?.() ?? [];
  if (ops.length) sendLiveOps(id, "main", ops);
  navigate(`/docs/${id}`);
  return id;
}

/**
 * Copy an artifact: a new doc of the same type in the same workspace holding
 * the saved layer as it is now (not the draft, comments or history), opened
 * when it exists.
 */
export async function duplicateLiveArtifact(
  doc: { _id: string; title: string; doc_type: ArtifactType; team_id?: string; workspace?: string },
  navigate: (href: string) => void,
): Promise<string | null> {
  const store = useInboxStore.getState() as any;
  const stamp: WorkspaceStamp = String(doc.workspace ?? "").startsWith("team:") && doc.team_id
    ? { workspace: "team", team_id: doc.team_id }
    : { workspace: "personal" };
  const ops: ArtifactOp[] = [];
  for (const [key, row] of docRows(doc._id).main) {
    if (row.deleted) continue;
    const { kind, fields } = fromElement(row);
    ops.push({ k: key, put: { kind, ...fields } });
  }
  const res = await store.createDoc({ title: `${doc.title || "Untitled"} (copy)`, content: "", doc_type: doc.doc_type, ...stamp }, { version: 1, kind: "navigate" });
  const id: string | undefined = res?.row?._id ?? res?.id ?? res?._id;
  if (!id) return null;
  if (ops.length) sendLiveOps(id, "main", ops);
  navigate(`/docs/${id}`);
  return id;
}
