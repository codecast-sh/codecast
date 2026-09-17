import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { bindConvex, joinCall } from "../calls/callManager";
import {
  getWalkieStatus,
  inOwnCall,
  observeWalkie,
  refreshWalkie,
  seatDeadline,
  walkieJoinedRoom,
} from "../calls/walkie";
import { useInboxStore } from "../../store/inboxStore";

// A RING ANSWERED INTO A BURST.
//
// Cam keys up in a DM; the walkie seats the other person to hear it. Cam
// long-presses the key and rings them, in the SAME room. They press Join. The
// join went through the ordinary accept — a deliberate join into a room the
// engine already held as a listen — and nothing told the engine that a
// person had decided to be there. So the seat's clock kept running: when
// Cam's key came up the engine handed the seat back with leaveCall, and the
// huddle they had just joined was hung up under them. Cam's own "ring them"
// had the same gap, so either side's clock could end it, and the other
// followed when the room emptied.
//
// Every deliberate join now passes through the engine (bindWalkieUpgrade): a
// room it holds becomes a call from that instant, and the seat is stamped so
// the far side's surface upgrades too.

const ROOM = "dm:cam:me";
const T0 = Date.now();

function burst(roomKey: string) {
  return {
    messageId: "m-cam",
    channelId: "c-cam",
    roomKey,
    fromUserId: "user_cam",
    fromName: "Cam",
    createdAt: T0 - 1_000,
  };
}

/** The control plane, recording seats and refusing the media: the engine's
 *  decision is made before the media plane is touched, and that is what these
 *  read. */
function fakeConvex() {
  const joins: any[] = [];
  bindConvex({
    mutation: async (_fn: unknown, args: any) => {
      if (args && "room_key" in args && "muted" in args) joins.push(args);
      return {};
    },
    action: async () => {
      throw new Error("no media in a unit test");
    },
    query: async () => null,
  });
  return joins;
}

beforeEach(() => {
  useInboxStore.getState().setCallState({ roomKey: null, phase: "idle", muted: true });
});

afterEach(() => {
  // Module state outlives this file under `bun test`: hand back an app with
  // no control plane, no burst and no call.
  observeWalkie({ bursts: [], doorOpen: false });
  useInboxStore.getState().setCallState({ roomKey: null, phase: "idle", muted: true });
  refreshWalkie();
  bindConvex(null as any);
});

describe("walkie: a deliberate join into a room the engine holds", () => {
  it("makes the room a call and stamps the seat, whichever button did it", async () => {
    const joins = fakeConvex();
    // Cam is talking; the engine seats this client to hear it.
    observeWalkie({ bursts: [burst(ROOM)], doorOpen: true });
    const held = getWalkieStatus().liveRoom;
    expect(held?.key).toBe(ROOM);
    expect(held?.mode).toBe("listen");
    expect(walkieJoinedRoom(getWalkieStatus())).toBeNull();

    // The ring is answered: the ordinary accept's deliberate join, with no
    // walkie flag on it — the accept does not know it is answering a burst.
    await joinCall(ROOM, { intent: "deliberate" });

    // The engine knows a person stepped in...
    expect(walkieJoinedRoom(getWalkieStatus())).toBe(ROOM);
    // ...and the seat was stamped for the far side.
    const seat = joins.find((j) => j.walkie_join === true);
    expect(seat?.room_key).toBe(ROOM);
    // ...so the clock that used to hang the call up is off, even once Cam's
    // key comes up and nothing else is happening in the room.
    expect(
      seatDeadline({ live: getWalkieStatus().liveRoom, bursting: false, incoming: null, lastAudioAt: T0 }),
    ).toBeNull();
  });

  it("leaves a room the engine does not hold alone", async () => {
    const joins = fakeConvex();
    await joinCall("dm:someone:else", { intent: "deliberate" });
    expect(walkieJoinedRoom(getWalkieStatus())).toBeNull();
    expect(joins.some((j) => j.walkie_join)).toBe(false);
  });
});

describe("walkie: what counts as a call of one's own", () => {
  // The ring's one question, asked by the voice host (draw the ring or keep
  // the stage), the ring hook (open the ring window or not) and the ring
  // window (draw or stand down). One answer, or one ring becomes two cards.
  const status = (liveRoom: any) => ({
    sending: null,
    incoming: null,
    liveRoom,
    unavailable: null,
    canReply: false,
    asr: "live" as const,
    error: null,
  });

  it("is not a seat the walkie holds to hear a burst", () => {
    const listen = status({ key: ROOM, mode: "listen", since: T0 });
    expect(inOwnCall(listen, { phase: "connected", roomKey: ROOM })).toBe(false);
    const talking = status({ key: ROOM, mode: "burst", since: T0 });
    expect(inOwnCall(talking, { phase: "connected", roomKey: ROOM })).toBe(false);
  });

  it("is a huddle, however it started", () => {
    expect(inOwnCall(status(null), { phase: "connected", roomKey: "huddle:1" })).toBe(true);
    const upgraded = status({ key: ROOM, mode: "call", since: T0 });
    expect(inOwnCall(upgraded, { phase: "connected", roomKey: ROOM })).toBe(true);
    // A huddle in another room while the walkie holds this one is still a call.
    const listen = status({ key: ROOM, mode: "listen", since: T0 });
    expect(inOwnCall(listen, { phase: "connecting", roomKey: "huddle:1" })).toBe(true);
  });

  it("is nothing when there is no call", () => {
    expect(inOwnCall(status(null), { phase: "idle", roomKey: null })).toBe(false);
  });
});
