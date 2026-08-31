"use client";

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { Sparkles, Pencil, X } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { isConvexId } from "../lib/entityLinks";
import { KeyCap } from "./KeyboardShortcutsHelp";

// Suggested replies above the composer. Mounted only when the pref is on;
// stays mounted while the user types (hidden via the `hidden` prop) so the
// suggestions subscription doesn't churn on every keystroke. The row renders
// only when the stored suggestions still match the conversation tail (the
// anchor), the agent spoke last, and the session is waiting on the user —
// a stale pill is worse than none.
//
// Clicking a pill SENDS it — the suggestion is press-send ready by contract,
// so the click is the confirmation. The keyboard path is arrow selection: the
// composer's ↑ ladder (images → queue → pills) hands off here through the
// SuggestionPillsHandle, Enter sends the selected pill, Tab fills the
// composer for editing instead. No modifier chords: bare Ctrl+digit is
// macOS Mission Control's Space switcher, Cmd+digit is the browser's tab
// switcher, Alt+digit is workbench switching — every digit chord is owned
// upstream, which is how the original Ctrl+1/2/3 binding shipped dead.

// Imperative selection surface for the composer's keydown ladder. Selection
// state lives in here (the pill list is this component's server row), but the
// keys arrive on the composer textarea, which keeps DOM focus the whole time —
// the same split the queue and image regions use in ConversationView.
export interface SuggestionPillsHandle {
  // Row is rendered with at least one pill.
  visible(): boolean;
  // A pill is currently selected.
  active(): boolean;
  // Select the first pill; false when the row isn't visible.
  enter(): boolean;
  // Move selection left/right. Right past the last pill exits (clears);
  // left of the first clamps. Returns whether a selection remains.
  move(delta: 1 | -1): boolean;
  // Send / edit the selected pill (clears selection).
  send(): boolean;
  edit(): boolean;
  clear(): void;
}

