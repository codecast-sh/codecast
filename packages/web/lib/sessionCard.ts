import { isHostedAgentType } from "@codecast/shared/contracts";
import { cleanTitle } from "./conversationProcessor";
import { conversationTitle } from "./conversationTitle";

// Small pure pieces of the inbox session card (components/inbox), shared with
// its container.

/** The title a card shows, and the one its drags and drops are named by. A
 *  hosted conversation is called by the hosted rule (its ask until the
 *  assistant names it). */
export function sessionCardTitle(session: { title?: string | null; agent_type?: string | null; last_user_message?: string | null; first_prompt?: string | null }): string {
  if (isHostedAgentType(session.agent_type)) return conversationTitle(session);
  return cleanTitle(sessionTitleText(session));
}

/** The text a session is called by before cleaning: its title, else what it
 *  began as when the row knows it (the palette's session index carries it;
 *  the server's search names an untitled session the same way). */
export function sessionTitleText(session: { title?: string | null; first_prompt?: string | null }): string {
  return session.title || session.first_prompt || "";
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

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A hosted conversation's time column, as Whisk's list says it: "now"
 *  within the minute, then a clock time today, "Yesterday", a weekday, a
 *  date. Other rows keep their age (formatIdleDuration). */
function hostedRowTime(at: number | null | undefined, now: number): string {
  if (!at) return "";
  if (now - at < 60_000) return "now";
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return new Date(at).toLocaleDateString([], { weekday: "short" });
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** A row's time column: a hosted conversation's in hostedRowTime's words,
 *  every other row its age. */
export function formatRowTime(updatedAt: number | null | undefined, hosted: boolean, now = Date.now()): string {
  return hosted ? hostedRowTime(updatedAt, now) : formatIdleDuration(updatedAt);
}
