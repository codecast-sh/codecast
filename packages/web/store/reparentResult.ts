// What a reparent of a session or a role echoes back, and the one toast it
// shows. The org slice's reparent actions resolve to it; the chart, the
// session map and the ownership menu toast it.

/** What orgRoles.reparentSession / reparent echo back (org-staffing.md S11):
 *  who the subject now reports to, and how many agents were told. The web
 *  reads this to toast both things at once. */
export type ReparentResult = {
  short_id?: string;
  reports_to?: { kind: "user" | "role"; name: string } | null;
  /** `deferred` counts a session too stale to wake for one sentence: the line
   *  is parked and it reads it when it next runs. Never "was told". */
  told?: { sessions: number; roles: number; deferred?: number };
};

/**
 * The one toast a reparent shows (S11). It must say only what actually
 * happened, because the three deliveries differ:
 *
 * - A SESSION move enqueues a real message into that session (tellSession), so
 *   "the session was told" is literally true: it arrives in its transcript.
 * - A session too stale to wake for one sentence is DEFERRED instead: the line
 *   is parked and it reads it on its next turn. Saying "was told" there would
 *   have someone open a transcript that has not received anything yet, so it
 *   says when it will arrive instead.
 * - A ROLE move wakes the role once and files one PASSIVE fact per live hand
 *   into the ROLE's own next frame (tellRoleMoved enqueues against role._id,
 *   not against the hand). Nothing reaches a hand's transcript, so calling them
 *   "told" would send a founder hunting for a line that was never written.
 *   They are noted in the role's frame, and that is what this says.
 */
export function reparentToastLine(subject: string, parentName: string, kind: "session" | "role", told?: { sessions: number; roles: number; deferred?: number }): string {
  const head = `${subject} now reports to ${parentName}`;
  if (kind === "session") {
    if (told?.sessions) return `${head}; the session was told.`;
    if (told?.deferred) return `${head}; it will be told when it next runs.`;
    return `${head}.`;
  }
  const hands = told?.sessions ?? 0;
  const noted = hands ? `${hands} hand${hands === 1 ? "" : "s"} noted in its frame` : "";
  if (told?.roles) return noted ? `${head}; the role was told, ${noted}.` : `${head}; the role was told.`;
  return noted ? `${head}; ${noted}.` : `${head}.`;
}
