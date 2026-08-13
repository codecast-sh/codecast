"use client";

import { memo, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { Sparkles, X } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { isConvexId } from "../lib/entityLinks";

// Suggested replies above the composer. Mounted only when the pref is on;
// stays mounted while the user types (hidden via the `hidden` prop) so the
// suggestions subscription doesn't churn on every keystroke. The row renders
// only when the stored suggestions still match the conversation tail (the
// anchor), the agent spoke last, and the session is waiting on the user —
// a stale pill is worse than none.
//
// Clicking a pill fills the composer (it never sends): the text is a
// prediction, and the user's Enter is the confirmation.

export const SuggestionPills = memo(function SuggestionPills({
  conversationId,
  idle,
  hidden,
  onPick,
}: {
  conversationId: string;
  // The session is waiting on the user (not streaming, not mid-task).
  idle: boolean;
  // Composer holds text/images — keep hooks alive but render nothing.
  hidden: boolean;
  onPick: (text: string) => void;
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
  const attemptedRef = useRef<string | null>(null);
  const [dismissedAnchor, setDismissedAnchor] = useState<string | null>(null);

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

  if (hidden || !idle || tailRole !== "assistant") return null;
  if (!row?.suggestions?.length) return null;
  if (row.anchor_message_uuid !== tailKey) return null;
  if (dismissedAnchor === row.anchor_message_uuid) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap pb-1.5">
      <Sparkles className="w-3 h-3 text-sol-violet/60 shrink-0" />
      {row.suggestions.map((text, i) => (
        <button
          key={text}
          type="button"
          // preventDefault so the composer keeps focus through the click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(text)}
          title="Fill the composer — Enter sends"
          className="max-w-full truncate text-[11px] leading-none px-2.5 py-1.5 rounded-full border border-sol-border/50 bg-sol-bg-alt/70 text-sol-text-muted hover:text-sol-text hover:border-sol-violet/40 hover:bg-sol-violet/10 transition-colors animate-fadeSlideIn"
          style={{ animationDelay: `${i * 70}ms`, animationFillMode: "backwards" }}
        >
          {text}
        </button>
      ))}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setDismissedAnchor(row.anchor_message_uuid)}
        title="Hide suggestions"
        className="w-4 h-4 flex items-center justify-center rounded-full text-sol-text-dim/40 hover:text-sol-text-dim transition-colors"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
});
