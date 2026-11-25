// A session as the editor's agent chrome draws it: its agent's icon in the
// session's color, and its short title. Reads one row through a string
// signature, never the row object (heartbeats hand back a new one each tick).

import { memo } from "react";
import { AgentTypeIcon } from "../../AgentTypeIcon";
import { useInboxStore } from "../../../store/inboxStore";
import { sessionColor, sessionShortTitle } from "../../../lib/code/agent/sessions";

/** The fields a mark draws, as one comparable string. */
export function useSessionFace(id: string | null | undefined): { title: string; agent: string; color: string } | null {
  const sig = useInboxStore((s) => {
    const r = id ? s.sessions[id] : undefined;
    return r ? `${r.agent_type}\u0000${r.short_title ?? ""}\u0000${r.title ?? ""}\u0000${r.icon_color ?? ""}` : "";
  });
  if (!id || !sig) return null;
  const [agent, short_title, title, icon_color] = sig.split("\u0000");
  return { agent, title: sessionShortTitle({ short_title, title }), color: sessionColor({ _id: id, icon_color: icon_color || undefined }) };
}

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
