"use client";
// `/line/<project>`: the address names a project by its short id or row id
// (lineStations lineProjectParam). The workspace opens once the store holds
// that project; a name the store does not hold, once projects have loaded, is
// one this viewer cannot open, and the page says so with the way back.
import Link from "next/link";
import { useLineProjectId } from "../../../hooks/useLineWorkspace";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { LineWorkspace } from "./LineWorkspace";
import "./workspace.css";

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
/** Membership only: whether projects have arrived, never a field of one. */
const idSig = (p: { _id: string }) => p._id;

export function LineWorkspaceRoute({ param }: { param: string }) {
  const ref = decode(param).trim();
  const projectId = useLineProjectId(ref);
  // Projects have arrived once the active workspace holds any (through the
  // workspace chokepoint); the named one may live in another workspace, which
  // useLineProjectId finds by its id or short id.
  const loaded = useWorkspaceCollection<{ _id: string }>("projects", idSig).length > 0;
  if (projectId) return <LineWorkspace projectId={projectId} />;
  return (
    <div className="lw" data-line-workspace-missing={ref}>
      {loaded ? (
        <div className="lw-empty">
          <b>No line here</b>
          There is no project {ref} you can open. <Link href="/line" className="lw-link">Every project's line</Link>
        </div>
      ) : (
        <div className="lw-skeleton" aria-busy>{[60, 86, 48].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>
      )}
    </div>
  );
}
