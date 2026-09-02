// The order a burst does things in, which is the difference between a walkie
// that works and one that answers every hold with "no words".
//
// It used to join the LiveKit room FIRST and take whatever track came back:
// a control-plane round trip, a token mint and an SFU connect — measured at
// 1.0s into a warm room and 12.7s into a cold one — before the recorder or the
// recognizer existed. Everything said in that gap reached nobody and landed in
// no recording, and a three second burst is mostly that gap.
//
// So these tests are about sequence, not about audio. The microphone comes
// first, what keeps the words comes second, and the room comes last and off to
// one side — a release that beats it still lands a complete message.

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { useInboxStore } from "../../store/inboxStore";

// ── the world the engine talks to ──────────────────────────────────────────

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e?: any) => void };
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Mocked as FAITHFUL STAND-INS, never as stubs: `mock.module` replaces a module
// for the whole test process, and bun loads every test file before it runs any
// of them — so a partial replacement of a widely imported module breaks other
// files' tests, wherever they sit in the alphabet. Each one below therefore
// spreads the real module and overrides only what this file drives.

const realCallManager = await import("../calls/callManager");
const realAsrPipe = await import("../calls/asrPipe");

/** The room join, held open so a test can ask what happened while it was still
 *  in flight — which is the whole question. */
let joining: Deferred<void>;
let joinCalls: Array<{ roomKey: string; micTrack?: MediaStreamTrack; intent?: string }> = [];
/** Whether the join OPENS THE MICROPHONE the way the real one does. Off for
 *  every test that is about sequence, so the counts above stay arithmetic; on
 *  for the ones about a device that refuses, where the whole question is what
 *  the real rule does with the failure — so it runs the real
 *  `openMicForJoin` against a participant that asks the fake browser, rather
 *  than a description of it. */
let micOnJoin = false;
/** Counted, not replaced. Leaving is what a guest burst must never do, and the
 *  real leave is what the ownership tests above watch the seat disappear
 *  through — so this records the call and then does exactly what it did. */
let leaveCalls = 0;
// Captured BEFORE the module is mocked. `mock.module` patches the live module
// record, so reading `realCallManager.leaveCall` at call time would find this
// wrapper again and recurse forever.
const trueLeaveCall = realCallManager.leaveCall;

/** A microphone already publishing into the room this client is sitting in.
 *  Null unless a test is about hold-to-reply inside a room that is really
 *  connected, which is the only case where the burst has one to borrow. */
let seatedMic: any = null;

mock.module("../calls/callManager", () => ({
  ...realCallManager,
  getRoom: () =>
    seatedMic
      ? { localParticipant: { getTrackPublication: () => ({ track: { mediaStreamTrack: seatedMic } }) } }
      : null,
  joinCall: async (roomKey: string, opts?: { micTrack?: MediaStreamTrack; intent?: string }) => {
    joinCalls.push({ roomKey, micTrack: opts?.micTrack, intent: opts?.intent });
    // A join handed a track publishes THAT one and opens no device; only a
    // join without one reaches for the microphone.
    if (micOnJoin && !opts?.micTrack) {
      await realCallManager.openMicForJoin(
        {
          setMicrophoneEnabled: async (on: boolean) => {
            if (on) await (globalThis as any).navigator.mediaDevices.getUserMedia({ audio: true });
          },
        },
        { intent: opts?.intent as any },
      );
    }
    return joining.promise;
  },
  leaveCall: () => {
    leaveCalls++;
    return trueLeaveCall();
  },
  // Recorded as well as applied. The release's mute is the seam the founder
  // feels — a key coming up must not close a microphone inside a call — and
  // reading the store afterwards cannot tell "never muted" apart from "muted
  // and unmuted again by something else in the same tick".
  setMuted: async (muted: boolean) => {
    muteCalls.push(muted);
    useInboxStore.getState().setCallState({ muted });
  },
}));

let muteCalls: boolean[] = [];

/** The recognizer, reduced to the three things the engine asks of it. */
type FakePipe = {
  finished: boolean;
  closed: boolean;
  finishing: Deferred<void>;
  events: any;
};
let pipes: FakePipe[] = [];

mock.module("../calls/asrPipe", () => ({
  ...realAsrPipe,
  openAsrPipe: (opts: any) => {
    const pipe: FakePipe = { finished: false, closed: false, finishing: defer<void>(), events: opts.events };
    pipes.push(pipe);
    return {
      get speaking() {
        return false;
      },
      finish: () => {
        pipe.finished = true;
        return pipe.finishing.promise;
      },
      close: () => {
        pipe.closed = true;
      },
    };
  },
}));

/** The sounds, recorded rather than played. They are the half of this feature
 *  that never appears in a screenshot, and each one is pinned to an exact
 *  moment in the burst — the chirp to the microphone opening, the roger to the
 *  key coming up, the squelch to a teammate's burst ending — so a change of
 *  ordering in the engine cannot quietly move them somewhere less true. */
const realSounds = await import("../sounds");
const soundLog: string[] = [];

mock.module("../sounds", () => ({
  ...realSounds,
  soundWalkieKeyUp: () => void soundLog.push("keyUp"),
  soundWalkieRoger: () => void soundLog.push("roger"),
  soundWalkieSquelch: () => void soundLog.push("squelch"),
  soundWalkieOpen: () => void soundLog.push("open"),
  soundWalkieJoined: () => void soundLog.push("joined"),
  soundWalkieAway: () => void soundLog.push("away"),
}));

const walkie = await import("../calls/walkie");
// The real surface lookup, not a copy of it, so the question asked below is the
// one the app asks.
const { callDockSurface, walkieStripState } = await import("../../hooks/useWalkie");
const { announceJoin, clearJoinAnnouncement, getJoinAnnouncement } = await import("../calls/joinAnnounce");

// ── the browser ────────────────────────────────────────────────────────────

let recorders: FakeRecorder[] = [];

class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, _opts?: unknown) {
    recorders.push(this);
  }
  start() {
    this.state = "recording";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

let micTracks: any[] = [];
function fakeTrack(): any {
  const track = {
    readyState: "live",
    stop() {
      track.readyState = "ended";
    },
    clone: () => fakeTrack(),
  };
  micTracks.push(track);
  return track;
}

let getUserMediaCalls = 0;
let permissionState = "granted";
let clock = 1_700_000_000_000;
const realNow = Date.now;

beforeEach(() => {
  joinCalls = [];
  seatedMic = null;
  micOnJoin = false;
  leaveCalls = 0;
  pipes = [];
  recorders = [];
  micTracks = [];
  muteCalls = [];
  getUserMediaCalls = 0;
  permissionState = "granted";
  joining = defer<void>();
  S().setCallState({ roomKey: null, phase: "idle", muted: true, micDenied: false, error: null });
  clock = 1_700_000_000_000;
  Date.now = () => clock;

  // The real upload path, answered rather than replaced: uploadBlobToStorage
  // mints a URL through convex and POSTs the bytes, and both halves are worth
  // exercising — a burst's recording only exists if that round trip works.
  (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ storageId: "storage-1" }) });

  (globalThis as any).MediaRecorder = FakeRecorder;
  (globalThis as any).MediaStream = class {
    constructor(public tracks: unknown[]) {}
  };
  (globalThis as any).AudioContext = class {
    resume = () => Promise.resolve();
    createAnalyser = () => ({ fftSize: 256, smoothingTimeConstant: 0, getByteTimeDomainData: () => {} });
    createMediaStreamSource = () => ({ connect() {} });
    close = () => Promise.resolve();
  };
  (globalThis as any).requestAnimationFrame = () => 1;
  (globalThis as any).navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        getUserMediaCalls++;
        const track = fakeTrack();
        return { getAudioTracks: () => [track] };
      },
    },
    permissions: { query: async () => ({ state: permissionState }) },
  };
});

