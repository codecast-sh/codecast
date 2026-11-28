// The linked-session picker: the sessions working in this folder (title,
// agent, state, last activity) plus None. Picking one links it to the folder
// and runs whatever action was waiting on a session (Cmd-L with no link).
// The filter on top is focused on open: empty, it lists the most recent;
// typed, it searches every session in the folder by title.

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
import { matchesSessionQuery, type AgentSessionRow } from "../../../lib/code/agent/sessions";
import { SessionMark } from "./SessionMark";
import { usePickerAria } from "../workspace/pickerAria";

const STATE_COLOR: Record<string, string> = {
  working: "var(--sol-green)",
  needs_input: "var(--sol-yellow)",
  done: "var(--sol-cyan)",
  dormant: "var(--sol-blue)",
  idle: "var(--sol-text-dim)",
};
const STATE_LABEL: Record<string, string> = { working: "Working", needs_input: "Needs input", done: "Done", dormant: "Dormant", idle: "Idle" };

const WIDTH = 380;
/** Sessions listed while the filter is empty, most recent first. */
const RECENT = 12;
/** The option keys of the "New session here" and "None" rows; a session row's
 *  key is its id. */
const NEW = "\u0000new";
const NONE = "\u0000none";

export const SessionPicker = memo(function SessionPicker({ request, root }: { request: PickerRequest; root: string | null }) {
  const { vaultId } = request;
  const sig = useInboxStore((s) => (root ? vaultAgentSig(s, { root, machine: vaultMachineOf(vaultId, s) }) : ""));
  const linked = useAgentStore((s) => s.links[vaultId]?.sessionId ?? null);
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const rows = useMemo(() => {
    const s = useInboxStore.getState();
    const all: AgentSessionRow[] = root ? placeCandidates(s, { root, machine: vaultMachineOf(vaultId, s) }, searching ? Infinity : RECENT) : [];
    const list = searching ? all.filter((r) => matchesSessionQuery(r, query)) : all;
    // The linked session stays listed even when it works elsewhere (beside).
    if (linked && !list.some((r) => r._id === linked)) {
      const row = steerableRow(s, linked);
      if (row && matchesSessionQuery(row, query)) list.unshift(row);
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, root, linked, vaultId, query]);
  const now = Date.now();
  // Sessions, then "New session here", then None. Rows re-sort by activity while
  // the picker is open, so the selection is held by key, never by position:
  // Enter acts on the row that was highlighted when the person pressed it.
  const options: string[] = [...rows.map((r) => r._id), NEW, NONE];
  const [selectedKey, setSelectedKey] = useState<string>(() => (linked && options.includes(linked) ? linked : request.action ? options[0] : NONE));
  // A selected session that left the list highlights nothing and Enter does
  // nothing until an arrow picks a row again.
  const selected = options.indexOf(selectedKey);
  const aria = usePickerAria(selected >= 0 ? selectedKey : null);
  const move = (by: number) => setSelectedKey(options[selected < 0 ? 0 : Math.max(0, Math.min(options.length - 1, selected + by))]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useWatchEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  // A typed query puts the best match under Enter.
  useWatchEffect(() => {
    if (searching) setSelectedKey(rows[0]?._id ?? NEW);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (selected >= 0) pick(selectedKey);
    }
  };

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
        <div className="flex items-center gap-2 border-b border-sol-border/30 px-3 py-1.5">
          <span className="shrink-0 text-meta text-sol-text-dim">{title}</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Filter"
            aria-label="Filter sessions"
            {...aria.field}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-sol-text outline-none placeholder:text-sol-text-dim"
          />
        </div>
        <div {...aria.list()} aria-label="Sessions" className="max-h-[50vh] overflow-y-auto py-1 outline-none">
          {rows.map((r) => {
            const state = sessionWorkState(r as InboxSession, now);
            return (
              <button
                key={r._id}
                type="button"
                {...aria.option(r._id, r._id === selectedKey)}
                tabIndex={-1}
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
          {rows.length === 0 && <div className="px-3 py-1.5 text-meta text-sol-text-dim">{searching ? "No match" : "No sessions in this folder"}</div>}
          <button
            type="button"
            {...aria.option(NEW, selectedKey === NEW)}
            tabIndex={-1}
            onClick={() => pick(NEW)}
            {...hoverFocus(() => setSelectedKey(NEW))}
            className={`flex w-full items-center gap-2.5 border-t border-sol-border/30 px-3 py-1 text-left text-[13px] ${selectedKey === NEW ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"}`}
          >
            <Plus className="h-3 w-3 shrink-0 opacity-60" />
            <span className="flex-1">New session here</span>
          </button>
          <button
            type="button"
            {...aria.option(NONE, selectedKey === NONE)}
            tabIndex={-1}
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
            <KeyCap size="xs">↑</KeyCap>
            <KeyCap size="xs">↓</KeyCap> move
          </span>
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
