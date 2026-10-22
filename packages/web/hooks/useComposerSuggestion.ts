import { useCallback, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";
import { isConvexId } from "../lib/entityLinks";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

// The suggested reply for an empty composer, shared by web
// (components/ComposerSuggestion) and the phone (MessageComposer). A stored
// suggestion shows only while its anchor still matches the conversation tail,
// the agent spoke last, and the session waits on the user: a stale suggestion
// is worse than none. The phone imports this file, so imports stay relative.
//
// `accept` hands back the shown text for the composer to fill; the outcome
// settles on send: verbatim is "sent", changed is "edited".
export function useComposerSuggestion({ conversationId, idle, hidden, enabled = true }: {
  conversationId: string;
  // The session is waiting on the user (not streaming, not mid-task).
  idle: boolean;
  // The composer holds text or images: keep the subscription, show nothing.
  hidden: boolean;
  enabled?: boolean;
}) {
  const isRealId = enabled && isConvexId(conversationId);

  // Tail signature of the last real turn, as a primitive so the selector
  // doesn't re-render on unrelated store churn. Mirrors the server's anchor:
  // message_uuid ?? _id of the last user/assistant row with content.
  const tailSig = useInboxStore((s) => {
    if (!isRealId) return null;
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

  // Ask for fresh suggestions when the agent's turn has settled and the
  // stored row targets an older tail. The server dedupes by anchor, so a
  // double-fire (second device, remount) is a cheap no-op.
  useWatchEffect(() => {
    if (!isRealId || hidden || !idle) return;
    if (tailRole !== "assistant" || !tailKey || tailKey === "opt") return;
    if (row === undefined) return; // still loading: the row may already match
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
    isRealId &&
    !hidden &&
    idle &&
    tailRole === "assistant" &&
    !!row?.suggestions?.length &&
    anchor === tailKey;
  const suggestions = visible ? row!.suggestions : [];
  const index = Math.min(idx, Math.max(0, suggestions.length - 1));

  // A new anchor starts at the top suggestion again.
  useWatchEffect(() => { setIdx(0); }, [anchor]);

  const stateRef = useRef({ suggestions, index, anchor });
  stateRef.current = { suggestions, index, anchor };

  // The shown suggestion, or null when nothing is shown.
  const accept = useCallback((): string | null => {
    const { suggestions: list, index: i, anchor: a } = stateRef.current;
    const text = list[i];
    if (!text || !a) return null;
    acceptedRef.current = { text, anchor: a };
    return text;
  }, []);

  // Step to the previous/next suggestion (wraps); false with fewer than two.
  const cycle = useCallback((delta: 1 | -1) => {
    const n = stateRef.current.suggestions.length;
    if (n < 2) return false;
    setIdx((cur) => (cur + delta + n) % n);
    return true;
  }, []);

  // The composer just sent `text`: report the outcome if it descends from an
  // accepted suggestion. Fire-and-forget; never fails the send it rides on.
  const settleSend = useCallback((text: string) => {
    const accepted = acceptedRef.current;
    acceptedRef.current = null;
    if (!accepted || !text.trim()) return;
    recordOutcome({
      conversation_id: conversationId as Id<"conversations">,
      anchor_message_uuid: accepted.anchor,
      suggestion: accepted.text,
      outcome: text.trim() === accepted.text.trim() ? "sent" : "edited",
    }).catch(() => {});
  }, [recordOutcome, conversationId]);

  return { text: suggestions[index] ?? null, index, count: suggestions.length, accept, cycle, settleSend };
}