afterEach(async () => {
  // Never leave a mic open between tests — that is the feature's worst failure,
  // and a burst left in flight would also make the next test's counts lie. The
  // release has to be unblocked as it goes: it waits on the recognizer's finish
  // and on nothing else, exactly as a real one does.
  const releasing = walkie.endBurst().catch(() => {});
  for (const p of pipes) p.finishing.resolve();
  joining.resolve();
  await releasing;
  // The engine holds its microphone for a minute after a burst. Ending the
  // tracks is what the idle release eventually does, and it is what keeps one
  // test's warm mic out of the next test's arithmetic.
  for (const t of micTracks) t.stop();
  Date.now = realNow;
});

// ── the convex client ──────────────────────────────────────────────────────

const mutations: Array<{ name: string; args: any }> = [];
function bind(opts: { onFinalize?: () => void; onMutation?: (name: string) => void } = {}) {
  const convex = {
    action: async () => null,
    mutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      mutations.push({ name, args });
      opts.onMutation?.(name);
      if (name === "images:generateUploadUrl") return "https://storage.test/upload";
      if (name === "chat:finalizeVoiceBurst") opts.onFinalize?.();
      return { message_id: "msg-1" };
    },
  };
  walkie.bindWalkie(convex as any);
  return convex;
}

const finalize = () => mutations.find((m) => m.name === "chat:finalizeVoiceBurst");

/** The store, read for real: the burst's own bubble is store state, so the
 *  honest question is what the channel now holds, not which method was called. */
const S = () => useInboxStore.getState();
/** The row id the burst is painting its bubble under, while it is still up. */
const bubbleId = () => walkie.getWalkieStatus().sending!.clientId;

/** Let every already-settled promise in the release path run. The release
 *  awaits the setup, then the recorder's stop, before it reaches the recognizer,
 *  and a test that asks "what has happened by now" has to let those through. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Let the key up and let the recognizer answer its commit, which is what a
 *  real release waits for. Tests that are ABOUT that wait drive it by hand. */
async function release() {
  const releasing = walkie.endBurst();
  for (const p of pipes) p.finishing.resolve();
  await releasing;
}

beforeEach(() => {
  mutations.length = 0;
  bind();
});

// Ordered FIRST on purpose. `micGranted` is a fact about the tab, not about a
// test: once a real press has been allowed, warming can never prompt again, so
// the no-prompt rule can only be proven before anything has been granted.
describe("walkie: pre-warming the microphone", () => {
  test("stays quiet where the browser cannot say whether it would prompt", async () => {
    (globalThis as any).navigator.permissions.query = async () => {
      throw new Error("microphone is not a queryable permission here");
    };
    await walkie.warmMic();
    expect(getUserMediaCalls).toBe(0);
  });

  test("NEVER prompts: a pointer passing over a button may not raise a permission dialog", async () => {
    permissionState = "prompt";
    await walkie.warmMic();
    expect(getUserMediaCalls).toBe(0);

    permissionState = "denied";
    await walkie.warmMic();
    expect(getUserMediaCalls).toBe(0);

    // A real press is the only thing allowed to ask.
    await walkie.startBurst("chan-1", "dm:a:b");
    expect(getUserMediaCalls).toBe(1);
  });

  test("opens it ahead of the press when permission is already granted", async () => {
    await walkie.warmMic();
    expect(getUserMediaCalls).toBe(1);
    // And the press that follows spends nothing on it.
    await walkie.startBurst("chan-1", "dm:a:b");
    expect(getUserMediaCalls).toBe(1);
  });
});

describe("walkie: what happens before the room", () => {
  test("the microphone, the recorder and the recognizer are all running while the join is still in flight", async () => {
    await walkie.startBurst("chan-1", "dm:a:b");

    // The join was ASKED for and has not answered.
    expect(joinCalls.length).toBe(1);
    expect(joinCalls[0].roomKey).toBe("dm:a:b");
    // Everything that keeps the words is already going.
    expect(getUserMediaCalls).toBe(1);
    expect(recorders[0]?.state).toBe("recording");
    expect(pipes.length).toBe(1);

    const sending = walkie.getWalkieStatus().sending!;
    // Live: the words are being kept. Not yet heard live: the room has not
    // answered, so nobody is listening in real time — two different claims,
    // and the old status could only make the second one.
    expect(sending.live).toBe(true);
    expect(sending.heardLive).toBe(false);
  });

  test("the room is handed a CLONE, so a call that ends cannot cut the recording short", async () => {
    await walkie.startBurst("chan-1", "dm:a:b");
    const published = joinCalls[0].micTrack as any;
    expect(published).toBeTruthy();
    expect(published).not.toBe(micTracks[0]);
  });

  test("the burst says it is heard live only once the join lands", async () => {
    await walkie.startBurst("chan-1", "dm:a:b");
    expect(walkie.getWalkieStatus().sending?.heardLive).toBe(false);

    S().setCallState({ roomKey: "dm:a:b", phase: "connected" });
    joining.resolve();
    await joining.promise;
    await Promise.resolve();
    expect(walkie.getWalkieStatus().sending?.heardLive).toBe(true);
  });

  test("a second press reuses the warm microphone instead of opening a new one", async () => {
    await walkie.startBurst("chan-1", "dm:a:b");
    clock += 2_000;
    await release();
    joining.resolve();

    joining = defer<void>();
    await walkie.startBurst("chan-1", "dm:a:b");
    expect(getUserMediaCalls).toBe(1);
  });
});

describe("walkie: releasing before the room ever answered", () => {
  test("the burst still lands, with its recording and its words", async () => {
    await walkie.startBurst("chan-1", "dm:a:b");
    const id = bubbleId();
    // Words heard while the room was still connecting — the ones that used to
    // be lost entirely.
    pipes[0].events.onUtterance({ text: "back in five", t0: 0, t1: 1 });
    clock += 2_000;

    const releasing = walkie.endBurst();
    pipes[0].finishing.resolve();
    await releasing;

    // The join never answered, and it did not matter.
    expect(joinCalls.length).toBe(1);
    const landed = finalize();
    expect(landed?.args.content).toBe("back in five");
    expect(landed?.args.attachments?.[0]?.storage_id).toBe("storage-1");
    // And the sender's own bubble says the same thing without a round trip.
    expect(S().chatMessages[id]?.content).toBe("back in five");
    expect(S().chatMessages[id]?.voice?.status).toBe("done");
  });

  test("the recognizer is asked to finish BEFORE the message is finalized", async () => {
    const order: string[] = [];
    mutations.length = 0;
    bind({ onFinalize: () => order.push("finalize") });
    await walkie.startBurst("chan-1", "dm:a:b");
    clock += 2_000;

    const releasing = walkie.endBurst();
    await settle();
    // Finish was asked for and has not answered, so nothing has been finalized:
    // closing the recognizer at release without waiting is what threw away the
    // last sentence, which on a short burst is the whole message.
    expect(pipes[0].finished).toBe(true);
    expect(order).toEqual([]);

    order.push("finish");
    pipes[0].finishing.resolve();
    await releasing;
    expect(order).toEqual(["finish", "finalize"]);
  });

  test("words that only arrive during the finish still reach the message", async () => {
    await walkie.startBurst("chan-1", "dm:a:b");
    clock += 2_000;
    const releasing = walkie.endBurst();
    await settle();
    // The commit's answer, coming back after the hand came off the key.
    pipes[0].events.onUtterance({ text: "on my way", t0: 0, t1: 1 });
    pipes[0].finishing.resolve();
    await releasing;
    expect(finalize()?.args.content).toBe("on my way");
  });

  test("a brushed key is still thrown away, whatever the room was doing", async () => {
    await walkie.startBurst("chan-1", "dm:a:b");
    const id = bubbleId();
    // The bubble was on screen from the press — a voice message is a message,
    // and a message never waits for a round trip to appear.
    expect(S().chatMessages[id]).toBeTruthy();
    clock += 100;
    const releasing = walkie.endBurst();
    pipes[0].finishing.resolve();
    await releasing;
    expect(finalize()).toBeUndefined();
    expect(S().chatMessages[id]).toBeUndefined();
  });
});

