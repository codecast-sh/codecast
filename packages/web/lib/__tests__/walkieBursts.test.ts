import { describe, expect, it } from "bun:test";
import { WALL_TAP_MS } from "../../components/people/peopleWallLayout";
import {
  MIN_BURST_MS,
  WALKIE_LOCK_MS,
  hotListenDeadline,
  landBurst,
  measureBurst,
  nextRoomMode,
  pickLiveBurst,
  seatDeadline,
  shouldLockBurst,
  shouldReleaseRoom,
  type LiveBurstRow,
} from "../calls/walkie";

// Which live burst a client should open its ears for. The rules are small and
// the consequences are loud — this is the function that decides whether a
// voice comes out of somebody's speakers — so they are pinned here.

const NOW = 1_700_000_000_000;

const row = (over: Partial<LiveBurstRow>): LiveBurstRow => ({
  messageId: "m1",
  channelId: "c1",
  roomKey: "dm:a:b",
  fromUserId: "u1",
  fromName: "Sam",
  createdAt: NOW - 1_000,
  ...over,
});

describe("walkie: choosing the burst to hear", () => {
  it("hears nobody when nobody is talking", () => {
    expect(pickLiveBurst([], NOW)).toBeNull();
  });

  it("hears the most recent speaker when two people key up", () => {
    const older = row({ messageId: "old", createdAt: NOW - 20_000 });
    const newer = row({ messageId: "new", createdAt: NOW - 2_000 });
    // Order in the payload must not decide it; the clock does.
    expect(pickLiveBurst([newer, older], NOW)?.messageId).toBe("new");
    expect(pickLiveBurst([older, newer], NOW)?.messageId).toBe("new");
  });

  it("ignores a burst with no room to join", () => {
    expect(pickLiveBurst([row({ roomKey: undefined })], NOW)).toBeNull();
  });

  it("ignores a row past the server's live window — that tab died mid-word", () => {
    expect(pickLiveBurst([row({ createdAt: NOW - 120_001 })], NOW)).toBeNull();
    // And a stale row does not shadow a real one behind it.
    const live = row({ messageId: "live", createdAt: NOW - 3_000 });
    const dead = row({ messageId: "dead", createdAt: NOW - 300_000 });
    expect(pickLiveBurst([dead, live], NOW)?.messageId).toBe("live");
  });
});

// What a burst's last round trip is allowed to conclude. The sender's own
// bubble is painted from this answer, and the wrong answer is the worst of the
// three states: a message that reads sent and playable to the person who spoke
// it, and does not exist for the person it was spoken to.
describe("walkie: landing a burst", () => {
  const ARGS = {
    messageId: "msg1",
    content: "back in five",
    durationMs: 1500,
    attachments: [{ storage_id: "st1", mime: "audio/webm", name: "voice.webm" }],
  };

  function fakeConvex(behavior: Record<string, "ok" | "throw">) {
    const calls: string[] = [];
    return {
      calls,
      handle: {
        action: async () => null,
        mutation: async (_fn: any, args: any) => {
          // Told apart by the call itself: only a finalize carries the words.
          const name = args.content === undefined ? "cancel" : "finalize";
          calls.push(name);
          if (behavior[name] === "throw") throw new Error(name + " refused");
          return { message_id: args.message_id };
        },
      },
    };
  }

  it("lands the message when the server takes it", async () => {
    const c = fakeConvex({ finalize: "ok" });
    expect(await landBurst(c.handle, ARGS)).toBe("landed");
    expect(c.calls).toEqual(["finalize"]);
  });

  it("cancels the burst when it cannot be finalized — the audio is over, it cannot be retried later", async () => {
    const c = fakeConvex({ finalize: "throw", cancel: "ok" });
    expect(await landBurst(c.handle, ARGS)).toBe("cancelled");
    expect(c.calls).toEqual(["finalize", "cancel"]);
  });

  it("says so when nobody answered, rather than claiming either outcome", async () => {
    // Both halves failing is the network being gone. The row is still live on
    // the server, and the sweep there — not this client — decides its fate.
    const c = fakeConvex({ finalize: "throw", cancel: "throw" });
    expect(await landBurst(c.handle, ARGS)).toBe("unresolved");
    expect(c.calls).toEqual(["finalize", "cancel"]);
  });
});

