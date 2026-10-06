import { useRef } from "react";
import { useMutation } from "convex/react";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";

import { useWatchEffect } from "./useWatchEffect";
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

export type PresenceAnchor = { message_id: string; offset: number };

export type PresenceRow = {
  user_id: string;
  user_name: string;
  user_color: string;
  user_image?: string;
  draft_text?: string;
  /** compose: rows only. Whether this person may send into the session; false makes their draft a suggestion. */
  can_send?: boolean;
  /** compose: rows only. Where this person is reading the transcript. */
  anchor?: PresenceAnchor;
  /** compose: rows only. Others' drafts this person just sent as parts of one joint turn. */
  claims?: Array<{ user_id: string; text: string; at: number }>;
};

const NO_ROWS: PresenceRow[] = [];

/** Read-only: who else is on a doc id. Several surfaces may read one id; only one broadcasts. */
export function usePresenceRows(docId: string, enabled: boolean): PresenceRow[] {
  // Presence only decorates the editor: when the doc is gone or the viewer
  // lost access the query throws NOT_FOUND, and the editor's own doc read says
  // so. The avatars go empty rather than taking the surface down.
  return (useQueryNoThrow(api.docSync.getPresence, enabled ? { doc_id: docId } : "skip").data ?? NO_ROWS) as PresenceRow[];
}

export function useDocPresence(opts: {
  docId: string;
  draftText?: string;
  /** Where this person is reading, sent with the draft (at most twice a second). */
  anchor?: PresenceAnchor | null;
  enabled: boolean;
  forceBroadcast: boolean;
}): PresenceRow[] {
  const { docId, draftText = "", anchor = null, enabled, forceBroadcast } = opts;
  const update = useMutation(api.docSync.updatePresence);
  const remove = useMutation(api.docSync.removePresence);
  const present = usePresenceRows(docId, enabled);
  const broadcast = enabled && (forceBroadcast || present.length > 0);

  const draftRef = useRef(draftText);
  draftRef.current = draftText;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const push = () => update({ doc_id: docId, draft_text: draftRef.current, anchor: anchorRef.current ?? undefined }).catch(() => {});

  // Heartbeat while broadcasting (keeps the row inside the 30s stale window),
  // and clear it on exit so the other side sees us leave promptly.
  useWatchEffect(() => {
    if (!broadcast) return;
    push();
    const iv = setInterval(push, 3000);
    return () => { clearInterval(iv); remove({ doc_id: docId }).catch(() => {}); };
  }, [broadcast, docId, update, remove]);

  // Snappier than the heartbeat: push shortly after the draft or the reading
  // place changes: words after 250ms of quiet, the reading place at most
  // twice a second while it moves.
  const anchorKey = anchor ? `${anchor.message_id}|${anchor.offset.toFixed(2)}` : "";
  useWatchEffect(() => {
    if (!broadcast) return;
    const t = setTimeout(push, 250);
    return () => clearTimeout(t);
  }, [draftText, broadcast, docId, update]);
  const anchorPushedAt = useRef(0);
  useWatchEffect(() => {
    if (!broadcast || !anchorKey) return;
    const wait = Math.max(0, 500 - (Date.now() - anchorPushedAt.current));
    const t = setTimeout(() => { anchorPushedAt.current = Date.now(); push(); }, wait);
    return () => clearTimeout(t);
  }, [anchorKey, broadcast, docId, update]);

  return present;
}
