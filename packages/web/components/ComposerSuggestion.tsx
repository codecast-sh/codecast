"use client";

import { forwardRef, memo, useCallback, useImperativeHandle, useRef } from "react";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { useComposerSuggestion } from "../hooks/useComposerSuggestion";
import { useWatchEffect } from "../hooks/useWatchEffect";
// A suggested reply, shown as ghost text inside the empty composer — the way
// a shell autosuggests from history: dim, sitting where the words would go,
// and Tab makes it yours. Nothing renders outside the input, so an idle
// session never grows a second strip above the box. A long suggestion (a
// reusable multi-sentence prompt) wraps the way typed text would and the box
// grows to fit it: the ghost and the textarea share one grid cell, so the
// cell takes the taller of the two and the textarea stretches to fill it.
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
  const { text, index, count, accept: take, cycle, settleSend } = useComposerSuggestion({ conversationId, idle, hidden });
  const visible = text !== null;
  useWatchEffect(() => { onVisibleChange?.(visible); }, [visible, onVisibleChange]);

  const accept = useCallback(() => {
    const t = take();
    if (t === null) return false;
    onAccept(t);
    return true;
  }, [take, onAccept]);

  const countRef = useRef(count);
  countRef.current = count;
  useImperativeHandle(ref, () => ({
    visible: () => countRef.current > 0,
    count: () => countRef.current,
    accept,
    cycle,
    settleSend,
  }), [accept, cycle, settleSend]);

  if (!visible) return null;

  // Stacked on the textarea in the same grid cell, in its font and rhythm, so
  // the ghost sits exactly where typed words would — and inert to the
  // pointer, so a click into the box focuses it as ever and never inserts
  // text by accident. The Tab cap is the one live spot: the key it names,
  // for a mouse; it holds the first line's height so it centres on that line
  // whether the text wraps or not.
  return (
    <div data-composer-ghost className="pointer-events-none [grid-area:1/1] flex items-start gap-2 py-1 min-w-0 text-sm leading-relaxed animate-in fade-in-0 duration-200">
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sol-text-dim">{text}</span>
      <span className="shrink-0 flex items-center gap-1.5 h-[calc(0.875rem*1.625)] text-[9px] text-sol-text-dim/70 select-none">
        {count > 1 && <span className="tabular-nums">{index + 1}/{count}</span>}
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
