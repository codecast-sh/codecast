"use client";
// `/line/<project>`: the address names a project by its short id or row id
// (lineStations lineProjectParam). The workspace opens once the store holds
// that project; a name the store does not hold, once projects have loaded, is
// one this viewer cannot open, and the page says so with the way back.
import Link from "next/link";
import { useInboxStore } from "../../../store/inboxStore";
import { useLineProjectId } from "../../../hooks/useLineWorkspace";
import { LineWorkspace } from "./LineWorkspace";
import "./workspace.css";

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export function LineWorkspaceRoute({ param }: { param: string }) {
  const ref = decode(param).trim();
  const projectId = useLineProjectId(ref);
  const loaded = useInboxStore((s) => Object.keys((s.projects as Record<string, unknown> | undefined) ?? {}).length > 0);
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
