import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { _resetChatRailMemo } from "../chatSlice";

// Real Convex ids are 32 chars: the store tells a server row from a local stub by that.
const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const CHANNEL = serverId("chan1");
const ME = serverId("userme");

describe("chat store slice: a send the server refuses", () => {
  const owner = {};
  let calls: { action: string; args: any[] }[];

  beforeEach(() => {
    calls = [];
    _resetChatRailMemo();
    useInboxStore.setState({
      chatChannels: {}, chatMessages: {}, chatReactions: {}, chatReads: {}, chatRail: [], pending: {},
      currentUser: { _id: ME },
    } as any);
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  // A message over the server's limit, pressed Retry on (or edited and still
  // over): the refusal came back as a rejected promise nobody held, and the
  // window drew the raw Convex error and its stack as a crash toast.
  it("settles a refused retry and a refused edit instead of leaving the rejection unhandled", async () => {
    const refusal = () => Object.assign(
      new Error('[CONVEX M(dispatch:dispatch)] Server Error\nUncaught ConvexError: {"code":"INVALID","message":"Message is longer than 8000 characters","retryable":false}'),
      { data: { code: "INVALID", message: "Message is longer than 8000 characters", retryable: false } },
    );
    useInboxStore.getState()._clearDispatch(owner);
    useInboxStore.getState()._setDispatch(async (action, args) => {
      calls.push({ action, args });
      throw refusal();
    }, { owner });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const clientId = useInboxStore.getState().sendChatMessage(CHANNEL, "x".repeat(8001));
      useInboxStore.getState().retryChatSend(clientId);
      useInboxStore.getState().editChatMessage(clientId, "y".repeat(8002));
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.filter((c) => c.action === "dispatchChatSend")).toHaveLength(3);
      expect(unhandled).toEqual([]);
      // What was typed is still the row's content, for an edit or a discard.
      expect(useInboxStore.getState().chatMessages[clientId].content).toBe("y".repeat(8002));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
