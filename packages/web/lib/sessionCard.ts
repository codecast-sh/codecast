import { cleanTitle } from "./conversationProcessor";
import type { InboxSession } from "../store/inboxStore";

// Small pure pieces of the inbox session card (components/inbox), shared with
// its container.

/** The title a card shows, and the one its drags and drops are named by. */
export function sessionCardTitle(session: Pick<InboxSession, "title">): string {
  return cleanTitle(session.title || "New Session");
}

// A row with no activity stamp yet (its fast fields ride the liveness overlay
// and have not landed) shows no age: Date.now() minus nothing is 1970, which
// rendered as "20705d".
export function formatIdleDuration(updatedAt: number | null | undefined): string {
  if (!updatedAt) return "";
  const diff = Date.now() - updatedAt;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
