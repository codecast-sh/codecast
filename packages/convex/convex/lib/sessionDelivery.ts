// How words reach a session fed from a call (transcripts.deliverRoutes): the
// pacing rule, pure, with the clocks it reads.
import { addressesAgent, callParticipantKind } from "@codecast/shared/contracts";

// Why deliverRoutes is running (its DELIVER_REASON validator).
export type DeliverReason = "flush" | "settle" | "hold_expired" | "route_added";
// A catch up delivery counts the room as quiet after this long without a
// closed utterance: the scribe's own lull (scribeEngine GAP_MS).
export const CATCH_UP_QUIET_MS = 2_500;
// The shortest gap between two context deliveries to one session. A line
// that names the agent still goes at once and carries everything unsent with
// it; the rest of the room's talk waits and arrives as one catch up. Each
// delivery costs the agent a whole turn over its context, so the gap stays,
// but at a minute: an agent that is meant to check what the room says as it
// goes cannot hear it three minutes late.
export const CONTEXT_MIN_GAP_MS = 60_000;

/** Whether a session route's unsent words go now, and in which lane. Pure,
 *  so the pacing rule is one readable function with tests. Context also
 *  waits out CONTEXT_MIN_GAP_MS after the last context chunk.
 *
 *  A line that names the agent goes at once, mid-turn if need be: the ask
 *  lane. Everything else is context, and context waits while the agent is
 *  mid-turn or holding the room off (`hold_until`); its turn's end and the
 *  hold's end each run delivery again. A clock-driven delivery (settle, hold
 *  expiry) also waits for the room to be quiet, so a catch up never opens
 *  on half a sentence: the scribe's next lull delivers it instead. */
export function sessionDeliveryVerdict(opts: {
  reason: DeliverReason;
  now: number;
  route: { hold_until?: number; context_at?: number };
  pacing: { names: string[]; busy: boolean } | null;
  unsent: Array<{ text: string; ended_at: number; speaker_id?: string }>;
}): { deliver: false; wait?: "quiet" | "gap"; at?: number } | { deliver: true; lane: "ask" | "context"; held: boolean } {
  const { reason, now, route, pacing, unsent } = opts;
  // Only the team opens the ask lane. A guest naming the agent is talking
  // about it or to it, and their words still arrive as context, but they
  // never cut into its turn: the ask lane reaches the agent at once with the
  // authority of whoever pointed the route at the call, and an outsider in
  // somebody's meeting does not get to spend that.
  const teamWords = unsent.filter((s) => !s.speaker_id || callParticipantKind(s.speaker_id) !== "guest");
  const addressed = !!pacing && addressesAgent(teamWords.map((s) => s.text).join("\n"), pacing.names);
  if (addressed) return { deliver: true, lane: "ask", held: false };
  const holding = (route.hold_until ?? 0) > now;
  if (pacing?.busy || holding) return { deliver: false };
  // A lull's flush and a turn's end both wait out the gap. A context chunk
  // costs the agent a turn, and that turn's end is a settle seconds later:
  // exempt, it shipped the next chunk at once and the gap never held. The
  // gap's own closing run is a settle that arrives after the gap, so it
  // delivers; a hold's catch up and a new route's backlog are never gapped.
  const gapped = reason === "flush" || reason === "settle";
  if (gapped && route.context_at && route.context_at + CONTEXT_MIN_GAP_MS > now) {
    return { deliver: false, wait: "gap", at: route.context_at + CONTEXT_MIN_GAP_MS };
  }
  const clockDriven = reason === "settle" || reason === "hold_expired";
  if (clockDriven) {
    const lastEnd = Math.max(...unsent.map((s) => s.ended_at));
    // Not quiet yet: the caller schedules one more clock-driven run after
    // the quiet window, so the words never wait for the call's end.
    if (now - lastEnd < CATCH_UP_QUIET_MS) return { deliver: false, wait: "quiet" };
  }
  // Words said under a hold are a catch up however they leave: the hold's end
  // can find the agent still mid-turn, and the scribe's next lull ships them.
  const saidUnderHold = unsent.some((s) => s.ended_at <= (route.hold_until ?? 0));
  return { deliver: true, lane: "context", held: clockDriven || saidUnderHold };
}
