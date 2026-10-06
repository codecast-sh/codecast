import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { applyDispatchFailure, makeDispatchBinding, newDispatchAckState, type DispatchCallArgs } from "../dispatchBinding";

const ID = "a".repeat(32);
const store = () => useInboxStore.getState();

describe("dispatch binding", () => {
  let stamps: any[][];
  let realStamp: ReturnType<typeof store>["stampSyncAck"];

  beforeEach(() => {
    stamps = [];
    realStamp = store().stampSyncAck;
    useInboxStore.setState({ stampSyncAck: (...a: any[]) => { stamps.push(a); } } as any);
  });
  afterEach(() => {
    useInboxStore.setState({ stampSyncAck: realStamp } as any);
  });

  it("unwraps __syncAckV1, stamps the ack with the patches and the send time, and returns the inner result", async () => {
    const now = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const calls: DispatchCallArgs[] = [];
    const ack = [{ scope_key: "user:u1", position: 7 }];
    const patches = { sessions: { [ID]: { is_pinned: true } } };
    const dispatch = makeDispatchBinding(async (args) => {
      calls.push(args);
      return { __syncAckV1: ack, result: { ok: 1 } };
    });
    try {
      const res = await dispatch("pinSession", [ID], patches, undefined);
      expect(res).toEqual({ ok: 1 });
      expect(calls).toEqual([{ action: "pinSession", args: [ID], patches, result: undefined, ack_positions: true }]);
      expect(stamps).toEqual([[patches, ack, 1_700_000_000_000]]);
    } finally {
      now.mockRestore();
    }
  });

  it("passes a result without the envelope through untouched and stamps nothing", async () => {
    const dispatch = makeDispatchBinding(async () => ({ plain: true }));
    expect(await dispatch("x", [], { a: 1 }, undefined)).toEqual({ plain: true });
    expect(stamps).toEqual([]);
  });

  it("stamps durable delivery receipts on their own entity and returns immediately after the save", async () => {
    const patches = { conversations: { [ID]: { title: "Saved" } } };
    const dispatch = makeDispatchBinding(async () => ({
      __syncAckV1: [],
      __syncAckV2: [{ id: "delivery", revision: 3, entity_type: "conversations", entity_id: ID }],
      result: "saved",
    }));
    expect(await dispatch("renameSession", [ID], patches, undefined)).toBe("saved");
    expect(stamps).toHaveLength(1);
    expect(stamps[0][0]).toEqual(patches);
    expect(stamps[0][1]).toEqual([{ scope_key: "outbox:delivery", position: 3 }]);
  });

  it("latches off on an ArgumentValidationError naming ack_positions and re-issues the call unflagged", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const state = newDispatchAckState();
    const calls: DispatchCallArgs[] = [];
    const dispatch = makeDispatchBinding(async (args) => {
      calls.push(args);
      if (args.ack_positions) throw new Error("ArgumentValidationError: Object contains extra field `ack_positions`");
      return "done";
    }, state);
    try {
      expect(await dispatch("killSession", [ID], undefined, undefined)).toBe("done");
      expect(state.ackFlagSupported).toBe(false);
      expect(calls.map((c) => c.ack_positions)).toEqual([true, undefined]);
      // Latched: the next call goes out unflagged the first time.
      expect(await dispatch("killSession", [ID], undefined, undefined)).toBe("done");
      expect(calls.map((c) => c.ack_positions)).toEqual([true, undefined, undefined]);
      // A second binding sharing the state object inherits the latch.
      const sibling = makeDispatchBinding(async (args) => { calls.push(args); return "ok"; }, state);
      await sibling("pinSession", [ID], undefined, undefined);
      expect(calls[3].ack_positions).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not retry other validation errors", async () => {
    const state = newDispatchAckState();
    let n = 0;
    const dispatch = makeDispatchBinding(async () => {
      n++;
      throw new Error("ArgumentValidationError: Value does not match validator. Path: .args[0]");
    }, state);
    await expect(dispatch("killSession", ["bad"], undefined, undefined)).rejects.toThrow("ArgumentValidationError");
    expect(n).toBe(1);
    expect(state.ackFlagSupported).toBe(true);
  });
});

describe("applyDispatchFailure", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: { [ID]: { _id: ID, session_id: "s", agent_type: "claude_code", agent_status: "idle", message_count: 1, updated_at: Date.now() } as any },
      conversations: {}, messages: {}, pendingMessages: {}, pending: {},
    });
    store()._setDispatch(async () => null);
  });
  afterEach(() => store()._clearRuntimeBindings());

  it("marks the optimistic send failed", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const clientId = store().addOptimisticMessage(ID, "hello");
      expect(store().pendingMessages[ID][0]._isFailed).toBeFalsy();
      applyDispatchFailure("sendMessage", new Error("boom"), [ID, "hello", undefined, clientId]);
      expect(store().pendingMessages[ID][0]._isFailed).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  it("leaves a send the server already holds (COMMAND_ID_REUSED) alone", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const clientId = store().addOptimisticMessage(ID, "hello");
      const before = store().dispatchErrors;
      applyDispatchFailure("sendMessage", new Error("COMMAND_ID_REUSED"), [ID, "hello", undefined, clientId]);
      expect(store().pendingMessages[ID][0]._isFailed).toBeFalsy();
      expect(store().dispatchErrors).toBe(before);
    } finally {
      err.mockRestore();
    }
  });
});
