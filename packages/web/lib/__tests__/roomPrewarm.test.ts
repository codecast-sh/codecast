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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { ConnectionState } from "livekit-client";
import { useInboxStore } from "../../store/inboxStore";

// ── the world ───────────────────────────────────────────────────────────────
//
// `mock.module` replaces a module for the whole test process, so this spreads
// the real livekit-client and overrides only the one class it drives. Nothing
// else in the suite constructs a Room (the enums and events stay real).

const realLivekit = await import("livekit-client");

class FakeRoom {
  static made: FakeRoom[] = [];
  state: ConnectionState = ConnectionState.Disconnected;
  connects = 0;
  disconnects = 0;
  /** Every request to open or close a device, in order. A prewarm must make
   *  none of them. */
  micCalls: boolean[] = [];
  published: unknown[] = [];
  remoteParticipants = new Map();
  opts: any;
  localParticipant = {
    setMicrophoneEnabled: async (on: boolean) => void this.micCalls.push(on),
    publishTrack: async (t: unknown) => void this.published.push(t),
    getTrackPublication: () => undefined,
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

mock.module("livekit-client", () => ({ ...realLivekit, Room: FakeRoom }));

const prewarm = await import("../calls/roomPrewarm");
const callManager = await import("../calls/callManager");

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
});

afterEach(() => {
  prewarm.releasePrewarm();
  globalThis.setTimeout = trueSetTimeout;
  globalThis.clearTimeout = trueClearTimeout;
});

/** Hold a room and wait for the connect to land, which is two awaits deep. */
async function warmUp(roomKey: string) {
  prewarm.prewarmRoom(roomKey);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("a prewarm takes nothing from anybody", () => {
  test("never opens a microphone and never publishes anything", async () => {
    await warmUp(ROOM);
    expect(prewarm.prewarmedRoomKey()).toBe(ROOM);
    const room = FakeRoom.made[0];
    expect(room.connects).toBe(1);
    // The whole promise of hovering a face: a connection, and no device. A
    // single `true` here is the browser's recording indicator lighting up
    // because somebody moved a pointer.
    expect(room.micCalls).toEqual([]);
    expect(room.published).toEqual([]);
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
