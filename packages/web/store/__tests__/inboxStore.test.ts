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

  it("preserves drafts when moving them to a new conversation id", () => {
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

    useInboxStore.getState().moveDraft("conv1", "conv2");

    const state = useInboxStore.getState();
    expect(state.drafts.conv1).toBeUndefined();
    expect(state.clientState.drafts?.conv1).toBeNull();
    expect(state.drafts.conv2).toEqual({
      draft_message: "draft survives switch",
    });
    expect(state.clientState.drafts?.conv2).toEqual({
      draft_message: "draft survives switch",
    });
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

  it("puts stopped sessions in Needs Input (not invisible)", () => {
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

    // Stopped sessions need user attention — they must be visible
    expect(needsInput.map((s) => s._id)).toContain("conv-stopped");
    expect(needsInput.map((s) => s._id)).toContain("conv-idle");
    expect(working.map((s) => s._id)).not.toContain("conv-stopped");
  });

  it("puts idle sessions with pending messages in Working (not Needs Input)", () => {
    const idleWithPending: InboxSession = {
      ...baseSession,
      _id: "conv-pending",
      session_id: "session-pending",
      message_count: 5,
      agent_status: "idle",
      is_idle: true,
      has_pending: true,
    };
    const idleNoPending: InboxSession = {
      ...baseSession,
      _id: "conv-no-pending",
      session_id: "session-no-pending",
      message_count: 3,
      agent_status: "idle",
      is_idle: true,
      has_pending: false,
    };

    const { needsInput, working } = categorizeSessions(
      {
        [idleWithPending._id]: idleWithPending,
        [idleNoPending._id]: idleNoPending,
      },
      new Set(),
    );

    // Pending messages mean work is about to start — don't flag as needs input
    expect(working.map((s) => s._id)).toContain("conv-pending");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-pending");
    // Genuinely idle session without pending work stays in needs input
    expect(needsInput.map((s) => s._id)).toContain("conv-no-pending");
  });

  it("puts sessions with queued messages in Working (not Needs Input)", () => {
    const idleSession: InboxSession = {
      ...baseSession,
      _id: "conv-queued",
      session_id: "session-queued",
      message_count: 5,
      agent_status: "idle",
      is_idle: true,
      has_pending: false,
    };

    const { needsInput, working } = categorizeSessions(
      { [idleSession._id]: idleSession },
      new Set(["conv-queued"]),
    );

    expect(working.map((s) => s._id)).toContain("conv-queued");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-queued");
  });
});
