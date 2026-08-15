// The review queue: one cross-entity answer to "what is waiting on a human
// right now?". Every source that accumulates open human-facing items — comment
// threads on sessions, viewer comments on published pages, paused workflow
// gates — projects them into this one row shape, so every surface (web dock,
// CLI, mobile) renders and routes them the same way without knowing the
// source's own tables or lifecycle.
//
// The contract deliberately carries only what a queue row needs: what kind of
// thing it is, one line of what/who/when, and a jump target. Lifecycle stays in
// the source table (comments.resolved_at, artifact_comments.status,
// workflow_runs.status) — an item leaves the queue by resolving at its source,
// never by mutating queue state. That is what keeps the queue honest: it is a
// projection, not a second inbox to groom.
//
// Adding a source = map its open items to ReviewItem in convex/reviewQueue.ts.
// Nothing else changes.

export type ReviewItemKind = "comment_thread" | "page_comment" | "workflow_gate";

export const REVIEW_ITEM_KINDS: ReviewItemKind[] = [
  "comment_thread",
  "page_comment",
  "workflow_gate",
];

export function parseReviewItemKind(value: unknown): ReviewItemKind | null {
  return REVIEW_ITEM_KINDS.includes(value as ReviewItemKind)
    ? (value as ReviewItemKind)
    : null;
}

// Jump target: exactly one of these is set, per kind.
//   comment_thread → conversation_id (+ anchor to focus the thread)
//   workflow_gate  → conversation_id (the run's primary session)
//   page_comment   → artifact_url (server-built, honors SITE_URL; artifact_slug
//                    stays for identity, never for building URLs client-side)
export interface ReviewItemAnchor {
  message_id?: string;
  file_path?: string;
  line_number?: number;
}

export interface ReviewItem {
  // Stable identity across refreshes: `${kind}:${source key}`. Used for React
  // keys and seen-state diffing; never parsed for routing.
  key: string;
  kind: ReviewItemKind;
  // One line naming the thing: "fleetDiff.ts:42 · Fix the auth race",
  // "3 comments on Launch checklist", "Gate: approve the deploy".
  title: string;
  // Newest open activity, trimmed for a row (the source keeps the full text).
  detail?: string;
  actor_name?: string;
  actor_avatar?: string;
  // Timestamp of the newest open activity; rows sort by it, newest first.
  raised_at: number;
  // True when the newest activity is the viewer's own — their move is done and
  // they are waiting on someone else, so surfaces de-emphasize the row.
  last_actor_is_viewer?: boolean;
  // Open items folded into this row (comments in the thread, comments on the
  // page). Absent means one.
  count?: number;
  conversation_id?: string;
  conversation_title?: string;
  artifact_slug?: string;
  artifact_url?: string;
  anchor?: ReviewItemAnchor;
}

// Newest first; key breaks ties so orders are stable across refreshes.
export function sortReviewItems(items: ReviewItem[]): ReviewItem[] {
  return [...items].sort((a, b) => b.raised_at - a.raised_at || a.key.localeCompare(b.key));
}

export function countUnseenReviewItems(items: ReviewItem[], seenAt: number | undefined): number {
  const cutoff = seenAt ?? 0;
  return items.filter((item) => item.raised_at > cutoff && !item.last_actor_is_viewer).length;
}
