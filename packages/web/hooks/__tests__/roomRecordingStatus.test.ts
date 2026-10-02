import { describe, expect, it } from "bun:test";
import { recordingMarkStatus, type RoomRecordingLive } from "../useRoomRecording";

// The red mark from three reads that arrive by different roads: this
// window's press in flight, the room's flag (getLiveRooms through the store,
// replicated to follower windows), and the detail (getRoomRecording). The
// four races the reviewers named: a press before either server read moves,
// the detail landing before the flag on somebody else's press, the flag
// trailing the detail at a run's end, and a server too old for the detail.
const live = (status: RoomRecordingLive["status"]): RoomRecordingLive => ({
  status,
  run_id: "run1",
  transcript_id: "t1",
  call_short_id: "cl-1",
  started_by: { id: "u1", name: "Ann" },
  requested_at: 1,
  started_at: status === "starting" ? null : 2,
});

describe("recordingMarkStatus", () => {
  it("my press decides while it is in flight", () => {
    expect(recordingMarkStatus({ press: true, flag: false, live: null })).toBe("starting");
    expect(recordingMarkStatus({ press: true, flag: true, live: live("recording") })).toBe("recording");
    expect(recordingMarkStatus({ press: false, flag: true, live: live("recording") })).toBe("stopping");
    expect(recordingMarkStatus({ press: false, flag: true, live: null })).toBeNull();
  });
  it("somebody else's press: the detail landed first, the flag still says off", () => {
    expect(recordingMarkStatus({ press: null, flag: false, live: live("recording") })).toBe("recording");
  });
  it("a run that ended: the flag trails, the detail says nothing runs", () => {
    expect(recordingMarkStatus({ press: null, flag: true, live: null })).toBeNull();
    expect(recordingMarkStatus({ press: null, flag: true, live: live("stopping") })).toBe("stopping");
  });
  it("a server without the detail: the flag alone", () => {
    expect(recordingMarkStatus({ press: null, flag: true, live: undefined })).toBe("recording");
    expect(recordingMarkStatus({ press: null, flag: false, live: undefined })).toBeNull();
  });
});
