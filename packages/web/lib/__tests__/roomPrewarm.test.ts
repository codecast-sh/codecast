// THE CONNECTION HELD OPEN AHEAD OF THE FIRST WORD.
//
// A walkie burst is only audible once the speaker's media connection is up, and
// that connection is the slow part of the whole feature — 1.0s into a room this
// client had touched, up to 12.7s into a cold one. Those seconds are not lost
// words (the recorder runs from t=0) but they are recorded rather than heard,
// which is the difference between a walkie and voicemail.
//
// So the room is connected before the gesture: opening a DM, or a pointer
// resting on a face. Every test here is about what that must NOT cost, because
// each one is a way of taking something from a person who only moved a mouse:
// a microphone they never opened, a seat in a room they never entered, a dock
// that appears on its own, six connections for one bar of faces, or a
// connection held forever.
//
// The last group is the payoff — the claim reusing the warm room — and it is
// mutation-checked: with the reuse removed, the join mints a second token and
// performs a second handshake, which is the 12.7 seconds coming back.

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { ConnectionState } from "livekit-client";
import { useInboxStore } from "../../store/inboxStore";

// ── the world ───────────────────────────────────────────────────────────────
//
// `mock.module` replaces a module for the whole test process, so this spreads
// the real livekit-client and overrides only the one class it drives. Nothing
// else in the suite constructs a Room (the enums and events stay real).

const realLivekit = await import("livekit-client");
const realAnalyser = realLivekit.createAudioAnalyser;
let meterProbe = false;
let meterStarts = 0;

class FakeRoom {
  static made: FakeRoom[] = [];
  /** Lets a test land a gesture inside publishTrack, which is the only way to
   *  hit that window deterministically rather than by counting microtasks. */
  static onPublish: (() => void) | null = null;
  state: ConnectionState = ConnectionState.Disconnected;
  connects = 0;
  disconnects = 0;
  /** Every request to open or close a device, in order. A prewarm must make
   *  none of them. */
  micCalls: boolean[] = [];
  published: unknown[] = [];
  remoteParticipants = new Map<string, any>();
  opts: any;
  /** Seat a remote whose audio track was ALREADY subscribed before this room
   *  was handed to joinCall — the shape a prewarm produces when the far side
   *  starts talking during the hold. */
  seatRemote(identity: string) {
    // `attaches` rather than a count of elements: attaching twice overwrites
    // the same key in the manager's map, so the map's SIZE cannot tell one
    // attach from two — and two is a voice playing twice.
    const track = {
      kind: "audio",
      sid: `sid_${identity}`,
      attaches: 0,
      attach() {
        this.attaches++;
        return { dataset: {} as any, remove() {} };
      },
      detach: () => [],
    };
    this.remoteParticipants.set(identity, {
      identity,
      trackPublications: new Map([["p", { kind: "audio", isSubscribed: true, track }]]),
      // rebuildTiles asks every participant for its camera and screen share.
      // A stand-in that cannot answer makes joinCall throw, which reads as
      // "the sweep did not attach" and sends you looking in the wrong place.
      getTrackPublication: () => undefined,
    });
    return track;
  }
  /** The microphone publication, once one exists. Modelled rather than stubbed
   *  because the ORDER is the safety property: a track must be silent before it
   *  is published, never after. */
  micPublication: { muted: boolean; track: any; mute: () => Promise<void> } | null = null;
  /** What the track's `enabled` was AT THE MOMENT it was handed over. A hover
   *  that publishes a live microphone and mutes it a round trip later has
   *  broadcast in the gap. */
  enabledAtPublish: boolean | null = null;
  localParticipant = {
    setMicrophoneEnabled: async (on: boolean) => {
      this.micCalls.push(on);
      if (this.micPublication) this.micPublication.muted = !on;
    },
    publishTrack: async (t: any) => {
      this.published.push(t);
      FakeRoom.onPublish?.();
      this.enabledAtPublish = t?.enabled ?? null;
      const pub = {
        muted: false,
        track: t,
        mute: async () => {
          pub.muted = true;
        },
      };
      this.micPublication = pub;
      return pub;
    },
    getTrackPublication: (source?: unknown) =>
      source === realLivekit.Track.Source.Microphone ? this.micPublication ?? undefined : undefined,
  };
  constructor(opts?: any) {
    this.opts = opts;
    FakeRoom.made.push(this);
  }
  on() {
    return this;
  }
  removeAllListeners() {
    return this;
  }
  async connect() {
    this.connects++;
    this.state = ConnectionState.Connected;
  }
  async disconnect() {
    this.disconnects++;
    this.state = ConnectionState.Disconnected;
  }
}

