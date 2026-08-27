// Every huddle transcribes. This is the client's half of deciding who does
// it: whether THIS window should ask the server to scribe right now, yield a
// run it no longer owns, or hold. The server (transcripts.start) is the
// arbiter — it answers "scribe" or "observer" — so this only has to avoid
// asking when the answer is obvious, and to notice when a run this client is
// still holding has been adopted by somebody else.
//
// Pure on purpose: useCallSync feeds it the store and the scribe status, and
// the tests feed it fixtures.
import { isRecRoomKey } from "@codecast/shared/contracts";

export type AutoScribeInput = {
  roomKey: string | null;
  connected: boolean;
  // A person joined this room on purpose (a button, an answered ring, "Join
  // live"). A walkie taking a background seat never scribes: the burst is
  // its own transcript, and a five-second exchange is not a huddle.
  deliberate: boolean;
  // liveRooms row for this room, if any.
  transcribeOff: boolean;
  // Live seats in the room (callOccupancy), by user id.
  rosterIds: string[];
  meId: string | null;
  // transcripts.getLive: undefined while loading, null when nobody is
  // transcribing, else the live run and who started it.
  live: { startedBy: string } | null | undefined;
  scribeActive: boolean;
};

export type AutoScribeVerdict = "start" | "yield" | "hold";

export function decideAutoScribe(i: AutoScribeInput): AutoScribeVerdict {
  if (!i.roomKey || !i.connected || !i.deliberate || isRecRoomKey(i.roomKey)) return "hold";
  if (i.live === undefined || !i.meId) return "hold";
  // A run I am holding that the server handed to someone else (my seat lease
  // lapsed and they adopted it): let go, or every word lands twice. The
  // transcript stays live — it is theirs now.
  if (i.scribeActive) {
    return i.live && i.live.startedBy !== i.meId ? "yield" : "hold";
  }
  if (i.transcribeOff) return "hold";
  // A huddle is two or more people; a seat waiting for a ring to be answered
  // has nothing to transcribe and no reason to open a recognizer.
  if (i.rosterIds.length < 2) return "hold";
  if (!i.live) return "start";
  if (i.live.startedBy === i.meId) return "start";
  // Somebody else's run whose scribe is no longer seated: an orphan to adopt.
  // The server re-checks the lease; this only avoids asking every heartbeat.
  return i.rosterIds.includes(i.live.startedBy) ? "hold" : "start";
}
