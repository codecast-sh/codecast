import { beforeEach, describe, expect, it } from "bun:test";
import { categorizeSessions, getSessionRenderKey, useInboxStore, type InboxSession } from "../inboxStore";

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
      drafts: {},
      clientState: {},
      currentSessionId: null,
      pending: {},
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

describe("draft migration", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      drafts: {},
      clientState: {},
      currentSessionId: null,
      pending: {},
      currentConversation: {},
    });
  });

  it("moves the draft payload to the replacement session id", () => {
    useInboxStore.getState().setDraft("conv1", {
      draft_message: "keep this",
      draft_image_storage_ids: [{ storageId: "img1" }],
    });

    useInboxStore.getState().moveDraft("conv1", "temp2");

    const state = useInboxStore.getState();
    expect(state.drafts.conv1).toBeUndefined();
    expect(state.clientState.drafts?.conv1).toBeNull();
    expect(state.drafts.temp2).toEqual({
      draft_message: "keep this",
      draft_image_storage_ids: [{ storageId: "img1" }],
    });
    expect(state.clientState.drafts?.temp2).toEqual({
      draft_message: "keep this",
      draft_image_storage_ids: [{ storageId: "img1" }],
    });
  });

  it("preserves drafts when switching agents through the inbox store", () => {
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
      drafts: {
        conv1: {
          draft_message: "draft survives switch",
        },
      },
      clientState: {
        drafts: {
          conv1: {
            draft_message: "draft survives switch",
          },
        },
      },
      currentSessionId: "conv1",
      pending: {},
    });

    const newSessionId = useInboxStore.getState().switchAgent("conv1", "codex");

    expect(newSessionId).toBeTruthy();
    const state = useInboxStore.getState();
    expect(state.drafts.conv1).toBeUndefined();
    expect(state.clientState.drafts?.conv1).toBeNull();
    expect(newSessionId ? state.drafts[newSessionId] : undefined).toEqual({
      draft_message: "draft survives switch",
    });
    expect(newSessionId ? state.sessions[newSessionId]?.agent_type : undefined).toBe("codex");
  });
});

describe("getSessionRenderKey", () => {
  it("prefers stable session_id over _id to survive rekeys", () => {
    expect(getSessionRenderKey({
      _id: "jn7abc123def456ghi789jklmnopqrs",
      session_id: "session-1",
    } as InboxSession)).toBe("session-1");

    expect(getSessionRenderKey({
      _id: "jn7abc123def456ghi789jklmnopqrs",
    } as InboxSession)).toBe("jn7abc123def456ghi789jklmnopqrs");
  });

  it("returns same key before and after rekey", () => {
    const before = getSessionRenderKey({
      _id: "temp-random-id",
      session_id: "session-stable",
    } as InboxSession);
    const after = getSessionRenderKey({
      _id: "jn7abc123def456ghi789jklmnopqrs",
      session_id: "session-stable",
    } as InboxSession);
    expect(before).toBe(after);
  });
});

describe("categorizeSessions", () => {
  it("puts interrupted sessions in Needs Input", () => {
    const interrupted: InboxSession = {
      ...baseSession,
      _id: "conv-interrupted",
      session_id: "session-interrupted",
      message_count: 3,
      last_user_message: "[Request interrupted by user]",
    };
    const needsReply: InboxSession = {
      ...baseSession,
      _id: "conv-needs-reply",
      session_id: "session-needs-reply",
      message_count: 4,
      last_user_message: "Can you finish the refactor?",
    };

    const { needsInput } = categorizeSessions(
      {
        [interrupted._id]: interrupted,
        [needsReply._id]: needsReply,
      },
      new Set(),
    );

    expect(needsInput.map((s) => s._id)).toContain("conv-interrupted");
    expect(needsInput.map((s) => s._id)).toContain("conv-needs-reply");
  });

  it("excludes stopped sessions from Needs Input", () => {
    const stopped: InboxSession = {
      ...baseSession,
      _id: "conv-stopped",
      session_id: "session-stopped",
      message_count: 5,
      agent_status: "stopped",
      is_idle: true,
    };
    const idle: InboxSession = {
      ...baseSession,
      _id: "conv-idle",
      session_id: "session-idle",
      message_count: 3,
      agent_status: "idle",
      is_idle: true,
    };

    const { needsInput, working } = categorizeSessions(
      {
        [stopped._id]: stopped,
        [idle._id]: idle,
      },
      new Set(),
    );

    expect(needsInput.map((s) => s._id)).not.toContain("conv-stopped");
    expect(needsInput.map((s) => s._id)).toContain("conv-idle");
    // stopped sessions shouldn't be in working either
    expect(working.map((s) => s._id)).not.toContain("conv-stopped");
  });
});
