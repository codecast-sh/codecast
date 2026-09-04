"use client";

import { forwardRef, memo, useCallback, useImperativeHandle, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { isConvexId } from "../lib/entityLinks";
import { KeyCap } from "./KeyboardShortcutsHelp";

import { useWatchEffect } from "../hooks/useWatchEffect";
// A suggested reply, shown as ghost text inside the empty composer — the way
// a shell autosuggests from history: dim, sitting where the words would go,
// and Tab makes it yours. Nothing renders outside the input, so an idle
// session never grows a second strip above the box.
//
// Mounted only when the pref is on; it stays mounted while the user types
// (hidden via the `hidden` prop) so the suggestions subscription doesn't
// churn on every keystroke. The ghost shows only when the stored suggestions
// still match the conversation tail (the anchor), the agent spoke last, and
// the session is waiting on the user — a stale suggestion is worse than none.
//
// Tab (or a click on the ghost) drops the text into the composer; Enter then
// sends it like anything typed. Up and down step through the alternatives
// while the composer is empty. Typing anything replaces the ghost, which is
// the whole dismissal — no gesture to learn. Outcome telemetry settles on
// send: verbatim is "sent", changed is "edited".

// Imperative surface for the composer's keydown handler. Selection state
// lives in here (the list is this component's server row), but the keys
// arrive on the composer textarea, which keeps DOM focus the whole time.
export interface ComposerSuggestionHandle {
  // The ghost is showing.
  visible(): boolean;
  count(): number;
  // Put the shown suggestion into the composer; false when nothing is shown.
  accept(): boolean;
  // Step to the previous/next suggestion (wraps).
  cycle(delta: 1 | -1): boolean;
  // The composer just sent `text`: report the outcome if it descends from an
  // accepted suggestion.
  settleSend(text: string): void;
}

export const ComposerSuggestion = memo(forwardRef<ComposerSuggestionHandle, {
  conversationId: string;
  // The session is waiting on the user (not streaming, not mid-task).
  idle: boolean;
  // Composer holds text/images — keep hooks alive but render nothing.
  hidden: boolean;
  onAccept: (text: string) => void;
  // The composer blanks its own placeholder while the ghost is showing.
  onVisibleChange?: (visible: boolean) => void;
}>(function ComposerSuggestion({ conversationId, idle, hidden, onAccept, onVisibleChange }, ref) {
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
  const [idx, setIdx] = useState(0);
  // The suggestion the user accepted, held until the send settles its outcome.
  const acceptedRef = useRef<{ text: string; anchor: string } | null>(null);

  // Fire-and-forget outcome telemetry — ground truth for judging the
  // suggester. Never blocks or fails the user gesture it rides on.
  const report = useCallback(
    (anchor: string, suggestion: string, outcome: "sent" | "edited" | "dismissed") => {
      recordOutcome({
        conversation_id: conversationId as Id<"conversations">,
        anchor_message_uuid: anchor,
        suggestion,
        outcome,
      }).catch(() => {});
    },
    [recordOutcome, conversationId],
  );

  // Ask for fresh suggestions when the agent's turn has settled and the
  // stored row targets an older tail. The server dedupes by anchor, so a
  // double-fire (second device, remount) is a cheap no-op.
  useWatchEffect(() => {
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

  const anchor = row?.anchor_message_uuid ?? null;
  const visible =
    !hidden &&
    idle &&
    tailRole === "assistant" &&
    !!row?.suggestions?.length &&
    anchor === tailKey;
  const suggestions = visible ? row!.suggestions : [];

  // A new anchor starts at the top suggestion again.
  useWatchEffect(() => { setIdx(0); }, [anchor]);
  useWatchEffect(() => { onVisibleChange?.(visible); }, [visible, onVisibleChange]);

  const stateRef = useRef({ visible, suggestions, idx, anchor });
  stateRef.current = { visible, suggestions, idx, anchor };
  const accept = useCallback(() => {
    const { visible: v, suggestions: list, idx: i, anchor: a } = stateRef.current;
    const text = v ? list[i] : undefined;
    if (!text || !a) return false;
    acceptedRef.current = { text, anchor: a };
    onAccept(text);
    return true;
  }, [onAccept]);

  useImperativeHandle(ref, () => ({
    visible: () => stateRef.current.visible && stateRef.current.suggestions.length > 0,
    count: () => (stateRef.current.visible ? stateRef.current.suggestions.length : 0),
    accept,
    cycle: (delta) => {
      const { visible: v, suggestions: list } = stateRef.current;
      if (!v || list.length < 2) return false;
      setIdx((cur) => (cur + delta + list.length) % list.length);
      return true;
    },
    settleSend: (text) => {
      const accepted = acceptedRef.current;
      acceptedRef.current = null;
      if (!accepted || !text.trim()) return;
      report(accepted.anchor, accepted.text, text.trim() === accepted.text.trim() ? "sent" : "edited");
    },
  }), [accept, report]);

  if (!visible) return null;
  const text = suggestions[Math.min(idx, suggestions.length - 1)];

  // Absolutely over the textarea, in its font and rhythm, so the ghost sits
  // exactly where typed words would — and inert to the pointer, so a click
  // into the box focuses it as ever and never inserts text by accident. The
  // Tab cap is the one live spot: the key it names, for a mouse.
  return (
    <div data-composer-ghost className="pointer-events-none absolute inset-0 flex items-center gap-2 py-1 min-w-0 text-sm leading-relaxed animate-in fade-in-0 duration-200">
      <span className="truncate min-w-0 flex-1 text-sol-text-dim" title={text}>{text}</span>
      <span className="shrink-0 flex items-center gap-1.5 text-[9px] text-sol-text-dim/70 select-none">
        {suggestions.length > 1 && <span className="tabular-nums">{idx + 1}/{suggestions.length}</span>}
        <button
          type="button"
          // preventDefault so the composer keeps focus through the click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={accept}
          title="Insert this suggestion"
          className="pointer-events-auto flex rounded-[4px] transition-opacity hover:opacity-70"
        >
          <KeyCap size="xs">Tab</KeyCap>
        </button>
      </span>
    </div>
  );
}));
