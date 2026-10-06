// What a hosted conversation is called, for every surface that names one (an
// inbox row, a tab, the plan's "Where it went"). A leaf: it imports nothing
// from the store or the views, so the tab strip and the lane read one rule.
import { promptTitle } from "@codecast/shared/contracts/assistant";

const PLACEHOLDER_TITLES = new Set(["new session", "new conversation", "untitled", ""]);

export type TitleRow = { title?: string | null; short_title?: string | null; last_user_message?: string | null } | null | undefined;

/** The row's own title, or empty while it only has a placeholder. */
export function ownTitle(row: TitleRow): string {
  const title = (row?.short_title || row?.title || "").trim();
  return title && !PLACEHOLDER_TITLES.has(title.toLowerCase()) ? title : "";
}

/** What a conversation is called: its title once it has a real one, else
 *  what the person asked, else a plain fallback. */
export function conversationTitle(row: TitleRow): string {
  return ownTitle(row) || promptTitle(row?.last_user_message) || "A new conversation";
}
