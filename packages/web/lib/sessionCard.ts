import { isHostedAgentType } from "@codecast/shared/contracts";
import { cleanTitle } from "./conversationProcessor";
import { conversationTitle } from "./conversationTitle";
import { hostedRowTime } from "./sameNameSuffix";
import { formatDateSmart } from "@codecast/shared/time";

// Small pure pieces of the inbox session card (components/inbox), shared with
// its container.

/** The title a card shows, and the one its drags and drops are named by. A
 *  hosted conversation is called by the hosted rule (its ask until the
 *  assistant names it). */
export function sessionCardTitle(session: { title?: string | null; agent_type?: string | null; last_user_message?: string | null }): string {
  if (isHostedAgentType(session.agent_type)) return conversationTitle(session);
  return cleanTitle(session.title || "") || "New Session";
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

/** A row's time as the hosted rail says it, as Whisk's list does: "now"
 *  within the minute, then a clock time today, "Yesterday", a weekday, a
 *  date. The developer rail keeps its age (formatIdleDuration). */
export function formatRowTime(updatedAt: number | null | undefined, hosted: boolean, now = Date.now()): string {
  return hosted ? hostedRowTime(updatedAt, now) : formatIdleDuration(updatedAt);
}

/** How the palette's rows say a time: in hosted mode the rail's words
 *  (hostedRowTime), so a row reads the same in both places; developer mode
 *  keeps the palette's relative time ("4h ago"). A StampTime format. */
export function paletteRowTime(hosted: boolean): (at: number, now: number) => string {
  return hosted ? hostedRowTime : formatDateSmart;
}

/** Text as hosted mode displays a typed title or suggestion: the first letter
 *  capitalised, the rest as written ("call the plumber" reads "Call the
 *  plumber"). A first word already cased inside ("iMessage", "eBay") is a
 *  name and stays as written. Display only; the stored text keeps the
 *  person's casing. */
export function sentenceCase(text: string | null | undefined): string {
  const t = text ?? "";
  const at = t.search(/\p{L}/u);
  if (at < 0) return t;
  const word = t.slice(at).match(/^[\p{L}\p{N}]+/u)?.[0] ?? "";
  if (/\p{Lu}/u.test(word.slice(1))) return t;
  return t.slice(0, at) + t.charAt(at).toUpperCase() + t.slice(at + 1);
}
