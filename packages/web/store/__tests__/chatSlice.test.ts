import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  useInboxStore,
  selectChatRail,
  selectChannelMessages,
  selectThreadReplies,
  selectChatReactions,
  chatReactionSyncOpts,
  chatSendState,
  chatReactionStubId,
} from "../inboxStore";
import { _resetChatRailMemo, type ChatMessageRow } from "../chatSlice";

type DispatchCall = { action: string; args: any[]; result?: unknown };

// Real Convex ids are 32 chars — the store branches on that everywhere to tell a
// server row from a local stub.
const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);

const CHANNEL = serverId("chan1");
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

function messagesIn(channelId: string): ChatMessageRow[] {
  return selectChannelMessages(chatState(), channelId);
}

describe("chat store slice", () => {
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
      currentUser: { _id: ME },
    } as any);
    useInboxStore.getState()._setDispatch(async (action, args, _patches, result) => {
      calls.push({ action, args, result });
      return null;
    }, { owner });
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  // ── Sending ───────────────────────────────────────────────────────────────

  describe("sendChatMessage", () => {
    it("paints the message before any round trip and dispatches the same client id", () => {
      const clientId = useInboxStore.getState().sendChatMessage(CHANNEL, "hello");

      // Synchronously on screen — the whole point of local-first.
      const rows = messagesIn(CHANNEL);
      expect(rows).toHaveLength(1);
      expect(rows[0]._id).toBe(clientId);
      expect(rows[0].content).toBe("hello");
      expect(rows[0].user_id).toBe(ME);
      expect(chatSendState(rows[0])).toBe("pending");

      expect(calls).toHaveLength(1);
      expect(calls[0].action).toBe("dispatchChatSend");
      expect(calls[0].args[0]).toBe(CHANNEL);
      expect(calls[0].args[1]).toBe("hello");
      // Index 2 is what the dispatch error hook reads to mark the row failed.
      expect(calls[0].args[2]).toBe(clientId);
    });

    it("posting is reading: the send advances this viewer's read mark", () => {
      useInboxStore.getState().sendChatMessage(CHANNEL, "hello");
      const read = Object.values(useInboxStore.getState().chatReads)
        .find((r) => r.channel_id === CHANNEL);
      expect(read).toBeDefined();
      expect(read!.last_read_at).toBeGreaterThan(0);
    });

    it("the server echo supersedes the stub by client_id", () => {
      const clientId = useInboxStore.getState().sendChatMessage(CHANNEL, "hello");
      const realId = serverId("msg1");

      useInboxStore.getState().syncTable("chatMessages", [{
        _id: realId,
        client_id: clientId,
        channel_id: CHANNEL,
        user_id: ME,
        content: "hello",
        created_at: 10,
        updated_at: 10,
      }]);

      const rows = messagesIn(CHANNEL);
      expect(rows).toHaveLength(1);
      expect(rows[0]._id).toBe(realId);
      expect(chatSendState(rows[0])).toBe("sent");
      expect(useInboxStore.getState().chatMessages[clientId]).toBeUndefined();
    });

    it("another channel's page never prunes this one (delta overlay)", () => {
      const other = serverId("chan2");
      useInboxStore.getState().sendChatMessage(CHANNEL, "mine");
      useInboxStore.getState().syncTable("chatMessages", [{
        _id: serverId("msgB"),
        channel_id: other,
        user_id: THEM,
        content: "theirs",
        created_at: 5,
        updated_at: 5,
      }]);

      expect(messagesIn(CHANNEL)).toHaveLength(1);
      expect(messagesIn(other)).toHaveLength(1);
    });
  });

  // ── Broadcast: Slack's "also send to #channel" ────────────────────────────

  describe("broadcast replies", () => {
    it("shows a broadcast reply in the channel AND its thread; a plain reply stays thread-only", () => {
      const rootId = serverId("root1");
      useInboxStore.getState().syncTable("chatMessages", [{
        _id: rootId, channel_id: CHANNEL, user_id: THEM, content: "root", created_at: 1, updated_at: 1,
      }]);

      useInboxStore.getState().sendChatMessage(CHANNEL, "thread only", { threadRootId: rootId });
      const bcast = useInboxStore.getState().sendChatMessage(CHANNEL, "for everyone", {
        threadRootId: rootId, broadcast: true,
      });

      expect(messagesIn(CHANNEL).map((r) => r.content)).toEqual(["root", "for everyone"]);
      // Both optimistic rows can share a millisecond, so compare as a set —
      // the server's per-channel monotonic stamp owns real ordering.
      expect(selectThreadReplies(chatState(), rootId).map((r) => r.content).sort())
        .toEqual(["for everyone", "thread only"]);

      // The flag rides the dispatch, so retry and delivery both keep it.
      const sendCall = calls.find((c) => c.action === "dispatchChatSend" && c.args[2] === bcast);
      expect(sendCall?.args[3]?.broadcast).toBe(true);
    });

    it("keeps the flag across a retry", () => {
      const rootId = serverId("root2");
      const clientId = useInboxStore.getState().sendChatMessage(CHANNEL, "again", {
        threadRootId: rootId, broadcast: true,
      });
      useInboxStore.getState().markChatSendFailed(clientId);
      calls.length = 0;
      useInboxStore.getState().retryChatSend(clientId);
      expect(calls[0].args[3]?.broadcast).toBe(true);
    });
  });

  // ── A failed send has to be visible ───────────────────────────────────────

  describe("failed sends", () => {
    it("marks the row failed and retries under the same client id", () => {
      const clientId = useInboxStore.getState().sendChatMessage(CHANNEL, "hello");

      // What hooks/useEnsureDispatch does when delivery finally gives up.
      useInboxStore.getState().markChatSendFailed(clientId, "Uncaught ConvexError: FORBIDDEN");
      expect(chatSendState(useInboxStore.getState().chatMessages[clientId])).toBe("failed");
      expect(useInboxStore.getState().chatMessages[clientId]._failReason).toContain("FORBIDDEN");

      calls.length = 0;
      useInboxStore.getState().retryChatSend(clientId);

      // Same row, same client id — the server dedupes on it, so a retry can
      // never double-post a message that actually landed.
      expect(calls).toHaveLength(1);
      expect(calls[0].action).toBe("dispatchChatSend");
      expect(calls[0].args[2]).toBe(clientId);
      expect(chatSendState(useInboxStore.getState().chatMessages[clientId])).toBe("pending");
      expect(messagesIn(CHANNEL)).toHaveLength(1);
    });

    it("never marks a message the server already holds as failed", () => {
      const realId = serverId("msg1");
      useInboxStore.getState().syncTable("chatMessages", [{
        _id: realId, channel_id: CHANNEL, user_id: ME, content: "hi", created_at: 1, updated_at: 1,
      }]);
      useInboxStore.getState().markChatSendFailed(realId, "boom");
      expect(chatSendState(useInboxStore.getState().chatMessages[realId])).toBe("sent");
    });

    it("discarding a failed send removes the row AND plants its exclude tombstone", () => {
      const clientId = useInboxStore.getState().sendChatMessage(CHANNEL, "hello");
      useInboxStore.getState().markChatSendFailed(clientId);
      useInboxStore.getState().discardChatSend(clientId);

      expect(messagesIn(CHANNEL)).toHaveLength(0);
      // Without the tombstone the IDB diff refuses the delete and boot hydration
      // resurrects the discarded message.
      expect(useInboxStore.getState().pending[`chatMessages:${clientId}`]?.type).toBe("exclude");
    });

    it("a discarded send that delivers anyway comes back as an ordinary message", () => {
      const clientId = useInboxStore.getState().sendChatMessage(CHANNEL, "hello");
      useInboxStore.getState().markChatSendFailed(clientId);
      useInboxStore.getState().discardChatSend(clientId);

      // The outbox never gives up on user-authored content, so the parked send
      // can still land. Better it reappears — deletable — than that it sit on
      // everyone else's screen while looking gone on this one.
      const realId = serverId("msg1");
      useInboxStore.getState().syncTable("chatMessages", [{
        _id: realId, client_id: clientId, channel_id: CHANNEL, user_id: ME,
        content: "hello", created_at: 10, updated_at: 10,
      }]);

      expect(messagesIn(CHANNEL).map((m) => m._id)).toEqual([realId]);
      // And the tombstone is retired rather than left in the persisted map.
      expect(useInboxStore.getState().pending[`chatMessages:${clientId}`]).toBeUndefined();
    });

    it("refuses to discard a message the server holds", () => {
      const realId = serverId("msg1");
      useInboxStore.getState().syncTable("chatMessages", [{
        _id: realId, channel_id: CHANNEL, user_id: ME, content: "hi", created_at: 1, updated_at: 1,
      }]);
      useInboxStore.getState().discardChatSend(realId);
      expect(messagesIn(CHANNEL)).toHaveLength(1);
    });
  });

  // ── Editing and deleting ──────────────────────────────────────────────────

  describe("editChatMessage", () => {
    it("edits a sent message optimistically and dispatches the edit", () => {
      const realId = serverId("msg1");
      useInboxStore.getState().syncTable("chatMessages", [{
        _id: realId, channel_id: CHANNEL, user_id: ME, content: "typo", created_at: 1, updated_at: 1,
      }]);
      calls.length = 0;

      useInboxStore.getState().editChatMessage(realId, "fixed");

      expect(useInboxStore.getState().chatMessages[realId].content).toBe("fixed");
      expect(calls.map((c) => c.action)).toEqual(["dispatchChatEdit"]);
      expect(calls[0].args).toEqual([realId, "fixed"]);
    });

    it("editing an unsent message re-drives the SEND with the new text", () => {
      const clientId = useInboxStore.getState().sendChatMessage(CHANNEL, "wrong");
      useInboxStore.getState().markChatSendFailed(clientId);
      calls.length = 0;

      useInboxStore.getState().editChatMessage(clientId, "right");

      // The parked delivery carries the original text, so rewriting the row
      // alone would ship the wrong words. One re-send, same client id.
      expect(calls.map((c) => c.action)).toEqual(["dispatchChatSend"]);
      expect(calls[0].args[1]).toBe("right");
      expect(calls[0].args[2]).toBe(clientId);
      expect(useInboxStore.getState().chatMessages[clientId].content).toBe("right");
      expect(chatSendState(useInboxStore.getState().chatMessages[clientId])).toBe("pending");
    });
  });

  describe("deleteChatMessage", () => {
    it("tombstones a sent message instead of removing it", () => {
      const realId = serverId("msg1");
      useInboxStore.getState().syncTable("chatMessages", [{
        _id: realId, channel_id: CHANNEL, user_id: ME, content: "oops", created_at: 1, updated_at: 1,
      }]);
      calls.length = 0;

      useInboxStore.getState().deleteChatMessage(realId);

      const row = useInboxStore.getState().chatMessages[realId];
      // Replies keep their root: the row stays, emptied.
      expect(row.deleted_at).toBeGreaterThan(0);
      expect(row.content).toBe("");
      expect(calls.map((c) => c.action)).toEqual(["dispatchChatDelete"]);
    });

    it("deleting an unsent message discards it — there is nothing to tombstone", () => {
      const clientId = useInboxStore.getState().sendChatMessage(CHANNEL, "never sent");
      calls.length = 0;

      useInboxStore.getState().deleteChatMessage(clientId);

      expect(useInboxStore.getState().chatMessages[clientId]).toBeUndefined();
      expect(calls).toHaveLength(0);
    });
  });

  // ── Reactions ─────────────────────────────────────────────────────────────

  describe("toggleChatReaction", () => {
    const realId = serverId("msg1");

    beforeEach(() => {
      useInboxStore.getState().syncTable("chatMessages", [{
        _id: realId, channel_id: CHANNEL, user_id: THEM, content: "hi", created_at: 1, updated_at: 1,
      }]);
      calls.length = 0;
    });

    it("adds the viewer's reaction locally and dispatches the intent", () => {
      useInboxStore.getState().toggleChatReaction(realId, "🎉");

      const summary = selectChatReactions(chatState(), realId, ME);
      expect(summary).toEqual([{ emoji: "🎉", count: 1, mine: true }]);
      expect(calls.map((c) => c.action)).toEqual(["toggleChatReaction"]);
      expect(calls[0].args).toEqual([realId, "🎉"]);
    });

    it("toggling off removes the row and plants its exclude tombstone", () => {
      useInboxStore.getState().toggleChatReaction(realId, "🎉");
      useInboxStore.getState().toggleChatReaction(realId, "🎉");

      expect(selectChatReactions(chatState(), realId, ME)).toEqual([]);
      const stubId = chatReactionStubId(realId, "🎉");
      expect(useInboxStore.getState().pending[`chatReactions:${stubId}`]?.type).toBe("exclude");
    });

    it("takes back a reaction the server already holds", () => {
      const rowId = serverId("react1");
      useInboxStore.getState().syncTable("chatReactions", [{
        _id: rowId, message_id: realId, channel_id: CHANNEL, user_id: ME, emoji: "👍", created_at: 2,
      }]);
      useInboxStore.getState().toggleChatReaction(realId, "👍");

      expect(selectChatReactions(chatState(), realId, ME)).toEqual([]);
      expect(useInboxStore.getState().pending[`chatReactions:${rowId}`]?.type).toBe("exclude");
    });

    it("is inert on a message the server has never seen", () => {
      const clientId = useInboxStore.getState().sendChatMessage(CHANNEL, "unsent");
      calls.length = 0;
      useInboxStore.getState().toggleChatReaction(clientId, "🎉");
      expect(selectChatReactions(chatState(), clientId, ME)).toEqual([]);
    });

    it("counts distinct people, so a stub and its server twin read as one", () => {
      useInboxStore.getState().toggleChatReaction(realId, "🎉");
      useInboxStore.getState().syncTable("chatReactions", [{
        _id: serverId("react2"), message_id: realId, channel_id: CHANNEL, user_id: ME, emoji: "🎉", created_at: 3,
      }]);
      expect(selectChatReactions(chatState(), realId, ME)).toEqual([
        { emoji: "🎉", count: 1, mine: true },
      ]);
    });
  });

  describe("chatReactionSyncOpts", () => {
    const realId = serverId("msg1");

    it("supersedes the optimistic stub once the real row is in an authoritative page", () => {
      useInboxStore.getState().syncTable("chatMessages", [{
        _id: realId, channel_id: CHANNEL, user_id: THEM, content: "hi", created_at: 1, updated_at: 1,
      }]);
      useInboxStore.getState().toggleChatReaction(realId, "🎉");
      const stubId = chatReactionStubId(realId, "🎉");
      expect(useInboxStore.getState().chatReactions[stubId]).toBeDefined();

      useInboxStore.getState().syncTable(
        "chatReactions",
        [{ _id: serverId("react1"), message_id: realId, channel_id: CHANNEL, user_id: ME, emoji: "🎉", created_at: 3 }],
        chatReactionSyncOpts([realId]),
      );

      expect(useInboxStore.getState().chatReactions[stubId]).toBeUndefined();
      expect(selectChatReactions(chatState(), realId, ME)).toEqual([
        { emoji: "🎉", count: 1, mine: true },
      ]);
    });

    it("prunes a reaction someone else took back, and retires the tombstone with it", () => {
      const rowId = serverId("react1");
      useInboxStore.getState().syncTable("chatReactions", [{
        _id: rowId, message_id: realId, channel_id: CHANNEL, user_id: THEM, emoji: "👍", created_at: 2,
      }]);
      expect(selectChatReactions(chatState(), realId, ME)).toHaveLength(1);

      // The page comes back without it: in a delta this would mean "unchanged",
      // but a scoped page is the complete truth for these messages.
      useInboxStore.getState().syncTable("chatReactions", [], chatReactionSyncOpts([realId]));

      expect(selectChatReactions(chatState(), realId, ME)).toHaveLength(0);
      // And no dead tombstone left behind — this runs on every page of a busy
      // channel, so one immortal entry per removed reaction would accumulate.
      expect(useInboxStore.getState().pending[`chatReactions:${rowId}`]).toBeUndefined();
    });

    it("leaves another message's reactions alone", () => {
      const otherMsg = serverId("msg2");
      useInboxStore.getState().syncTable("chatReactions", [
        { _id: serverId("react1"), message_id: realId, channel_id: CHANNEL, user_id: THEM, emoji: "👍", created_at: 2 },
        { _id: serverId("react2"), message_id: otherMsg, channel_id: CHANNEL, user_id: THEM, emoji: "🎉", created_at: 2 },
      ]);
      useInboxStore.getState().syncTable("chatReactions", [], chatReactionSyncOpts([realId]));

      expect(selectChatReactions(chatState(), realId, ME)).toHaveLength(0);
      expect(selectChatReactions(chatState(), otherMsg, ME)).toHaveLength(1);
    });
  });

  // ── Read state ────────────────────────────────────────────────────────────

  describe("markChannelRead", () => {
    it("stamps exactly what the server will write, so the badge cannot flicker back", () => {
      const realId = serverId("msg1");
      useInboxStore.getState().syncTable("chatMessages", [{
        _id: realId, channel_id: CHANNEL, user_id: THEM, content: "hi", created_at: 1234, updated_at: 1234,
      }]);
      calls.length = 0;

      useInboxStore.getState().markChannelRead(CHANNEL, realId);

      const read = Object.values(useInboxStore.getState().chatReads)
        .find((r) => r.channel_id === CHANNEL)!;
      expect(read.last_read_at).toBe(1234);
      expect(read.last_read_message_id).toBe(realId);
      expect(calls.map((c) => c.action)).toEqual(["markChannelRead"]);
      expect(calls[0].args).toEqual([CHANNEL, realId]);
    });

    it("never moves the mark backwards", () => {
      const older = serverId("msg1");
      const newer = serverId("msg2");
      useInboxStore.getState().syncTable("chatMessages", [
        { _id: older, channel_id: CHANNEL, user_id: THEM, content: "a", created_at: 100, updated_at: 100 },
        { _id: newer, channel_id: CHANNEL, user_id: THEM, content: "b", created_at: 200, updated_at: 200 },
      ]);

      useInboxStore.getState().markChannelRead(CHANNEL, newer);
      useInboxStore.getState().markChannelRead(CHANNEL, older);

      const read = Object.values(useInboxStore.getState().chatReads)
        .find((r) => r.channel_id === CHANNEL)!;
      expect(read.last_read_at).toBe(200);
    });
  });

  it("setChannelNotifyLevel writes the level and dispatches it", () => {
    useInboxStore.getState().setChannelNotifyLevel(CHANNEL, "none");
    const read = Object.values(useInboxStore.getState().chatReads)
      .find((r) => r.channel_id === CHANNEL)!;
    expect(read.notify_level).toBe("none");
    expect(calls.map((c) => c.action)).toEqual(["setChannelNotifyLevel"]);
    expect(calls[0].args).toEqual([CHANNEL, "none"]);
  });

  // ── Channels ──────────────────────────────────────────────────────────────

  describe("createChatChannel", () => {
    it("returns a stub id the rail can select immediately", () => {
      const stubId = useInboxStore.getState().createChatChannel("Design Review");
      const channel = useInboxStore.getState().chatChannels[stubId];
      expect(channel.name).toBe("design-review");
      expect(channel.client_id).toBe(stubId);
      expect(calls.map((c) => c.action)).toEqual(["dispatchCreateChatChannel"]);
      expect(calls[0].args[0]).toBe(stubId);
    });

    it("carries messages sent into the stub across the supersede", () => {
      const stubId = useInboxStore.getState().createChatChannel("design");
      const clientId = useInboxStore.getState().sendChatMessage(stubId, "first!");
      const realId = serverId("chanreal");

      useInboxStore.getState().syncTable("chatChannels", [{
        _id: realId,
        client_id: stubId,
        name: "design",
        team_id: serverId("team1"),
        created_at: 1,
        updated_at: 1,
      }]);

      // The message and the read row followed the channel; nothing orphaned
      // under an id no query will ever return.
      expect(useInboxStore.getState().chatChannels[stubId]).toBeUndefined();
      expect(useInboxStore.getState().chatMessages[clientId].channel_id).toBe(realId);
      expect(messagesIn(realId)).toHaveLength(1);
      expect(
        Object.values(useInboxStore.getState().chatReads).some((r) => r.channel_id === realId),
      ).toBe(true);
    });
  });

  // ── Selectors ─────────────────────────────────────────────────────────────

  describe("selectors", () => {
    it("returns a channel's roots ascending, and a thread's replies separately", () => {
      const root = serverId("msgroot");
      useInboxStore.getState().syncTable("chatMessages", [
        { _id: serverId("msgb"), channel_id: CHANNEL, user_id: THEM, content: "b", created_at: 20, updated_at: 20 },
        { _id: root, channel_id: CHANNEL, user_id: THEM, content: "a", created_at: 10, updated_at: 10 },
        { _id: serverId("msgr1"), channel_id: CHANNEL, thread_root_id: root, user_id: ME, content: "reply", created_at: 30, updated_at: 30 },
      ]);

      // Roots only: folding replies in would render every reply twice.
      expect(messagesIn(CHANNEL).map((m) => m.content)).toEqual(["a", "b"]);
      expect(selectThreadReplies(chatState(), root).map((m) => m.content)).toEqual(["reply"]);
    });

    it("orders the rail by newest activity and counts unread and mentions from local rows", () => {
      const quiet = serverId("chanq");
      useInboxStore.getState().syncTable("chatChannels", [
        { _id: CHANNEL, name: "general", created_at: 1, updated_at: 1 },
        { _id: quiet, name: "quiet", created_at: 2, updated_at: 2 },
      ]);
      useInboxStore.getState().syncTable("chatReads", [{
        _id: serverId("read1"), channel_id: CHANNEL, user_id: ME,
        last_read_at: 100, notify_level: "all", updated_at: 100,
      }]);
      useInboxStore.getState().syncTable("chatMessages", [
        { _id: serverId("m1"), channel_id: CHANNEL, user_id: THEM, content: "read", created_at: 50, updated_at: 50 },
        { _id: serverId("m2"), channel_id: CHANNEL, user_id: THEM, content: "new", created_at: 150, updated_at: 150 },
        { _id: serverId("m3"), channel_id: CHANNEL, user_id: THEM, content: "hey", created_at: 160, updated_at: 160, mentions: [ME] },
        { _id: serverId("m4"), channel_id: CHANNEL, user_id: ME, content: "mine", created_at: 170, updated_at: 170 },
      ]);

      _resetChatRailMemo();
      const rail = selectChatRail(chatState(), ME);
      expect(rail.map((c) => c.id)).toEqual([CHANNEL, quiet]);
      // Two unread from other people, one of which names the viewer. The
      // viewer's own line never counts — sending is reading.
      expect(rail[0].unreadCount).toBe(2);
      expect(rail[0].mentionCount).toBe(1);
      expect(rail[1].unreadCount).toBe(0);
    });

    it("falls back to the server's count for a channel whose messages are not loaded", () => {
      useInboxStore.getState().syncTable("chatChannels", [
        { _id: CHANNEL, name: "general", created_at: 1, updated_at: 1 },
      ]);
      useInboxStore.getState().syncTable("chatRail", [{
        channel_id: CHANNEL, sort_at: 900, unread: 7, unread_mentions: 2,
        notify_level: "all", joined: true, last_message: null,
      }]);

      _resetChatRailMemo();
      const rail = selectChatRail(chatState(), ME);
      expect(rail[0].unreadCount).toBe(7);
      expect(rail[0].mentionCount).toBe(2);
    });

    it("attests emptiness only when a rail row says so", () => {
      const unknown = serverId("chanunk");
      useInboxStore.getState().syncTable("chatChannels", [
        { _id: CHANNEL, name: "general", created_at: 1, updated_at: 1 },
        { _id: unknown, name: "mystery", created_at: 2, updated_at: 2 },
      ]);
      // The server's summary: CHANNEL genuinely has no messages. `unknown`
      // has no rail row at all — never synced, could hold anything.
      useInboxStore.getState().syncTable("chatRail", [{
        channel_id: CHANNEL, sort_at: 1, unread: 0, unread_mentions: 0,
        notify_level: "all", joined: true, last_message: null,
      }]);

      _resetChatRailMemo();
      const rail = selectChatRail(chatState(), ME);
      expect(rail.find((c) => c.id === CHANNEL)?.knownEmpty).toBe(true);
      // No attestation for the unsynced channel: it must show a skeleton,
      // not an empty state that may be a lie.
      expect(rail.find((c) => c.id === unknown)?.knownEmpty).toBe(false);
    });

    it("withdraws the emptiness attestation once the rail carries a message", () => {
      useInboxStore.getState().syncTable("chatChannels", [
        { _id: CHANNEL, name: "general", created_at: 1, updated_at: 1 },
      ]);
      useInboxStore.getState().syncTable("chatRail", [{
        channel_id: CHANNEL, sort_at: 900, unread: 1, unread_mentions: 0,
        notify_level: "all", joined: true,
        last_message: { _id: serverId("mlast"), user_id: THEM, created_at: 900, preview: "hi" },
      }]);

      _resetChatRailMemo();
      expect(selectChatRail(chatState(), ME)[0].knownEmpty).toBe(false);
    });

    it("hides archived channels and marks a silenced one muted", () => {
      const dead = serverId("chandead");
      useInboxStore.getState().syncTable("chatChannels", [
        { _id: CHANNEL, name: "general", created_at: 1, updated_at: 1 },
        { _id: dead, name: "old", created_at: 1, updated_at: 1, archived_at: 5 },
      ]);
      useInboxStore.getState().setChannelNotifyLevel(CHANNEL, "none");

      _resetChatRailMemo();
      const rail = selectChatRail(chatState(), ME);
      expect(rail.map((c) => c.id)).toEqual([CHANNEL]);
      expect(rail[0].muted).toBe(true);
    });
  });
});

