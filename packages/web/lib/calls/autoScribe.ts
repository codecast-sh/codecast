// Every huddle transcribes. This is the client's half of deciding who does
// it: whether THIS window should ask the server to scribe right now, yield a
// run it no longer owns, or hold. The server (transcripts.start) is the
// arbiter — it answers "scribe" or "observer" — so this only has to avoid
// asking when the answer is obvious, and to notice when a run this client is
// still holding has been adopted by somebody else.
//
// Pure on purpose: useCallSync feeds it the store and the scribe status, and
// the tests feed it fixtures.
import { isRecRoomKey, sessionRoomConversationId } from "@codecast/shared/contracts";

export type AutoScribeInput = {
  roomKey: string | null;
  connected: boolean;
  // A person joined this room on purpose (a button, an answered ring, "Join
  // live"). A walkie taking a background seat never scribes: the burst is
  // its own transcript, and a five-second exchange is not a huddle.
  deliberate: boolean;
  // liveRooms row for this room, if any.
  transcribeOff: boolean;
  // When that opt-out was switched on (liveRooms.transcribe_off_at), and when
  // this window's own run started (scribe status). Together they tell an
  // opt-out aimed at this run from a stale flag the store still shows for a
  // beat after a person switched transcription back on by hand.
  transcribeOffAt?: number | null;
  scribeStartedAt?: number | null;
  // Live seats in the room (callOccupancy), by user id.
  rosterIds: string[];
  meId: string | null;
  // transcripts.getLive: undefined while loading, null when nobody is
  // transcribing, else the live run and who started it.
  live: { startedBy: string } | null | undefined;
  scribeActive: boolean;
};

// "stop": the room said "don't transcribe" while this window holds the run.
// The opt-out is the room's, not the scribe's, so whoever flips it ends the
// run wherever it lives; the digest of what was said still posts.
export type AutoScribeVerdict = "start" | "yield" | "stop" | "hold";

export function decideAutoScribe(i: AutoScribeInput): AutoScribeVerdict {
  if (!i.roomKey || !i.connected || !i.deliberate || isRecRoomKey(i.roomKey)) return "hold";
  if (i.live === undefined || !i.meId) return "hold";
  // A run I am holding that the server handed to someone else (my seat lease
  // lapsed and they adopted it): let go, or every word lands twice. The
  // transcript stays live — it is theirs now.
  if (i.scribeActive) {
    if (i.transcribeOff && optOutAimsAtRun(i)) return "stop";
    return i.live && i.live.startedBy !== i.meId ? "yield" : "hold";
  }
  if (i.transcribeOff) return "hold";
  // A huddle is two or more people; a seat waiting for a ring to be answered
  // has nothing to transcribe and no reason to open a recognizer.
  //
  // A SESSION'S OWN ROOM is the exception, and it is the whole point of that
  // room: the second party is the agent, which never takes a seat. One person
  // in there is not waiting for anybody — they are talking to the session, and
  // the transcript is how the words reach it.
  if (i.rosterIds.length < 2 && !sessionRoomConversationId(i.roomKey)) return "hold";
  if (!i.live) return "start";
  if (i.live.startedBy === i.meId) return "start";
  // Somebody else's run whose scribe is no longer seated: an orphan to adopt.
  // The server re-checks the lease; this only avoids asking every heartbeat.
  return i.rosterIds.includes(i.live.startedBy) ? "hold" : "start";
}

// The opt-out ends a run only when it was switched on after the run began.
// Both stamps are wall clocks from different machines, so a second of slack
// keeps ordinary skew from reading a hand start as a stop.
const OPT_OUT_SLACK_MS = 1_000;
function optOutAimsAtRun(i: AutoScribeInput): boolean {
  if (!i.transcribeOffAt || !i.scribeStartedAt) return false;
  return i.transcribeOffAt > i.scribeStartedAt + OPT_OUT_SLACK_MS;
}
