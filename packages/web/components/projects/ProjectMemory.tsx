"use client";
// A project's memory (session-projects.md SP6): its pinned docs, whose index
// every session in the project starts with. Each opens whole; unpinning takes
// it out of the memory and keeps the doc.
import Link from "next/link";
import { PinOff } from "lucide-react";
import { useMemo } from "react";
import { useInboxStore, type DocItem } from "../../store/inboxStore";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { RecordSection } from "../initiatives/InitiativeRecord";
import { DocTypeMark } from "../docs/DocTypeMark";
import type { WorkspaceKey } from "../../lib/workspaceScope";

const memorySig = (d: any) => `${d.project_id ?? ""}|${d.pinned ? 1 : 0}|${d.archived_at ? 1 : 0}|${d.title ?? ""}|${d.updated_at ?? 0}`;

export function ProjectMemory({ projectId, workspace }: { projectId: string; workspace?: WorkspaceKey | null }) {
  const docs = useWorkspaceCollection<DocItem & { project_id?: string; archived_at?: number }>("docs", memorySig, workspace);
  const memory = useMemo(
    () => docs.filter((d) => d.project_id === projectId && d.pinned && !d.archived_at).sort((a, b) => b.updated_at - a.updated_at),
    [docs, projectId],
  );
  return (
    <RecordSection name="memory" label="Memory" count={memory.length}>
      {memory.length ? (
        <ul className="flex flex-col" data-project-memory>
          {memory.map((d) => (
            <li key={d._id} className="group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-sol-bg-alt" data-project-memory-doc={d._id}>
              <DocTypeMark type={d.doc_type} size={13} />
              <Link href={`/docs/${d._id}`} className="min-w-0 flex-1 truncate text-[13px] text-sol-text hover:text-sol-cyan">
                {(d as any).display_title || d.title || "Untitled"}
              </Link>
              <button
                type="button"
                onClick={() => useInboxStore.getState().pinDoc(d._id, false)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-meta text-sol-text-dim opacity-0 transition-opacity hover:text-sol-orange focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={`Unpin ${d.title || "doc"} from the project memory`}
                data-project-memory-unpin
              >
                <PinOff className="h-3 w-3" />Unpin
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-sol-text-dim">Empty</p>
      )}
    </RecordSection>
  );
}
