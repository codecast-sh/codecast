// The composer co-presence helpers, kept out of the component file: an
// export that is not a component makes the whole module a failed Fast
// Refresh boundary, so every save re-executes its importers (the shell).
import { isConvexId } from "../store/inboxStore";
import type { PresenceRow } from "../hooks/useDocPresence";
import type { ChatMember } from "./chatViews";

/**
 * Whether a conversation can carry composer co-presence. It must be a real
 * server row: a fresh optimistic stub is keyed by its session uuid, which the
 * presence query's id validator rejects. Every real conversation qualifies,
 * private ones included: the server gates the read on access, and the owner
 * writes nothing until someone else appears, so a solo session costs one
 * silent subscription and no rows.
 */
export function composerPresenceEnabled(conversation: { _id: unknown } | null | undefined): boolean {
  return !!conversation && isConvexId(String(conversation._id));
}

/** The rows in a presence list that are forming words right now. */
export function typingRows(present: readonly PresenceRow[]): PresenceRow[] {
  return present.filter((p) => !!p.draft_text && p.draft_text.trim().length > 0);
}

/**
 * A presence row as the typing strip's member: the roster row when the
 * person is a teammate (their real face), else the name the row carries (a
 * share link guest, who is not on the roster).
 */
export function presenceMember(row: PresenceRow, roster: readonly ChatMember[]): ChatMember {
  return roster.find((m) => String(m._id) === row.user_id) ?? { _id: row.user_id, name: row.user_name };
}