// The brushed key. MIN_BURST_MS throws away a hold too short to be speech, and
// it only works if the hold is measured from the hand, not from the clock the
// setup happens to be on. Measuring the burst from press to "setup finished"
// charged mic acquisition, the room join and the start round trip to the
// person's thumb: a real 60ms tap reported 1274ms, so the guard never fired
// once and every brushed key posted a wordless voice note.
describe("walkie: measuring a burst", () => {
  const PRESS = 1_000_000;
  // What setup actually cost on a warm room in the browser: about 1.2 seconds.
  const SETUP_MS = 1_200;

  const measure = (holdMs: number, over: Partial<Parameters<typeof measureBurst>[0]> = {}) =>
    measureBurst({
      startedAt: PRESS,
      captureAt: PRESS + SETUP_MS,
      releasedAt: PRESS + holdMs,
      stoppedAt: PRESS + Math.max(holdMs, SETUP_MS),
      transcript: "",
      hasAudio: true,
      ...over,
    });

  it("throws away a brushed key even when the setup it raced took a second", () => {
    expect(measure(60).discard).toBe(true);
    expect(measure(300).discard).toBe(true);
    expect(measure(699).discard).toBe(true);
  });

  it("keeps a hold that reached the threshold", () => {
    expect(measure(700).discard).toBe(false);
    expect(measure(25_000).discard).toBe(false);
  });

  it("reports the recording's own span, not the setup that preceded it", () => {
    // 25s of hold on a room that took 1.2s to open is 23.8s of audio.
    expect(measure(25_000).durationMs).toBe(23_800);
  });

  it("falls back to the hold when there was no recorder to run", () => {
    // An old browser or a blocked codec: live audio and a transcript, no
    // recording. The hold is then the only span there is.
    const m = measure(4_000, { captureAt: null, transcript: "on my way" });
    expect(m.durationMs).toBe(4_000);
    expect(m.discard).toBe(false);
  });

  it("never reports a negative span when the release beat the setup", () => {
    const m = measure(200, { stoppedAt: PRESS + SETUP_MS - 100 });
    expect(m.durationMs).toBe(0);
    expect(m.discard).toBe(true);
  });

  it("throws away a real hold that carried neither words nor audio", () => {
    expect(measure(5_000, { hasAudio: false }).discard).toBe(true);
    // Audio with nothing recognized is still a voice note.
    expect(measure(5_000, { hasAudio: true }).discard).toBe(false);
    // As is a transcript with no recording behind it.
    expect(measure(5_000, { hasAudio: false, transcript: "on my way" }).discard).toBe(false);
    // Whitespace is not words.
    expect(measure(5_000, { hasAudio: false, transcript: "   " }).discard).toBe(true);
  });
});

// ct-44931 polish round 2. Whose seat is it?
//
// The walkie takes a seat in a real call room to carry a burst, and it used to
// hand every such seat back the same way: linger thirty seconds, then leave if
// nothing is happening. Two things were wrong with that.
//
// A burst that came to NOTHING still lingered. Measured in the browser: a 102ms
// brush of the mic left the sender connected for the full half minute AND
// auto-joined the receiver, who saw the live row in the second before it was
// cancelled. Both watched a floating strip claim "Still open with <the other
// person>", and to teammates both showed as seated in a live huddle. Nothing
// had been said and no message existed.
//
// And the leave did not ask whose seat it was. Someone who walked into a huddle
// by hand and sat in it muted — then used hold-to-reply, which is exactly what
// that gesture is for — was thrown out of the meeting thirty seconds later.

const seat = (over: Partial<Parameters<typeof shouldReleaseRoom>[0]> = {}) => ({
  mode: "burst" as const,
  bursting: false,
  incoming: false,
  ...over,
});

// ── what the room becomes ──────────────────────────────────────────────────
//
// The transition of the whole state machine, in three lines. It lives out here
// rather than inside the setter because a rule nobody can call is a rule nobody
// can check, and the two cases below are exactly the ones that used to need a
// flag apiece: a `guest` marker for a room already sat in, and an early return
// for a room this client's own key was down in.

