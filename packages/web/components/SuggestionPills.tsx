"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { Sparkles, Pencil, X } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useEventListener } from "../hooks/useEventListener";
import { isConvexId } from "../lib/entityLinks";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { isMac } from "../shortcuts";

// Suggested replies above the composer. Mounted only when the pref is on;
// stays mounted while the user types (hidden via the `hidden` prop) so the
// suggestions subscription doesn't churn on every keystroke. The row renders
// only when the stored suggestions still match the conversation tail (the
// anchor), the agent spoke last, and the session is waiting on the user —
// a stale pill is worse than none.
//
// Clicking a pill (or Ctrl+Shift+1/2/3) SENDS it — the suggestion is
// press-send ready by contract, so the click is the confirmation. The hover
// pencil is the escape hatch: it fills the composer for editing instead.

export const SuggestionPills = memo(function SuggestionPills({
  conversationId,
  idle,
  hidden,
  onSend,
  onEdit,
}: {
  conversationId: string;
  // The session is waiting on the user (not streaming, not mid-task).
  idle: boolean;
  // Composer holds text/images — keep hooks alive but render nothing.
  hidden: boolean;
  onSend: (text: string) => void;
  onEdit: (text: string) => void;
}) {
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

  // Ctrl+Shift+1/2/3 sends the matching pill. Bare Ctrl+digit is dead on
  // macOS (Mission Control's "Switch to Desktop N" eats it at the OS level
  // whenever the user has Spaces), and Alt+digit is taken by workbench
  // switching — stealing it here would turn a navigation habit into an
  // accidental send. Capture phase so a focused textarea doesn't swallow the
  // chord, and armed only while the row is visible so nothing leaks into the
  // global shortcut layer when there are no pills.
  const suggestions = visible ? row!.suggestions : [];
  const suggestionsRef = useRef(suggestions);
  suggestionsRef.current = suggestions;
  useEventListener(
    "keydown",
    useCallback(
      (e: KeyboardEvent) => {
        if (!e.ctrlKey || !e.shiftKey || e.metaKey || e.altKey) return;
        const idx = ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
        if (idx === -1) return;
        const text = suggestionsRef.current[idx];
        if (!text) return;
        e.preventDefault();
        e.stopPropagation();
        report(text, "sent");
        onSend(text);
      },
      [onSend, report],
    ),
    visible ? document : null,
    { capture: true },
  );

  if (!visible) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap pb-1.5">
      <Sparkles className="w-3 h-3 text-sol-violet/60 shrink-0" />
      {suggestions.map((text, i) => (
        <span
          key={text}
          className="group inline-flex items-center max-w-full rounded-full border border-sol-border/50 bg-sol-bg-alt/70 hover:border-sol-violet/40 hover:bg-sol-violet/10 transition-colors animate-fadeSlideIn"
          style={{ animationDelay: `${i * 70}ms`, animationFillMode: "backwards" }}
        >
          <button
            type="button"
            // preventDefault so the composer keeps focus through the click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { report(text, "sent"); onSend(text); }}
            title="Send"
            className="flex items-center gap-1.5 min-w-0 pl-2.5 pr-1 py-1 text-[11px] leading-none text-sol-text-muted group-hover:text-sol-text transition-colors"
          >
            <span className="truncate">{text}</span>
            {i < 3 && (
              <span className="shrink-0 opacity-50">
                <KeyCap size="xs">{isMac ? `⌃⇧${i + 1}` : `Ctrl+Shift+${i + 1}`}</KeyCap>
              </span>
            )}
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { report(text, "edited"); onEdit(text); }}
            title="Edit before sending"
            className="shrink-0 pl-0.5 pr-2 py-1 text-sol-text-dim/0 group-hover:text-sol-text-dim hover:!text-sol-text transition-colors"
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
    </div>
  );
});
