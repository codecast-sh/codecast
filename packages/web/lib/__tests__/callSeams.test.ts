import { replaceGlobals } from "../../test-helpers/globals";
// STATUS TRUTH AT THE SEAMS (pl-756, F5).
//
// The founder: "it just delays the status or gets on/off calls." Each seam
// below is one place where a call, a burst or a seat read as OFF for a moment
// and then ON again, or stayed on past its end, and each is pinned at the
// source it was fixed in: the engine, never a component's guess.
//
//   (b) hanging up frees the seat BEFORE the scribe's local teardown, so a
//       teammate's roster drops the face at End rather than after the flush;
//   (c) a seat re-taken after the server swept it keeps its walkie stamp, so a
//       conversation that survived a sleep is still a conversation;
//   (d) a LiveKit reconnect is still the call: the phase never dips, so the
//       desktop's in-huddle report and the seated room key hold;
//   (e) the walkie's own linger draws, so the surface never vanishes at Stop
//       and returns as a call when the far side's join lands;
//   (g) the join chime follows the ROSTER, so a prewarm peer (a connection
//       with no seat) arrives and leaves in silence.
//
// The convex half of (a), the heartbeat sweep, is pinned in
// packages/convex/convex/calls.test.ts.

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { ConnectionState, RoomEvent } from "livekit-client";
import { useInboxStore } from "../../store/inboxStore";
import { flushSyncPublishes } from "../../store/syncTransaction";

// ── the world ───────────────────────────────────────────────────────────────
//
// Every module mocked here is spread from the real one and restored after:
// `mock.module` replaces a module for the whole test process, so a partial
// stand-in breaks other files' tests wherever they sit in the alphabet.

const realLivekit = { ...await import("livekit-client") };
afterAll(() => { mock.module("livekit-client", () => realLivekit); });

/** A Room that remembers its listeners so a test can fire the SFU's events. */
class FakeRoom {
  static made: FakeRoom[] = [];
  state: ConnectionState = ConnectionState.Disconnected;
  private handlers = new Map<string, Array<(...args: any[]) => void>>();
  remoteParticipants = new Map<string, any>();
  localParticipant = {
    identity: "me",
    name: "Me",
    metadata: undefined as string | undefined,
    setMicrophoneEnabled: async () => {},
    publishTrack: async (t: any) => ({ muted: false, track: t, mute: async () => {} }),
    getTrackPublication: () => undefined,
  };
  constructor() {
    FakeRoom.made.push(this);
  }
  on(event: string, cb: (...args: any[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: any[]) {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  removeAllListeners() {
    this.handlers.clear();
    return this;
  }
  async connect() {
    this.state = ConnectionState.Connected;
  }
  async disconnect() {
    this.state = ConnectionState.Disconnected;
  }
}

mock.module("livekit-client", () => ({ ...realLivekit, Room: FakeRoom }));

const realSounds = { ...await import("../sounds") };
afterAll(() => { mock.module("../sounds", () => realSounds); });
const soundLog: string[] = [];
mock.module("../sounds", () => ({
  ...realSounds,
  soundCallJoin: () => void soundLog.push("join"),
  soundCallLeave: () => void soundLog.push("leave"),
}));

/** The scribe's stop, held open so a test can ask what the seat did while
 *  the local teardown was still running. */
const realTranscription = { ...await import("../calls/transcription") };
afterAll(() => { mock.module("../calls/transcription", () => realTranscription); });
let scribeStopping: { promise: Promise<void>; resolve: () => void } | null = null;
let scribeStops = 0;
mock.module("../calls/transcription", () => ({
  ...realTranscription,
  stopScribe: async () => {
    scribeStops++;
    if (scribeStopping) await scribeStopping.promise;
  },
}));

const callManager = await import("../calls/callManager");
const { inHuddle } = await import("../../components/DesktopProvider");
const { callDockSurface } = await import("../../hooks/useWalkie");

const restoreDocument = replaceGlobals({ document: {
  createElement: () => ({ style: {}, dataset: {} as any, appendChild() {}, remove() {} }),
  body: { appendChild() {} },
} });
afterAll(restoreDocument);

let mutations: Array<{ name: string; args: any }> = [];
/** What the server answers a heartbeat with; `ok:false` is a swept row. */
let heartbeatAnswer: { ok: boolean } = { ok: true };

const convex = {
  mutation: async (fn: any, args: any) => {
    const name = getFunctionName(fn);
    mutations.push({ name, args });
    if (name.endsWith("heartbeat")) return heartbeatAnswer;
    return { room_key: args?.room_key };
  },
  action: async () => ({ url: "wss://sfu.example", token: "tok" }),
  query: async () => ({}),
};

const named = (suffix: string) => mutations.filter((c) => c.name.endsWith(suffix));

const ROOM = "dm:me:them";
const S = () => useInboxStore.getState();

/** The occupancy feed landing, exactly as useCallSync hands it to the store,
 *  with the sync window's held publish delivered now rather than 33ms on: the
 *  seat watcher is a store subscriber, and this is the visit it gets. */
function occupancy(rows: Array<{ user_id: string; walkie_joined_at?: number }>) {
  S().syncTable("callOccupancy", { [ROOM]: rows.map((r) => ({ user_name: r.user_id, muted: true, ...r })) });
  flushSyncPublishes();
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
  FakeRoom.made = [];
  mutations = [];
  soundLog.length = 0;
  heartbeatAnswer = { ok: true };
  scribeStopping = null;
  scribeStops = 0;
  S().setCallState({ phase: "idle", roomKey: null, muted: true, error: null, speaking: [] });
  occupancy([]);
  callManager.bindConvex(convex);
});

afterEach(async () => {
  scribeStopping?.resolve();
  await callManager.leaveCall();
});

const room = () => FakeRoom.made[FakeRoom.made.length - 1];

// ── (d) a reconnect is still the call ───────────────────────────────────────

describe("a LiveKit reconnect is still the call", () => {
  test("the phase holds at connected through Reconnecting, and every reader of it holds too", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    expect(S().call.phase).toBe("connected");

    room().emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting);

    // MUTATION CHECK: restore `setCall({ phase: "connecting" })` on
    // Reconnecting and all three of these flip, which is the off-then-on the
    // founder saw: the desktop says "not in a huddle", the knocks and the
    // auto-scribe watch lose their room, the dock paints "connecting".
    expect(S().call.phase).toBe("connected");
    expect(inHuddle(S())).toBe(true);
    const seatedRoomKey = S().call.phase === "connected" ? S().call.roomKey : null;
    expect(seatedRoomKey).toBe(ROOM);

    room().emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected);
    expect(S().call.phase).toBe("connected");
  });