// ── who is holding the room, at every instant ──────────────────────────────
//
// The walkie and the ordinary call dock are two surfaces for one room, and
// exactly one of them is right at any moment. The answer is `liveRoom`: it is
// claimed at the press and dropped only once the seat has genuinely gone, so a
// synchronous push in which this client is seated with no live room is a push
// in which the call dock takes over a room the walkie has not let go of.
//
// It was real, back when that answer was assembled from three separate fields.
// The linger began after the audio upload and the finalize round trip, both of
// which happen after the burst is cleared — measured in the browser at 861ms
// with a ten second recording: a floating call window, or the full stage,
// appearing by itself a beat after the person stopped talking.
//
// ONE SURFACE IS ALLOWED TO BE NOTHING. Since talk became click-to-start and
// click-to-stop (Sep 1), the sender's OWN seat lingering after their talk ended
// draws no card at all — Stop means the card goes — while the room stays open a
// moment so an answer arrives fast. That quiet seat is `liveRoom` in burst mode
// with nobody sending and nobody incoming, and `callDockSurface` answers "none"
// for it on purpose. It is the opposite of the defect above: the ordinary dock
// did not take the room, nothing did. So the watcher accepts exactly that shape
// and still fails on "dock" or "stage" over a room the walkie holds.

describe("walkie: who is holding the room after the key comes up", () => {
  /** The room answering, exactly as the real joinCall leaves the call plane. */
  async function roomAnswers() {
    joining.resolve();
    S().setCallState({ roomKey: "dm:a:b", phase: "connected", muted: false });
    await settle();
  }

  /**
   * Watch the surface on EVERY status the engine publishes, which is what a
   * subscribed component sees. A lapse lasting one synchronous push is
   * invisible to any test that reads the settled state afterwards, and one push
   * is exactly the size these bugs come in.
   *
   * Judged only while SEATED, because a seat is the only thing the ordinary
   * call dock can take. Before the room answers there is nothing to lose, and
   * once the seat is gone the surface is "none" whatever the walkie thinks.
   */
  function watchOwnership() {
    const lapses: string[] = [];
    const off = walkie.subscribeWalkie(() => {
      const s = walkie.getWalkieStatus();
      const call = S().call as any;
      const seated =
        call.roomKey === "dm:a:b" && (call.phase === "connected" || call.phase === "connecting");
      if (!seated) return;
      // Both halves of the same claim: the engine says it is in this room as a
      // burst, and the lookup that reads it says the strip. Neither alone would
      // catch a live room whose mode had drifted.
      const held = s.liveRoom?.key === call.roomKey && s.liveRoom.mode !== "call";
      const surface = callDockSurface(s, { roomKey: call.roomKey, phase: call.phase }, { expanded: false });
      // My own seat, quiet after Stop: no card is the design, not a lapse.
      const quietOwnSeat =
        surface === "none" && !s.sending && !s.incoming && s.liveRoom?.mode === "burst";
      if (!held || (surface !== "walkie" && !quietOwnSeat)) {
        lapses.push(
          JSON.stringify({
            sending: !!s.sending,
            incoming: !!s.incoming,
            liveRoom: s.liveRoom,
            surface,
            phase: call.phase,
          }),
        );
      }
    });
    return { lapses, off };
  }

  test("the room is still the walkie's while the upload runs, not only once it finishes", async () => {
    const heldAt: Record<string, string | null> = {};
    mutations.length = 0;
    bind({
      onMutation: (name) => void (heldAt[name] = walkie.getWalkieStatus().liveRoom?.key ?? null),
    });
    await walkie.startBurst("chan-1", "dm:a:b");
    await roomAnswers();
    clock += 2_000;
    await release();

    // The upload is the first network call after the burst is cleared, and it
    // is the long one — it carries the recording. The room must already be the
    // walkie's by then.
    expect(heldAt["images:generateUploadUrl"]).toBe("dm:a:b");
    expect(heldAt["chat:finalizeVoiceBurst"]).toBe("dm:a:b");
    expect(walkie.getWalkieStatus().liveRoom?.key).toBe("dm:a:b");
  });

  test("NO SINGLE PUSH ever shows the room without an owner", async () => {
    const { lapses, off } = watchOwnership();

    await walkie.startBurst("chan-1", "dm:a:b");
    await roomAnswers();
    clock += 2_000;
    await release();

    // AND STRAIGHT INTO A SECOND PRESS, which is the press side of the same
    // defect: starting a burst used to drop the linger BEFORE publishing the
    // burst, so answering somebody inside that half minute put one ownerless
    // push on the wire. The whole span from the first press to the second
    // release is judged by one watcher, because that is the span the founder
    // holds the key across.
    expect(walkie.getWalkieStatus().liveRoom?.key).toBe("dm:a:b");
    clock += 1_000;
    await walkie.startBurst("chan-1", "dm:a:b");
    clock += 2_000;
    await release();
    off();

    expect(lapses).toEqual([]);
  });

  // A BRUSHED KEY IS THE OTHER BRANCH, and the first round of this fix left it
  // uninstrumented — the tests above only ever exercised a burst that lands.
  // A brush hands the room back instead of holding it, and handing back is
  // async: `leaveCall` awaits the scribe before `call.phase` moves. So the
  // brush had to be watched at BOTH timings, because they are different code
  // paths through `shouldReleaseRoom`: before the room answers there is no seat
  // to lose, and after it answers there is.
  for (const when of ["before the room answers", "after the room answers"] as const) {
    test(`a brushed key ${when} never leaves the room ownerless`, async () => {
      const { lapses, off } = watchOwnership();
      await walkie.startBurst("chan-1", "dm:a:b");
      if (when === "after the room answers") await roomAnswers();
      clock += 100;
      await release();
      off();

      expect(finalize()).toBeUndefined();
      expect(lapses).toEqual([]);
    });
  }

  // THE GUEST BRUSH, which is the one way this fix could have gone wrong.
  //
  // `abandonRoom` hands a room back, and the whole point of the discard branch
  // is that it does so promptly. But the room a burst is spoken into may be a
  // huddle the person was ALREADY sitting in — the dm: room of a 1:1 call is
  // the very room a burst to that person opens. Handing that one back would
  // hang up a live conversation because somebody brushed a key.
  //
  // The seat itself decides it: a room this client was already sitting in when
  // the key went down IS a call, whoever opened it, so `shouldReleaseRoom`
  // refuses. This pins that the refusal survives the reordering — no leave, and
  // the person is still in their call afterwards.
  test("a brushed key inside a huddle the person joined never takes their seat", async () => {
    // Seated first, and not by the walkie.
    S().setCallState({ roomKey: "dm:a:b", phase: "connected", muted: false });
    joining.resolve();
    await settle();
    leaveCalls = 0;

    await walkie.startBurst("chan-1", "dm:a:b");
    clock += 100;
    await release();

    // Still a brush: the row is gone and nothing was finalized.
    expect(finalize()).toBeUndefined();
    // But the huddle is untouched. A guest never announces a hand-back and
    // never performs one.
    expect(leaveCalls).toBe(0);
    expect(walkie.getWalkieStatus().liveRoom?.mode).toBe("call");
    expect((S().call as any).phase).toBe("connected");
    expect((S().call as any).roomKey).toBe("dm:a:b");
  });

  test("a brushed key never holds the room open at all", async () => {
    // A key nobody meant to press used to seat both people in a call room for
    // thirty seconds under a strip claiming a conversation was open, and the
    // first attempt at the fix armed the hold and took it back a round trip
    // later — the same lie for a shorter time. The seat goes back inside the
    // release now, so there is no room left for a deadline to run against.
    await walkie.startBurst("chan-1", "dm:a:b");
    await roomAnswers();
    clock += 100;
    await release();
    expect(finalize()).toBeUndefined();
    expect(walkie.getWalkieStatus().liveRoom).toBeNull();
    expect(
      walkie.seatDeadline({ live: null, bursting: false, incoming: null, lastAudioAt: clock }),
    ).toBeNull();
    expect(leaveCalls).toBeGreaterThan(0);
  });
});

