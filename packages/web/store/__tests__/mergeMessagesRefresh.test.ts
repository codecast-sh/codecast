import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// A hosted turn streams its first words into a row, then patches the same row
// with the full text and the tool call that followed. The warm loop and the
// recovery loop read getNewMessages from just before the newest local row and
// merge through mergeMessages, so the server's newer copy of a row it already
// holds must replace the local one, or the transcript keeps "I" for good.

const CONV = "conv_merge_aaaaaaaaaaaaaaaaaaaaaaa";
const msg = (id: string, ts: number, role: string, content: string, extra: Record<string, unknown> = {}) =>
  ({ _id: id, role, content, timestamp: ts, ...extra }) as any;

describe("mergeMessages refreshes rows the server sends again", () => {
  beforeEach(() => {
    useInboxStore.setState({ messages: { [CONV]: [] }, pendingMessages: { [CONV]: [] }, pagination: {}, pending: {} });
  });

  it("replaces a row cached mid-stream with its final copy and adds what followed", () => {
    const store = useInboxStore.getState();
    store.setMessages(CONV, [msg("u1", 100, "user", "Make a packing list"), msg("a1", 200, "assistant", "I")]);
    const call = { id: "toolu_1", name: "write_doc", input: "{}" };
    store.mergeMessages(CONV, [
      msg("a1", 200, "assistant", "I'll make a packing list.", { tool_calls: [call] }),
      msg("u2", 300, "user", "", { tool_results: [{ tool_use_id: "toolu_1", content: "Created doc" }] }),
      msg("a2", 400, "assistant", "Here it is."),
    ], "append");
    const rows = useInboxStore.getState().messages[CONV];
    expect(rows.map((m: any) => m._id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(rows[1].content).toBe("I'll make a packing list.");
    expect(rows[1].tool_calls).toEqual([call]);
  });

  it("keeps the same array when the server sends nothing new", () => {
    const store = useInboxStore.getState();
    store.setMessages(CONV, [msg("u1", 100, "user", "Hi"), msg("a1", 200, "assistant", "Hello")]);
    const before = useInboxStore.getState().messages[CONV];
    store.mergeMessages(CONV, [msg("a1", 200, "assistant", "Hello")], "append");
    expect(useInboxStore.getState().messages[CONV]).toBe(before);
  });
});