describe("walkie: what a room becomes when a gesture arrives", () => {
  it("gives a fresh room whatever the gesture says", () => {
    expect(nextRoomMode(null, "burst", { seated: false })).toBe("burst");
    expect(nextRoomMode(null, "listen", { seated: false })).toBe("listen");
  });

  it("calls a room this client was already sitting in a call, whoever opened it", () => {
    // Hold-to-reply inside a huddle. The huddle keeps its own dock and its
    // hang-up, and no timer of ours may take its seat — which is the whole of
    // what a separate `guest` flag used to record.
    expect(nextRoomMode(null, "burst", { seated: true })).toBe("call");
    expect(nextRoomMode(null, "listen", { seated: true })).toBe("call");
  });

  it("never lets a burst take a call back down to a burst", () => {
    // Somebody stepped in on purpose. A sentence spoken afterwards is a
    // sentence in a conversation, not a walkie message.
    expect(nextRoomMode("call", "burst", { seated: true })).toBe("call");
    expect(nextRoomMode("call", "listen", { seated: false })).toBe("call");
  });

  it("keeps a room MY OWN key is down in mine when they answer into it", () => {
    // Two people pressing at once. Their burst arriving is a reply into the
    // room I opened, not a room I am listening in: the mode says what THIS
    // client is doing here, and both voices being live is `sending` and
    // `incoming`. Without this the strip changed hands mid-sentence.
    expect(nextRoomMode("burst", "listen", { seated: true })).toBe("burst");
  });

  it("lets a listen become a burst when I answer them", () => {
    // The other order, and it must NOT be symmetrical: pressing is a decision
    // and hearing is not, so the client's own key wins either way round.
    expect(nextRoomMode("listen", "burst", { seated: true })).toBe("burst");
  });
});

describe("walkie: handing a room back", () => {
  it("hands back a seat the walkie itself took", () => {
    expect(shouldReleaseRoom(seat())).toBe(true);
  });

  it("never closes a room the person walked into by hand", () => {
    // The muted lurker in a huddle who uses hold-to-reply. Their seat predates
    // the burst and outlives it — which the engine records by giving a room it
    // finds itself already sitting in the mode `call`, whoever opened it.
    expect(shouldReleaseRoom(seat({ mode: "call" }))).toBe(false);
  });

  it("leaves a room somebody stepped into on purpose alone", () => {
    // Join live was pressed: this is a huddle now, and a huddle is left by
    // hand rather than by a timer running out. The same answer as the line
    // above, and that is the point of one mode rather than two flags — the two
    // situations were never different.
    expect(shouldReleaseRoom(seat({ mode: "call" }))).toBe(false);
  });

  it("hands back a listen whose microphone is open but that nobody joined", () => {
    // THE MUTE USED TO BE THE TEST HERE and it cannot be any more. Auto-listen
    // is hot: every receiver's mic is open for the whole burst, so reading an
    // open mic as "they joined" would refuse this handback on the ordinary
    // listening path — the linger would never expire, the seat would never go
    // back, and the microphone would stay open indefinitely with nothing
    // holding it. `joinedLive` is the only thing that ever really meant a
    // conversation had started, and this is what bounds the hot mic: the
    // burst, plus the half minute an answer might arrive in, then it closes
    // itself.
    expect(shouldReleaseRoom(seat({ mode: "listen" }))).toBe(true);
  });

  it("does not pull the room out from under a burst still in flight", () => {
    expect(shouldReleaseRoom(seat({ bursting: true }))).toBe(false);
    expect(shouldReleaseRoom(seat({ incoming: true }))).toBe(false);
  });

  it("asks what the room IS before anything else", () => {
    // Every other reason to stay is moot once the room is a call: the answer is
    // the same no matter what else is true.
    for (const over of [{ bursting: true }, { incoming: true }, {}]) {
      expect(shouldReleaseRoom(seat({ mode: "call", ...over }))).toBe(false);
    }
  });
});

// ── The seat's one clock ───────────────────────────────────────────────────
//
// This replaced a linger timer, a separate hot-listen ceiling, a `lingerRoomKey`
// and a `ceilingFor`, each of which existed partly to stop one of the others
// going wrong. The whole of it is now one deadline derived from the state, so
// the rule can be read rather than traced, and re-arming is a comparison.

