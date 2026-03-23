import { beforeEach, describe, expect, it } from "bun:test";
import { getSessionRenderKey, useInboxStore, type InboxSession } from "../inboxStore";

const baseSession: InboxSession = {
  _id: "conv1",
  session_id: "session-1",
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 0,
  is_idle: true,
  has_pending: false,
};

describe("inboxStore.setConversationAgent", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      currentConversation: {},
    });
  });

  it("updates the inbox session, conversation meta, and current conversation together", () => {
    useInboxStore.setState({
      sessions: {
        conv1: baseSession,
      },
      conversations: {
        conv1: {
          _id: "conv1",
          agent_type: "claude_code",
          title: "New Session",
        },
      },
      currentConversation: {
        conversationId: "conv1",
        projectPath: "/tmp/codecast",
        gitRoot: "/tmp/codecast",
        agentType: "claude_code",
        source: "sessions",
      },
    });

    useInboxStore.getState().setConversationAgent("conv1", "codex");

    const state = useInboxStore.getState();
    expect(state.sessions.conv1?.agent_type).toBe("codex");
    expect(state.conversations.conv1?.agent_type).toBe("codex");
    expect(state.currentConversation.agentType).toBe("codex");
    expect(state.currentConversation.source).toBe("sessions");
  });

  it("still updates sessions-page state when there is no inbox session entry", () => {
    useInboxStore.setState({
      conversations: {
        conv2: {
          _id: "conv2",
          agent_type: "claude_code",
          title: "Fresh Session",
        },
      },
      currentConversation: {
        conversationId: "conv2",
        agentType: "claude_code",
        source: "sessions",
      },
    });

    useInboxStore.getState().setConversationAgent("conv2", "gemini");

    const state = useInboxStore.getState();
    expect(state.sessions.conv2).toBeUndefined();
    expect(state.conversations.conv2?.agent_type).toBe("gemini");
    expect(state.currentConversation.agentType).toBe("gemini");
    expect(state.currentConversation.source).toBe("sessions");
  });
});

describe("getSessionRenderKey", () => {
  it("stays stable across optimistic-to-server id promotion", () => {
    expect(getSessionRenderKey({
      _id: "temp-session-id",
      session_id: "session-1",
    })).toBe("session-1");

    expect(getSessionRenderKey({
      _id: "jn7abc123def456ghi789jklmnopqrs",
      session_id: "session-1",
    })).toBe("session-1");
  });

  it("falls back to the conversation id when there is no session id", () => {
    expect(getSessionRenderKey({
      _id: "jn7abc123def456ghi789jklmnopqrs",
    } as Pick<InboxSession, "_id" | "session_id">)).toBe("jn7abc123def456ghi789jklmnopqrs");
  });
});
