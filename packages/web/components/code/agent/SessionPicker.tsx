// The linked-session picker: the sessions working in this folder (title,
// agent, state, last activity) plus None. Picking one links it to the folder
// and runs whatever action was waiting on a session (Cmd-L with no link).

import { memo, useMemo, useRef, useState } from "react";
import { Ban, Plus } from "lucide-react";
import { useInboxStore, sessionWorkState, type InboxSession } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { KeyCap } from "../../KeyCap";
import { hoverFocus } from "../../../shortcuts/focusSource";
import { modernDialog } from "../../ui/modernLook";
import { formatRelativeTime } from "../../../lib/conversationFormat";
import { useAgentStore, type PickerRequest } from "../../../lib/code/agent/agentStore";
import { composeInVault, placeCandidates, steerableRow, vaultAgentSig, vaultMachineOf } from "../../../lib/code/agent/live";
import type { AgentSessionRow } from "../../../lib/code/agent/sessions";
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
/** The option keys of the "New session here" and "None" rows; a session row's
 *  key is its id. */
const NEW = "\u0000new";
const NONE = "\u0000none";

export const SessionPicker = memo(function SessionPicker({ request, root }: { request: PickerRequest; root: string | null }) {
  const { vaultId } = request;
  const sig = useInboxStore((s) => (root ? vaultAgentSig(s, { root, machine: vaultMachineOf(vaultId, s) }) : ""));
  const linked = useAgentStore((s) => s.links[vaultId]?.sessionId ?? null);
  const rows = useMemo(() => {
    const s = useInboxStore.getState();
    const list: AgentSessionRow[] = root ? placeCandidates(s, { root, machine: vaultMachineOf(vaultId, s) }) : [];
    // The linked session stays listed even when it works elsewhere (beside).
    if (linked && !list.some((r) => r._id === linked)) {
      const row = steerableRow(s, linked);
      if (row) list.unshift(row);
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, root, linked, vaultId]);
  const now = Date.now();
  // Sessions, then "New session here", then None. Rows re-sort by activity while
  // the picker is open, so the selection is held by key, never by position:
  // Enter acts on the row that was highlighted when the person pressed it.
  const options: string[] = [...rows.map((r) => r._id), NEW, NONE];
  const [selectedKey, setSelectedKey] = useState<string>(() => (linked && options.includes(linked) ? linked : request.action ? options[0] : NONE));
  // A selected session that left the list highlights nothing and Enter does
  // nothing until an arrow picks a row again.
  const selected = options.indexOf(selectedKey);
  const move = (by: number) => setSelectedKey(options[selected < 0 ? 0 : Math.max(0, Math.min(options.length - 1, selected + by))]);
  const listRef = useRef<HTMLDivElement | null>(null);

  useWatchEffect(() => {
    requestAnimationFrame(() => listRef.current?.focus());
  }, []);

  const close = () => useAgentStore.getState().closePicker();
  const pick = (key: string) => {
    const st = useAgentStore.getState();
    const id = key === NONE ? null : key;
    if (key === NEW) {
      st.closePicker();
      if (!request.newSession?.()) composeInVault(vaultId, "");
      return;
    }
    st.setOverride(vaultId, id ?? "none");
    st.closePicker();
    if (id) request.then?.(id);
  };
  const verb = request.action === "quote" ? "quote" : request.action === "instruct" ? (request.then ? "send" : "pick") : "link";
  const title = request.action === "quote" ? "Quote to" : request.action === "instruct" ? "Instruction to" : "Linked session";

  const a = request.anchor;
  const style: React.CSSProperties = a
    ? { position: "fixed", width: WIDTH, left: Math.max(8, Math.min(a.left, window.innerWidth - WIDTH - 8)), bottom: Math.max(8, window.innerHeight - a.top + 6) }
    : { position: "fixed", width: WIDTH, left: "50%", top: "20%", transform: "translateX(-50%)" };

  return (
    <div role="dialog" aria-modal="true" aria-label="Link a session" className="fixed inset-0 z-[70]" onMouseDown={close}>
      <div style={style} className={`overflow-hidden rounded-lg border border-sol-border/50 bg-sol-card shadow-2xl ${modernDialog({ scroll: false })}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-sol-border/30 px-3 py-1.5 text-meta text-sol-text-dim">{title}</div>
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
              move(1);
            } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p") || e.key === "k") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (selected >= 0) pick(selectedKey);
            }
          }}
        >
          {rows.map((r) => {
            const state = sessionWorkState(r as InboxSession, now);
            return (
              <button
                key={r._id}
                type="button"
                role="option"
                aria-selected={r._id === selectedKey}
                onClick={() => pick(r._id)}
                {...hoverFocus(() => setSelectedKey(r._id))}
                className={`flex w-full items-center gap-2.5 px-3 py-1 text-left text-[13px] ${r._id === selectedKey ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"}`}
              >
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: STATE_COLOR[state] }} title={STATE_LABEL[state]} />
                <SessionMark id={r._id} className="flex-1" />
                {r._id === linked && <span className="shrink-0 text-meta text-sol-cyan">linked</span>}
                <span className="w-14 shrink-0 text-right text-meta tabular-nums text-sol-text-dim">{state === "working" ? "now" : formatRelativeTime(r.updated_at, now).replace(" ago", "")}</span>
              </button>
            );
          })}
          {rows.length === 0 && <div className="px-3 py-1.5 text-meta text-sol-text-dim">No sessions in this folder</div>}
          <button
            type="button"
            role="option"
            aria-selected={selectedKey === NEW}
            onClick={() => pick(NEW)}
            {...hoverFocus(() => setSelectedKey(NEW))}
            className={`flex w-full items-center gap-2.5 border-t border-sol-border/30 px-3 py-1 text-left text-[13px] ${selectedKey === NEW ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"}`}
          >
            <Plus className="h-3 w-3 shrink-0 opacity-60" />
            <span className="flex-1">New session here</span>
          </button>
          <button
            type="button"
            role="option"
            aria-selected={selectedKey === NONE}
            onClick={() => pick(NONE)}
            {...hoverFocus(() => setSelectedKey(NONE))}
            className={`flex w-full items-center gap-2.5 px-3 py-1 text-left text-[13px] ${selectedKey === NONE ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"}`}
          >
            <Ban className="h-3 w-3 shrink-0 opacity-60" />
            <span className="flex-1">None</span>
            {!linked && <span className="shrink-0 text-meta text-sol-cyan">linked</span>}
          </button>
        </div>
        <div className="flex items-center gap-4 border-t border-sol-border/30 px-3 py-1.5 text-meta text-sol-text-dim">
          <span className="flex items-center gap-1">
            <KeyCap size="xs">↵</KeyCap> {verb}
          </span>
          <span className="flex items-center gap-1">
            <KeyCap size="xs">Esc</KeyCap> cancel
          </span>
        </div>
      </div>
    </div>
  );
});
