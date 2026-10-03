import { describe, expect, it } from "bun:test";
import { owedStopNotice, roomRunWatch, STOP_NEWS_MS, watchRoomRun, type RoomRecordingEnd } from "./roomRecordingEnd";
import type { RoomRecordingLive } from "./roomRecordingFields";

// The walk every screen in a huddle takes over the room's runs (the web's
// notice and the phone's call screen): a stop is said once, the presser of a
// run LiveKit refused is told even though REC never came on, and a newer run
// makes the last stop old news.

const run = (over: Partial<RoomRecordingLive> = {}): RoomRecordingLive => ({
  status: "recording",
  run_id: "r1",
  started_by: { id: "u1", name: "Ann Lee" },
  requested_at: 1,
  started_at: 2,
  stop_requested_at: null,
  video_shared: false,
  ...over,
});
const end = (over: Partial<RoomRecordingEnd> = {}): RoomRecordingEnd => ({
  run_id: "r1",
  status: "ready",
  stop_reason: "pressed",
  error: null,
  stopped_by: { id: "u2", name: "Bo Park" },
  ...over,
});

describe("watchRoomRun", () => {
  it("owes the room a stop once a run it saw filming goes", () => {
    const told = new Set<string>();
    const noticed = (k: string) => told.has(k);
    const w = roomRunWatch("room");
    expect(watchRoomRun(w, run(), undefined, null, noticed, 0).running?.run_id).toBe("r1");
    expect(owedStopNotice(w, undefined, "u1", noticed, 0)).toBeNull();
    const step = watchRoomRun(w, run({ status: "stopping" }), undefined, null, noticed, 10);
    expect(step.stopped?.run_id).toBe("r1");
    // The end has not arrived yet: hold.
    expect(owedStopNotice(w, undefined, "u1", noticed, 10)?.how).toBe("wait");
    const owed = owedStopNotice(w, end(), "u1", noticed, 20);
    expect(owed?.how).toBe("say");
    expect(owed?.key).toBe("stop:r1");
    // Said once: another screen of this person's claimed it.
    told.add("stop:r1");
    expect(owedStopNotice(w, end(), "u1", noticed, 30)?.how).toBe("drop");
  });

  it("tells the presser why a run LiveKit refused never started", () => {
    const w = roomRunWatch("room");
    const refused = end({ run_id: "r9", status: "failed", stop_reason: "failed", stopped_by: null, error: "egress minutes exceeded" });
    watchRoomRun(w, null, refused, "r9", () => false, 0);
    const owed = owedStopNotice(w, refused, "u1", () => false, 0);
    expect(owed?.how).toBe("say");
    expect(owed?.stop.was.run_id).toBe("r9");
    // Somebody else's refused press is not this person's to be told about.
    const other = roomRunWatch("room");
    watchRoomRun(other, null, refused, "r8", () => false, 0);
    expect(owedStopNotice(other, refused, "u1", () => false, 0)).toBeNull();
  });

  it("says only where the file went to whoever pressed Stop, once it lands", () => {
    const w = roomRunWatch("room");
    watchRoomRun(w, run(), undefined, null, () => false, 0);
    watchRoomRun(w, null, undefined, null, () => false, 1);
    const mine = end({ status: "stopping", stopped_by: { id: "u1", name: "Ann" } });
    expect(owedStopNotice(w, mine, "u1", () => false, 2)?.how).toBe("wait");
    expect(owedStopNotice(w, { ...mine, status: "ready" }, "u1", () => false, 3)?.how).toBe("saved");
  });

  it("drops the last stop when a newer run begins, or when it is old news", () => {
    const w = roomRunWatch("room");
    watchRoomRun(w, run(), undefined, null, () => false, 0);
    watchRoomRun(w, null, undefined, null, () => false, 1);
    expect(w.stop?.was.run_id).toBe("r1");
    watchRoomRun(w, run({ run_id: "r2" }), undefined, null, () => false, 2);
    expect(w.stop).toBeNull();

    const late = roomRunWatch("room");
    watchRoomRun(late, run(), undefined, null, () => false, 0);
    watchRoomRun(late, null, undefined, null, () => false, 1);
    expect(owedStopNotice(late, end(), "u3", () => false, 1 + STOP_NEWS_MS)?.how).toBe("drop");
  });
});