describe("channel management actions", () => {
  const CHAN = "chanmgmt12345678901234567890123x";

  beforeEach(() => {
    useInboxStore.getState().syncTable("chatChannels", [
      { _id: CHAN, name: "old-name", topic: "old topic", created_at: 1, updated_at: 1 },
    ]);
  });

  it("updateChatChannel renames and re-topics optimistically", () => {
    useInboxStore.getState().updateChatChannel(CHAN, { name: "new-name" });
    expect(useInboxStore.getState().chatChannels[CHAN].name).toBe("new-name");
    useInboxStore.getState().updateChatChannel(CHAN, { topic: "what this room is for" });
    const row = useInboxStore.getState().chatChannels[CHAN];
    expect(row.topic).toBe("what this room is for");
    expect(row.name).toBe("new-name");
  });

  it("archiveChatChannel hides the row from the rail at once; restore writes the null tombstone", () => {
    useInboxStore.getState().archiveChatChannel(CHAN, true);
    expect(useInboxStore.getState().chatChannels[CHAN].archived_at).toBeGreaterThan(0);
    _resetChatRailMemo();
    expect(selectChatRail(chatState(), "me").some((c) => c.id === CHAN)).toBe(false);

    // Restore is null, never field-removal — the clear a delta sync can SEE.
    useInboxStore.getState().archiveChatChannel(CHAN, false);
    expect(useInboxStore.getState().chatChannels[CHAN].archived_at).toBe(null);
    _resetChatRailMemo();
    expect(selectChatRail(chatState(), "me").some((c) => c.id === CHAN)).toBe(true);
  });
});

