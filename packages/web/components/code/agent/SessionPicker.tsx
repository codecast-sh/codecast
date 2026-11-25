// The linked-session picker: the sessions working in this folder (title,
// agent, state, last activity) plus None. Picking one links it to the folder
// and runs whatever action was waiting on a session (Cmd-L with no link).

import { memo, useMemo, useRef, useState } from "react";
import { Ban } from "lucide-react";
import { useInboxStore, sessionWorkState, type InboxSession } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { KeyCap } from "../../KeyCap";
import { hoverFocus } from "../../../shortcuts/focusSource";
import { modernDialog } from "../../ui/modernLook";
import { formatRelativeTime } from "../../../lib/conversationFormat";
import { useAgentStore, type PickerRequest } from "../../../lib/code/agent/agentStore";
import { agentSessionsSig, steerableRow } from "../../../lib/code/agent/live";
import { candidateSessions, type AgentSessionRow } from "../../../lib/code/agent/sessions";
import { SessionMark } from "./SessionMark";

const STATE_COLOR: Record<string, string> = {
  working: "var(--sol-green)",
  needs_input: "var(--sol-yellow)",
  done: "var(--sol-cyan)",
  dormant: "var(--sol-blue)",
  idle: "var(--sol-text-dim)",
};
const STATE_LABEL: Record<string, string> = { working: "Working", needs_input: "Needs input", done: "Done", dormant: "Dormant", idle: "Idle" };

const WIDTH = 380;

export const SessionPicker = memo(function SessionPicker({ request, root }: { request: PickerRequest; root: string | null }) {
  const { vaultId } = request;
  const sig = useInboxStore((s) => agentSessionsSig(s.sessions as Record<string, InboxSession>));
  const linked = useAgentStore((s) => s.links[vaultId]?.sessionId ?? null);
  const rows = useMemo(() => {
    const s = useInboxStore.getState();
    const viewer = (s.currentUser as { _id?: unknown } | null)?._id;
    const list: AgentSessionRow[] = candidateSessions(Object.values(s.sessions) as AgentSessionRow[], root, viewer ? String(viewer) : null);
    // The linked session stays listed even when it works elsewhere (beside).
    if (linked && !list.some((r) => r._id === linked)) {
      const row = steerableRow(s, linked);
      if (row) list.unshift(row);
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, root, linked]);
  const now = Date.now();
  const options: Array<string | null> = [...rows.map((r) => r._id), null];
  const [selected, setSelected] = useState(() => Math.max(0, options.indexOf(linked)));
  const listRef = useRef<HTMLDivElement | null>(null);

  useWatchEffect(() => {
    requestAnimationFrame(() => listRef.current?.focus());
  }, []);

  const close = () => useAgentStore.getState().closePicker();
  const pick = (id: string | null) => {
    const st = useAgentStore.getState();
    st.setOverride(vaultId, id ?? "none");
    st.closePicker();
    if (id) request.then?.(id);
  };

  const a = request.anchor;
  const style: React.CSSProperties = a
    ? { position: "fixed", width: WIDTH, left: Math.max(8, Math.min(a.left, window.innerWidth - WIDTH - 8)), bottom: Math.max(8, window.innerHeight - a.top + 6) }
    : { position: "fixed", width: WIDTH, left: "50%", top: "20%", transform: "translateX(-50%)" };

  return (
    <div role="dialog" aria-modal="true" aria-label="Link a session" className="fixed inset-0 z-[70]" onMouseDown={close}>
      <div style={style} className={`overflow-hidden rounded-lg border border-sol-border/50 bg-sol-card shadow-2xl ${modernDialog({ scroll: false })}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-sol-border/30 px-3 py-1.5 text-meta text-sol-text-dim">{request.then ? "Send to" : "Linked session"}</div>
        <div
          ref={listRef}
          tabIndex={-1}
          role="listbox"
          className="max-h-[50vh] overflow-y-auto py-1 outline-none"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n") || e.key === "j") {
              e.preventDefault();
              setSelected((i) => Math.min(options.length - 1, i + 1));
            } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p") || e.key === "k") {
              e.preventDefault();
              setSelected((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(options[selected] ?? null);
            }
          }}
        >
          {rows.map((r, i) => {
            const state = sessionWorkState(r as InboxSession, now);
            return (
              <button
                key={r._id}
                type="button"
                role="option"
                aria-selected={i === selected}
                onClick={() => pick(r._id)}
                {...hoverFocus(() => setSelected(i))}
                className={`flex w-full items-center gap-2.5 px-3 py-1 text-left text-[13px] ${i === selected ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"}`}
              >
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: STATE_COLOR[state] }} title={STATE_LABEL[state]} />
                <SessionMark id={r._id} className="flex-1" />
                {r._id === linked && <span className="shrink-0 text-meta text-sol-cyan">linked</span>}
                <span className="w-14 shrink-0 text-right text-meta tabular-nums text-sol-text-dim">{state === "working" ? "now" : formatRelativeTime(r.updated_at, now).replace(" ago", "")}</span>
              </button>
            );
          })}
          {rows.length === 0 && <div className="px-3 py-2 text-meta text-sol-text-dim">No sessions in this folder</div>}
          <button
            type="button"
            role="option"
            aria-selected={selected === options.length - 1}
            onClick={() => pick(null)}
            {...hoverFocus(() => setSelected(options.length - 1))}
            className={`flex w-full items-center gap-2.5 border-t border-sol-border/30 px-3 py-1 text-left text-[13px] ${selected === options.length - 1 ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"}`}
          >
            <Ban className="h-3 w-3 shrink-0 opacity-60" />
            <span className="flex-1">None</span>
            {!linked && <span className="shrink-0 text-meta text-sol-cyan">linked</span>}
          </button>
        </div>
        <div className="flex items-center gap-4 border-t border-sol-border/30 px-3 py-1.5 text-meta text-sol-text-dim">
          <span className="flex items-center gap-1">
            <KeyCap size="xs">↵</KeyCap> link
          </span>
          <span className="flex items-center gap-1">
            <KeyCap size="xs">Esc</KeyCap> cancel
          </span>
        </div>
      </div>
    </div>
  );
});