describe("walkie: when the seat stops being worth holding", () => {
  const AUDIO = 1_700_000_000_000;
  const live = (mode: "burst" | "listen" | "call") => ({ key: "dm:a:b", mode, since: AUDIO });
  const at = (over: Partial<Parameters<typeof seatDeadline>[0]> = {}) =>
    seatDeadline({ live: live("burst"), bursting: false, incoming: null, lastAudioAt: AUDIO, ...over });

  it("holds a room for half a minute after the last thing said in it", () => {
    // A burst is one half of a conversation. Leaving at once would send the
    // answer to an empty room.
    expect(at()).toBe(AUDIO + 30_000);
    expect(at({ live: live("listen") })).toBe(AUDIO + 30_000);
    // From the LAST audio, either direction, so a back-and-forth holds the seat
    // for as long as it is a conversation rather than for one fixed half minute.
    expect(at({ lastAudioAt: AUDIO + 12_000 })).toBe(AUDIO + 42_000);
  });

  it("gives a key in hand no clock at all", () => {
    // The hold itself is what holds the room; a deadline here would be a timer
    // racing a person who is still talking.
    expect(at({ bursting: true })).toBeNull();
  });

  it("gives a room somebody stepped into no clock at all", () => {
    // A huddle is left by hand. A timer must never hang one up — which covers
    // both a Join live and a room this client was already sitting in when the
    // key went down, because the engine calls both of them a call.
    expect(at({ live: live("call") })).toBeNull();
  });

  it("bounds a listen by the burst's own age, whatever the server says", () => {
    // THE ONE CLOCK ON THIS PATH. Auto-listen is hot, so a burst holds the
    // receiver's microphone open, and what normally closes it is the server
    // saying the burst is over. That push never comes if the sender's tab dies
    // mid-word: the row stays live forever, the sweep runs only as a side
    // effect of the next burst in that channel, and the query result is
    // byte-identical so nothing wakes. So the receiver counts from the burst's
    // own age instead.
    const opened = AUDIO - 4_000;
    expect(at({ incoming: { createdAt: opened } })).toBe(hotListenDeadline(opened));
    // It outranks the half minute: a burst that is still playing has not
    // finished being said.
    expect(at({ incoming: { createdAt: opened }, lastAudioAt: AUDIO })).toBe(hotListenDeadline(opened));
    // AND IT RUNS INSIDE A CALL TOO. The dead row still has to be cleared
    // there; handing the seat back is `shouldReleaseRoom`'s decision and it
    // refuses, which is what keeps a timer from ending a conversation.
    expect(at({ live: live("call"), incoming: { createdAt: opened } })).toBe(hotListenDeadline(opened));
  });

  it("clears the sender's own cap by a real margin", () => {
    // Stated as a number rather than left implicit: this is the outer bound on
    // any microphone the feature opens without being asked. The sender's cap is
    // the same 120s as the staleness window, so a legitimate two-minute
    // monologue reaches the line at the very moment it stops — and its upload
    // and finalize still have to land after that.
    expect(hotListenDeadline(1_000) - 1_000).toBe(150_000);
    expect(hotListenDeadline(1_000) - 1_000).toBeGreaterThan(120_000);
  });

  it("gives a walkie that is in no room nothing to count", () => {
    expect(at({ live: null })).toBeNull();
  });
});

// ── The meter's calibration ────────────────────────────────────────────────
//
// A meter linear in amplitude spends nearly all of its travel doing nothing,
// because speech is not linear. The numbers below come from the real WAV the
// real-speech run played through the fake microphone: 831 windows of 256
// samples, RMS per window, exactly what the AnalyserNode sees. Quiet talkers
// are that recording scaled down, which is what a soft voice or a far mic is.
//
// What the old `min(1, rms * 4)` did to them, as a share of voiced windows
// landing in each fifth of the meter, and the sweep of a 360-degree ring:
//
//   loud    26/25/31/11/8   ring  28° … 273°
//   quiet   92/8/0/0/0      ring  15° …  70°
//   softer  100/0/0/0/0     ring   9° …  34°   ← the meter is dead
//
// A person talking softly watched a ring that never left its starting point,
// which reads as "the microphone is not working". Under the dB curve the same
// three recordings read 129/244/291, 84/152/194 and 50/104/144.
import { meterLevel } from "../calls/walkie";