describe("walkie: a recognizer that is down", () => {
  test("says so, and the burst lands anyway", async () => {
    await walkie.startBurst("chan-1", "dm:a:b");
    expect(walkie.getWalkieStatus().asr).toBe("live");

    pipes[0].events.onFailed("Transcription is not configured");
    expect(walkie.getWalkieStatus().asr).toBe("unavailable");

    clock += 2_000;
    const releasing = walkie.endBurst();
    pipes[0].finishing.resolve();
    await releasing;
    // No words, but the recording is a message — and the server transcribes it.
    const landed = finalize();
    expect(landed?.args.content).toBe("");
    expect(landed?.args.attachments?.[0]?.storage_id).toBe("storage-1");
  });

  test("the next press starts hopeful again", async () => {
    await walkie.startBurst("chan-1", "dm:a:b");
    pipes[0].events.onDropped();
    expect(walkie.getWalkieStatus().asr).toBe("unavailable");
    clock += 2_000;
    await release();
    joining.resolve();

    joining = defer<void>();
    await walkie.startBurst("chan-1", "dm:a:b");
    expect(walkie.getWalkieStatus().asr).toBe("live");
  });
});

describe("walkie: the live transcript", () => {
  test("a partial shows after the words already committed, and is replaced, not appended", async () => {
    await walkie.startBurst("chan-1", "dm:a:b");
    const events = pipes[0].events;
    const words = () => walkie.getWalkieStatus().sending?.transcript;

    events.onUtterance({ text: "hey", t0: 0, t1: 1 });
    expect(words()).toBe("hey");

    events.onPartial("are you");
    expect(words()).toBe("hey are you");
    events.onPartial("are you around");
    expect(words()).toBe("hey are you around");

    // The sentence closes: the recognizer's own version wins, and the trailing
    // partial does not linger as a duplicate.
    events.onPartial("");
    events.onUtterance({ text: "are you around?", t0: 0, t1: 1 });
    expect(words()).toBe("hey are you around?");
  });
});

// ── what a hold SOUNDS like ────────────────────────────────────────────────
//
// The founder's complaint was "not enough sound / feedback". A push-to-talk key
// is held while the person is looking at what they are about to talk about, not
// at the key, so sound is the only channel that reaches them — which makes WHEN
// each one plays a correctness question and not a taste one. A chirp that plays
// on the press rather than on the microphone opening tells somebody to start
// speaking into a device that is not listening yet.

describe("walkie: the sounds, and the moments they belong to", () => {
  beforeEach(() => {
    soundLog.length = 0;
  });

  test("the chirp marks the MICROPHONE opening, not the room answering", async () => {
    await walkie.startBurst("chan-1", "dm:a:b");
    // The join is still in flight — `joining` is deferred and nothing below
    // resolves it — so this is exactly the window that used to be silent, and
    // the one in which the person is already talking.
    expect(joinCalls.length).toBe(1);
    expect(walkie.getWalkieStatus().sending?.heardLive).toBe(false);
    expect(soundLog).toEqual(["keyUp"]);
  });

  test("the roger signs off the burst on release", async () => {
    await walkie.startBurst("chan-1", "dm:a:b");
    clock += 2_000;
    soundLog.length = 0;
    await release();
    expect(soundLog).toEqual(["roger"]);
  });

  test("the roger signs off ONCE, however many times release arrives", async () => {
    // `endBurst` promises it is safe to call twice, and the max-length cap is
    // the caller that makes it true: the cap releases the key itself without
    // touching the hook's `held` flag, so the hand coming off it afterwards
    // releases again. Everything else in endBurst honours that through
    // `b.done` — which is only set past an await, so the SOUND, which sits in
    // front of that await, beeped a second time for a burst already sent.
    // Measured in a browser: two calls in the same tick both beeped, and
    // guarding on `!b.done` did not help. The claim has to be synchronous.
    await walkie.startBurst("chan-1", "dm:a:b");
    clock += 2_000;
    soundLog.length = 0;
    const first = walkie.endBurst();
    const second = walkie.endBurst();
    // The pipe's finish() is deferred in this harness; release() resolves it,
    // and both calls are waiting on the same one.
    for (const p of pipes) p.finishing.resolve();
    await Promise.all([first, second]);
    expect(soundLog.filter((s) => s === "roger")).toEqual(["roger"]);
  });

  test("a press that never got a microphone makes no sound at either end", async () => {
    // A denied or missing device is a burst that never happened. A chirp would
    // say the mic was open and a roger would sign off a message that is about
    // to be thrown away — both are lies, and the toast is the honest answer.
    (globalThis as any).navigator.mediaDevices.getUserMedia = async () => {
      throw new Error("NotAllowedError");
    };
    await walkie.startBurst("chan-1", "dm:a:b");
    await settle();
    await walkie.endBurst();
    expect(soundLog).toEqual([]);
  });

  test("a teammate's burst opens with a chirp and closes with a squelch tail", async () => {
    const burst = {
      messageId: "m-in",
      channelId: "chan-2",
      roomKey: "dm:b:c",
      fromUserId: "u-sam",
      fromName: "Sam",
      createdAt: clock - 500,
    };
    walkie.observeWalkie({ bursts: [burst], doorOpen: true });
    expect(soundLog).toEqual(["open"]);
    expect(walkie.getWalkieStatus().incoming?.fromName).toBe("Sam");

    // Their key comes up after a real sentence.
    clock += 3_000;
    walkie.observeWalkie({ bursts: [], doorOpen: true });
    expect(soundLog).toEqual(["open", "squelch"]);
    expect(walkie.getWalkieStatus().incoming).toBeNull();
  });

  test("a key somebody brushed is silent at BOTH ends, not just the first", async () => {
    // Under the threshold nothing was said, and the listening side already
    // refuses to hold the room open for it. A squelch tail there would punctuate
    // a sentence that never existed.
    const burst = {
      messageId: "m-brush",
      channelId: "chan-2",
      roomKey: "dm:b:c",
      fromUserId: "u-sam",
      fromName: "Sam",
      createdAt: clock,
    };
    walkie.observeWalkie({ bursts: [burst], doorOpen: true });
    soundLog.length = 0;
    clock += 100;
    walkie.observeWalkie({ bursts: [], doorOpen: true });
    expect(soundLog).toEqual([]);
  });
});

