import { isSessionHidden, isSessionKilled, type InboxSession } from "../../store/inboxStore";

// The /sessions triage derivation, extracted from the page's classification
// useMemo so it can be tested without mounting the component. ct-41083.
//
// `killed` has an AUTHORITATIVE source and a fallback:
//
//   - `rowKilled` — listActiveSessions projects `is_killed` as
//     `!!conv.inbox_killed_at` straight off the conversation doc, before and
//     independent of any inbox filtering. It therefore covers every killed row,
//     pinned or not, and is the only source that can report an UNPINNED one.
//   - the inbox join (`inbox_killed_at`) — a strict subset: shouldShowInInbox
//     (convex/inboxFilters.ts) drops `inbox_killed_at && !inbox_pinned_at`
//     unconditionally, above the `show_all` branch, so the join can only ever
//     deliver a killed row that is PINNED.
//
// The join term is kept as belt-and-braces, not because it is load-bearing: it
// costs nothing, is covered by the tests below, and keeps this correct if a
// future projection change drops the row flag. `rowKilled` stays optional so
// callers without a projected flag still get the fallback behavior.
//
// `dismissed` means "out of the active inbox" on ANY axis — stashed, dismissed,
// or killed — because that is what the server means: shouldShowInInbox hides a
// killed row just as the hide stamps hide the other two. The per-row badge then
// uses `killed` to name which flavor it is.
export function deriveTriageFlags(
  inbox: Pick<InboxSession, "inbox_killed_at" | "inbox_dismissed_at" | "inbox_stashed_at"> | undefined,
  rowKilled?: boolean,
): { killed: boolean; dismissed: boolean } {
  const killed = !!rowKilled || (!!inbox && isSessionKilled(inbox));
  return { killed, dismissed: killed || (!!inbox && isSessionHidden(inbox)) };
}