mock.module("livekit-client", () => ({
  ...realLivekit,
  Room: FakeRoom,
  createAudioAnalyser: (...args: Parameters<typeof realAnalyser>) => {
    if (!meterProbe) return realAnalyser(...args);
    meterStarts++;
    return {
      analyser: { fftSize: 256, getByteTimeDomainData: (bytes: Uint8Array) => {
        for (let i = 0; i < bytes.length; i++) bytes[i] = 128 + (i % 2 ? 8 : -8);
      } },
      cleanup: () => {},
    };
  },
}));

const prewarm = await import("../calls/roomPrewarm");
const callManager = await import("../calls/callManager");

// `attachAudio` puts a real element on the page, so the audible half of these
// tests needs somewhere to put it. Installed AFTER the imports on purpose:
// modules that inject stylesheets at load (sonner, through callManager) branch
// on `document` existing, and a stub present during import sends them down
// their DOM path with a document that cannot answer.
if (typeof (globalThis as any).document === "undefined") {
  (globalThis as any).document = {
    createElement: () => ({ style: {}, dataset: {} as any, appendChild() {}, remove() {} }),
    body: { appendChild() {} },
  };
  // The whole test run shares one process, so a lingering partial `document`
  // sends every LATER file's `typeof document !== "undefined"` branch down a
  // DOM path this stub cannot answer (document.hasFocus is not a function, in
  // unrelated store suites). Uninstall what this file installed.
  afterAll(() => {
    delete (globalThis as any).document;
  });
}

let mutations: Array<{ name: string; args: any }> = [];
let actions: Array<{ name: string; args: any }> = [];

const convex = {
  mutation: async (fn: any, args: any) => {
    mutations.push({ name: getFunctionName(fn), args });
    return { room_key: args?.room_key, prewarm: !!args?.prewarm };
  },
  action: async (fn: any, args: any) => {
    actions.push({ name: getFunctionName(fn), args });
    return { url: "wss://sfu.example", token: "tok" };
  },
};

const named = (log: Array<{ name: string }>, suffix: string) =>
  log.filter((c) => c.name.endsWith(suffix));

// ── a clock the tests own ───────────────────────────────────────────────────
// The idle release is ninety seconds away and the point of the test is that it
// arrives, so time is driven rather than waited on.

type Timer = { id: number; fn: () => void; at: number; cleared: boolean };
let timers: Timer[] = [];
let timerId = 1;
let clockNow = 0;
const trueSetTimeout = globalThis.setTimeout;
const trueClearTimeout = globalThis.clearTimeout;

function advance(ms: number) {
  clockNow += ms;
  for (const t of [...timers]) {
    if (!t.cleared && t.at <= clockNow) {
      t.cleared = true;
      t.fn();
    }
  }
}

const ROOM = "dm:aaa:bbb";
const OTHER = "dm:aaa:ccc";

beforeEach(() => {
  FakeRoom.made = [];
  FakeRoom.onPublish = null;
  mutations = [];
  actions = [];
  timers = [];
  timerId = 1;
  clockNow = 0;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const t = { id: timerId++, fn, at: clockNow + (ms ?? 0), cleared: false };
    timers.push(t);
    return t.id;
  }) as any;
  globalThis.clearTimeout = ((id: any) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  }) as any;
  useInboxStore.getState().setCallState({
    phase: "idle",
    roomKey: null,
    muted: true,
    error: null,
    speaking: [],
  });
  (useInboxStore.getState() as any).callOccupancy = {};
  prewarm.bindPrewarmConvex(convex);
  callManager.bindConvex(convex);
  // No device unless a test asks for one, so every test that is about
  // something else keeps saying what it always said.
  prewarm.bindPrewarmMic(async () => null);
});

afterEach(() => {
  prewarm.releasePrewarm();
  globalThis.setTimeout = trueSetTimeout;
  globalThis.clearTimeout = trueClearTimeout;
});

/** The shared device, counting what is done to it. */
function fakeMicTrack() {
  const t: any = {
    kind: "audio",
    readyState: "live",
    enabled: true,
    stopped: false,
    clones: 0,
    stop() {
      this.stopped = true;
    },
    clone() {
      t.clones++;
      return {
        kind: "audio",
        readyState: "live",
        enabled: true,
        stopped: false,
        stop() {
          this.stopped = true;
        },
      };
    },
  };
  return t;
}

