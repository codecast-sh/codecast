import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// A call's video in the store (registry callRecordings / callRecordingCalls):
// deleting a run takes every file of it off the page in the same tick, marks
// the call as deleted here, and keeps the run off through a push computed
// before the delete committed. The delete is receipt-backed: only a refusal
// the server recorded brings the rows back; a failure on the way (a timeout,
// an offline socket) leaves the run gone for the outbox to land. The share
// switch moves on the press, holds through a stale push, and falls back
// when the server refuses.
const CALL = "k17callid";

const row = (id: string, run: string, kind: "composite" | "screen", status = "ready") => ({
  _id: id,
  run_id: run,
  kind,
  status,
  transcript_id: CALL,
  requested_at: run === "r1" ? 1_000 : 2_000,
  started_at: run === "r1" ? 1_100 : 2_100,
  url: `https://r2/${id}`,
});
const files = () => [row("a1", "r1", "composite"), row("a2", "r1", "screen"), row("b1", "r2", "composite")];
const facts = (video_shared: boolean) => ({ _id: CALL, short_id: "cl-7", call_started_at: 900, share_link: true, video_shared });

type Answer = "ack" | "reject" | "transient";

describe("call recordings local-first", () => {
  const owner = {};
  let calls: Array<{ action: string; args: any[] }>;
  let answer: Answer;

  beforeEach(() => {
    calls = [];
    answer = "ack";
    useInboxStore.setState({ callRecordings: {}, callRecordingCalls: {}, callFrameShares: {}, pending: {} } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[], _patches: any, result: any) => {
      calls.push({ action, args });
      if (answer === "transient") throw new Error("Your request timed out");
      if (action === "deleteCallRecording") {
        return answer === "reject"
          ? {
              receiptVersion: 1,
              commandId: result.commandId,
              commandName: "callRecordings.delete/v1",
              status: "rejected",
              rejection: { code: "STILL_RECORDING", message: "Stop the recording before deleting it" },
              coverage: [],
              retryUntil: null,
            }
          : { receiptVersion: 1, commandId: result.commandId, commandName: "callRecordings.delete/v1", status: "acknowledged", result: { deleted: 2 }, coverage: [], retryUntil: null };
      }
      if (answer === "reject") throw new Error("[CONVEX M(callRecordings:setCallShareVideo)] Uncaught Error: Turn on the share link first");
      return null;
    }, { owner });
    useInboxStore.getState().syncTable("callRecordings", files(), { isDelta: true });
    useInboxStore.getState().syncTable("callRecordingCalls", [facts(false)], { isDelta: true });
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  const st = () => useInboxStore.getState() as any;
  const ids = () => Object.keys(st().callRecordings).sort();
  const shared = () => st().callRecordingCalls[CALL].video_shared;
  const deletedHere = () => st().callRecordingCalls[CALL].deleted_here_at;
  const tombstones = () => Object.keys(st().pending).filter((k) => k.startsWith("callRecordings:")).sort();
  const tick = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("deletes the whole run at once, says so in the same frame, and a stale push cannot bring it back", async () => {
    const del = st().deleteCallRecording("a2");
    expect(ids()).toEqual(["b1"]);
    expect(typeof deletedHere()).toBe("number");
    await del;
    expect(calls.map((c) => [c.action, c.args])).toEqual([["deleteCallRecording", ["a2"]]]);
    useInboxStore.getState().syncTable("callRecordings", files(), { isDelta: true });
    expect(ids()).toEqual(["b1"]);
    // The mark survives the server's facts, which never carry it.
    useInboxStore.getState().syncTable("callRecordingCalls", [facts(false)], { isDelta: true });
    expect(typeof deletedHere()).toBe("number");
  });

  it("a recorded refusal puts the run back, lifts its tombstones and the mark, and rejects the caller", async () => {
    answer = "reject";
    const del = st().deleteCallRecording("a1");
    expect(ids()).toEqual(["b1"]);
    await expect(del).rejects.toMatchObject({ message: "Stop the recording before deleting it" });
    expect(ids()).toEqual(["a1", "a2", "b1"]);
    expect(tombstones()).toEqual([]);
    expect(deletedHere()).toBeUndefined();
  });

  it("a failure on the way is not a refusal: the run stays gone and the caller is not told it failed", async () => {
    answer = "transient";
    const { deleteRecordingRun } = await import("../../hooks/useRoomRecording");
    deleteRecordingRun("a1");
    await tick();
    expect(ids()).toEqual(["b1"]);
    expect(tombstones()).toEqual(["callRecordings:a1", "callRecordings:a2"]);
  });

  it("a push that no longer sends a deleted row lets its tombstone go", async () => {
    await st().deleteCallRecording("a1");
    expect(tombstones()).toEqual(["callRecordings:a1", "callRecordings:a2"]);
    const { releasedRecordingTombstones } = await import("../../hooks/useRoomRecording");
    const seen = new Map([[CALL, new Set(["a1", "a2", "b1"])], ["k17other", new Set(["z1"])]]);
    // Computed before the delete committed: still held out.
    expect(releasedRecordingTombstones(st().pending, CALL, ["a1", "a2", "b1"], seen)).toEqual([]);
    // Another call's answer says nothing about this call's delete.
    expect(releasedRecordingTombstones(st().pending, "k17other", ["z1"], seen)).toEqual([]);
    // After it: the server has let them go, and so does the store.
    const released = releasedRecordingTombstones(st().pending, CALL, ["b1"], seen);
    expect(released.sort()).toEqual(["a1", "a2"]);
    st().settleCallRecordingTombstones(released);
    expect(tombstones()).toEqual([]);
  });

  // A picture of the call on a public link (registry callFrameShares) leaves
  // the list on the press, stays gone through a push computed before the
  // delete committed, and its tombstone goes with the first answer that no
  // longer sends it; another collection's tombstones are not touched.
  it("a shared picture taken down leaves at once, and only its own tombstone settles", async () => {
    const share = (id: string) => ({ _id: id, transcript_id: CALL, recording_id: "a2", kind: "screen", at_ms: 150_000, url: `https://img/${id}`, shared_by: "u1", shared_by_name: "Ana", created_at: 5 });
    useInboxStore.getState().syncTable("callFrameShares", [share("f1"), share("f2")], { isDelta: true });
    await st().deleteCallRecording("b1");
    const down = st().deleteCallFrameShare("f1");
    expect(Object.keys(st().callFrameShares)).toEqual(["f2"]);
    await down;
    expect(calls.map((c) => [c.action, c.args]).at(-1)).toEqual(["deleteCallFrameShare", ["f1"]]);
    useInboxStore.getState().syncTable("callFrameShares", [share("f1"), share("f2")], { isDelta: true, pruneAbsentScope: (r: any) => r.transcript_id === CALL });
    expect(Object.keys(st().callFrameShares)).toEqual(["f2"]);
    const { releasedRecordingTombstones } = await import("../../hooks/useRoomRecording");
    const seen = new Map([[CALL, new Set(["f1", "f2"])]]);
    expect(releasedRecordingTombstones(st().pending, CALL, ["f1", "f2"], seen, "callFrameShares")).toEqual([]);
    const released = releasedRecordingTombstones(st().pending, CALL, ["f2"], seen, "callFrameShares");
    expect(released).toEqual(["f1"]);
    st().settleCallRecordingTombstones(released, "callFrameShares");
    expect(Object.keys(st().pending).filter((k) => k.startsWith("callFrameShares:"))).toEqual([]);
    expect(tombstones()).toEqual(["callRecordings:b1"]);
  });

  it("a tombstone from an earlier life of the tab goes with the first answer that lacks it", async () => {
    const { releasedRecordingTombstones } = await import("../../hooks/useRoomRecording");
    useInboxStore.setState({ pending: { "callRecordings:old1": { type: "exclude", ts: 1 } } } as any);
    expect(releasedRecordingTombstones(st().pending, CALL, ["b1"], new Map())).toEqual(["old1"]);
    expect(releasedRecordingTombstones(st().pending, CALL, ["old1"], new Map())).toEqual([]);
  });

  it("the share switch moves on the press and holds through a stale push", async () => {
    const press = st().setCallShareVideo(CALL, true);
    expect(shared()).toBe(true);
    await press;
    expect(calls.map((c) => [c.action, c.args])).toEqual([["setCallShareVideo", [CALL, true]]]);
    useInboxStore.getState().syncTable("callRecordingCalls", [facts(false)], { isDelta: true });
    expect(shared()).toBe(true);
    useInboxStore.getState().syncTable("callRecordingCalls", [facts(true)], { isDelta: true });
    useInboxStore.getState().syncTable("callRecordingCalls", [facts(false)], { isDelta: true });
    expect(shared()).toBe(false);
  });

  it("a refused share falls back to what the server holds", async () => {
    answer = "reject";
    await st().setCallShareVideo(CALL, true).catch(() => {});
    expect(shared()).toBe(false);
  });

  it("a null answer (access lost, or the call gone) takes the call's files and facts out at once, and only that call's", async () => {
    const { forgetCallRecordings } = await import("../../hooks/useRoomRecording");
    const OTHER = "k17other";
    useInboxStore.getState().syncTable("callRecordings", [{ ...row("z1", "r9", "composite"), transcript_id: OTHER }], { isDelta: true });
    useInboxStore.getState().syncTable("callRecordingCalls", [{ ...facts(false), _id: OTHER }], { isDelta: true });
    forgetCallRecordings(CALL);
    // No signed URL of this call is left for a player or a frame to keep using.
    expect(ids()).toEqual(["z1"]);
    expect(st().callRecordingCalls[CALL]).toBeUndefined();
    expect(st().callRecordingCalls[OTHER]).toBeDefined();
    // Forgetting a call the store never held changes nothing.
    const before = st().callRecordings;
    forgetCallRecordings("k17never");
    expect(st().callRecordings).toBe(before);
  });

  it("rows past their URL window are held back on a first mount, kept under a player already on screen", async () => {
    const { lapsedRowsVerdict } = await import("../../hooks/useRoomRecording");
    // A fresh mount onto old rows: the page holds the player's place.
    expect(lapsedRowsVerdict(true, false)).toBe("hold");
    // The tab slept through a rollover with the player up: it keeps its
    // place and says it is refreshing, never unmounts.
    expect(lapsedRowsVerdict(true, true)).toBe("refreshing");
    expect(lapsedRowsVerdict(false, false)).toBe("paint");
    expect(lapsedRowsVerdict(false, true)).toBe("paint");
  });
});