// ── the hot listen's ceiling ───────────────────────────────────────────────
//
// Auto-listen joins UNMUTED, so a burst holds this person's microphone open.
// Everything that closes it again runs on a server push — and there is a real
// case with no pushes at all in it: the sender's tab dies mid-word.
//
// The row stays `voice.status: "live"`. The server sweep is not a cron; it
// runs as a side effect of the next burst in that channel, and nobody is
// coming back to talk. `chat.listLiveVoiceBursts` returns only ids, sender,
// room and created_at — every one frozen for the life of a burst, deliberately,
// so the transcript cannot re-push it to every watcher — so the result stays
// byte-identical and the client is never woken. That last fact is what makes
// the ceiling a CEILING rather than a heartbeat: during a healthy burst there
// are no pushes to refresh it with either.
describe("walkie: the hot listen cannot outlive the burst", () => {
  const ROOM = "dm:ceiling:test";
  const burstRow = (over: Record<string, unknown> = {}) => ({
    messageId: "m-ceiling",
    channelId: "chan-ceiling",
    roomKey: ROOM,
    fromUserId: "u-riley",
    fromName: "Riley",
    createdAt: clock,
    ...over,
  });

  /** What the real joinCall writes when it lands, which the mocked one does
   *  not: without a seat there is no seat to hand back, and every question the
   *  release path asks would answer "not ours". */
  function seatLanded() {
    S().setCallState({ roomKey: ROOM, phase: "connected", muted: false });
  }

  /** Move the world and the timers together. The engine reads `Date.now`
   *  (mocked to `clock`) to judge staleness and schedules against it, so a test
   *  that advanced only one of the two would be testing neither. */
  async function passTime(ms: number) {
    clock += ms;
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  }

  test("the sender's tab dies mid-burst: the microphone still closes", async () => {
    jest.useFakeTimers();
    Date.now = () => clock;
    try {
      walkie.observeWalkie({ bursts: [burstRow()], doorOpen: true });
      seatLanded();
      // The bargain as shipped: hearing someone means they can hear you.
      expect(S().call.muted).toBe(false);
      expect(joinCalls.at(-1)?.roomKey).toBe(ROOM);

      // Now nothing happens. No finalize, no cancel, no sweep, no push — the
      // exact silence a crashed tab leaves behind.
      await passTime(200_000);

      expect(S().call.muted).toBe(true);
      expect(S().call.phase).toBe("idle");
      expect(leaveCalls).toBeGreaterThan(0);
      expect(walkie.getWalkieStatus().incoming).toBeNull();
    } finally {
      jest.useRealTimers();
      Date.now = () => clock;
    }
  });

  test("a stale burst goes back at once, with no half minute of open mic", async () => {
    // The linger exists so an answer can follow a sentence. A burst nobody
    // ended is a tab that died, so there is no sentence and nobody to answer:
    // holding the room another thirty seconds would just be thirty more
    // seconds of open microphone.
    jest.useFakeTimers();
    Date.now = () => clock;
    try {
      walkie.observeWalkie({ bursts: [burstRow()], doorOpen: true });
      seatLanded();
      await passTime(160_000);
      expect(S().call.phase).toBe("idle");
      expect(walkie.getWalkieStatus().liveRoom).toBeNull();
    } finally {
      jest.useRealTimers();
      Date.now = () => clock;
    }
  });

  test("an honest two-minute monologue is never cut off, and still ends bounded", async () => {
    // The sender's own cap is 120s, the same number the staleness window uses,
    // so a full-length hold reaches the line at the very instant it stops —
    // and its upload and finalize still have to land after that. The slack is
    // what stops the ceiling taking the last word off an honest burst.
    //
    // Both halves in one test on purpose. A ceiling that fires early is a bug,
    // and so is one that gives up after firing early: `applyReport` re-arms
    // whatever it does not resolve, and this is what proves it.
    jest.useFakeTimers();
    Date.now = () => clock;
    try {
      walkie.observeWalkie({ bursts: [burstRow()], doorOpen: true });
      seatLanded();
      await passTime(119_000);
      expect(S().call.muted).toBe(false);
      expect(S().call.phase).toBe("connected");
      expect(leaveCalls).toBe(0);
      expect(walkie.getWalkieStatus().incoming?.messageId).toBe("m-ceiling");

      await passTime(41_000);
      expect(S().call.muted).toBe(true);
      expect(S().call.phase).toBe("idle");
    } finally {
      jest.useRealTimers();
      Date.now = () => clock;
    }
  });

  test("somebody who stepped in keeps their seat when the ceiling fires", async () => {
    // The ceiling fires here too — the burst really is over and saying so is
    // right — but handing the room back is `shouldReleaseRoom`'s call, and it
    // refuses for a room somebody chose to be in. A timer must never hang up a
    // call.
    jest.useFakeTimers();
    Date.now = () => clock;
    try {
      walkie.observeWalkie({ bursts: [burstRow()], doorOpen: true });
      seatLanded();
      walkie.markWalkieUpgraded(ROOM);
      await passTime(200_000);
      expect(S().call.phase).toBe("connected");
      expect(S().call.muted).toBe(false);
      expect(leaveCalls).toBe(0);
      // And the dead burst is still cleared, because it is still dead.
      expect(walkie.getWalkieStatus().incoming).toBeNull();
    } finally {
      jest.useRealTimers();
      Date.now = () => clock;
      // Retire the stamp the way the app does — the call ending is what clears
      // it — so it cannot leak into the next test's arithmetic.
      S().setCallState({ roomKey: null, phase: "idle", muted: true });
      walkie.refreshWalkie();
      expect(walkie.getWalkieStatus().liveRoom).toBeNull();
    }
  });

  test("the deadline clears the sender's cap by a real margin", () => {
    // Stated as a number rather than left implicit: this is the outer bound on
    // any microphone the feature opens without being asked.
    const deadline = walkie.hotListenDeadline(1_000);
    expect(deadline - 1_000).toBe(150_000);
    expect(deadline - 1_000).toBeGreaterThan(120_000);
  });
});

// ── the release, once the burst has become a call ───────────────────────────
//
// THE SEAM THE FOUNDER FEELS. A burst and a call are the same room, so the
// upgrade adds no machinery — but the release still ran the walkie's own
// ending over the top of it: `setMuted(true)`, because the microphone belongs
// to the hold, and the roger, because a message had been sent. Neither is true
// once somebody has stepped in. The person carried on speaking into a mic that
// had just closed under them, and heard themselves signed off mid-sentence.
describe("walkie: letting go inside a call", () => {
  const ROOM = "dm:upgrade:release";

  /** A held key, published into a room this client is seated in. */
  async function holdInto(room: string) {
    await walkie.startBurst("chan-1", room);
    S().setCallState({ roomKey: room, phase: "connected", muted: false });
    joining.resolve();
    await settle();
    clock += 2_000;
  }

  /** Put the stamp back the way the app does — the call ending clears it — so
   *  one test's upgrade cannot decide the next one's release. */
  function retire() {
    S().setCallState({ roomKey: null, phase: "idle", muted: true });
    walkie.refreshWalkie();
  }

  test("the key coming up leaves the microphone open", async () => {
    await holdInto(ROOM);
    walkie.markWalkieUpgraded(ROOM);
    muteCalls.length = 0;
    try {
      await release();
      await settle();
      // Not "the store says unmuted" — never asked for at all. The two are
      // different claims and only this one survives something else unmuting
      // in the same tick.
      expect(muteCalls).not.toContain(true);
      expect(S().call.muted).toBe(false);
      // And the seat is still there to be heard through.
      expect(S().call.phase).toBe("connected");
      expect(leaveCalls).toBe(0);
    } finally {
      retire();
    }
  });

  test("and no roger: there is no message to sign off", async () => {
    await holdInto(ROOM);
    walkie.markWalkieUpgraded(ROOM);
    soundLog.length = 0;
    try {
      await release();
      await settle();
      expect(soundLog).not.toContain("roger");
    } finally {
      retire();
    }
  });

  test("an ordinary burst still closes the mic and still signs off", async () => {
    // The other half of the rule, and the reason it is a condition rather than
    // a deletion: nobody stepped in here, so the hold ends the way it always
    // did and the microphone the hold opened goes back.
    await holdInto("dm:plain:release");
    muteCalls.length = 0;
    soundLog.length = 0;
    await release();
    await settle();
    expect(muteCalls).toContain(true);
    expect(soundLog).toContain("roger");
  });

  test("a stamp on a DIFFERENT room does not keep this mic open", async () => {
    // `joinedLive` names a room rather than carrying a flag, and this is why:
    // a call somebody is in elsewhere says nothing about the burst in hand.
    await holdInto("dm:plain:release");
    walkie.markWalkieUpgraded("dm:somewhere:else");
    muteCalls.length = 0;
    try {
      await release();
      await settle();
      expect(muteCalls).toContain(true);
    } finally {
      retire();
    }
  });
});

