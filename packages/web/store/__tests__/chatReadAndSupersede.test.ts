import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  useInboxStore,
  selectChatRail,
  selectChatReactions,
  selectChannelReadMarker,
} from "../inboxStore";
import { _resetChatRailMemo } from "../chatSlice";
import { foldReactions } from "../../lib/chatViews";

// The three halves of chat that have to agree with each other:
//
//  - what a SEND does when the channel it names does not exist server-side yet,
//  - what "read" means when the newest thing in a room is a thread reply,
//  - and which number the rail is allowed to believe after a reload.
//
// Each of these was a place where two parts of the surface counted different
// sets and the disagreement showed up as a badge that could not be cleared, or
// a message that sat pending forever.

type DispatchCall = { action: string; args: any[] };

const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);

const CHANNEL = serverId("chanA");
const ME = serverId("userme");
const THEM = serverId("userthem");

function chatState() {
  const s = useInboxStore.getState();
  return {
    chatChannels: s.chatChannels,
    chatMessages: s.chatMessages,
    chatReactions: s.chatReactions,
    chatReads: s.chatReads,
    chatRail: s.chatRail,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("chat: reads, supersede and the rail's numbers", () => {
  const owner = {};
  let calls: DispatchCall[];

  beforeEach(() => {
    calls = [];
    _resetChatRailMemo();
    useInboxStore.setState({
      chatChannels: {},
      chatMessages: {},
      chatReactions: {},
      chatReads: {},
      chatRail: [],
      pending: {},
      tabs: [],
      currentUser: { _id: ME },
    } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
      calls.push({ action, args });
      return null;
    }, { owner });
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  // ── A send into a channel the server has never seen ───────────────────────

  describe("a channel create that is still in flight", () => {
    it("re-drives the messages typed into the stub once the real channel lands", async () => {
      const stubId = useInboxStore.getState().createChatChannel("design");
      const clientId = useInboxStore.getState().sendChatMessage(stubId, "first!");

      // The dispatch that just went out names the stub, and the server handler
      // refuses a stub id — a refusal the outbox reads as success. Without a
      // re-drive this message never leaves the device.
      const firstSend = calls.find((c) => c.action === "dispatchChatSend");
      expect(firstSend?.args[0]).toBe(stubId);

      const realId = serverId("chanreal");
      useInboxStore.getState().syncTable("chatChannels", [
        { _id: realId, client_id: stubId, name: "design", created_at: 1, updated_at: 1 },
      ]);
      await tick();

      const sends = calls.filter((c) => c.action === "dispatchChatSend");
      expect(sends).toHaveLength(2);
      // Same client id — chat.sendMessage dedupes on it, so a message that did
      // somehow land cannot double-post.
      expect(sends[1].args[0]).toBe(realId);
      expect(sends[1].args[2]).toBe(clientId);
      expect(useInboxStore.getState().chatMessages[clientId].channel_id).toBe(realId);
    });

    it("re-drives a send that had already been marked failed, and clears the failure", async () => {
      const stubId = useInboxStore.getState().createChatChannel("design");
      const clientId = useInboxStore.getState().sendChatMessage(stubId, "hello");
      useInboxStore.getState().markChatSendFailed(clientId, "offline");
      expect(useInboxStore.getState().chatMessages[clientId]._failedAt).toBeGreaterThan(0);

      const realId = serverId("chanreal");
      useInboxStore.getState().syncTable("chatChannels", [
        { _id: realId, client_id: stubId, name: "design", created_at: 1, updated_at: 1 },
      ]);
      await tick();

      const row = useInboxStore.getState().chatMessages[clientId];
      expect(row._failedAt).toBeUndefined();
      expect(row.channel_id).toBe(realId);
    });

    it("rewrites a tab parked on the stub channel's URL", () => {
      const stubId = useInboxStore.getState().createChatChannel("design");
      useInboxStore.setState({
        tabs: [
          { id: "t1", path: `/chat/${stubId}`, title: "Chat" },
          { id: "t2", path: `/chat/${stubId}?m=${serverId("msgx")}`, title: "Chat" },
          { id: "t3", path: "/inbox", title: "Inbox" },
        ],
      } as any);

      const realId = serverId("chanreal");
      useInboxStore.getState().syncTable("chatChannels", [
        { _id: realId, client_id: stubId, name: "design", created_at: 1, updated_at: 1 },
      ]);

      const paths = useInboxStore.getState().tabs.map((t: any) => t.path);
      expect(paths[0]).toBe(`/chat/${realId}`);
      expect(paths[1]).toBe(`/chat/${realId}?m=${serverId("msgx")}`);
      expect(paths[2]).toBe("/inbox");
    });
  });

  // ── The read marker counts the same set the rail does ─────────────────────

  describe("the read marker", () => {
    const root = serverId("msgroot");
    const reply = serverId("msgreply");

    beforeEach(() => {
      useInboxStore.getState().syncTable("chatChannels", [
        { _id: CHANNEL, name: "general", created_at: 1, updated_at: 1 },
      ]);
      useInboxStore.getState().syncTable("chatMessages", [
        { _id: root, channel_id: CHANNEL, user_id: THEM, content: "root", created_at: 100, updated_at: 100 },
        {
          _id: reply,
          channel_id: CHANNEL,
          thread_root_id: root,
          user_id: THEM,
          content: "in the thread",
          created_at: 200,
          updated_at: 200,
          mentions: [ME],
        },
      ]);
    });

    it("is the newest message in the room, replies included", () => {
      expect(selectChannelReadMarker(chatState(), CHANNEL)?._id).toBe(reply);
    });

    it("a thread reply never raises the channel number; its mention still counts", () => {
      // The server's rule, mirrored by the shared tally: the reply's body never
      // appears in the channel view, so it cannot tick a number that reading
      // the channel is unable to extinguish. Being named counts from anywhere.
      _resetChatRailMemo();
      const rail = selectChatRail(chatState(), ME);
      expect(rail[0].unreadCount).toBe(1); // the root alone
      expect(rail[0].mentionCount).toBe(1); // the mention inside the thread

      const marker = selectChannelReadMarker(chatState(), CHANNEL);
      useInboxStore.getState().markChannelRead(CHANNEL, marker?._id);

      _resetChatRailMemo();
      const after = selectChatRail(chatState(), ME);
      expect(after[0].unreadCount).toBe(0);
      expect(after[0].mentionCount).toBe(0);
    });

    it("marking only the newest ROOT read leaves the thread mention standing", () => {
      // The reply (and its mention of you) sits past the root's timestamp, so a
      // marker that stops at the root must not clear it — this is why the read
      // marker is the newest message INCLUDING replies.
      useInboxStore.getState().markChannelRead(CHANNEL, root);

      _resetChatRailMemo();
      const rail = selectChatRail(chatState(), ME);
      expect(rail[0].unreadCount).toBe(0);
      expect(rail[0].mentionCount).toBe(1);
    });
  });

  // ── Which number the rail believes ────────────────────────────────────────

  describe("the rail's unread count", () => {
    const tip = serverId("msgtip");

    it("keeps the server's number when the local page does not reach the newest message", () => {
      // The boot case: chatMessages hydrated from IndexedDB holds a page from
      // yesterday, and only the OPEN channel is subscribed. Tallying that page
      // returns 0 while the server says 12.
      useInboxStore.getState().syncTable("chatChannels", [
        { _id: CHANNEL, name: "general", created_at: 1, updated_at: 1 },
      ]);
      useInboxStore.getState().syncTable("chatMessages", [
        { _id: serverId("msgold"), channel_id: CHANNEL, user_id: THEM, content: "yesterday", created_at: 100, updated_at: 100 },
      ]);
      useInboxStore.getState().syncTable("chatReads", [
        { _id: serverId("read1"), channel_id: CHANNEL, user_id: ME, last_read_at: 150, notify_level: "all", updated_at: 150 },
      ]);
      useInboxStore.getState().syncTable("chatRail", [
        {
          channel_id: CHANNEL,
          sort_at: 9000,
          unread: 12,
          unread_mentions: 3,
          notify_level: "all",
          joined: true,
          last_message: { _id: tip, user_id: THEM, created_at: 9000, preview: "newest" },
        },
      ]);

      _resetChatRailMemo();
      const rail = selectChatRail(chatState(), ME);
      expect(rail[0].unreadCount).toBe(12);
      expect(rail[0].mentionCount).toBe(3);
    });

    it("tallies locally as soon as the page holds the rail's own newest message", () => {
      useInboxStore.getState().syncTable("chatChannels", [
        { _id: CHANNEL, name: "general", created_at: 1, updated_at: 1 },
      ]);
      useInboxStore.getState().syncTable("chatMessages", [
        { _id: serverId("msgold"), channel_id: CHANNEL, user_id: THEM, content: "read", created_at: 100, updated_at: 100 },
        { _id: tip, channel_id: CHANNEL, user_id: THEM, content: "newest", created_at: 9000, updated_at: 9000 },
      ]);
      useInboxStore.getState().syncTable("chatReads", [
        { _id: serverId("read1"), channel_id: CHANNEL, user_id: ME, last_read_at: 150, notify_level: "all", updated_at: 150 },
      ]);
      useInboxStore.getState().syncTable("chatRail", [
        {
          channel_id: CHANNEL,
          sort_at: 9000,
          unread: 12,
          unread_mentions: 3,
          notify_level: "all",
          joined: true,
          last_message: { _id: tip, user_id: THEM, created_at: 9000, preview: "newest" },
        },
      ]);

      _resetChatRailMemo();
      const rail = selectChatRail(chatState(), ME);
      // One unread, not twelve: the client can see the whole tail now.
      expect(rail[0].unreadCount).toBe(1);
    });

    it("clears when this viewer's mark is past everything the server knows about", () => {
      useInboxStore.getState().syncTable("chatChannels", [
        { _id: CHANNEL, name: "general", created_at: 1, updated_at: 1 },
      ]);
      useInboxStore.getState().syncTable("chatMessages", [
        { _id: serverId("msgold"), channel_id: CHANNEL, user_id: THEM, content: "old", created_at: 100, updated_at: 100 },
      ]);
      useInboxStore.getState().syncTable("chatRail", [
        {
          channel_id: CHANNEL,
          sort_at: 9000,
          unread: 12,
          unread_mentions: 3,
          notify_level: "all",
          joined: true,
          last_message: { _id: tip, user_id: THEM, created_at: 9000, preview: "newest" },
        },
      ]);
      useInboxStore.getState().syncTable("chatReads", [
        { _id: serverId("read1"), channel_id: CHANNEL, user_id: ME, last_read_at: 9000, notify_level: "all", updated_at: 9000 },
      ]);

      _resetChatRailMemo();
      const rail = selectChatRail(chatState(), ME);
      expect(rail[0].unreadCount).toBe(0);
      expect(rail[0].mentionCount).toBe(0);
    });
  });

  // ── One counting rule for reactions ───────────────────────────────────────

  it("the reaction selector and foldReactions are the same rule", () => {
    const messageId = serverId("msgr");
    const rows = [
      { _id: serverId("rx1"), message_id: messageId, user_id: ME, emoji: "🎉", created_at: 10 },
      { _id: serverId("rx2"), message_id: messageId, user_id: THEM, emoji: "🎉", created_at: 20 },
      { _id: serverId("rx3"), message_id: messageId, user_id: THEM, emoji: "🚀", created_at: 30 },
      { _id: serverId("rx4"), message_id: serverId("other"), user_id: THEM, emoji: "👍", created_at: 40 },
    ];
    useInboxStore.getState().syncTable("chatReactions", rows);

    const viaSelector = selectChatReactions(chatState(), messageId, ME);
    const viaFold = foldReactions(rows.filter((r) => r.message_id === messageId) as any, ME);
    expect(viaSelector).toEqual(viaFold);
    expect(viaSelector.map((r) => [r.emoji, r.count, r.mine])).toEqual([
      ["🎉", 2, true],
      ["🚀", 1, false],
    ]);
  });
});
