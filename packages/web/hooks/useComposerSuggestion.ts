import { useCallback, useMemo, useRef } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";
import { isConvexId } from "../lib/entityLinks";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useWatchEffect } from "./useWatchEffect";

type SuggestionRow = { _id: string; conversation_id: string; anchor_message_uuid: string; suggestions: string[]; generated_at: number };
const rowSig = (r: SuggestionRow) => `${r._id}|${r.anchor_message_uuid}|${r.generated_at}`;

// The suggested reply for an empty composer, shared by web
// (components/ComposerSuggestion) and the phone (MessageComposer). A stored
// suggestion shows only while its anchor still matches the conversation tail,
// the agent spoke last, and the session waits on the user: a stale suggestion
// is worse than none. The phone imports this file, so imports stay relative.
//
// `accept` hands back the shown text for the composer to fill; the outcome
// settles once a send is committed: verbatim is "sent", changed is "edited",
// and a reply of their own after a suggestion was on show is "ignored". The
// report names the agent turn and what was offered; what the person sent is
// read back from the transcript, so deleting the session takes it too.
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

  // The row lives in the store (registry `composerSuggestions`), fed while
  // this conversation is open, so a cached suggestion paints at once.
  useSyncCollection("composerSuggestions", (api as any).composerSuggestions.forConversation, entityIdArgs("conversation_id", isRealId ? conversationId : undefined));
  const where = useMemo(() => (r: SuggestionRow) => isRealId && String(r.conversation_id) === conversationId, [isRealId, conversationId]);
  const row = useCollectionRows<SuggestionRow>("composerSuggestions", { where, sig: rowSig })[0] ?? null;
  const generate = useAction(api.composerSuggestions.generateComposerSuggestions);
  const recordOutcome = useMutation((api as any).suggestionOutcomes.record);
  const attemptedRef = useRef<string | null>(null);
  // The suggestion the user accepted, held until the send settles its outcome.
  const acceptedRef = useRef<Offer | null>(null);
  // The suggestion on show for the current agent turn, kept while the person
  // types (typing hides the ghost) so an own-words send can be reported.
  const shownRef = useRef<Offer | null>(null);

  // Ask for a fresh suggestion when the agent's turn has settled and the
  // stored row targets an older tail. The delay gives the feeder time to land
  // a row that already matches; the server dedupes by anchor anyway, so a
  // double-fire (second device, remount, cold cache) is a cheap no-op.
  useWatchEffect(() => {
    if (!isRealId || hidden || !idle) return;
    if (tailRole !== "assistant" || !tailKey || tailKey === "opt") return;
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
  // One reply: the suggester returns at most one, and a row stored before
  // that may hold more, of which the first is the likeliest.
  const text = visible ? row!.suggestions[0]! : null;

  const stateRef = useRef({ text, anchor, tailKey });
  stateRef.current = { text, anchor, tailKey };
  if (text && anchor) shownRef.current = { anchor, text };
  else if (shownRef.current && shownRef.current.anchor !== tailKey) shownRef.current = null;
  // A suggestion taken for an earlier turn says nothing about this one.
  if (acceptedRef.current && acceptedRef.current.anchor !== tailKey) acceptedRef.current = null;

  // The shown suggestion, or null when nothing is shown.
  const accept = useCallback((): string | null => {
    const { text: t, anchor: a } = stateRef.current;
    if (!t || !a) return null;
    acceptedRef.current = { text: t, anchor: a };
    return t;
  }, []);

  // The composer just committed a send of `text`: report what became of the
  // suggestion on show for this agent turn, once. Fire-and-forget; never
  // fails the send it rides on.
  const settleSend = useCallback((text: string) => {
    const report = suggestionOutcome(acceptedRef.current, shownRef.current, stateRef.current.tailKey, text);
    acceptedRef.current = null;
    shownRef.current = null;
    if (report) recordOutcome({ conversation_id: conversationId as Id<"conversations">, ...report }).catch(() => {});
  }, [recordOutcome, conversationId]);

  return { text, accept, settleSend };
}

type Offer = { text: string; anchor: string };

// What one send says about the suggestion on show for the agent turn it
// answers: taken as written ("sent") or changed ("edited"), or passed over
// ("ignored") for the person's own words. Only a suggestion for the turn
// still being answered counts, and a slash command is not a reply to the
// agent. Null when there is nothing to report.
export function suggestionOutcome(accepted: Offer | null, shown: Offer | null, tailKey: string | null, text: string) {
  const sent = text.trim();
  if (!sent || sent.startsWith("/")) return null;
  if (accepted && accepted.anchor === tailKey) {
    return {
      anchor_message_uuid: accepted.anchor,
      suggestion: accepted.text,
      outcome: sent === accepted.text.trim() ? ("sent" as const) : ("edited" as const),
      shown: [accepted.text],
      typed_length: sent.length,
    };
  }
  if (shown && shown.anchor === tailKey) {
    return {
      anchor_message_uuid: shown.anchor,
      suggestion: shown.text,
      outcome: "ignored" as const,
      shown: [shown.text],
      typed_length: sent.length,
    };
  }
  return null;
}
