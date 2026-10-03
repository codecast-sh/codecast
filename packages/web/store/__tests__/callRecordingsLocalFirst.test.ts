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
    useInboxStore.setState({ callRecordings: {}, callRecordingCalls: {}, pending: {} } as any);
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
    // Computed before the delete committed: still held out.
    st().settleCallRecordingTombstones(files().map((r) => r._id));
    expect(tombstones()).toEqual(["callRecordings:a1", "callRecordings:a2"]);
    // After it: the server has let them go, and so does the store.
    st().settleCallRecordingTombstones(["b1"]);
    expect(tombstones()).toEqual([]);
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
});