describe("boot with a persisted stub AND its server twin", () => {
  const CHAN = "chanboot123456789012345678901234";
  const SERVER_ID = "msgboot123456789012345678901234x";
  const STUB_ID = "chatmsgstub-boottwin";

  it("one live sync collapses the pair — the screenshot-duplicate case", () => {
    // IDB persistence saves BOTH the optimistic stub and, after supersede, the
    // server row. A crash between the stub write and the supersede leaves both
    // on disk; boot hydration then seeds both keys, and every message you ever
    // sent renders twice until something collapses them.
    useInboxStore.getState().syncTable("chatMessages", [
      { _id: STUB_ID, client_id: STUB_ID, channel_id: CHAN, user_id: "me", content: "ping", created_at: 100, updated_at: 100 },
      { _id: SERVER_ID, client_id: STUB_ID, channel_id: CHAN, user_id: "me", content: "ping", created_at: 100, updated_at: 100 },
    ], { isDelta: true });

    // The live page for the channel arrives.
    useInboxStore.getState().syncTable("chatMessages", [
      { _id: SERVER_ID, client_id: STUB_ID, channel_id: CHAN, user_id: "me", content: "ping", created_at: 100, updated_at: 100 },
    ], { isDelta: true });

    const rows = selectChannelMessages(chatState(), CHAN);
    expect(rows.map((r) => r._id)).toEqual([SERVER_ID]);
    expect(useInboxStore.getState().chatMessages[STUB_ID]).toBeUndefined();
  });
});