// ── the two cues that answer a person rather than a machine ────────────────
//
// The walkie's sounds are the half of it that never appears in a screenshot,
// and these two are the ones that say what happened to the message: somebody
// stepped into it, or nobody was there to hear it. Both are pinned to an exact
// moment for the same reason the roger is — a cue that drifts is worse than no
// cue, because a person has already learned what it meant.
describe("walkie: the join and the away tick", () => {
  test("pressing Join live sounds the join on this side too", async () => {
    // The far side hears it off the roster stamp. Nothing was playing it for
    // the person who actually pressed the button, so the one gesture that
    // turns a burst into a call was the only one in the set that was silent.
    soundLog.length = 0;
    try {
      // NOT awaited: the join itself is a round trip the mocked room never
      // answers, and the cue deliberately sits in front of it — a person who
      // pressed a button is owed an answer now, not when the SFU says so.
      const joining = walkie.joinWalkieLive("dm:join:sound", { name: "Jordan" });
      expect(soundLog).toContain("joined");
      void joining.catch(() => {});
    } finally {
      S().setCallState({ roomKey: null, phase: "idle", muted: true });
      walkie.refreshWalkie();
    }
  });

  test("the away tick plays once for a burst, however often the roster pushes", async () => {
    // THE MUTATION CHECK. The watcher that decides this fires on every push of
    // the room's occupancy, and a person who is not there does not become more
    // absent each time. Without the guard on the burst a two second hold into
    // an empty room ticks over and over.
    await walkie.startBurst("chan-1", "dm:away:tick");
    soundLog.length = 0;
    walkie.noteBurstUnheard();
    walkie.noteBurstUnheard();
    walkie.noteBurstUnheard();
    expect(soundLog.filter((s) => s === "away")).toEqual(["away"]);
    clock += 2_000;
    await release();
  });

  test("a second hold gets its own tick", async () => {
    // "Once" is once per hold, not once per tab: the next burst into the same
    // empty room is a new message and deserves the same answer.
    await walkie.startBurst("chan-1", "dm:away:tick");
    walkie.noteBurstUnheard();
    clock += 2_000;
    await release();
    joining.resolve();

    joining = defer<void>();
    await walkie.startBurst("chan-1", "dm:away:tick");
    soundLog.length = 0;
    walkie.noteBurstUnheard();
    expect(soundLog).toContain("away");
    clock += 2_000;
    await release();
  });

  test("says nothing when there is no burst to be unheard", async () => {
    soundLog.length = 0;
    walkie.noteBurstUnheard();
    expect(soundLog).not.toContain("away");
  });
});

