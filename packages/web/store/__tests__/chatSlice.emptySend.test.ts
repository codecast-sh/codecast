import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { _resetChatRailMemo } from "../chatSlice";

// ct-91208: chat.sendMessage refuses a line with no text and no attachment
// ("A message needs text or an attachment"), and the web store sent such lines,
// which surfaced as "[CONVEX M(dispatch:dispatch)] Server Error" in the error feed.
// Every store path that sends (send, retry, edit-before-send) must hold a blank
// line back instead of dispatching it.

const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const CHANNEL = serverId("chan1");
const ME = serverId("userme");

describe("chat store slice: a blank line never reaches chat.sendMessage", () => {
  const owner = {};
  let calls: { action: string; args: any[] }[];

  beforeEach(() => {
    calls = [];
    _resetChatRailMemo();
    useInboxStore.setState({
      chatChannels: {}, chatMessages: {}, chatReactions: {}, chatReads: {}, chatRail: [], pending: {},
      currentUser: { _id: ME },
    } as any);
    useInboxStore.getState()._clearDispatch(owner);
    useInboxStore.getState()._setDispatch(async (action, args) => {
      calls.push({ action, args });
      return { message_id: serverId("msg1") };
    }, { owner });
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  const sends = () => calls.filter((c) => c.action === "dispatchChatSend");
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("sending only spaces dispatches nothing", async () => {
    useInboxStore.getState().sendChatMessage(CHANNEL, "   \n ");
    await settle();
    expect(sends()).toHaveLength(0);
  });

  it("editing an unsent line down to blank dispatches nothing", async () => {
    useInboxStore.getState()._clearDispatch(owner);
    useInboxStore.getState()._setDispatch(async (action, args) => {
      calls.push({ action, args });
      throw new Error("offline");
    }, { owner });
    const clientId = useInboxStore.getState().sendChatMessage(CHANNEL, "hello");
    await settle();
    const before = sends().length;
    useInboxStore.getState().editChatMessage(clientId, "  ");
    await settle();
    expect(sends().slice(before).filter((c) => !String(c.args[1] ?? "").trim())).toHaveLength(0);
  });

  it("retrying an unsent image-only line whose uploads failed dispatches nothing", async () => {
    const clientId = "local-retry-blank";
    useInboxStore.setState((s: any) => ({
      chatMessages: {
        ...s.chatMessages,
        [clientId]: {
          _id: clientId, client_id: clientId, channel_id: CHANNEL, user_id: ME, author_kind: "user",
          content: "", attachments: [{ type: "image", preview_url: "blob:dead", storage_id: "" }],
          created_at: Date.now(), updated_at: Date.now(), _failedAt: Date.now(),
        },
      },
    }));
    useInboxStore.getState().retryChatSend(clientId);
    await settle();
    expect(sends()).toHaveLength(0);
  });

  it("still sends a line with text", async () => {
    useInboxStore.getState().sendChatMessage(CHANNEL, "hello");
    await settle();
    expect(sends()).toHaveLength(1);
  });
});
