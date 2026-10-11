"use client";
// `/line/<project>`: the address names a project by its short id or row id
// (lineStations lineProjectParam), or by its name as a slug. The workspace opens once the store holds
// that project; a name the store does not hold, once projects have loaded, is
// one this viewer cannot open, and the page says so with the way back.
import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLineProjectId } from "../../../hooks/useLineWorkspace";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { useInboxStore } from "../../../store/inboxStore";
import { lineProjectParam } from "../../../lib/line/lineStations";
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
  // A project named by its slug opens, and the address settles on its short id, so the link shared from here is the stable one.
  const canonical = useInboxStore((s) => (projectId ? (s.projects as Record<string, { _id: string; short_id?: string | null }>)[projectId] : null));
  const router = useRouter();
  const settled = canonical ? lineProjectParam(canonical) : null;
  useEffect(() => {
    if (settled && settled !== ref && canonical?._id !== ref) router.replace(`/line/${encodeURIComponent(settled)}${window.location.search}`, { scroll: false });
  }, [settled, ref, canonical?._id, router]);
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
