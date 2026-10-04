import { describe, expect, it } from "bun:test";
import { recordingMarkStatus } from "../../lib/calls/recordingPress";
import type { RoomRecordingLive } from "../../lib/calls/roomRecordingFields";

// The red mark from what a window knows: its own press in flight, and the
// room's row in the store (the flag, and the run behind it when the server
// sends one; both ride calls.getLiveRooms). A press decides while it is in
// flight, then the run, and the flag alone only on a server too old to send
// the run.
const live = (status: RoomRecordingLive["status"]): RoomRecordingLive => ({
  status,
  run_id: "run1",
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
