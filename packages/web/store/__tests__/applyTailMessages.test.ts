import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// The live tail (listMessagesTail) is AUTHORITATIVE for the range
// (anchor, last_timestamp]. These tests pin the two behaviors that make the
// tail channel correct where add-only mergeMessages would silently break it:
// an in-place streaming patch must REPLACE the local copy of a row, and an
// in-range delete (API-error banner supersession) must drop the local row.

const CONV = "conv_tail_aaaaaaaaaaaaaaaaaaaaaaaa";
const msg = (id: string, ts: number, content: string, extra: Record<string, unknown> = {}) =>
  ({ _id: id, role: "assistant", content, timestamp: ts, ...extra }) as any;

describe("applyTailMessages", () => {
  beforeEach(() => {
    useInboxStore.setState({
      messages: { [CONV]: [] },
      pendingMessages: { [CONV]: [] },
      pagination: {},
      pending: {},
    });
  });

  it("replaces an in-place streaming patch to an existing _id", () => {
    useInboxStore.getState().setMessages(CONV, [msg("m1", 100, "old"), msg("m2", 200, "Half a reply")]);
    useInboxStore.getState().applyTailMessages(CONV, 199, [msg("m2", 200, "Half a reply, now complete.")], 200);
    const rows = useInboxStore.getState().messages[CONV];
    expect(rows.map((m: any) => m._id)).toEqual(["m1", "m2"]);
    expect(rows[1].content).toBe("Half a reply, now complete.");
  });

  it("drops an in-range row the server deleted (banner supersession)", () => {
    useInboxStore.getState().setMessages(CONV, [msg("m1", 100, "keep"), msg("banner", 150, "API error"), msg("m2", 200, "turn")]);
    // Tail anchored below the banner: the result contains only the real turn.
    useInboxStore.getState().applyTailMessages(CONV, 120, [msg("m2", 200, "turn")], 200);
    expect(useInboxStore.getState().messages[CONV].map((m: any) => m._id)).toEqual(["m1", "m2"]);
  });

  it("keeps rows at or before the anchor and rows newer than the tail's end", () => {
    useInboxStore.getState().setMessages(CONV, [msg("m1", 100, "a"), msg("m2", 200, "b"), msg("m3", 300, "recovery raced ahead")]);
    useInboxStore.getState().applyTailMessages(CONV, 150, [msg("m2", 200, "b2")], 200);
    const rows = useInboxStore.getState().messages[CONV];
    expect(rows.map((m: any) => m._id)).toEqual(["m1", "m2", "m3"]);
    expect(rows[1].content).toBe("b2");
  });

  it("an empty tail result changes nothing", () => {
    useInboxStore.getState().setMessages(CONV, [msg("m1", 100, "a"), msg("m2", 200, "b")]);
    const before = useInboxStore.getState().messages[CONV];
    useInboxStore.getState().applyTailMessages(CONV, 199, [], null);
    expect(useInboxStore.getState().messages[CONV]).toBe(before);
  });

  it("prunes a pending echo delivered through the tail", () => {
    useInboxStore.getState().setMessages(CONV, [msg("m1", 100, "a")]);
    useInboxStore.setState({
      pendingMessages: {
        [CONV]: [{ _id: "opt1", role: "user", content: "hi there", timestamp: 190, _isOptimistic: true, _clientId: "c1" } as any],
      },
    });
    useInboxStore.getState().applyTailMessages(
      CONV, 150,
      [msg("u1", 200, "hi there", { role: "user", client_id: "c1" })],
      200,
    );
    expect(useInboxStore.getState().pendingMessages[CONV]).toHaveLength(0);
    expect(useInboxStore.getState().messages[CONV].map((m: any) => m._id)).toEqual(["m1", "u1"]);
  });
});
