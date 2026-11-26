// The inline instruction (Cmd-K): a small composer under the selection that
// sends ONE message, the quoted range plus what the person typed, to the
// linked session. The target is named on the box, and Enter is the send.
//
// The text box is uncontrolled: typing commits React zero times and writes no
// store (the typing budget). Rendered by AgentLayer into the widget host the
// editor placed below the range (lib/code/agent/editorMarks.ts).

import { memo, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { KeyCap } from "../../KeyCap";
import { isMac } from "../../../shortcuts";
import { inlineDraft, useAgentStore, type InlineRequest } from "../../../lib/code/agent/agentStore";
import { newSessionText, rangeLabel, sendInstruction } from "../../../lib/code/agent/compose";
import { composeInVault } from "../../../lib/code/agent/live";
import { SessionMark } from "./SessionMark";

export const InlineInstruction = memo(function InlineInstruction({ request }: { request: InlineRequest }) {
  // The target was fixed when the box opened; only this box's picker moves it.
  const target = request.sessionId;
  const draft = inlineDraft(request.id);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useWatchEffect(() => {
    // Focus once per box: a box drawn again after a scroll must not pull focus
    // from wherever the person moved it.
    if (draft.focused) return;
    draft.focused = true;
    requestAnimationFrame(() => boxRef.current?.focus());
  }, []);

  const close = () => {
    useAgentStore.getState().closeInline(request.id);
    request.onClose();
  };

  const send = (sessionId: string) => {
    const text = boxRef.current?.value ?? "";
    if (!text.trim()) return;
    const clientId = sendInstruction(useInboxStore.getState(), sessionId, request.range, text);
    if (!clientId) return;
    useAgentStore.getState().closeInline(request.id);
    request.onSent(sessionId, clientId);
  };

  /** Choose where this goes; `andSend` sends once picked (Enter with no target). */
  const pickTarget = (andSend: boolean) => {
    const rect = rootRef.current?.getBoundingClientRect();
    useAgentStore.getState().openPicker({
      vaultId: request.vaultId,
      anchor: rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null,
      action: "instruct",
      then: (id) => {
        useAgentStore.getState().setInlineTarget(request.id, id);
        if (andSend) send(id);
        else requestAnimationFrame(() => boxRef.current?.focus());
      },
      newSession: () => {
        const text = boxRef.current?.value.trim() ?? "";
        if (!composeInVault(request.vaultId, `${newSessionText(request.range)}${text}`)) return false;
        close();
        return true;
      },
    });
  };

  const r = request.range;
  const lines = r.endLine > r.startLine ? `L${r.startLine}-${r.endLine}` : `L${r.startLine}`;

  return (
    <div
      ref={rootRef}
      data-agent-inline
      className="mr-6 max-w-[640px] rounded-lg border border-sol-border/60 bg-sol-card font-sans shadow-lg"
      style={{ marginLeft: "0.5em" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-sol-border/30 px-2.5 py-1 text-meta">
        <span className="text-sol-text-dim">To</span>
        <button
          type="button"
          onClick={() => pickTarget(false)}
          className="flex min-w-0 max-w-[60%] items-center gap-1 rounded px-1 py-0.5 text-sol-text hover:bg-sol-bg-alt"
          title="Change the session this goes to"
        >
          {target ? <SessionMark id={target} /> : <span className="text-sol-yellow">Pick a session</span>}
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
        <span className="ml-auto truncate tabular-nums text-sol-text-dim" title={rangeLabel(r)}>
          {r.absPath.slice(r.absPath.lastIndexOf("/") + 1)}:{lines}
        </span>
      </div>
      <textarea
        ref={boxRef}
        rows={Math.min(8, draft.text.split("\n").length)}
        defaultValue={draft.text}
        placeholder="Tell the agent what to do with these lines"
        aria-label="Instruction for the agent"
        spellCheck={false}
        style={{ fieldSizing: "content" } as React.CSSProperties}
        className="block max-h-40 w-full resize-none bg-transparent px-2.5 py-1.5 text-[13px] leading-5 text-sol-text outline-none placeholder:text-sol-text-dim"
        onInput={(e) => {
          // Kept for a redraw of the widget. The box grows by CSS
          // (field-sizing); where that is missing, `rows` follows the line
          // count, set only when it changes and with no layout read.
          const el = e.currentTarget;
          draft.text = el.value;
          const rows = String(Math.min(8, el.value.split("\n").length));
          if (el.getAttribute("rows") !== rows) el.setAttribute("rows", rows);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (target) send(target);
            else pickTarget(true);
          } else if (e.key === "k" && (isMac ? e.metaKey : e.ctrlKey)) {
            // Cmd-K twice: the command palette, as everywhere else in the app.
            e.preventDefault();
            close();
            useInboxStore.getState().togglePalette();
          }
        }}
      />
      <div className="flex items-center gap-3 px-2.5 pb-1.5 text-meta text-sol-text-dim">
        <span className="flex items-center gap-1">
          <KeyCap size="xs">↵</KeyCap> send
        </span>
        <span className="flex items-center gap-1">
          <KeyCap size="xs">⇧</KeyCap>
          <KeyCap size="xs">↵</KeyCap> new line
        </span>
        <span className="flex items-center gap-1">
          <KeyCap size="xs">Esc</KeyCap> cancel
        </span>
      </div>
    </div>
  );
});