// ── DM channel resolution: real rows beat stubs ─────────────────────────────
//
// A press that races the channel sync creates a stub DM whose dm_key matches
// the real channel. The server's idempotent open answers with the EXISTING
// row (someone else's client_id), so nothing supersedes the stub — it lives
// forever in the cache. These pin that a persisted stub can never again
// shadow the real channel, and that a stub in flight can be resolved to the
// row that makes it real.
import { CHAT_CHANNEL_STUB_PREFIX, findDmChannelId, resolveChannelStubId } from "../chatSlice";

describe("findDmChannelId", () => {
  const DM_KEY = "team1:usera:userb";
  const REAL = serverId("dmreal");
  const STUB = `${CHAT_CHANNEL_STUB_PREFIX}abc123`;

  it("prefers the real row when a stub carries the same dm_key", () => {
    // Stub first in insertion order — the order that used to poison the key.
    const rows = {
      [STUB]: { _id: STUB, dm_key: DM_KEY },
      [REAL]: { _id: REAL, dm_key: DM_KEY },
    };
    expect(findDmChannelId(rows, DM_KEY)).toBe(REAL);
  });

  it("falls back to the stub when no real row has arrived", () => {
    const rows = { [STUB]: { _id: STUB, dm_key: DM_KEY } };
    expect(findDmChannelId(rows, DM_KEY)).toBe(STUB);
  });

  it("finds nothing for an unknown key", () => {
    expect(findDmChannelId({ [REAL]: { _id: REAL, dm_key: DM_KEY } }, "other")).toBeNull();
  });
});