  test("a heartbeat during the reconnect still re-takes a swept seat", async () => {
    // The recovery join is gated on `phase === "connected"`; a phase that
    // dipped to "connecting" for the reconnect would skip it and leave the
    // seat gone for good once the media came back.
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    room().emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting);
    mutations = [];
    heartbeatAnswer = { ok: false };
    await callManager.heartbeatOnce(ROOM);
    expect(named("joinRoom")).toHaveLength(1);
  });
});

// ── (b) the seat goes before the scribe ─────────────────────────────────────

describe("hanging up frees the seat before the scribe's teardown", () => {
  test("leaveRoom is sent while stopScribe is still running", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    mutations = [];
    let resolve!: () => void;
    scribeStopping = { promise: new Promise<void>((r) => { resolve = r; }), resolve: () => resolve() };

    const leaving = callManager.leaveCall();
    await settle();

    // MUTATION CHECK: move the leaveRoom mutation back below `stopScribe` and
    // this reads 0: the seat survives the flush, so every teammate's roster
    // keeps our face for as long as our pipes take to close.
    expect(scribeStops).toBe(1);
    expect(named("leaveRoom")).toHaveLength(1);
    expect(named("leaveRoom")[0].args).toEqual({ room_key: ROOM });

    scribeStopping.resolve();
    await leaving;
    expect(S().call.phase).toBe("idle");
  });
});

// ── (c) the re-taken seat keeps its stamp ───────────────────────────────────