// ── a receiver with no microphone ──────────────────────────────────────────
//
// A WALKIE IS ONE WAY (founder, Sep 1): the person talking is seen and heard,
// and hears nobody back until the listener steps in on purpose. So a listen is
// a seat that subscribes and publishes nothing — the microphone is not asked
// for at all, and the one moment it opens is Join live, which is a deliberate
// join. That replaces the earlier bargain (Aug 26: every join unmuted, hearing
// somebody meant they could hear you), and it also closes the failure that
// bargain had: on a browser where the person refused the microphone, the
// auto-listen's join opened the device, the device threw, and the join's own
// error path tore the room down and freed the seat while `incoming` stayed
// put, so the strip said "Sam is talking" over a silence with no room behind
// it. Now there is no device in a listen to refuse.
//
// What these pin: a listen never touches the microphone, never claims one, and
// never reports one missing; a denied microphone is reported exactly when a
// person presses Join live and is owed the sentence.
describe("walkie: a receiver with no microphone still hears", () => {
  const ROOM = "dm:denied:seat";
  const burstRow = () => ({
    messageId: "m-denied",
    channelId: "chan-denied",
    roomKey: ROOM,
    fromUserId: "u-sam",
    fromName: "Sam",
    createdAt: clock,
  });

  /** A browser where the person said no. The rejection carries the DOMException
   *  NAME, which is the only thing that tells "you said no" apart from "there
   *  is no such device". */
  let deviceAsks = 0;
  function refuseTheMicrophone() {
    micOnJoin = true;
    permissionState = "denied";
    deviceAsks = 0;
    (globalThis as any).navigator.mediaDevices.getUserMedia = async () => {
      deviceAsks++;
      throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    };
  }

  /** Let the listening seat's join resolve and its reads settle. */
  async function seatTaken() {
    joining.resolve();
    await settle();
  }

  // The engine keeps `incoming` keyed by MESSAGE ID, so a listen left standing
  // makes the next test's identical report a no-op — it reads as the same burst
  // still playing. Hand the seat back between tests, the way a real burst
  // ending does.
  afterEach(() => {
    walkie.observeWalkie({ bursts: [], doorOpen: false });
    S().setCallState({ roomKey: null, phase: "idle", muted: true, micDenied: false, error: null });
    walkie.refreshWalkie();
  });

  test("the room stays up: subscribe-only, nothing published, still hearing Sam", async () => {
    refuseTheMicrophone();
    walkie.observeWalkie({ bursts: [burstRow()], doorOpen: true });
    // The seat is asked for as a LISTEN, which is what keeps the microphone
    // out of it entirely.
    expect(joinCalls.at(-1)?.roomKey).toBe(ROOM);
    expect(joinCalls.at(-1)?.intent).toBe("listen");
    await seatTaken();
    S().setCallState({ roomKey: ROOM, phase: "connected" });

    // The device was never asked, so a refusal it would have given is not a
    // fact about this seat: muted, and nothing to report.
    expect(deviceAsks).toBe(0);
    expect(S().call.micDenied).toBe(false);
    expect(S().call.muted).toBe(true);
    // THE ROOM IS STILL THERE. Nothing hung up, nothing was handed back, and
    // the burst is still playing — which is the entire point of the seat.
    expect(leaveCalls).toBe(0);
    expect(S().call.phase).toBe("connected");
    expect(walkie.getWalkieStatus().liveRoom?.key).toBe(ROOM);
    expect(walkie.getWalkieStatus().liveRoom?.mode).toBe("listen");
    expect(walkie.getWalkieStatus().incoming?.fromName).toBe("Sam");
  });

  test("the strip says the true thing, and never the hot-mic line", async () => {
    refuseTheMicrophone();
    walkie.observeWalkie({ bursts: [burstRow()], doorOpen: true });
    await seatTaken();
    S().setCallState({ roomKey: ROOM, phase: "connected" });

    const strip = walkieStripState(walkie.getWalkieStatus(), S(), { name: "Sam", now: clock });
    // A listen is Sam talking and nothing about MY microphone: it was not
    // asked for, so "permission denied" is not a true thing to say either.
    expect(strip.headline).toBe("Sam is talking");
    expect(strip.micDenied).toBe(false);
    expect(strip.rx).toBe(true);
    // "Your mic is open — Sam can hear you" over a microphone that never opened
    // is the worst sentence this surface could say, and it is the one the old
    // two-way listen would have said.
    expect(strip.hotMic).toBe(false);
  });

  test("never claims an open microphone before one is publishing", async () => {
    // THE WINDOW THIS CLOSES, measured in a real headless browser with the
    // permission refused: the SFU connects, `call.phase` goes to connected, and
    // the publish fails about two seconds later. The walkie used to write
    // `muted: false` before the join, so those two seconds were spent telling a
    // person with no microphone that their mic was open and Riley could hear
    // them. The mute is the publication's to write now, and this is the tick
    // that proves it — before the join has answered anything.
    refuseTheMicrophone();
    walkie.observeWalkie({ bursts: [burstRow()], doorOpen: true });
    S().setCallState({ roomKey: ROOM, phase: "connected" });
    expect(S().call.muted).toBe(true);
    expect(
      walkieStripState(walkie.getWalkieStatus(), S(), { name: "Sam", now: clock }).hotMic,
    ).toBe(false);

    await seatTaken();
    expect(S().call.muted).toBe(true);
    expect(
      walkieStripState(walkie.getWalkieStatus(), S(), { name: "Sam", now: clock }).hotMic,
    ).toBe(false);
  });

  test("a working microphone stays shut on a listen; Join live is what opens it", async () => {
    // The other half of the same rule. A listen with a perfectly good device
    // still publishes nothing — the walkie is one way until the listener steps
    // in. And a rule that only ever said "muted" would ship a walkie nobody
    // can answer, so the seam that DOES open the microphone is pinned too: a
    // deliberate join, which is what Join live issues.
    micOnJoin = true;
    walkie.observeWalkie({ bursts: [burstRow()], doorOpen: true });
    await seatTaken();
    S().setCallState({ roomKey: ROOM, phase: "connected" });
    expect(S().call.muted).toBe(true);
    expect(S().call.micDenied).toBe(false);
    const strip = walkieStripState(walkie.getWalkieStatus(), S(), { name: "Sam", now: clock });
    expect(strip.hotMic).toBe(false);
    expect(strip.headline).toBe("Sam is talking");

    // The rule at its seam, against the real call manager: a listen never
    // reaches the participant; a deliberate join publishes.
    const asked: boolean[] = [];
    const participant = { setMicrophoneEnabled: async (on: boolean) => void asked.push(on) };
    await realCallManager.openMicForJoin(participant, { intent: "listen" });
    expect(asked).toEqual([]);
    expect(S().call.muted).toBe(true);
    S().setCallState({ muted: false });
    await realCallManager.openMicForJoin(participant, { intent: "deliberate" });
    expect(asked).toEqual([true]);
    expect(S().call.muted).toBe(false);

    // And Join live is the gesture that issues that deliberate join.
    await walkie.joinWalkieLive(ROOM, { name: "Sam" });
    expect(joinCalls.at(-1)).toMatchObject({ roomKey: ROOM, intent: "deliberate" });
  });

  test("a refused microphone is not mentioned on a listen — nothing was asked", async () => {
    // The toast the walkie has for a denied device belongs to a person who
    // tried to talk. A burst playing perfectly well is not that; raising the
    // toast here would be the surface inventing a problem nobody has.
    refuseTheMicrophone();
    walkie.observeWalkie({ bursts: [burstRow()], doorOpen: true });
    await seatTaken();
    expect(deviceAsks).toBe(0);
    expect(walkie.getWalkieStatus().error).toBeNull();
    expect(S().call.error).toBeNull();
  });

  test("a background listen writes no call error; a person who pressed Join live is told", async () => {
    // The same failure, two different debts. A red notice on the dock over a
    // burst playing perfectly well is the surface inventing a problem nobody
    // has; a person who pressed a button to talk is owed the sentence.
    const refusing = {
      setMicrophoneEnabled: async () => {
        throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
      },
    };
    permissionState = "denied";

    S().setCallState({ error: null, micDenied: false, muted: true });
    await realCallManager.openMicForJoin(refusing, { intent: "listen" });
    // A listen never reached the device, so there is no denial to record.
    expect(S().call.micDenied).toBe(false);
    expect(S().call.muted).toBe(true);
    expect(S().call.error).toBeNull();

    S().setCallState({ error: null, micDenied: false, muted: false });
    await realCallManager.openMicForJoin(refusing, { intent: "deliberate" });
    expect(S().call.micDenied).toBe(true);
    expect(S().call.error).toContain("site settings");
  });

  test("muting a seat that has no device never reads as a device that works", async () => {
    // `setMicrophoneEnabled(false)` succeeds trivially — there is nothing to
    // turn off — so clearing the denial on a mute would erase a fact nobody has
    // fixed, and the strip would go back to claiming a working microphone.
    S().setCallState({ micDenied: true, muted: false });
    await realCallManager.setMuted(true);
    expect(S().call.micDenied).toBe(true);
  });
});

