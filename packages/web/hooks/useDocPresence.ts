import { useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";

// ── Generic live co-presence over the doc_presence backend ───────────────────
// One ephemeral presence row per (user, doc_id). Anyone watching a doc_id sees
// who else is there and the words they're forming live (draft_text) — the "type
// with me" / "is typing…" signal — with no shared OT buffer.
//
// doc_id is an arbitrary namespace string. Established conventions:
//   compose:<conversationId>            — the owner/collab composer co-presence
//   comment:<conversationId>            — the conversation's global comment thread
//   comment:<conversationId>:<msgId>    — a per-message anchored comment thread
//
// Broadcast (writing our own row: heartbeat + draft pushes + leave-cleanup) is
// gated: we write iff `forceBroadcast` is set OR someone else is already present.
// So a passive solo viewer writes nothing, but once anyone joins, everyone there
// announces themselves. The query is gated by `enabled` (skip until authed;
// getPresence errors during the auth-loading window otherwise).

export type PresenceRow = {
  user_id: string;
  user_name: string;
  user_color: string;
  draft_text?: string;
};

export function useDocPresence(opts: {
  docId: string;
  draftText?: string;
  enabled: boolean;
  forceBroadcast: boolean;
}): PresenceRow[] {
  const { docId, draftText = "", enabled, forceBroadcast } = opts;
  const update = useMutation(api.docSync.updatePresence);
  const remove = useMutation(api.docSync.removePresence);
  const present = (useQuery(api.docSync.getPresence, enabled ? { doc_id: docId } : "skip") ?? []) as PresenceRow[];
  const broadcast = enabled && (forceBroadcast || present.length > 0);

  const draftRef = useRef(draftText);
  draftRef.current = draftText;

  // Heartbeat while broadcasting (keeps the row inside the 30s stale window),
  // and clear it on exit so the other side sees us leave promptly.
  useEffect(() => {
    if (!broadcast) return;
    update({ doc_id: docId, draft_text: draftRef.current }).catch(() => {});
    const iv = setInterval(() => update({ doc_id: docId, draft_text: draftRef.current }).catch(() => {}), 3000);
    return () => { clearInterval(iv); remove({ doc_id: docId }).catch(() => {}); };
  }, [broadcast, docId, update, remove]);

  // Snappier than the heartbeat: push shortly after the draft changes.
  useEffect(() => {
    if (!broadcast) return;
    const t = setTimeout(() => update({ doc_id: docId, draft_text: draftRef.current }).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [draftText, broadcast, docId, update]);

  return present;
}
