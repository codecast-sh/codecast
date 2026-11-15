// Create a board, sheet or dashboard in one step and open it. Every place that
// creates things (the header's New, the palette's Create group) calls this, so
// a new artifact always gets its product's seed (a sheet's first tab) and a
// title the person can rename in place.
import { artifactSpec, fromElement, type ArtifactElement, type ArtifactOp, type ArtifactType } from "@codecast/shared/artifacts";
import { docRows, sendLiveOps } from "../components/live/useLiveArtifact";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";
import { newStubDocId } from "../components/live/liveStub";
import { noteStubDoc, promoteStubDoc } from "../components/live/liveStubDocs";

export type WorkspaceStamp = { workspace: "team"; team_id: string } | { workspace: "personal" } | Record<string, never>;

/** What a new artifact starts from: its product's seed, or a template's title and elements. */
export type LiveStart = { title?: string; ops?: ArtifactOp[] };

// A new artifact opens at once on a placeholder doc (components/live/liveStub.ts): its row is painted by
// createDoc under the placeholder id, the page opens on it, and the seed (or template) lands in the store.
// Everything written there waits under the placeholder until the server has made the doc; then
// promoteStubDoc sends it under the real id and moves the page to the real address. Offline, the create
// waits in the outbox like any write, and the artifact is usable meanwhile.
// A double press (or a key held down) makes one artifact: a second press within this of the first is the same press.
let lastPressAt = 0;
const SAME_PRESS_MS = 1000;

export function createLiveArtifact(type: ArtifactType, stamp: WorkspaceStamp, navigate: (href: string) => void, start?: LiveStart): Promise<string | null> {
  if (Date.now() - lastPressAt < SAME_PRESS_MS) return Promise.resolve(null);
  lastPressAt = Date.now();
  const spec = artifactSpec(type);
  const title = start?.title ?? `Untitled ${spec.label.toLowerCase()}`;
  const stubId = newStubDocId();
  const store = useInboxStore.getState() as any;
  const created = store.createDoc({ title, content: "", doc_type: type, client_key: stubId, ...stamp });
  noteStubDoc(stubId);
  const ops = start?.ops ?? spec.seed?.() ?? [];
  if (ops.length) sendLiveOps(stubId, "main", ops);
  navigate(`/docs/${stubId}`);
  return Promise.resolve(created)
    .then((res: any) => {
      const id: string | undefined = res?.row?._id ?? res?.id ?? res?._id;
      if (!id) throw new Error("no id");
      if (res?.row && !(useInboxStore.getState() as any).docs?.[id]) (useInboxStore.getState() as any).syncRecord("docs", id, res.row);
      promoteStubDoc(stubId, id);
      return id;
    })
    .catch((e: any) => {
      // A create parked for a later send (offline) still lands: the outbox replays it and the docs row
      // brings the real id (watchStubDocs). Only a refusal is final.
      if (isRefusedDispatchError(e)) toast.error(`Could not create ${title}`);
      return null;
    });
}

/**
 * Copy an artifact: a new doc of the same type in the same workspace holding
 * the saved layer as it is now (not the draft, comments or history), opened
 * when it exists.
 */
export function duplicateLiveArtifact(
  doc: { _id: string; title: string; doc_type: ArtifactType; team_id?: string; workspace?: string },
  navigate: (href: string) => void,
  /** The elements to copy, when not the saved layer as it is now (a version that is open). */
  from?: ArtifactElement[],
): Promise<string | null> {
  const stamp: WorkspaceStamp = String(doc.workspace ?? "").startsWith("team:") && doc.team_id
    ? { workspace: "team", team_id: doc.team_id }
    : { workspace: "personal" };
  const ops: ArtifactOp[] = [];
  const source: Iterable<[string, any]> = from ? from.map((e) => [e.key, e] as [string, any]) : docRows(doc._id).main;
  for (const [key, row] of source) {
    if (row.deleted) continue;
    const { kind, fields } = fromElement(row);
    ops.push({ k: key, put: { kind, ...fields } });
  }
  // The one guarded create: the press shows at once, a second press makes no second copy, a failure says so.
  return createLiveArtifact(doc.doc_type, stamp, navigate, { title: `${doc.title || "Untitled"} (copy)`, ops });
}
