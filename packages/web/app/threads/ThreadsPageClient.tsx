"use client";

import { usePagePresence } from "../../hooks/usePagePresence";
import { ThreadsView } from "../../components/threads/ThreadsView";

// The Threads inbox: every conversation the viewer is in — chat threads, DMs,
// session comment threads, task comment streams — one page, newest activity
// first, readable and replyable in place. Owns its whole canvas (see
// lib/pageLayout FULL_WIDTH_PATTERNS). Never gated on a team feature: comment
// and task threads exist whether or not the team has chat on.
//
// READS FOLLOW PRESENCE: a thread is marked read only while the reader is
// actually here (this tab active, the window focused); arrival, hydration and
// background sync never mark anything.
export function ThreadsPageClient() {
  const present = usePagePresence();
  return <ThreadsView present={present} />;
}
