// What a hosted conversation is called, for every surface that names one (an
// inbox row, a tab, the plan's "Where it went"). A leaf: it imports nothing
// from the store or the views, so the tab strip and the lane read one rule.
import { promptTitle } from "@codecast/shared/contracts/assistant";

const PLACEHOLDER_TITLES = new Set(["new session", "new conversation", "untitled", ""]);

export type TitleRow = { title?: string | null; short_title?: string | null; last_user_message?: string | null } | null | undefined;

/** The row's own title, or empty while it only has a placeholder. The full
 *  title comes first: short_title is a developer tab label ("Tasks" for
 *  "Personal task reminders") and not every store home carries it, so
 *  preferring it gave one conversation two names. Width is CSS's job. */
export function ownTitle(row: TitleRow): string {
  const title = (row?.title || row?.short_title || "").trim();
  return title && !PLACEHOLDER_TITLES.has(title.toLowerCase()) ? title : "";
}

/** What a conversation is called: its title once it has a real one, else
 *  what the person asked, else a plain fallback. */
export function conversationTitle(row: TitleRow): string {
  return ownTitle(row) || promptTitle(row?.last_user_message) || "A new conversation";
}

/** A hosted conversation's name from its two store homes: the conversation
 *  row's own title, else the session row's (the inbox projection carries the
 *  generated title long before the conversation is opened in this window),
 *  else the person's first ask, read lazily from the transcript only when
 *  neither row has a title. Every surface that names a hosted conversation
 *  (the rail row, the header, the same-name suffix) reads this one rule. */
export function hostedTitle(conversation: TitleRow, session: TitleRow, firstAsk: () => string | null | undefined): string {
  return ownTitle(conversation) || ownTitle(session) || promptTitle(firstAsk());
}
