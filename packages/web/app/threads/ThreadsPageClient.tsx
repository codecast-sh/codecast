"use client";

import { usePagePresence, usePageReading } from "../../hooks/usePagePresence";
import { ThreadsView } from "../../components/threads/ThreadsView";

// The Threads inbox: every conversation the viewer is in — chat threads, DMs,
// session comment threads, task comment streams — one page, newest activity
// first, readable and replyable in place. Owns its whole canvas (see
// lib/pageLayout FULL_WIDTH_PATTERNS). Never gated on a team feature: comment
// and task threads exist whether or not the team has chat on.
//
// READS FOLLOW THE READER: a thread is marked read only while the page is on
// screen (the active pane or a split sibling) in a focused window; arrival,
// hydration and background sync never mark anything. The keyboard belongs to
// the page only while it is the active pane (`present`).
export function ThreadsPageClient() {
  const present = usePagePresence();
  const reading = usePageReading();
  return <ThreadsView present={present} reading={reading} />;
}