describe("a seat re-taken after a sweep keeps its walkie stamp", () => {
  test("the recovery join re-sends walkie_join for a seat that was stamped", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate", walkieJoin: true });
    expect(named("joinRoom")[0].args.walkie_join).toBe(true);
    mutations = [];

    heartbeatAnswer = { ok: false };
    await callManager.heartbeatOnce(ROOM);

    // MUTATION CHECK: drop `walkieJoinedSeat` from controlJoin and the
    // re-take lands unstamped: to every third party the conversation reads
    // as a burst that ended, and the far side's surface falls back to the
    // strip.
    const retake = named("joinRoom");
    expect(retake).toHaveLength(1);
    expect(retake[0].args.walkie_join).toBe(true);
  });

  test("a seat that was never stamped is re-taken unstamped", async () => {
    // The stamp is intent, recorded rather than inferred: a recovery must
    // not invent one for an auto-listen seat.
    await callManager.joinCall(ROOM, { intent: "listen" });
    expect(named("joinRoom")[0].args.walkie_join).toBeUndefined();
    mutations = [];
    heartbeatAnswer = { ok: false };
    await callManager.heartbeatOnce(ROOM);
    expect(named("joinRoom")[0].args.walkie_join).toBeUndefined();
  });

  test("the stamp ends with the seat: the next join into the same room starts clean", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate", walkieJoin: true });
    await callManager.leaveCall();
    mutations = [];
    await callManager.joinCall(ROOM, { intent: "listen" });
    expect(named("joinRoom")[0].args.walkie_join).toBeUndefined();
  });
});

// ── (g) the chime follows the roster ────────────────────────────────────────

describe("the join chime follows the roster, not the SFU", () => {
  const peer = (identity: string) => ({ identity, name: identity, metadata: undefined, getTrackPublication: () => undefined, trackPublications: new Map() });

  test("a peer whose seat already landed chimes at once", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    soundLog.length = 0;
    occupancy([{ user_id: "me" }, { user_id: "them" }]);
    room().emit(RoomEvent.ParticipantConnected, peer("them"));
    expect(soundLog).toEqual(["join"]);
  });

  test("a peer whose media beats their row chimes when the row lands, once", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    soundLog.length = 0;
    room().emit(RoomEvent.ParticipantConnected, peer("them"));
    expect(soundLog).toEqual([]);
    occupancy([{ user_id: "me" }, { user_id: "them" }]);
    expect(soundLog).toEqual(["join"]);
    // A later roster push for the same seat is not a second arrival.
    occupancy([{ user_id: "me" }, { user_id: "them", walkie_joined_at: 1 }]);
    expect(soundLog).toEqual(["join"]);
  });

  test("a prewarm peer arrives and leaves in silence", async () => {
    // MUTATION CHECK: chime on ParticipantConnected unconditionally and the
    // first expectation reads ["join"]: a teammate who opened this DM, or
    // rested on a face, is announced as having walked in.
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    soundLog.length = 0;
    room().emit(RoomEvent.ParticipantConnected, peer("hoverer"));
    // Some other roster movement meanwhile must not be read as their seat.
    occupancy([{ user_id: "me" }, { user_id: "them" }]);
    room().emit(RoomEvent.ParticipantDisconnected, peer("hoverer"));
    expect(soundLog).toEqual([]);
  });

  test("a seated peer leaving still chimes out", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    occupancy([{ user_id: "me" }, { user_id: "them" }]);
    soundLog.length = 0;
    room().emit(RoomEvent.ParticipantConnected, peer("them"));
    room().emit(RoomEvent.ParticipantDisconnected, peer("them"));
    expect(soundLog).toEqual(["join", "leave"]);
  });
});

// ── (e) the linger draws ────────────────────────────────────────────────────

describe("the walkie's own linger is drawn, not hidden", () => {
  const status = (over: Record<string, unknown>) => ({
    sending: null,
    incoming: null,
    liveRoom: null,
    unavailable: null,
    canReply: false,
    asr: "live",
    error: null,
    ...over,
  }) as any;

  test("my seat lingering after Stop is still the walkie's surface", () => {
    // MUTATION CHECK: restore the `return "none"` for a quiet own seat and
    // the first expectation reads "none": the surface vanishes at Stop and
    // returns as a call when the far side's join lands, off then on.
    const linger = status({ liveRoom: { key: ROOM, mode: "burst", since: 1 } });
    const seated = { roomKey: ROOM, phase: "connected" };
    expect(callDockSurface(linger, seated, { expanded: false })).toBe("walkie");
    expect(callDockSurface(linger, seated, { expanded: true })).toBe("walkie");
    // Once the seat is released nothing is held, and nothing draws.
    expect(callDockSurface(status({}), { roomKey: null, phase: "idle" }, { expanded: false })).toBe("none");
  });
});
