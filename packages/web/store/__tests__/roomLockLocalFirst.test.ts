import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// The flags a person flips inside a huddle (the lock, the transcription
// switch) live in `callRooms`, one localFirst row per room. The control flips
// in the same tick, a getLiveRooms push computed before the write committed
// (the query re-runs on every call_members heartbeat) must not flap it back,
// and once the server agrees its value is the one that stands.
const ROOM = "dm:ann:me";

function serverFlags(locked: boolean, transcribe_off = false) {
  return { _id: ROOM, locked, transcribe_off, transcribe_off_at: transcribe_off ? 1_000 : null };
}

describe("room flags local-first", () => {
  const owner = {};
  let calls: Array<{ action: string; args: any[] }>;

  beforeEach(() => {
    calls = [];
    useInboxStore.setState({ callRooms: {}, pending: {} } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
      calls.push({ action, args });
      return null;
    }, { owner });
    useInboxStore.getState().syncTable("callRooms", [serverFlags(false)]);
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  it("rides the same-named dispatch side effects", async () => {
    useInboxStore.getState().setRoomLocked(ROOM, true);
    await useInboxStore.getState().setRoomTranscribeOff(ROOM, true);
    expect(calls.map((c) => [c.action, c.args])).toEqual([
      ["setRoomLocked", [ROOM, true]],
      ["setRoomTranscribeOff", [ROOM, true]],
    ]);
  });

  it("flips the lock in the same tick", () => {
    useInboxStore.getState().setRoomLocked(ROOM, true);
    expect((useInboxStore.getState() as any).callRooms[ROOM].locked).toBe(true);
  });

  it("keeps the in-flight lock when a stale live-rooms push arrives", () => {
    useInboxStore.getState().setRoomLocked(ROOM, true);
    useInboxStore.getState().syncTable("callRooms", [serverFlags(false)]);
    expect((useInboxStore.getState() as any).callRooms[ROOM].locked).toBe(true);
  });

  it("takes the server's value once it agrees", () => {
    useInboxStore.getState().setRoomLocked(ROOM, true);
    useInboxStore.getState().syncTable("callRooms", [serverFlags(true)]);
    useInboxStore.getState().syncTable("callRooms", [serverFlags(false)]);
    expect((useInboxStore.getState() as any).callRooms[ROOM].locked).toBe(false);
  });

  it("paints the transcription switch off and stamps the opt-out for this window's scribe", () => {
    const before = Date.now();
    void useInboxStore.getState().setRoomTranscribeOff(ROOM, true);
    const row = (useInboxStore.getState() as any).callRooms[ROOM];
    expect(row.transcribe_off).toBe(true);
    expect(row.transcribe_off_at).toBeGreaterThanOrEqual(before);
    // A stale push holds the switch, but the server's clock replaces ours.
    useInboxStore.getState().syncTable("callRooms", [serverFlags(false)]);
    expect((useInboxStore.getState() as any).callRooms[ROOM].transcribe_off).toBe(true);
    useInboxStore.getState().syncTable("callRooms", [serverFlags(false, true)]);
    expect((useInboxStore.getState() as any).callRooms[ROOM].transcribe_off_at).toBe(1_000);
  });

  it("holds the transcription switch and the lock independently", () => {
    useInboxStore.getState().setRoomLocked(ROOM, true);
    void useInboxStore.getState().setRoomTranscribeOff(ROOM, true);
    // The server took the lock but has not seen the switch yet.
    useInboxStore.getState().syncTable("callRooms", [serverFlags(true, false)]);
    const row = (useInboxStore.getState() as any).callRooms[ROOM];
    expect(row.locked).toBe(true);
    expect(row.transcribe_off).toBe(true);
  });

  it("paints a room the feed has not listed yet", () => {
    useInboxStore.getState().setRoomLocked("dm:bo:me", true);
    expect((useInboxStore.getState() as any).callRooms["dm:bo:me"].locked).toBe(true);
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

describe("callRooms at boot", () => {
  it("is a registered collection with an empty floor, so a press before the first push still paints", async () => {
    const { collectionInitialState } = await import("../clientSyncRegistry");
    expect((collectionInitialState() as any).callRooms).toEqual({});
  });
});
