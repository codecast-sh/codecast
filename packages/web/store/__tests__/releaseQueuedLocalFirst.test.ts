import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { heldQueueRowsOf } from "../../lib/sharedQueue";

// ct-59107: "Send now" on the shared queue ("Up next") must take the rows out
// of the line at once and keep them out until the server answers. The press
// flips them from held to pending on the draft; a push of
// getConversationPendingMessage computed before the release reached the
// server (still saying held) must not put them back in the row.
const CONV = "jx7conv00000000000000000000000rq";
const row = (id: string, at: number, extra: Record<string, unknown> = {}) =>
  ({ message_id: id, created_at: at, status: "held", queued: true, content: `msg ${id}`, from_name: "Ann", ...extra });
const status = (inflight: any[], extra: Record<string, unknown> = {}) =>
  ({ _id: CONV, conversation_id: CONV, ...inflight[0], inflight, ...extra });

describe("Send now on the shared queue is local-first", () => {
  const owner = {};
  let resolveRelease: () => void = () => {};

  beforeEach(() => {
    useInboxStore.setState({ pendingMessageStatus: {}, pendingMessages: {}, pending: {} } as any);
    // The server has not answered the release yet.
    useInboxStore.getState()._setDispatch((action: string) =>
      action === "releaseQueued" ? new Promise<null>((r) => { resolveRelease = () => r(null); }) : Promise.resolve(null),
    { owner });
  });

  afterEach(() => {
    resolveRelease();
    useInboxStore.getState()._clearDispatch(owner);
  });

  const held = () => heldQueueRowsOf((useInboxStore.getState() as any).pendingMessageStatus[CONV]).map((r) => r.message_id);

  it("leaves the row on the press and stays gone through a push from before the release", async () => {
    useInboxStore.getState().syncTable("pendingMessageStatus", [status([row("a", 1), row("b", 2)])]);
    expect(held()).toEqual(["a", "b"]);

    useInboxStore.getState().releaseQueued(CONV);
    expect(held()).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));

    // A status tick the server computed before it applied the release.
    useInboxStore.getState().syncTable("pendingMessageStatus", [status([row("a", 1), row("b", 2)], { updated_at: 5 })]);
    expect(held()).toEqual([]);
  });

  it("takes a newer push as it is", async () => {
    useInboxStore.getState().syncTable("pendingMessageStatus", [status([row("a", 1), row("b", 2)])]);
    useInboxStore.getState().releaseQueued(CONV);
    // A row queued after the press is held on the server and stays in line;
    // the released rows went on to delivery.
    useInboxStore.getState().syncTable("pendingMessageStatus", [status([row("a", 1, { status: "delivered" }), row("c", 3)])]);
    expect(held()).toEqual(["c"]);
  });

  it("puts the rows back in line when the server refuses the release", () => {
    useInboxStore.getState().syncTable("pendingMessageStatus", [status([row("a", 1), row("b", 2)])]);
    useInboxStore.getState().releaseQueued(CONV);
    expect(held()).toEqual([]);
    useInboxStore.getState().rollbackRelease(CONV);
    expect(held()).toEqual(["a", "b"]);
    // And the server's own held rows stay in line on the next push.
    useInboxStore.getState().syncTable("pendingMessageStatus", [status([row("a", 1), row("b", 2)], { updated_at: 6 })]);
    expect(held()).toEqual(["a", "b"]);
  });
});
