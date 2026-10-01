import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// Record and Stop paint the room's red mark (callRooms.recording) in the same
// tick, ride the setRoomRecording dispatch (convex callRecordings start/stop),
// take the server's word on every push after (the flag is the server's), and
// put the mark back when the server refuses the press.
const ROOM = "channel:design";

const flags = (recording: boolean) => ({ _id: ROOM, locked: false, transcribe_off: false, transcribe_off_at: null, recording });

describe("room recording local-first", () => {
  const owner = {};
  let calls: Array<{ action: string; args: any[] }>;
  let refuse: string | null;

  beforeEach(() => {
    calls = [];
    refuse = null;
    useInboxStore.setState({ callRooms: {}, pending: {} } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
      calls.push({ action, args });
      if (refuse) throw new Error(refuse);
      return null;
    }, { owner });
    useInboxStore.getState().syncTable("callRooms", [flags(false)]);
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  const mark = () => (useInboxStore.getState() as any).callRooms[ROOM].recording;

  it("paints the mark at once and rides the dispatch", async () => {
    const press = useInboxStore.getState().setRoomRecording(ROOM, true);
    expect(mark()).toBe(true);
    await press;
    expect(calls.map((c) => [c.action, c.args])).toEqual([["setRoomRecording", [ROOM, true]]]);
  });

  it("takes the server's word on every push, even one that never said true", async () => {
    // A run LiveKit refused at once, or one somebody stopped a moment after
    // the press: the server goes false without this window ever seeing true.
    // A lock waiting for true would hold the mark up over a room nobody films.
    await useInboxStore.getState().setRoomRecording(ROOM, true);
    expect(mark()).toBe(true);
    useInboxStore.getState().syncTable("callRooms", [flags(false)]);
    expect(mark()).toBe(false);
    expect(Object.keys((useInboxStore.getState() as any).pending).filter((k) => k.endsWith(":recording"))).toEqual([]);
  });

  it("a refused press takes the mark down and says why", async () => {
    // How a mutation's own throw reaches the client: deterministic, so not retried.
    refuse = "[CONVEX M(callRecordings:startRecording)] Uncaught Error: Recording is not set up on this server";
    const { setRoomRecording } = await import("../../hooks/useRoomRecording");
    await setRoomRecording(ROOM, true);
    expect(mark()).toBe(false);
  });
});
