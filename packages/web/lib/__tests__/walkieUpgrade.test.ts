import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { otherJoinedLive, senderHearing, senderHearingFrom } from "../../hooks/useWalkie";
import { observeWalkieUpgrade, walkieDoorOpen } from "../../hooks/useWalkieSync";
import { micConstraints } from "../calls/joinPrefs";
import { getWalkieStatus, refreshWalkie, walkieJoinedRoom } from "../calls/walkie";
import {
  JOIN_TITLE_MS,
  clearJoinAnnouncement,
  getJoinAnnouncement,
  joinTitle,
  subscribeJoinAnnouncement,
  theyJoinedText,
  youJoinedText,
} from "../calls/joinAnnounce";
import { useInboxStore } from "../../store/inboxStore";

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
    // engine's live room. Counting my own row would make the rule wait on a
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

  it("ignores a stamp left behind by a browser that died", () => {
    // `walkie_joined_at` is written when somebody joins and nothing takes it
    // back: a tab that crashes without leaving keeps its seat, and its stamp,
    // until the server sweeps the room. Read without a floor, the NEXT burst
    // into that room is a call from its very first tick — the sender's mic
    // never closes on release, a join is announced that nobody made, and the
    // strip hands itself to the call dock over three seconds of voice.
    //
    // The floor is when THIS client entered the room, IN THE UNITS THE STAMP
    // ARRIVES IN. The server floors it to the minute before sending, so this
    // rule can only ever be as fine as that — written to the millisecond it
    // rejected every real join instead (see the bucket tests below).
    const minute = 60_000;
    const entered = 100 * minute;
    expect(otherJoinedLive([seat({ walkie_joined_at: entered - minute })], ME, entered)).toBe(false);
    // The same room and the same person: the join is real once the stamp lands
    // inside this seat's own lifetime.
    expect(otherJoinedLive([seat({ walkie_joined_at: entered + minute })], ME, entered)).toBe(true);
    // A stamp at the very moment of entry counts. A receiver who was already
    // seated when the burst opened presses Join live in the same breath often
    // enough that rounding it out would drop real joins.
    expect(otherJoinedLive([seat({ walkie_joined_at: entered })], ME, entered)).toBe(true);
    // And one live stamp among leftovers is still news.
    expect(
      otherJoinedLive(
        [
          seat({ user_id: "user_ghost", walkie_joined_at: entered - 40 * minute }),
          seat({ walkie_joined_at: entered + minute }),
        ],
        ME,
        entered,
      ),
    ).toBe(true);
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

// ── what the sender is told ────────────────────────────────────────────────
//
// "Live to Jordan" was a claim about JORDAN made out of a fact about me: my
// own track had reached the SFU. It was false whenever Jordan was away from
// the machine, busy, or had the door shut — the ordinary cases, and the ones
// the walkie is built to survive, because the burst lands in the DM either
// way. The sentence now comes off the room's roster, which is the only thing
// that knows whether anybody is there.
describe("walkie: the sender's claim about the other person", () => {
  const ME = "user_me";
  const THEM = "user_them";
  const them = (over: Record<string, unknown> = {}) => ({ userId: THEM, name: "Jordan", ...over });
  const seat = (id: string) => ({ user_id: id });

  it("says they hear you when they are actually in the room", () => {
    const out = senderHearing([seat(ME), seat(THEM)], ME, them());
    expect(out.state).toBe("hears");
    expect(out.text).toBe("Jordan hears you");
  });

  it("NEVER reads hearing off my own seat", () => {
    // The whole bug in one line: I am in the room because I am the one talking
    // into it. A roster of exactly me is nobody listening.
    const out = senderHearing([seat(ME)], ME, them());
    expect(out.state).toBe("away");
    expect(out.text).toBe("Jordan is away — they get the message");
  });

  it("says away when the room is empty, and never calls it a failure", () => {
    const out = senderHearing([], ME, them());
    expect(out.state).toBe("away");
    // The message still arrives. The sentence has to carry that, or a person
    // stops talking when there was no reason to.
    expect(out.text).toContain("they get the message");
  });

  it("tells busy apart from away, by the same door the receiver applies", () => {
    // Three ways to shut it, one sentence — because from here they are the
    // same fact: the voice will not play, the message will.
    for (const shut of [{ status: "busy" }, { pref: "off" }, { snoozed: true }]) {
      const out = senderHearing([seat(ME)], ME, them(shut));
      expect(out.state).toBe("busy");
      expect(out.text).toBe("Jordan is busy — they get the message");
    }
  });

  it("prefers the room over the door: a seated teammate hears you whatever their status says", () => {
    // They are in the room. However they had their day marked, the audio is
    // playing on their machine, and the strip must say the true thing.
    expect(senderHearing([seat(THEM)], ME, them({ status: "busy" })).state).toBe("hears");
  });

  it("ignores a seat that belongs to somebody else entirely", () => {
    // A group room, or a third person who wandered in. The claim names one
    // person, so it is answered by that person's seat and no other.
    expect(senderHearing([seat("user_third")], ME, them()).state).toBe("away");
    // With nobody named — a room the description could not resolve — any seat
    // that is not mine is somebody listening.
    expect(senderHearing([seat("user_third")], ME, { name: "The room" }).state).toBe("hears");
  });

  it("claims nothing at all when neither identity has resolved", () => {
    // A roster read before currentUser has landed, in a room that named
    // nobody: my own seat is indistinguishable from theirs, and this is the
    // one claim that must never be guessed.
    expect(senderHearing([seat(ME)], undefined, { name: "Jordan" }).state).toBe("away");
  });
});

// ── the join, in words ─────────────────────────────────────────────────────
//
// The founder asked for "a message like hey he joined". What shipped was a
// sound and a surface swap: on the sender's side the strip silently became the
// call window, the microphone stayed open, and nothing said what had changed.
// These are the words, and the four seconds they live for.
describe("walkie: the dock's title when somebody joins", () => {
  const ROOM = "dm:title:test";
  const T0 = 1_700_000_000_000;
  const ann = (over: Record<string, unknown> = {}) => ({
    roomKey: ROOM,
    text: "Jordan joined — it's a call now",
    at: T0,
    ...over,
  });

  it("says the room's ordinary name when nothing has happened", () => {
    expect(joinTitle(null, ROOM, T0, "Jordan Lee")).toBe("Jordan Lee");
  });

  it("says who joined, for four seconds, and then stops", () => {
    expect(joinTitle(ann(), ROOM, T0, "Jordan Lee")).toBe("Jordan joined — it's a call now");
    expect(joinTitle(ann(), ROOM, T0 + JOIN_TITLE_MS - 1, "Jordan Lee")).toBe(
      "Jordan joined — it's a call now",
    );
    // A title is never allowed to outlive its moment: a tab that slept through
    // the timer must not come back still announcing somebody walking in.
    expect(joinTitle(ann(), ROOM, T0 + JOIN_TITLE_MS, "Jordan Lee")).toBe("Jordan Lee");
    expect(joinTitle(ann(), ROOM, T0 + 60_000, "Jordan Lee")).toBe("Jordan Lee");
  });

  it("belongs to the room it names and to no room after it", () => {
    // The person left and walked into another huddle inside the four seconds.
    expect(joinTitle(ann(), "dm:somewhere:else", T0, "Ana")).toBe("Ana");
    expect(joinTitle(ann(), null, T0, "Ana")).toBe("Ana");
  });

  it("names both sides of the same moment", () => {
    expect(theyJoinedText("Jordan")).toBe("Jordan joined — it's a call now");
    expect(youJoinedText("Jordan")).toBe("You joined Jordan");
    // A name that never resolved still gets a sentence rather than a blank.
    expect(theyJoinedText("")).toBe("Somebody joined — it's a call now");
    expect(youJoinedText(null)).toBe("You joined the call");
  });
});

describe("walkie: the far side's join, applied exactly once", () => {
  const ROOM = "dm:announce:test";

  beforeEach(() => {
    // SEATED FIRST, because that is the only way this moment ever happens: a
    // stamp arrives on the roster of a room this client is sitting in. The
    // engine reconciles its live room against the seat, so an upgrade marked
    // from outside one is dropped again before it can be read.
    useInboxStore.getState().setCallState({ roomKey: ROOM, phase: "connected", muted: false });
  });

  afterEach(() => {
    clearJoinAnnouncement();
    // Retire the room the way the app does: the call ending is what clears it.
    useInboxStore.getState().setCallState({ roomKey: null, phase: "idle", muted: true });
    refreshWalkie();
  });

  it("announces the join once, however many times the roster re-pushes", () => {
    // THE MUTATION CHECK LIVES HERE. The roster this rides on re-pushes for
    // every mute, camera and heartbeat in the room, and the stamp on it never
    // changes once written — so without the guard the sound and the sentence
    // would fire again on each of them, and the person would be told somebody
    // joined for as long as the call lasted.
    const seen: string[] = [];
    const unsubscribe = subscribeJoinAnnouncement(() => seen.push(getJoinAnnouncement()?.text ?? ""));
    try {
      observeWalkieUpgrade(ROOM, "Jordan");
      observeWalkieUpgrade(ROOM, "Jordan");
      observeWalkieUpgrade(ROOM, "Jordan");
    } finally {
      unsubscribe();
    }
    expect(seen).toEqual(["Jordan joined — it's a call now"]);
    expect(getJoinAnnouncement()?.roomKey).toBe(ROOM);
    // And the engine knows the room is a call, which is what keeps the mic open
    // and hands the surface to the ordinary dock.
    expect(walkieJoinedRoom(getWalkieStatus())).toBe(ROOM);
  });
});

// ── one derivation, two readers ────────────────────────────────────────────
//
// The strip says the sentence and the away tick makes the sound, and they read
// the same function on purpose. Two copies of this lookup would eventually
// disagree, and the shape of that bug is a person hearing "nobody is there"
// while the words in front of them say somebody is.
describe("walkie: the sender's claim, derived from the store", () => {
  const ME = "user_me";
  const THEM = "user_them";
  const ROOM = `dm:${ME}:${THEM}`;
  const NOW = 1_700_000_000_000;

  const store = (over: Record<string, any> = {}) => ({
    currentUser: { _id: ME },
    teamMembers: [{ _id: THEM, name: "Jordan Lee" }],
    chatChannels: {},
    chatRail: [],
    conversations: {},
    sessions: {},
    callOccupancy: {},
    ...over,
  });

  it("names the other person off the room key and the live roster", () => {
    const s = store({ callOccupancy: { [ROOM]: [{ user_id: ME }, { user_id: THEM }] } });
    const out = senderHearingFrom(s, ROOM, NOW);
    expect(out.otherId).toBe(THEM);
    expect(out.state).toBe("hears");
    expect(out.text).toBe("Jordan Lee hears you");
  });

  it("says away for a room holding nobody but me", () => {
    const s = store({ callOccupancy: { [ROOM]: [{ user_id: ME }] } });
    expect(senderHearingFrom(s, ROOM, NOW).state).toBe("away");
  });

  it("reads the door off the teammate's own row, snooze included", () => {
    // The same three ways the receiver's client shuts its door, seen from the
    // other end (walkieDoorOpen). A snooze is a clock, so it is compared
    // against the `now` the caller passes rather than one hidden in here.
    const busy = store({ teamMembers: [{ _id: THEM, name: "Jordan Lee", status: "busy" }] });
    expect(senderHearingFrom(busy, ROOM, NOW).state).toBe("busy");

    const off = store({ teamMembers: [{ _id: THEM, name: "Jordan Lee", walkie_pref: "off" }] });
    expect(senderHearingFrom(off, ROOM, NOW).state).toBe("busy");

    const snoozed = store({
      teamMembers: [{ _id: THEM, name: "Jordan Lee", walkie_snoozed_until: NOW + 60_000 }],
    });
    expect(senderHearingFrom(snoozed, ROOM, NOW).state).toBe("busy");
    // And the hour running out puts them back to merely away.
    expect(senderHearingFrom(snoozed, ROOM, NOW + 120_000).state).toBe("away");
  });

  it("renames live: the sentence follows the roster, not the burst", () => {
    const renamed = store({ teamMembers: [{ _id: THEM, name: "Jordan L." }] });
    expect(senderHearingFrom(renamed, ROOM, NOW).text).toBe("Jordan L. is away — they get the message");
  });
});

// ── the stamp arrives already rounded ──────────────────────────────────────
//
// `walkie_joined_at` is floored to the minute before it leaves the server
// (calls.projectMember, through bucketTs) so a room's occupancy pushes
// byte-identical results while people mute and unmute in it. The rule that
// tells a fresh join from a leftover therefore has to compare in the wire's
// units, not in the local clock's.
//
// Found with two browsers, not by reading: the sender's side never became a
// call, so the release muted them mid-sentence — the whole of A1 silently
// undone by a comparison that looked right.
describe("walkie: telling a fresh join from a leftover", () => {
  const ME = "user_me";
  const stamped = (at: number) => [{ user_id: "user_them", walkie_joined_at: at }];
  const MINUTE = 60_000;
  const TOP = 1_700_000_040_000 - (1_700_000_040_000 % MINUTE);

  it("counts a join made in the same minute this client sat down", () => {
    // Sat down 40 seconds into the minute; they pressed Join live ten seconds
    // later; the stamp comes back floored to the top of that minute, which is
    // EARLIER than the moment I arrived. It is still news.
    expect(otherJoinedLive(stamped(TOP), ME, TOP + 40_000)).toBe(true);
  });

  it("still refuses a stamp left behind in an earlier minute", () => {
    // The case the rule exists for: a browser that died without leaving keeps
    // its seat and its stamp, and the next burst into that room must not read
    // as a call nobody joined.
    expect(otherJoinedLive(stamped(TOP - MINUTE), ME, TOP)).toBe(false);
    expect(otherJoinedLive(stamped(TOP - 60 * MINUTE), ME, TOP)).toBe(false);
  });

  it("counts everything when nobody said when the seat began", () => {
    expect(otherJoinedLive(stamped(TOP), ME)).toBe(true);
    expect(otherJoinedLive(stamped(TOP), ME, 0)).toBe(true);
  });
});