/** Hold a room and wait for the connect to land, which is two awaits deep. */
async function warmUp(roomKey: string) {
  prewarm.prewarmRoom(roomKey);
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("a prewarm takes nothing from anybody", () => {
  test("publishes the microphone SILENT, and silent before it is published", async () => {
    // The founder's call: the device opens on hover so the far side has already
    // negotiated the track and a press is an unmute rather than a publish. What
    // that must never become is a hover that broadcasts.
    const shared = fakeMicTrack();
    prewarm.bindPrewarmMic(async () => shared);
    await warmUp(ROOM);
    const room = FakeRoom.made[0];
    expect(room.published).toHaveLength(1);
    // MUTATION CHECK: publish first and mute after, and this is true — a live
    // microphone in the room for however long the mute takes to land.
    expect(room.enabledAtPublish).toBe(false);
    expect(room.micPublication?.muted).toBe(true);
    // A CLONE, never the shared device: the walkie records from the original
    // and stopping our copy must not truncate the recording.
    expect(room.published[0]).not.toBe(shared);
    expect(shared.clones).toBe(1);
  });

  test("stays silent where permission was never granted, rather than asking", async () => {
    // `warmMic` hands back nothing unless the answer is already yes, so this is
    // the shape of a hover on a browser that has never been asked. The rule the
    // founder's decision did NOT move: a pointer can never raise a dialog.
    prewarm.bindPrewarmMic(async () => null);
    await warmUp(ROOM);
    const room = FakeRoom.made[0];
    expect(room.connects).toBe(1);
    expect(room.published).toEqual([]);
    expect(room.micCalls).toEqual([]);
    // The connection is still worth holding: the press just publishes then.
    expect(prewarm.prewarmedRoomKey()).toBe(ROOM);
  });

  test("gives the device back when the hover came to nothing", async () => {
    const shared = fakeMicTrack();
    prewarm.bindPrewarmMic(async () => shared);
    await warmUp(ROOM);
    const clone = FakeRoom.made[0].published[0] as any;
    expect(clone.stopped).toBe(false);
    advance(prewarm.PREWARM_IDLE_MS + 1);
    // MUTATION CHECK: drop the stop() in releasePrewarm and this is false — a
    // microphone left open by somebody who moved a mouse ninety seconds ago.
    expect(clone.stopped).toBe(true);
    // The SHARED device is not ours to stop; the walkie may still be recording
    // from it, and its own idle clock owns it.
    expect(shared.stopped).toBe(false);
  });

  test("never shows a surface: the call slice is untouched, so the dock reads none", async () => {
    await warmUp(ROOM);
    const call = useInboxStore.getState().call;
    expect(call.roomKey).toBe(null);
    expect(call.phase).toBe("idle");
  });

  test("never stamps walkie_join, and says what it is on the seat row", async () => {
    await warmUp(ROOM);
    const joins = named(mutations, "joinRoom");
    expect(joins).toHaveLength(1);
    expect(joins[0].args.prewarm).toBe(true);
    // The stamp is what turns a burst into a call on both sides' surfaces.
    // Nobody joined anything here.
    expect(joins[0].args.walkie_join).toBeUndefined();
  });

  test("refuses while the call plane holds a room", async () => {
    useInboxStore.getState().setCallState({ phase: "connected", roomKey: OTHER });
    await warmUp(ROOM);
    expect(prewarm.prewarmedRoomKey()).toBe(null);
    expect(FakeRoom.made).toHaveLength(0);
  });

  test("refuses a room somebody is already sitting in", async () => {
    (useInboxStore.getState() as any).callOccupancy = { [ROOM]: [{ user_id: "them" }] };
    await warmUp(ROOM);
    expect(prewarm.prewarmedRoomKey()).toBe(null);
    expect(FakeRoom.made).toHaveLength(0);
  });

  test("the rule is readable on its own", () => {
    expect(prewarm.prewarmAllowed(ROOM, { call: {}, callOccupancy: {} })).toBe(true);
    expect(prewarm.prewarmAllowed("", { call: {}, callOccupancy: {} })).toBe(false);
    expect(prewarm.prewarmAllowed(ROOM, { call: { phase: "connecting" }, callOccupancy: {} })).toBe(false);
    expect(prewarm.prewarmAllowed(ROOM, { call: { roomKey: ROOM }, callOccupancy: {} })).toBe(false);
  });
});

describe("bounded: one room, and not for long", () => {
  test("a new room releases the last one", async () => {
    await warmUp(ROOM);
    await warmUp(OTHER);
    expect(prewarm.prewarmedRoomKey()).toBe(OTHER);
    // A bar of six faces must never become six SFU connections.
    expect(FakeRoom.made[0].disconnects).toBe(1);
    expect(FakeRoom.made[1].disconnects).toBe(0);
  });

  test("re-asking for the room already held costs no second connection", async () => {
    await warmUp(ROOM);
    await warmUp(ROOM);
    expect(FakeRoom.made).toHaveLength(1);
    expect(named(actions, "mintAccessToken")).toHaveLength(1);
  });

  test("releases itself after the idle window, and frees the row with it", async () => {
    await warmUp(ROOM);
    advance(prewarm.PREWARM_IDLE_MS - 1);
    expect(prewarm.prewarmedRoomKey()).toBe(ROOM);
    advance(2);
    expect(prewarm.prewarmedRoomKey()).toBe(null);
    expect(FakeRoom.made[0].disconnects).toBe(1);
    expect(named(mutations, "leaveRoom")).toHaveLength(1);
  });

  test("a fresh signal pushes the release out rather than stacking a second one", async () => {
    await warmUp(ROOM);
    advance(prewarm.PREWARM_IDLE_MS - 1_000);
    await warmUp(ROOM);
    advance(2_000);
    expect(prewarm.prewarmedRoomKey()).toBe(ROOM);
    advance(prewarm.PREWARM_IDLE_MS);
    expect(prewarm.prewarmedRoomKey()).toBe(null);
  });
});

describe("the claim spends it", () => {
  test("the warm room is handed over once, and only for its own room", async () => {
    await warmUp(ROOM);
    expect(prewarm.takePrewarmedRoom(OTHER)).toBe(null);
    // Wrong room: dropped rather than left holding an identity the join is
    // about to use.
    expect(FakeRoom.made[0].disconnects).toBe(1);

    await warmUp(ROOM);
    const room = prewarm.takePrewarmedRoom(ROOM);
    expect(room).toBe(FakeRoom.made[1] as any);
    expect(prewarm.takePrewarmedRoom(ROOM)).toBe(null);
  });

  test("a join into a warm room mints no token and performs no handshake", async () => {
    await warmUp(ROOM);
    const warmRoom = FakeRoom.made[0];
    mutations = [];
    actions = [];

    await callManager.joinCall(ROOM);

    // THE MUTATION CHECK. Delete the `takePrewarmedRoom` call in joinCall and
    // both of these become 1 and 2 respectively: a second token minted and a
    // second SFU handshake — the seconds this whole file exists to remove.
    expect(named(actions, "mintAccessToken")).toHaveLength(0);
    expect(FakeRoom.made).toHaveLength(1);
    expect(warmRoom.connects).toBe(1);
    // It is the same connection, now doing a call's work.
    expect(useInboxStore.getState().call.roomKey).toBe(ROOM);
    expect(useInboxStore.getState().call.phase).toBe("connected");
    expect(warmRoom.micCalls).toEqual([false]);
    await callManager.leaveCall();
  });

  test("a join into a cold room still mints and connects", async () => {
    await callManager.joinCall(OTHER);
    expect(named(actions, "mintAccessToken")).toHaveLength(1);
    expect(FakeRoom.made).toHaveLength(1);
    expect(FakeRoom.made[0].connects).toBe(1);
    await callManager.leaveCall();
  });

  test("a join elsewhere stands the prewarm down instead of letting it evict the call", async () => {
    await warmUp(ROOM);
    const stale = FakeRoom.made[0];
    await callManager.joinCall(OTHER);
    // mintAccessToken signs the identity as the user id, so a prewarm left
    // connected under it is a duplicate identity waiting to happen.
    expect(stale.disconnects).toBe(1);
    expect(prewarm.prewarmedRoomKey()).toBe(null);
    await callManager.leaveCall();
  });
});


// THE VOICE THAT ARRIVED BEFORE ANYBODY WAS LISTENING.
//
// Found on the two-identity rig, not by any unit test, and it is the reason
// this file has a section for it. A prewarmed room is CONNECTED, so LiveKit
// subscribes to whatever is published into it — and RoomEvent.TrackSubscribed
// fires ONCE, at subscription time. joinCall registers its handlers when it
// adopts the room, which is after that, so `attachAudio` never ran and the
// receiver sat there connected, subscribed and completely silent, with nothing
// in its own state to say anything was wrong.
//
// Measured: adopting a warm room after the far side began publishing gave 0
// audio elements against a subscribed track. The ordinary path escaped it by
// 25ms, which is not a margin, it is luck.
describe("adopting a warm room that is already carrying a voice", () => {
  test("attaches the tracks that were subscribed before the handlers existed", async () => {
    await warmUp(ROOM);
    const warmRoom = FakeRoom.made[0];
    // The far side started talking during the hold.
    warmRoom.seatRemote("them");

    await callManager.joinCall(ROOM);

    // MUTATION CHECK: delete the already-subscribed sweep in joinCall's warm
    // branch and this is 0 — a connected, subscribed, silent client.
    expect(callManager.getAudioElementCount()).toBe(1);
    await callManager.leaveCall();
  });

  test("does not double-attach when the listener also fires for that track", async () => {
    await warmUp(ROOM);
    const warmRoom = FakeRoom.made[0];
    const track = warmRoom.seatRemote("them");
    await callManager.joinCall(ROOM);
    expect(track.attaches).toBe(1);
    // The same track arriving again through the ordinary event path must not
    // be attached a second time and play the voice twice.
    callManager.__attachAudioForTest(track as any, "them");
    expect(track.attaches).toBe(1);
    expect(callManager.getAudioElementCount()).toBe(1);
    await callManager.leaveCall();
  });

  test("a cold join has nothing to sweep and still ends with no elements", async () => {
    await callManager.joinCall(OTHER);
    expect(callManager.getAudioElementCount()).toBe(0);
    await callManager.leaveCall();
  });
});


// THE VOICE DOES NOT WAIT ON THE BOOKKEEPING.
//
// `joinCall` used to await the control-plane seat row before it touched media,
// which on the rig was most of what remained between a press and the far side
// hearing it once both rooms were warm: press to publish fell from 877ms to
// 88ms when the row stopped gating it. Both halves are authorized by the same
// rule, so the row is who the dock draws, not whether anyone may be here.
describe("the seat row is bookkeeping, not a gate", () => {
  test("the microphone is published while the row is still in flight", async () => {
    let releaseRow: () => void = () => {};
    const rowLanded = new Promise<void>((res) => {
      releaseRow = res;
    });
    const slow = {
      ...convex,
      mutation: async (fn: any, args: any) => {
        mutations.push({ name: getFunctionName(fn), args });
        if (getFunctionName(fn).endsWith("joinRoom")) await rowLanded;
        return { room_key: args?.room_key };
      },
    };
    callManager.bindConvex(slow);

    const joining = callManager.joinCall(OTHER);
    // Let the media plane run as far as it can while the row hangs.
    for (let i = 0; i < 40; i++) await Promise.resolve();

    const r = FakeRoom.made[0];
    // MUTATION CHECK: await controlJoin before the handshake again and this is
    // 0 — nothing has connected, and nobody can hear anything yet.
    expect(r.connects).toBe(1);
    expect(r.micCalls.length).toBe(1);
    // …and the join still has not been declared, because the row has not landed.
    expect(useInboxStore.getState().call.phase).toBe("connecting");

    releaseRow();
    await joining;
    expect(useInboxStore.getState().call.phase).toBe("connected");
    await callManager.leaveCall();
  });

  test("a refused row still fails the join and frees the seat", async () => {
    const refusing = {
      ...convex,
      mutation: async (fn: any, args: any) => {
        mutations.push({ name: getFunctionName(fn), args });
        if (getFunctionName(fn).endsWith("joinRoom")) throw new Error("Cannot join room: not a member");
        return { room_key: args?.room_key };
      },
    };
    callManager.bindConvex(refusing);
    await callManager.joinCall(OTHER);
    // Taking the media plane off the row's critical path must not make a
    // refusal survivable: the call still ends in error rather than running on
    // with a seat nobody granted.
    expect(useInboxStore.getState().call.phase).toBe("error");
    expect(callManager.getRoom()).toBe(null);
  });
});


// ONE PERSON, ONE VOICE IN THE ROOM.
//
// A warm room arrives already holding a muted microphone, negotiated by the far
// side before anybody pressed — that is what makes a press an unmute instead of
// a publish. So the join has nothing left to publish, and publishing anyway
// would put two copies of one person in the room.
describe("adopting a warm room that already carries our microphone", () => {
  // This one is the plain case and it passes either way: with no track handed
  // over, `setMicrophoneEnabled(true)` unmutes the publication that is already
  // there. Kept because it pins the SAVING — a press is one unmute and no
  // renegotiation — not because it distinguishes the guard.
  test("a press is an unmute, not a publish", async () => {
    const shared = fakeMicTrack();
    prewarm.bindPrewarmMic(async () => shared);
    await warmUp(ROOM);
    const room = FakeRoom.made[0];
    expect(room.published).toHaveLength(1);

    useInboxStore.getState().setCallState({ muted: false });
    await callManager.joinCall(ROOM, { intent: "deliberate" });

    expect(room.published).toHaveLength(1);
    expect(room.micCalls).toEqual([true]);
    await callManager.leaveCall();
  });

  test("stops a hand-off track it no longer needs rather than leaking it", async () => {
    // THE CASE THE GUARD IS FOR, and the one the walkie actually takes:
    // startBurst clones the shared device to hand to the room. When the room
    // already publishes one, that clone has no owner — and a clone nobody stops
    // is a capture nobody closes.
    //
    // MUTATION CHECK: remove the warmRoomPublishesMic branch and the clone is
    // published as a second microphone AND never stopped.
    const shared = fakeMicTrack();
    prewarm.bindPrewarmMic(async () => shared);
    await warmUp(ROOM);
    const handOff: any = { kind: "audio", readyState: "live", stopped: false, stop() { this.stopped = true; } };

    await callManager.joinCall(ROOM, { micTrack: handOff });

    expect(handOff.stopped).toBe(true);
    expect(FakeRoom.made[0].published).toHaveLength(1);
    await callManager.leaveCall();
  });
});


// A PRESS THAT LANDS MID-PUBLISH MUST NOT CUT THE VOICE OFF.
//
// The prewarm's publish is several awaits long, and a hand can arrive inside
// it. `takePrewarmedRoom` then gives the room away while this module is still
// running: the clone it published a moment ago is by then the live microphone
// of somebody's burst, and the cleanup that was correct a tick earlier would
// stop it at the exact moment it opened.
describe("a press landing inside the prewarm's publish", () => {
  test("leaves the published microphone alone once the room is adopted", async () => {
    const shared = fakeMicTrack();
    prewarm.bindPrewarmMic(async () => shared);

    // The hand arrives at the exact moment the track is handed to LiveKit —
    // the one window where the clone exists, is published, and this module has
    // not yet recorded it as its own.
    let taken: unknown = null;
    FakeRoom.onPublish = () => {
      taken = prewarm.takePrewarmedRoom(ROOM);
    };
    try {
      await warmUp(ROOM);
    } finally {
      FakeRoom.onPublish = null;
    }

    const room = FakeRoom.made[0];
    expect(taken).toBe(room as any);
    const clone = room.published[0] as any;
    expect(clone).toBeTruthy();
    // MUTATION CHECK: stop the clone on the superseded path after publishing
    // and this is true — the burst opens onto a dead microphone.
    expect(clone.stopped).toBe(false);
    expect(prewarm.prewarmedRoomKey()).toBe(null);
  });
});


test("a prepublished warm microphone starts the live meter without a publication event", async () => {
  const realInterval = globalThis.setInterval;
  let tick = () => {};
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    if (ms === 50) { tick = fn; return realInterval(() => {}, 60_000); }
    return realInterval(fn, ms);
  }) as any;
  meterProbe = true;
  meterStarts = 0;
  try {
    prewarm.bindPrewarmMic(async () => fakeMicTrack());
    await warmUp(ROOM);
    expect(FakeRoom.made[0].micPublication).not.toBeNull();
    expect(meterStarts).toBe(0);
    useInboxStore.getState().setCallState({ muted: false });
    await callManager.joinCall(ROOM);
    expect(meterStarts).toBe(1);
    tick();
    expect(callManager.getMicLevel()).toBeGreaterThan(0.5);
    await callManager.setMuted(true, { remember: false });
    tick();
    expect(callManager.getMicLevel()).toBe(0);
  } finally {
    await callManager.leaveCall();
    globalThis.setInterval = realInterval;
    meterProbe = false;
  }
});