// ── two keys down at once ──────────────────────────────────────────────────
//
// Two people press in the same DM within a second of each other, which is what
// a walkie invites. Each one used to take the seated path alone: `applyReport`
// returned early for anybody with a burst in flight, so the first presser never
// learned that a second voice had joined the room they were already in. The
// strip stayed one-directional over a two-way conversation.
//
// The rule now is that a press into a room with a live burst in it is a REPLY:
// one room, both directions on the status, both messages landing in the order
// they were spoken.
describe("walkie: two keys down in one room", () => {
  const ROOM = "dm:both:press";
  const theirBurst = () => ({
    messageId: "m-theirs",
    channelId: "chan-both",
    roomKey: ROOM,
    fromUserId: "u-sam",
    fromName: "Sam",
    createdAt: clock,
  });

  // The engine keeps `incoming` keyed by MESSAGE ID, so a listen left standing
  // makes the next test's identical report a no-op — it reads as the same burst
  // still playing. Hand the seat back between tests, the way a real burst
  // ending does.
  afterEach(() => {
    walkie.observeWalkie({ bursts: [], doorOpen: false });
    S().setCallState({ roomKey: null, phase: "idle", muted: true, micDenied: false, error: null });
    walkie.refreshWalkie();
  });

  test("a press while they are talking answers into the same room", async () => {
    walkie.observeWalkie({ bursts: [theirBurst()], doorOpen: true });
    S().setCallState({ roomKey: ROOM, phase: "connected", muted: false });

    await walkie.startBurst("chan-both", ROOM);

    // ONE ROOM, and nothing left it. The reply asks for the room it is already
    // in — idempotent in callManager, and this harness has no LiveKit to
    // publish into — so what matters is that every join names the SAME key and
    // the seat is never handed back mid-sentence.
    expect(new Set(joinCalls.map((j) => j.roomKey))).toEqual(new Set([ROOM]));
    expect(leaveCalls).toBe(0);
    const s = walkie.getWalkieStatus();
    expect(s.liveRoom?.key).toBe(ROOM);
    expect(s.liveRoom?.mode).toBe("burst");
    // BOTH DIRECTIONS, which is what the strip draws the two rings from.
    expect(s.sending?.roomKey).toBe(ROOM);
    expect(s.incoming?.fromName).toBe("Sam");

    const strip = walkieStripState(s, S(), { name: "Sam", now: clock });
    expect(strip.tx).toBe(true);
    expect(strip.rx).toBe(true);
    expect(strip.headline).toBe("You and Sam are both talking");

    clock += 2_000;
    await release();
  });

  test("their burst arriving mid-hold reaches a sender who is already talking", async () => {
    // The other order, and the one the early return broke outright: I pressed
    // FIRST, so there was no incoming to survive — there was a report I never
    // looked at.
    await walkie.startBurst("chan-both", ROOM);
    S().setCallState({ roomKey: ROOM, phase: "connected", muted: false });
    expect(walkie.getWalkieStatus().incoming).toBeNull();

    walkie.observeWalkie({ bursts: [theirBurst()], doorOpen: true });
    const s = walkie.getWalkieStatus();
    expect(s.incoming?.fromName).toBe("Sam");
    expect(s.sending?.roomKey).toBe(ROOM);
    expect(s.liveRoom?.mode).toBe("burst");

    clock += 2_000;
    await release();
  });

  test("both bursts land, in the order they were spoken", async () => {
    walkie.observeWalkie({ bursts: [theirBurst()], doorOpen: true });
    S().setCallState({ roomKey: ROOM, phase: "connected", muted: false });
    await walkie.startBurst("chan-both", ROOM);

    // Their key comes up first: their message is theirs to land, and this side
    // must not cancel, mute or evict anything on the way through.
    clock += 3_000;
    walkie.observeWalkie({ bursts: [], doorOpen: true });
    expect(walkie.getWalkieStatus().incoming).toBeNull();
    expect(walkie.getWalkieStatus().sending?.roomKey).toBe(ROOM);
    expect(leaveCalls).toBe(0);

    // Then mine, which lands as its own message behind theirs.
    clock += 1_000;
    await release();
    expect(finalize()).toBeTruthy();
    expect(mutations.some((m) => m.name === "chat:cancelVoiceBurst")).toBe(false);
  });

  test("borrows the microphone already publishing here, and is heard at once", async () => {
    // Hold-to-reply where the seat is REALLY connected: the mic is in the room
    // already, so there is no second device to open and nothing to wait for.
    seatedMic = { readyState: "live", stop() {}, clone: () => ({ readyState: "live", stop() {} }) };
    S().setCallState({ roomKey: ROOM, phase: "connected", muted: false });
    const gum = getUserMediaCalls;

    await walkie.startBurst("chan-both", ROOM);
    expect(getUserMediaCalls).toBe(gum);
    expect(walkie.getWalkieStatus().sending?.heardLive).toBe(true);
    // Nothing to ask the room for: the track is already in it.
    expect(joinCalls.length).toBe(0);

    clock += 2_000;
    await release();
  });

  test("a seat still CONNECTING is not a microphone in the room", async () => {
    // The ordinary shape of answering a burst you only just started hearing:
    // the listening join is in flight, so the seat exists and the publication
    // does not. Reading `inRoom` as "my mic is already here" made the burst
    // skip the join it needed and then claim it was being heard by a room it
    // had never reached — measured in the headless rig, where a press 868ms
    // after the burst arrived landed in exactly this state.
    S().setCallState({ roomKey: ROOM, phase: "connecting", muted: false });

    await walkie.startBurst("chan-both", ROOM);
    // Its own device, carried into the room by the join.
    expect(joinCalls.at(-1)?.roomKey).toBe(ROOM);
    expect(joinCalls.at(-1)?.micTrack).toBeTruthy();
    // And no claim of being heard until that join answers.
    expect(walkie.getWalkieStatus().sending?.heardLive).toBe(false);

    clock += 2_000;
    await release();
  });

  test("a burst in ANOTHER room is never walked into mid-sentence", async () => {
    // One pair of ears cannot follow two rooms, and leaving to hear a third
    // person would evict the conversation I am in the middle of having. It
    // waits as a message, which is what it already is.
    await walkie.startBurst("chan-both", ROOM);
    const joinsBefore = joinCalls.length;
    walkie.observeWalkie({
      bursts: [{ ...theirBurst(), messageId: "m-elsewhere", roomKey: "dm:some:other" }],
      doorOpen: true,
    });
    expect(walkie.getWalkieStatus().incoming).toBeNull();
    expect(walkie.getWalkieStatus().liveRoom?.key).toBe(ROOM);
    // Nothing reached for the other room.
    expect(joinCalls.length).toBe(joinsBefore);

    clock += 2_000;
    await release();
  });
});

// ── the stamp that arrived a moment too late ───────────────────────────────
//
// A join is a round trip behind the gesture that made it. So the far side
// pressing Join live just before the key comes up lands just AFTER: the release
// reads a room that is still a burst, mutes, and a beat later the stamp says it
// is a call. The person is then in a conversation, told so in words and a
// sound, with the microphone the whole upgrade exists to keep open already
// closed — which is A1's bug arriving by a different door.
describe("walkie: a join stamp that lands after the key came up", () => {
  const ROOM = "dm:late:stamp";

  afterEach(() => {
    S().setCallState({ roomKey: null, phase: "idle", muted: true, micDenied: false, error: null });
    walkie.refreshWalkie();
  });

  test("re-opens the microphone the release closed, and rogers only once", async () => {
    await walkie.startBurst("chan-1", ROOM);
    S().setCallState({ roomKey: ROOM, phase: "connected", muted: false });
    clock += 2_000;
    soundLog.length = 0;
    muteCalls = [];
    await release();

    // The ordinary release: the sign-off, and the mic closed behind it.
    expect(soundLog.filter((x) => x === "roger")).toEqual(["roger"]);
    expect(muteCalls).toEqual([true]);

    // And now the stamp, one beat late.
    walkie.markWalkieUpgraded(ROOM);
    await settle();
    expect(S().call.muted).toBe(false);
    expect(muteCalls).toEqual([true, false]);
    // The sign-off is not said twice. It marked the end of a message, and the
    // message is over; what happened since is that a conversation started.
    expect(soundLog.filter((x) => x === "roger")).toEqual(["roger"]);
  });

  test("never opens a microphone the PERSON closed", async () => {
    // The muted lurker in a huddle. Somebody stepping into a burst in the room
    // they are sitting in must not open their mic — the release never closed
    // it, so this rule has nothing to undo.
    S().setCallState({ roomKey: ROOM, phase: "connected", muted: true });
    muteCalls = [];
    walkie.markWalkieUpgraded(ROOM);
    await settle();
    expect(S().call.muted).toBe(true);
    expect(muteCalls).toEqual([]);
  });

  test("never opens a microphone in a room the stamp does not name", async () => {
    await walkie.startBurst("chan-1", ROOM);
    S().setCallState({ roomKey: ROOM, phase: "connected", muted: false });
    clock += 2_000;
    await release();
    muteCalls = [];
    walkie.markWalkieUpgraded("dm:somewhere:else");
    await settle();
    expect(muteCalls).toEqual([]);
  });
});

// ── the title dies with the room ───────────────────────────────────────────
describe("walkie: the join announcement", () => {
  const ROOM = "dm:title:life";

  afterEach(() => {
    clearJoinAnnouncement();
    S().setCallState({ roomKey: null, phase: "idle", muted: true, micDenied: false, error: null });
    walkie.refreshWalkie();
  });

  test("goes when the room does, rather than outliving it by four seconds", async () => {
    // "Jordan joined — it's a call now" is news about a room. Hanging up inside
    // the four seconds used to leave the sentence sitting there, ready to
    // announce a join into whatever opened next.
    S().setCallState({ roomKey: ROOM, phase: "connected", muted: false });
    walkie.markWalkieUpgraded(ROOM);
    announceJoin(ROOM, "Jordan joined — it's a call now");
    expect(getJoinAnnouncement()?.roomKey).toBe(ROOM);

    S().setCallState({ roomKey: null, phase: "idle", muted: true });
    walkie.refreshWalkie();
    expect(walkie.getWalkieStatus().liveRoom).toBeNull();
    expect(getJoinAnnouncement()).toBeNull();
  });
});
