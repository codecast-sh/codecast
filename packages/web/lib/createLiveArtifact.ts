// Create a board, sheet or dashboard in one step and open it. Every place that
// creates things (the header's New, the palette's Create group) calls this, so
// a new artifact always gets its product's seed (a sheet's first tab) and a
// title the person can rename in place.
import { artifactSpec, fromElement, type ArtifactElement, type ArtifactOp, type ArtifactType } from "@codecast/shared/artifacts";
import { docRows, sendLiveOps } from "../components/live/useLiveArtifact";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";

export type WorkspaceStamp = { workspace: "team"; team_id: string } | { workspace: "personal" } | Record<string, never>;

/** What a new artifact starts from: its product's seed, or a template's title and elements. */
export type LiveStart = { title?: string; ops?: ArtifactOp[] };

// One creation at a time: a second press while the first waits on the server makes nothing. A
// create that waits longer than this frees the button (the toast still says it is on its way).
let creating: Promise<string | null> | null = null;
const PRESS_HOLD_MS = 20_000;
// An answer this late, or after the person moved on, never moves the view: it offers the new artifact.
const OPEN_FRESH_MS = 15_000;

export function createLiveArtifact(type: ArtifactType, stamp: WorkspaceStamp, navigate: (href: string) => void, start?: LiveStart): Promise<string | null> {
  if (creating) return creating;
  const spec = artifactSpec(type);
  const title = start?.title ?? `Untitled ${spec.label.toLowerCase()}`;
  const pressedAt = Date.now();
  const pressedOn = typeof window !== "undefined" ? window.location.pathname : "";
  // The press shows at once; the artifact opens when the server has made it.
  const toastId = toast.loading(`Creating ${title}…`);
  const run = (async () => {
    const res = await (useInboxStore.getState() as any).createDoc({ title, content: "", doc_type: type, ...stamp }, { version: 1, kind: "navigate" });
    const id: string | undefined = res?.row?._id ?? res?.id ?? res?._id;
    if (!id) throw new Error("no id");
    const ops = start?.ops ?? spec.seed?.() ?? [];
    if (ops.length) sendLiveOps(id, "main", ops);
    const href = `/docs/${id}`;
    const stillHere = typeof window === "undefined" || window.location.pathname === pressedOn;
    if (Date.now() - pressedAt <= OPEN_FRESH_MS && stillHere) {
      toast.dismiss(toastId);
      navigate(href);
    } else {
      // Offered for a short while, and only to a page that isn't showing it already.
      if (typeof window !== "undefined" && window.location.pathname === href) toast.dismiss(toastId);
      else toast.success(`${title} is ready`, { id: toastId, duration: 10_000, action: { label: "Open", onClick: () => navigate(href) } });
    }
    return id;
  })().catch(() => {
    toast.error(`Could not create ${title}`, { id: toastId });
    return null;
  });
  creating = run;
  const release = () => { if (creating === run) creating = null; };
  void run.finally(release);
  setTimeout(release, PRESS_HOLD_MS);
  return run;
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
