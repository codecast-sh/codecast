import { describe, expect, it } from "bun:test";
import { otherJoinedLive } from "../../hooks/useWalkie";
import { walkieDoorOpen } from "../../hooks/useWalkieSync";
import { micConstraints } from "../calls/joinPrefs";

// THE UPGRADE: a burst becoming a call because somebody stepped into it.
//
// Everything here exists because one signal died. A burst and a call are the
// same room, and what used to tell them apart was the microphone — an open mic
// meant a person had joined. The founder's decision made auto-listen HOT, so
// every listener's mic is open now and that reading would call every burst a
// conversation. The intent is carried instead of inferred: one deliberate
// gesture, stamped on the seat (call_members.walkie_joined_at), read back off
// the roster both sides already subscribe to.

const ME = "user_me";
const THEM = "user_them";

const seat = (over: Record<string, unknown> = {}) => ({
  user_id: THEM,
  user_name: "Jordan",
  muted: false,
  ...over,
});

describe("walkie: reading the far side's join off the roster", () => {
  it("says no when the room is full of people who only heard the burst", () => {
    // The ordinary case, and the one that must never read as a call: a burst
    // played to two people seats both of them, unmuted, with nothing stamped.
    expect(otherJoinedLive([seat(), seat({ user_id: "user_third" })], ME)).toBe(false);
  });

  it("says yes the moment one of them steps in on purpose", () => {
    expect(otherJoinedLive([seat({ walkie_joined_at: 123 })], ME)).toBe(true);
  });

  it("never reads MY OWN stamp back as news", () => {
    // This side already knows what it pressed, synchronously, through the
    // engine's `joinedLive`. Counting my own row would make the rule wait on a
    // round trip that the local-first path exists to avoid — and worse, it
    // would keep answering true for the whole call, so the watcher that fires
    // the join cue and the camera would have no edge to fire on.
    expect(otherJoinedLive([seat({ user_id: ME, walkie_joined_at: 123 })], ME)).toBe(false);
    expect(
      otherJoinedLive([seat({ user_id: ME, walkie_joined_at: 1 }), seat({ walkie_joined_at: 2 })], ME),
    ).toBe(true);
  });

  it("treats an unresolved viewer as nobody, never as everybody", () => {
    // A roster read before currentUser has landed must not decide that every
    // stamped row is somebody else's — but it must also not decide the reverse.
    // Nothing is stamped here, so the answer is no either way.
    expect(otherJoinedLive([seat()], undefined)).toBe(false);
    expect(otherJoinedLive([seat({ walkie_joined_at: 5 })], undefined)).toBe(true);
  });

  it("ignores a row an older client wrote without the field", () => {
    expect(otherJoinedLive([seat({ walkie_joined_at: undefined })], ME)).toBe(false);
    expect(otherJoinedLive([seat({ walkie_joined_at: 0 })], ME)).toBe(false);
  });
});

// THE DOOR, which is now also the consent for a microphone.
//
// It used to gate only whether a voice reached this machine. With hot
// auto-listen it gates whether a mic opens untouched, so every clause is worth
// a test of its own.
describe("walkie: the door", () => {
  const open = {
    callsOn: true,
    present: true,
    snoozed: false,
    pref: "team",
    status: "available",
  };

  it("is open by default, because a teammate reaching you is the point", () => {
    expect(walkieDoorOpen(open)).toBe(true);
    // Absent pref means "team": the product's default is the open door.
    expect(walkieDoorOpen({ ...open, pref: undefined })).toBe(true);
  });

  it("is shut by every one of the four ways to shut it", () => {
    expect(walkieDoorOpen({ ...open, callsOn: false })).toBe(false);
    expect(walkieDoorOpen({ ...open, present: false })).toBe(false);
    expect(walkieDoorOpen({ ...open, snoozed: true })).toBe(false);
    expect(walkieDoorOpen({ ...open, pref: "off" })).toBe(false);
    expect(walkieDoorOpen({ ...open, status: "busy" })).toBe(false);
  });

  it("stays shut while snoozed even with everything else wide open", () => {
    // Snooze is pressed to stop a voice that is playing at that second, so it
    // has to outrank the pref rather than merely agree with it.
    expect(walkieDoorOpen({ ...open, snoozed: true, pref: "team", status: "available" })).toBe(false);
  });

  it("lets an away teammate through, and stops a busy one", () => {
    // "away" is a fact about the person's day; "busy" is a request. Only one of
    // them is an instruction to this door.
    expect(walkieDoorOpen({ ...open, status: "away" })).toBe(true);
    expect(walkieDoorOpen({ ...open, status: "busy" })).toBe(false);
  });
});

describe("walkie: what the microphone is opened with", () => {
  it("cancels echo, always", () => {
    // Not a preference. The receiver auto-listens with a hot mic, so the burst
    // coming out of their speakers arrives back at their own open microphone —
    // and both halves of the walkie capture through this one constraint set.
    expect(micConstraints().echoCancellation).toBe(true);
    expect(micConstraints("dev-1").echoCancellation).toBe(true);
  });

  it("asks for the remembered device without insisting on it", () => {
    // `ideal`, never `exact`: a headset that was unplugged since the last call
    // must degrade to the built-in mic, not fail to open one at all.
    expect(micConstraints("dev-1").deviceId).toEqual({ ideal: "dev-1" });
    expect(micConstraints().deviceId).toBeUndefined();
    expect(micConstraints("").deviceId).toBeUndefined();
  });
});
