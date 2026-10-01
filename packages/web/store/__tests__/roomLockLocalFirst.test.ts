import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// Locking a huddle must be local-first: the glyph flips in the same tick, and
// a getLiveRooms push computed before setRoomLocked committed (the query
// re-runs on every call_members heartbeat) must not flap it back. When the
// server agrees, the protection stops; when the mutation is refused, the room
// goes back to the state it never left.
const ROOM = "dm:ann:me";

function serverRoom(locked: boolean) {
  return {
    room_key: ROOM,
    team_id: "team1",
    locked,
    redacted: false,
    members: [{ user_id: "me", user_name: "Ashot" }],
  };
}

describe("room lock local-first toggle", () => {
  beforeEach(() => {
    useInboxStore.setState({ liveRooms: [serverRoom(false)], callRoomPending: {} } as any);
  });

  it("flips the lock in the same tick and records the pending intent", () => {
    useInboxStore.getState().noteRoomPending(ROOM, { locked: true });
    const s = useInboxStore.getState() as any;
    expect(s.liveRooms[0].locked).toBe(true);
    expect(s.callRoomPending[ROOM].flags.locked).toBe(true);
  });

  it("keeps the in-flight lock when a stale live-rooms push arrives", () => {
    useInboxStore.getState().noteRoomPending(ROOM, { locked: true });
    useInboxStore.getState().syncTable("liveRooms", [serverRoom(false)]);
    const s = useInboxStore.getState() as any;
    expect(s.liveRooms[0].locked).toBe(true);
    expect(s.callRoomPending[ROOM]).toBeDefined();
  });

  it("stops protecting once the server reflects the lock", () => {
    useInboxStore.getState().noteRoomPending(ROOM, { locked: true });
    useInboxStore.getState().syncTable("liveRooms", [serverRoom(true)]);
    const s = useInboxStore.getState() as any;
    expect(s.liveRooms[0].locked).toBe(true);
    expect(s.callRoomPending[ROOM]).toBeUndefined();
  });

  it("gives up on a protection the server never accepted", () => {
    useInboxStore.setState({
      callRoomPending: { [ROOM]: { flags: { locked: true }, at: Date.now() - 60_000 } },
      liveRooms: [serverRoom(true)],
    } as any);
    useInboxStore.getState().syncTable("liveRooms", [serverRoom(false)]);
    const s = useInboxStore.getState() as any;
    expect(s.liveRooms[0].locked).toBe(false);
    expect(s.callRoomPending[ROOM]).toBeUndefined();
  });

  it("holds the transcription switch and the lock independently", () => {
    useInboxStore.getState().noteRoomPending(ROOM, { locked: true });
    useInboxStore.getState().noteRoomPending(ROOM, { transcribe_off: true });
    // The server took the lock but has not seen the switch yet.
    useInboxStore.getState().syncTable("liveRooms", [{ ...serverRoom(true), transcribe_off: false }]);
    let s = useInboxStore.getState() as any;
    expect(s.liveRooms[0].transcribe_off).toBe(true);
    expect(s.callRoomPending[ROOM].flags).toEqual({ transcribe_off: true });
    useInboxStore.getState().syncTable("liveRooms", [{ ...serverRoom(true), transcribe_off: true }]);
    s = useInboxStore.getState() as any;
    expect(s.callRoomPending[ROOM]).toBeUndefined();
  });

  it("reverts to the prior state when the mutation is refused", () => {
    useInboxStore.getState().noteRoomPending(ROOM, { locked: true });
    useInboxStore.getState().revertRoomPending(ROOM, { locked: false });
    const s = useInboxStore.getState() as any;
    expect(s.liveRooms[0].locked).toBe(false);
    expect(s.callRoomPending[ROOM]).toBeUndefined();
  });
});

describe("knock bookkeeping", () => {
  beforeEach(() => {
    useInboxStore.setState({ callKnocked: {} } as any);
  });

  it("remembers a knock so the admit ring can answer itself, and forgets it after", () => {
    useInboxStore.getState().noteKnock(ROOM);
    expect((useInboxStore.getState() as any).callKnocked[ROOM]).toBeGreaterThan(0);
    useInboxStore.getState().clearKnock(ROOM);
    expect((useInboxStore.getState() as any).callKnocked[ROOM]).toBeUndefined();
  });
});
