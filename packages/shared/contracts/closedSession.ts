// A CLOSED session: the person's Close (web/phone), which stops an agent that
// has nothing in flight without retiring it. Close writes inbox_closed_at equal
// to the inbox_dismissed_at it stamps, and nothing else. The equality is the
// marker: every un-hide clears inbox_dismissed_at and every other dismissal
// writes a new stamp, so neither needs to know this field exists, and a stale
// inbox_closed_at left behind is inert. A kill (inbox_killed_at) is not a close.
export type ClosedFields = {
  inbox_closed_at?: number | null;
  inbox_dismissed_at?: number | null;
  inbox_killed_at?: number | null;
};

export function isClosedSession(row: ClosedFields): boolean {
  return row.inbox_closed_at != null && row.inbox_closed_at === row.inbox_dismissed_at && !row.inbox_killed_at;
}
