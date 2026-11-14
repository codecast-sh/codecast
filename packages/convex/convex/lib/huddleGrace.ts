// The huddle grace: how long an emptied room's huddle waits for somebody to
// come back, and the one answer to "is this still the same huddle".

import type { Doc } from "../_generated/dataModel";
import { isSeat } from "../callRooms";

/** How long an emptied room's huddle waits for somebody to come back. A
 *  rejoin, a window handoff, a dropped connection or an accidental hop to
 *  another room inside this window is the same conversation, and the same
 *  record carries on. */
export const HUDDLE_GRACE_MS = 3 * 60_000;

/** When a live huddle went quiet: the stamp the last leave left on the
 *  record, else the latest of the room's own emptied stamp (the last leave,
 *  with or without a record: call_room_state.emptied_at) and the last lease
 *  any seat refreshed (a tab that died never leaves). SEATS ONLY: a prewarm
 *  row is somebody holding a connection open after the huddle died, and
 *  dating the end from it would inflate the call by up to ninety seconds. */
export function quietSince(
  t: Doc<"transcripts"> | null,
  rows: Array<{ last_seen: number; prewarm?: boolean }>,
  emptiedAt?: number,
): number | null {
  if (t?.idle_since) return t.idle_since;
  const lastSeen = rows.filter(isSeat).reduce((m, r) => Math.max(m, r.last_seen), emptiedAt ?? 0);
  return lastSeen || null;
}

/** Is an EMPTY room still inside its huddle's grace? The one answer to "is
 *  this the same huddle", for the people coming back (resumeOrEndHuddle) and
 *  for the guests they let in (huddleAlive), so the two can never disagree.
 *  With a live record, a record nobody dated yet counts as just gone quiet.
 *  Without one (transcription off, or nobody scribing yet) the room's own
 *  stamps date it: when the last person left, or when the last seat lapsed.
 *  Both cases get the same grace, so a teammate who reloads the tab comes
 *  back to the same huddle whether or not anything was transcribing it. */
export function withinHuddleGrace(
  t: Doc<"transcripts"> | null,
  rows: Array<{ last_seen: number; prewarm?: boolean }>,
  now: number,
  emptiedAt?: number,
): boolean {
  const quiet = t ? (quietSince(t, rows, emptiedAt) ?? now) : quietSince(null, rows, emptiedAt);
  return quiet !== null && now - quiet < HUDDLE_GRACE_MS;
}