describe("resolveChannelStubId", () => {
  const DM_KEY = "team1:usera:userb";
  const REAL = serverId("dmreal");
  const STUB = `${CHAT_CHANNEL_STUB_PREFIX}abc123`;

  it("resolves through the create echo (client_id)", () => {
    const rows = {
      [STUB]: { client_id: STUB },
      [REAL]: { client_id: STUB },
    };
    expect(resolveChannelStubId(rows, STUB)).toBe(REAL);
  });

  it("resolves through a matching dm_key when the DM already existed", () => {
    const rows = {
      [STUB]: { client_id: STUB, dm_key: DM_KEY },
      [REAL]: { client_id: "someone-elses-create", dm_key: DM_KEY },
    };
    expect(resolveChannelStubId(rows, STUB)).toBe(REAL);
  });

  it("never answers with another stub", () => {
    const OTHER_STUB = `${CHAT_CHANNEL_STUB_PREFIX}zzz999`;
    const rows = {
      [STUB]: { client_id: STUB, dm_key: DM_KEY },
      [OTHER_STUB]: { client_id: OTHER_STUB, dm_key: DM_KEY },
    };
    expect(resolveChannelStubId(rows, STUB)).toBeNull();
  });

  it("passes an unresolved stub back as null", () => {
    expect(resolveChannelStubId({ [STUB]: { client_id: STUB } }, STUB)).toBeNull();
  });
});
