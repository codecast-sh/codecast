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
  let answer: unknown;

  beforeEach(() => {
    calls = [];
    refuse = null;
    answer = null;
    useInboxStore.setState({ callRooms: {}, pending: {} } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
      calls.push({ action, args });
      if (refuse) throw new Error(refuse);
      return answer;
    }, { owner });
    useInboxStore.getState().syncTable("callRooms", [flags(false)]);
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  const mark = () => (useInboxStore.getState() as any).callRooms[ROOM].recording;

  it("paints the mark at once and rides the dispatch", async () => {
    const press = useInboxStore.getState().setRoomRecording(ROOM, true, 1_000);
    expect(mark()).toBe(true);
    await press;
    expect(calls.map((c) => [c.action, c.args])).toEqual([["setRoomRecording", [ROOM, true, 1_000]]]);
  });

  it("takes the server's word on every push, even one that never said true", async () => {
    // A run LiveKit refused at once, or one somebody stopped a moment after
    // the press: the server goes false without this window ever seeing true.
    // A lock waiting for true would hold the mark up over a room nobody films.
    await useInboxStore.getState().setRoomRecording(ROOM, true, 1_000);
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

  // The web and the phone press through one function (lib/calls/
  // recordingPress); only how a refusal is said is theirs.
  it("the shared press says a refusal in the caller's own way, and notes the run a press made", async () => {
    const { pressRoomRecording, pressedRunOf } = await import("../../lib/calls/recordingPress");
    refuse = "[CONVEX M(callRecordings:startRecording)] Uncaught Error: Recording is not set up on this server";
    const said: string[] = [];
    await pressRoomRecording(ROOM, true, (message) => said.push(message));
    expect(mark()).toBe(false);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Recording is not set up on this server");
    refuse = null;
    answer = { recording_id: "run9", existing: false };
    await pressRoomRecording(ROOM, true, (message) => said.push(message));
    expect(said).toHaveLength(1);
    expect(pressedRunOf(ROOM)).toBe("run9");
  });

  // A Stop rides the outbox and may land late: it names the run its mark
  // showed, so it never ends a run somebody started after it was pressed.
  it("a Stop carries the run the mark showed; a Record carries none", async () => {
    const { pressRoomRecording } = await import("../../lib/calls/recordingPress");
    useInboxStore.getState().syncTable("callRooms", [
      { ...flags(true), recording_status: "recording", recording_run_id: "run1", recording_by_id: "u2", recording_by_name: "Ana", recording_requested_at: 1 },
    ]);
    await pressRoomRecording(ROOM, false, () => {});
    expect(calls.at(-1)!.args).toEqual([ROOM, false, expect.any(Number), "run1"]);
    useInboxStore.getState().syncTable("callRooms", [flags(false)]);
    await pressRoomRecording(ROOM, true, () => {});
    expect(calls.at(-1)!.args).toEqual([ROOM, true, expect.any(Number)]);
  });

  // A press is a moment (shared recordingPressStale): the dispatch binding
  // refuses one that is no longer, on every send, so a press that could not
  // be delivered when it was made never films the room later.
  describe("a press that did not land", () => {
    it("could not reach the server: the mark comes down, and the queued copy is dead", async () => {
      const { setRoomRecording } = await import("../../hooks/useRoomRecording");
      const { deadRecordingPress } = await import("../../lib/calls/recordingPress");
      refuse = "Your request timed out";
      await setRoomRecording(ROOM, true);
      expect(mark()).toBe(false);
      // The outbox re-drives the same args a moment later, within the
      // window: the person was told it did not start, so it must not.
      const sent = calls[calls.length - 1];
      expect(sent.action).toBe("setRoomRecording");
      expect(deadRecordingPress(sent.action, sent.args, sent.args[2] + 1_000)).not.toBeNull();
      // The send is tried four times over seven seconds before it gives up,
      // then the row is given PRESS_SETTLE_MS to show the press landed.
    }, 30_000);

    // Under load a mutation can run on the server while its answer is lost
    // (a dropped socket, a late receipt). The presser must not then be told
    // the room is not being filmed: the room's row says what happened.
    it("a send that failed but whose run the row shows is a press that worked", async () => {
      const { pressRoomRecording, pressedRunOf } = await import("../../lib/calls/recordingPress");
      useInboxStore.setState({ currentUser: { _id: "me1" } } as any);
      const said: string[] = [];
      const at = Date.now();
      useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
        calls.push({ action, args });
        // The server ran it, and its push lands before the answer is lost.
        useInboxStore.getState().syncTable("callRooms", [
          {
            ...flags(true),
            recording_status: "starting",
            recording_run_id: "runLost",
            recording_by_id: "me1",
            recording_by_name: "Me",
            recording_requested_at: at,
          },
        ]);
        throw new Error("Connection lost while action was in flight");
      }, { owner });
      await pressRoomRecording(ROOM, true, (message) => said.push(message));
      expect(said).toEqual([]);
      expect(mark()).toBe(true);
      expect(pressedRunOf(ROOM)).toBe("runLost");
    }, 20_000);

    it("the row decides a failed send: someone else's run or an old one does not confirm a Record", async () => {
      const { pressConfirmedBy } = await import("../../lib/calls/recordingPress");
      const row = { recording: true, recording_status: "recording" as const, recording_run_id: "r1", recording_by_id: "u2", recording_requested_at: 1_000 };
      expect(pressConfirmedBy(row, true, 1_000, "me1")).toBe(false);
      expect(pressConfirmedBy({ ...row, recording_by_id: "me1" }, true, 1_000, "me1")).toBe("r1");
      expect(pressConfirmedBy({ ...row, recording_by_id: "me1" }, true, 60_000, "me1")).toBe(false);
      // Stop: the run gone or saving confirms; one still filming does not.
      expect(pressConfirmedBy(row, false, 1_000, "me1")).toBe(false);
      expect(pressConfirmedBy({ ...row, recording_status: "stopping" }, false, 1_000, "me1")).toBe(true);
      expect(pressConfirmedBy({ recording: false, recording_status: null }, false, 1_000, "me1")).toBe(true);
      // A row from a server too old to name the run confirms nothing.
      expect(pressConfirmedBy({ recording: true }, true, 1_000, "me1")).toBe(false);
    });

    it("a replay after a reload is refused as stale, and a fresh press is not", async () => {
      const { deadRecordingPress } = await import("../../lib/calls/recordingPress");
      const { isRefusedDispatchError } = await import("../mutativeMiddleware");
      const pressedAt = 5_000_000;
      expect(deadRecordingPress("setRoomRecording", [ROOM, true, pressedAt], pressedAt + 2_000)).toBeNull();
      const late = deadRecordingPress("setRoomRecording", ["channel:other", true, pressedAt], pressedAt + 10 * 60_000);
      // Final, so the outbox drops the row instead of trying again.
      expect(isRefusedDispatchError(late)).toBe(true);
      // A stale Stop is refused too: it would end a run somebody has since started.
      expect(deadRecordingPress("setRoomRecording", ["channel:other", false, pressedAt], pressedAt + 10 * 60_000)).not.toBeNull();
      expect(deadRecordingPress("setRoomLocked", [ROOM, true], pressedAt + 10 * 60_000)).toBeNull();
    });

    it("Record, Stop, Record while offline is one queued press, the last", async () => {
      const { outboxCoalesceKeyFor } = await import("../mutativeMiddleware");
      const key = outboxCoalesceKeyFor("setRoomRecording", [ROOM, true, 1]);
      expect(key).toBe(outboxCoalesceKeyFor("setRoomRecording", [ROOM, false, 2]));
      expect(key).not.toBe(outboxCoalesceKeyFor("setRoomRecording", ["channel:other", true, 1]));
    });

    it("a second press while one is in flight is dropped", async () => {
      const { setRoomRecording } = await import("../../hooks/useRoomRecording");
      const first = setRoomRecording(ROOM, true);
      await setRoomRecording(ROOM, false);
      await first;
      expect(calls.filter((c) => c.action === "setRoomRecording").map((c) => c.args[1])).toEqual([true]);
    });
  });

  // One home: the run behind the flag rides the room's row (getLiveRooms).
  describe("the run on the room's row", () => {
    it("files the run flat, and reads it back as the mark's detail", async () => {
      const { roomRecordingFields, roomRecordingLive } = await import("../../hooks/useRoomRecording");
      const room = {
        recording: false,
        recording_configured: true,
        recording_run: { status: "stopping", run_id: "run1", started_by: { id: "u1", name: "Ann" }, requested_at: 10, started_at: 20 },
      };
      const fields = roomRecordingFields(room);
      expect(fields).toMatchObject({ recording: false, recording_status: "stopping", recording_by_name: "Ann", recording_configured: true });
      expect(roomRecordingLive(fields)).toEqual({
        status: "stopping",
        run_id: "run1",
        started_by: { id: "u1", name: "Ann" },
        requested_at: 10,
        started_at: 20,
        stop_requested_at: null,
        video_shared: false,
      });
      // Why a press cannot work right now rides the row beside whether it could.
      expect(roomRecordingFields({ ...room, recording_unavailable: "Out of minutes" }).recording_unavailable).toBe("Out of minutes");
      // Nothing runs: said, not left unknown.
      expect(roomRecordingLive(roomRecordingFields({ recording: false, recording_run: null }))).toBeNull();
      // A server that does not send the run: unknown, so the flag decides.
      expect(roomRecordingLive(roomRecordingFields({ recording: true }))).toBeUndefined();
    });

    it("a push that ends the run clears every field of it", () => {
      const st = useInboxStore.getState();
      st.syncTable("callRooms", [{ ...flags(true), recording_status: "recording", recording_run_id: "run1", recording_by_id: "u1", recording_by_name: "Ann", recording_requested_at: 1, recording_started_at: 2 }]);
      st.syncTable("callRooms", [{ ...flags(false), recording_status: null, recording_run_id: null, recording_by_id: null, recording_by_name: null, recording_requested_at: null, recording_started_at: null }]);
      const row = (useInboxStore.getState() as any).callRooms[ROOM];
      expect([row.recording, row.recording_status, row.recording_run_id]).toEqual([false, null, null]);
    });
  });
});
