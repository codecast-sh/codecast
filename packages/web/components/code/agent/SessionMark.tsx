// A session as the editor's agent chrome draws it: its agent's icon in the
// session's color, and its short title. Reads one row through a string
// signature, never the row object (heartbeats hand back a new one each tick).

import { memo } from "react";
import { AgentTypeIcon } from "../../AgentTypeIcon";
import { useSessionFace } from "../../../hooks/useSessionFace";

export const SessionMark = memo(function SessionMark({ id, className = "" }: { id: string; className?: string }) {
  const face = useSessionFace(id);
  if (!face) return null;
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <span className="inline-flex shrink-0" style={{ color: face.color }}>
        <AgentTypeIcon agentType={face.agent} className="h-3 w-3" mono />
      </span>
      <span className="truncate">{face.title}</span>
    </span>
  );
});