export const SuggestionPills = memo(forwardRef<SuggestionPillsHandle, {
  conversationId: string;
  // The session is waiting on the user (not streaming, not mid-task).
  idle: boolean;
  // Composer holds text/images — keep hooks alive but render nothing.
  hidden: boolean;
  onSend: (text: string) => void;
  onEdit: (text: string) => void;
}>(function SuggestionPills({ conversationId, idle, hidden, onSend, onEdit }, ref) {
  const isRealId = isConvexId(conversationId);

  // Tail signature of the last real turn, as a primitive so the selector
  // doesn't re-render this component on unrelated store churn. Mirrors the
  // server's anchor: message_uuid ?? _id of the last user/assistant row with
  // content.
  const tailSig = useInboxStore((s) => {
    const msgs = s.messages[conversationId];
    if (!msgs?.length) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if ((m.role === "user" || m.role === "assistant") && m.content?.trim() && !m.tool_results?.length) {
        return `${m.role}|${m._isOptimistic ? "opt" : m.message_uuid ?? m._id}`;
      }
    }
    return null;
  });
  const [tailRole, tailKey] = tailSig ? (tailSig.split("|") as [string, string]) : [null, null];

  const { data: row } = useQueryNoThrow(
    api.composerSuggestions.getComposerSuggestions,
    isRealId ? { conversation_id: conversationId as Id<"conversations"> } : "skip",
  );
  const generate = useAction(api.composerSuggestions.generateComposerSuggestions);
  const recordOutcome = useMutation(api.composerSuggestions.recordSuggestionOutcome);
  const attemptedRef = useRef<string | null>(null);
  const [dismissedAnchor, setDismissedAnchor] = useState<string | null>(null);
  const [selIdx, setSelIdx] = useState<number | null>(null);

  // Fire-and-forget outcome telemetry — ground truth for judging the
  // suggester. Never blocks or fails the user gesture it rides on.
  const report = useCallback(
    (suggestion: string, outcome: "sent" | "edited" | "dismissed") => {
      if (!row?.anchor_message_uuid) return;
      recordOutcome({
        conversation_id: conversationId as Id<"conversations">,
        anchor_message_uuid: row.anchor_message_uuid,
        suggestion,
        outcome,
      }).catch(() => {});
    },
    [recordOutcome, conversationId, row?.anchor_message_uuid],
  );

  // Ask for fresh suggestions when the agent's turn has settled and the
  // stored row targets an older tail. The server dedupes by anchor, so a
  // double-fire (second device, remount) is a cheap no-op.
  useEffect(() => {
    if (!isRealId || hidden || !idle) return;
    if (tailRole !== "assistant" || !tailKey || tailKey === "opt") return;
    if (row === undefined) return; // still loading — the row may already match
    if (row?.anchor_message_uuid === tailKey) return;
    if (attemptedRef.current === tailKey) return;
    const t = setTimeout(() => {
      attemptedRef.current = tailKey;
      generate({ conversation_id: conversationId as Id<"conversations"> }).catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [isRealId, hidden, idle, tailRole, tailKey, row, row?.anchor_message_uuid, generate, conversationId]);

  const visible =
    !hidden &&
    idle &&
    tailRole === "assistant" &&
    !!row?.suggestions?.length &&
    row.anchor_message_uuid === tailKey &&
    dismissedAnchor !== row.anchor_message_uuid;

  const suggestions = visible ? row!.suggestions : [];

  // Selection can't outlive the row or the list it points into.
  useEffect(() => {
    if (!visible) setSelIdx(null);
    else setSelIdx((i) => (i !== null && i >= suggestions.length ? suggestions.length - 1 : i));
  }, [visible, suggestions.length]);

  const stateRef = useRef({ visible, suggestions, selIdx });
  stateRef.current = { visible, suggestions, selIdx };
  useImperativeHandle(ref, () => ({
    visible: () => stateRef.current.visible && stateRef.current.suggestions.length > 0,
    active: () => stateRef.current.visible && stateRef.current.selIdx !== null,
    enter: () => {
      if (!stateRef.current.visible || stateRef.current.suggestions.length === 0) return false;
      setSelIdx(0);
      return true;
    },
    move: (delta) => {
      const { selIdx: cur, suggestions: list } = stateRef.current;
      if (cur === null) return false;
      const next = cur + delta;
      if (next >= list.length) {
        setSelIdx(null);
        return false;
      }
      setSelIdx(Math.max(0, next));
      return true;
    },
    send: () => {
      const { selIdx: cur, suggestions: list } = stateRef.current;
      const text = cur !== null ? list[cur] : undefined;
      if (!text) return false;
      setSelIdx(null);
      report(text, "sent");
      onSend(text);
      return true;
    },
    edit: () => {
      const { selIdx: cur, suggestions: list } = stateRef.current;
      const text = cur !== null ? list[cur] : undefined;
      if (!text) return false;
      setSelIdx(null);
      report(text, "edited");
      onEdit(text);
      return true;
    },
    clear: () => setSelIdx(null),
  }), [report, onSend, onEdit]);

  if (!visible) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap pb-1.5">
      <Sparkles className="w-3 h-3 text-sol-violet/60 shrink-0" />
      {suggestions.map((text, i) => (
        <span
          key={text}
          className={`group inline-flex items-center max-w-full rounded-full border transition-colors animate-fadeSlideIn ${
            selIdx === i
              ? "border-sol-violet/60 bg-sol-violet/15"
              : "border-sol-border/50 bg-sol-bg-alt/70 hover:border-sol-violet/40 hover:bg-sol-violet/10"
          }`}
          style={{ animationDelay: `${i * 70}ms`, animationFillMode: "backwards" }}
        >
          <button
            type="button"
            // preventDefault so the composer keeps focus through the click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { report(text, "sent"); onSend(text); }}
            title="Send"
            className={`flex items-center gap-1.5 min-w-0 pl-2.5 pr-1 py-1 text-[11px] leading-none transition-colors ${
              selIdx === i ? "text-sol-text" : "text-sol-text-muted group-hover:text-sol-text"
            }`}
          >
            <span className="truncate">{text}</span>
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { report(text, "edited"); onEdit(text); }}
            title="Edit before sending"
            className={`shrink-0 pl-0.5 pr-2 py-1 transition-colors hover:!text-sol-text ${
              selIdx === i ? "text-sol-text-dim" : "text-sol-text-dim/0 group-hover:text-sol-text-dim"
            }`}
          >
            <Pencil className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { suggestions.forEach((t) => report(t, "dismissed")); setDismissedAnchor(row!.anchor_message_uuid); }}
        title="Hide suggestions"
        className="w-4 h-4 flex items-center justify-center rounded-full text-sol-text-dim/40 hover:text-sol-text-dim transition-colors"
      >
        <X className="w-3 h-3" />
      </button>
      {selIdx !== null ? (
        <span className="text-[9px] text-sol-text-dim flex items-center gap-2 pl-1">
          <span className="inline-flex items-center gap-1"><KeyCap size="xs">←</KeyCap><KeyCap size="xs">→</KeyCap> navigate</span>
          <span className="inline-flex items-center gap-1"><KeyCap size="xs">Enter</KeyCap> send</span>
          <span className="inline-flex items-center gap-1"><KeyCap size="xs">Tab</KeyCap> edit</span>
          <span className="inline-flex items-center gap-1"><KeyCap size="xs">Esc</KeyCap> deselect</span>
        </span>
      ) : (
        <span className="text-[9px] text-sol-text-dim/60 flex items-center gap-1 pl-1">
          <KeyCap size="xs">↑</KeyCap> select
        </span>
      )}
    </div>
  );
}));