describe("meterLevel", () => {
  it("is silent for silence and for a room's noise floor", () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(-1)).toBe(0);
    // -50 dBFS is the bottom of the scale; below it is a room, not a voice.
    expect(meterLevel(0.003)).toBe(0);
  });

  it("pegs only on a shout, and never above 1", () => {
    // -6 dBFS is the top of the scale; 0.5 amplitude IS -6.02 dB, so it
    // arrives a whisker short, and anything louder is clamped.
    expect(meterLevel(0.5)).toBeGreaterThan(0.99);
    expect(meterLevel(0.6)).toBe(1);
    expect(meterLevel(1)).toBe(1);
  });

  it("moves visibly for the valleys between syllables", () => {
    // The dips a talker makes between words. The old scale mapped these to
    // 0.02–0.05 — seven to eighteen degrees of the ring.
    expect(meterLevel(0.005)).toBeGreaterThan(0.08);
    expect(meterLevel(0.0125)).toBeGreaterThan(0.25);
  });

  it("puts an ordinary voice in the upper half without pinning it", () => {
    const ordinary = meterLevel(0.0986); // the real WAV's median voiced window
    expect(ordinary).toBeGreaterThan(0.6);
    expect(ordinary).toBeLessThan(0.85);
  });

  it("gives a soft talker most of the meter, where linear gain gave none", () => {
    // The real WAV at a quarter amplitude: its 10th and 90th percentile
    // voiced windows. Linear gain put BOTH in the bottom fifth.
    expect(meterLevel(0.0102)).toBeGreaterThan(0.2);
    expect(meterLevel(0.0666)).toBeLessThan(0.95);
    expect(meterLevel(0.0666) - meterLevel(0.0102)).toBeGreaterThan(0.25);
  });

  it("rises monotonically, so a louder voice never draws a smaller ring", () => {
    let prev = -1;
    for (const rms of [0, 0.004, 0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 0.9]) {
      const v = meterLevel(rms);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

// The fill-to-lock gesture: a hold that outlives the fill stops being a
// message and becomes a seat. The rules are small and the consequence is an
// open microphone changing what it IS, so both halves are pinned: when a
// completed fill may lock, and where the lock sits in the gesture ladder.
describe("walkie: the fill locking a hold", () => {
  it("locks the burst the fill was timing", () => {
    expect(
      shouldLockBurst({ sending: { roomKey: "dm:a:b" }, joinedRoom: null, roomKey: "dm:a:b" }),
    ).toBe(true);
  });

  it("locks nothing when the burst already landed — a cap or a blur beat the fill", () => {
    expect(shouldLockBurst({ sending: null, joinedRoom: null, roomKey: "dm:a:b" })).toBe(false);
  });

  it("locks nothing when the hold moved to another room under the timer", () => {
    expect(
      shouldLockBurst({ sending: { roomKey: "dm:a:c" }, joinedRoom: null, roomKey: "dm:a:b" }),
    ).toBe(false);
  });

  it("re-locks nothing inside a room that is already a call — hold-to-reply stays a non-event", () => {
    expect(
      shouldLockBurst({ sending: { roomKey: "dm:a:b" }, joinedRoom: "dm:a:b", roomKey: "dm:a:b" }),
    ).toBe(false);
  });

  it("keeps the gesture ladder in order: tap under burst under lock", () => {
    // Release <WALL_TAP_MS is a tap, <MIN_BURST_MS a discarded brush,
    // <WALKIE_LOCK_MS a burst that lands, and past the fill the hold locks.
    // Each meaning needs real room on the clock or one gesture swallows its
    // neighbour.
    expect(WALL_TAP_MS).toBeLessThan(MIN_BURST_MS - 200);
    expect(MIN_BURST_MS).toBeLessThan(WALKIE_LOCK_MS - 200);
  });
});

// The blunt words. Every state the corner card can be in has one loud badge
// and one instruction, and both are pinned here so a surface cannot soften
// them back into a tooltip.
import { walkieStageWords } from "../../hooks/useWalkie";

describe("walkie: the stage words", () => {
  const base = { sending: null, incoming: false, locked: false, muted: true, dropped: false, micDenied: false, name: "Jordan" };

  it("says RECORDING with the release and the lock in one breath", () => {
    const w = walkieStageWords({ ...base, sending: { live: true, heardLive: false } });
    expect(w.stage).toBe("recording");
    expect(w.badge).toBe("RECORDING");
    expect(w.hint).toContain("Release to send");
    expect(w.hint).toContain("keep holding to lock in");
  });

  it("says LIVE only once the room actually carries the voice", () => {
    expect(walkieStageWords({ ...base, sending: { live: true, heardLive: true } }).badge).toBe("LIVE");
    expect(walkieStageWords({ ...base, sending: { live: false, heardLive: false } }).badge).toBe("OPENING MIC");
  });

  it("says ON THE LINE hands free, and names END as the door", () => {
    const w = walkieStageWords({ ...base, locked: true, muted: false });
    expect(w.badge).toBe("ON THE LINE");
    expect(w.hint).toContain("Hands free");
    expect(w.hint).toContain("END");
  });

  it("muted on the line is said first, because it flips every other promise", () => {
    const w = walkieStageWords({ ...base, locked: true, muted: true });
    expect(w.badge).toContain("MUTED");
    expect(w.hint).toContain("cannot hear you");
  });

  it("an incoming voice lists all three answers", () => {
    const w = walkieStageWords({ ...base, incoming: true });
    expect(w.badge).toBe("INCOMING");
    for (const word of ["HOLD", "JOIN LIVE", "SNOOZE"]) expect(w.hint).toContain(word);
  });

  it("bad news first: a dropped room outranks everything", () => {
    const w = walkieStageWords({ ...base, sending: { live: true, heardLive: true }, incoming: true, dropped: true });
    expect(w.badge).toBe("NOT HEARD");
  });

  it("a denied mic is said as a state, not hidden in a sentence", () => {
    expect(walkieStageWords({ ...base, micDenied: true }).badge).toBe("MIC OFF");
  });
});
