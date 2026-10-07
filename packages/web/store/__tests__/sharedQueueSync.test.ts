import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// The shared queue lives on the conversation's pending status row
// (pendingMessageStatus[conv].inflight). A queued message, a reorder or a
// merge changes only that array while the primary row's scalars stay put, so
// the push must still land; and the steering actions move the rows at once
// and ride their dispatch side effects.
const CONV = "jx7conv00000000000000000000000qq";
const row = (id: string, at: number, extra: Record<string, unknown> = {}) =>
  ({ message_id: id, created_at: at, status: "held", queued: true, content: `msg ${id}`, from_name: "Ann", ...extra });
const status = (inflight: any[]) => ({ _id: CONV, conversation_id: CONV, ...inflight[0], inflight });

describe("shared queue in the store", () => {
  const owner = {};
  let calls: Array<{ action: string; args: any[] }>;

  beforeEach(() => {
    calls = [];
    useInboxStore.setState({ pendingMessageStatus: {}, pendingMessages: {}, pending: {} } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
      calls.push({ action, args });
      return null;
    }, { owner });
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  const inflight = () => ((useInboxStore.getState() as any).pendingMessageStatus[CONV]?.inflight ?? []).map((r: any) => r.message_id);

  it("lands a push that only adds a queued row behind the same head", () => {
    useInboxStore.getState().syncTable("pendingMessageStatus", [status([row("a", 1)])]);
    useInboxStore.getState().syncTable("pendingMessageStatus", [status([row("a", 1), row("b", 2)])]);
    expect(inflight()).toEqual(["a", "b"]);
  });

  it("reorders and merges on the press, then dispatches", async () => {
    useInboxStore.getState().syncTable("pendingMessageStatus", [status([row("a", 1), row("b", 2), row("c", 3)])]);
    useInboxStore.getState().reorderQueued(CONV, "c", "a");
    expect(inflight()).toEqual(["c", "a", "b"]);
    useInboxStore.getState().mergeQueued(CONV, "b", "a");
    expect(inflight()).toEqual(["c", "a"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c.action)).toEqual(["reorderQueued", "mergeQueued"]);
  });
});
