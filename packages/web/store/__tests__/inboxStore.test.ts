import { beforeEach, describe, expect, it } from "bun:test";
import { categorizeSessions, getSessionRenderKey, isSessionDismissed, useInboxStore, type InboxSession } from "../inboxStore";
import { isPersistedStoreKey } from "../idbCache";

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

  it("keeps a working session out of Needs Input even when the previous turn was interrupted", () => {
    // Regression: resume after interrupt leaves last_user_message as the
    // interrupt control text while agent_status flips to "working". An old
    // override classified this as idle; it must now stay in Working.
    const resumedAfterInterrupt: InboxSession = {
      ...baseSession,
      _id: "conv-resumed",
      session_id: "session-resumed",
      message_count: 5,
      agent_status: "working",
      is_idle: false,
      last_user_message: "[Request interrupted by user]",
    };

    const { needsInput, working } = categorizeSessions(
      { [resumedAfterInterrupt._id]: resumedAfterInterrupt },
      new Set(),
    );

    expect(working.map((s) => s._id)).toContain("conv-resumed");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-resumed");
  });

  it("trusts backend is_idle=false when agent_status is idle (recent assistant burst)", () => {
    // Right after the assistant finishes streaming, the daemon flips
    // agent_status from "working" to "idle" while the conversation was
    // updated <45s ago. The backend's is_idle composes recency + role and
    // returns false (still effectively working). The frontend must defer
    // to that — not short-circuit on agent_status === "idle".
    const justFinished: InboxSession = {
      ...baseSession,
      _id: "conv-just-finished",
      session_id: "session-just-finished",
      message_count: 7,
      agent_status: "idle",
      is_idle: false,
      last_user_message: "Earlier user prompt",
    };

    const { needsInput, working } = categorizeSessions(
      { [justFinished._id]: justFinished },
      new Set(),
    );

    expect(working.map((s) => s._id)).toContain("conv-just-finished");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-just-finished");
  });

  it("classifies agent_status=working as Working even if backend is_idle is stale=true", () => {
    // Convex propagation gap: agent_status update arrives before is_idle
    // recomputes. ACTIVE statuses are a definitive working signal.
    const workingButStaleIdle: InboxSession = {
      ...baseSession,
      _id: "conv-stale-idle",
      session_id: "session-stale-idle",
      message_count: 3,
      agent_status: "working",
      is_idle: true,
    };

    const { needsInput, working } = categorizeSessions(
      { [workingButStaleIdle._id]: workingButStaleIdle },
      new Set(),
    );

    expect(working.map((s) => s._id)).toContain("conv-stale-idle");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-stale-idle");
  });

  it("classifies an open poll as Needs Input even when agent_status is raced to working", () => {
    // The bug: an AskUserQuestion poll blocks the agent on the user, but the
    // daemon races agent_status back to "working" while the poll is still open,
    // burying it in the Working bucket. awaiting_input (derived server-side from
    // the unanswered tool_use) must override agent_status: a poll is ALWAYS
    // needs-input.
    const openPoll: InboxSession = {
      ...baseSession,
      _id: "conv-open-poll",
      session_id: "session-open-poll",
      message_count: 5,
      agent_status: "working",
      is_idle: false,
      awaiting_input: true,
    };

    const { needsInput, working } = categorizeSessions(
      { [openPoll._id]: openPoll },
      new Set(),
    );

    expect(needsInput.map((s) => s._id)).toContain("conv-open-poll");
    expect(working.map((s) => s._id)).not.toContain("conv-open-poll");
  });

  it("classifies a permission_blocked agent as Needs Input even within the 45s recency grace", () => {
    // A permission prompt (Bash approval, resume menu, AskUserQuestion) reports
    // agent_status=permission_blocked. The block event itself bumps updated_at, so
    // the backend's is_idle stays false for the 45s recentlyUpdated grace, and a
    // non-AskUserQuestion prompt has no awaiting_input message to derive from.
    // Without treating permission_blocked as a hard "blocked on user" signal, the
    // session sits in Working while it is actually waiting on the user.
    const blocked: InboxSession = {
      ...baseSession,
      _id: "conv-perm-blocked",
      session_id: "session-perm-blocked",
      message_count: 5,
      agent_status: "permission_blocked",
      is_idle: false,
      awaiting_input: false,
    };

    const { needsInput, working } = categorizeSessions(
      { [blocked._id]: blocked },
      new Set(),
    );

    expect(needsInput.map((s) => s._id)).toContain("conv-perm-blocked");
    expect(working.map((s) => s._id)).not.toContain("conv-perm-blocked");
  });

  it("an open poll overrides a stuck queued message → Needs Input", () => {
    // Deadlock case: a message is queued for the agent, but the agent is blocked
    // on a poll, so the message can't be delivered (you can't paste into a
    // blocking menu). The poll must win over has_pending, otherwise the session
    // is hidden in Working forever with an undeliverable message.
    const polled: InboxSession = {
      ...baseSession,
      _id: "conv-poll-queued",
      session_id: "session-poll-queued",
      message_count: 5,
      agent_status: "working",
      awaiting_input: true,
      has_pending: true,
    };

    const { needsInput, working } = categorizeSessions(
      { [polled._id]: polled },
      new Set(),
    );

    expect(needsInput.map((s) => s._id)).toContain("conv-poll-queued");
    expect(working.map((s) => s._id)).not.toContain("conv-poll-queued");
  });

  it("a pinned poll stays in its own group, not duplicated into Needs Input", () => {
    const pinnedPoll: InboxSession = {
      ...baseSession,
      _id: "conv-pinned-poll",
      session_id: "session-pinned-poll",
      message_count: 5,
      awaiting_input: true,
      is_pinned: true,
    };

    const { needsInput, pinned } = categorizeSessions(
      { [pinnedPoll._id]: pinnedPoll },
      new Set(),
    );

    expect(pinned.map((s) => s._id)).toContain("conv-pinned-poll");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-pinned-poll");
  });

  it("sinks deferred sessions to the bottom of Needs Input", () => {
    // Defer (shift+backspace / "send to bottom") sets is_deferred. The needsInput
    // group must honor that flag, otherwise deferring a needs-input session is a no-op.
    const early: InboxSession = {
      ...baseSession,
      _id: "conv-early",
      session_id: "session-early",
      message_count: 3,
      updated_at: 100,
    };
    const late: InboxSession = {
      ...baseSession,
      _id: "conv-late",
      session_id: "session-late",
      message_count: 3,
      updated_at: 200,
    };
    // Deferred and OLDEST — a pure updated_at sort would float it to the top,
    // so this only passes if is_deferred overrides the timestamp ordering.
    const deferred: InboxSession = {
      ...baseSession,
      _id: "conv-deferred",
      session_id: "session-deferred",
      message_count: 3,
      updated_at: 50,
      is_deferred: true,
    };

    const { needsInput } = categorizeSessions(
      {
        [deferred._id]: deferred,
        [early._id]: early,
        [late._id]: late,
      },
      new Set(),
    );

    // All three still need input; deferred sinks below the rest despite newest updated_at.
    expect(needsInput.map((s) => s._id)).toEqual([
      "conv-early",
      "conv-late",
      "conv-deferred",
    ]);
  });
});

describe("mergeMessages — sync-recovery safety net", () => {
  // mergeMessages is the operation the watermark recovery loop in
  // useConversationMessages relies on to back-fill messages when
  // usePaginatedQuery's reactivity stalls. These tests pin the
  // guarantees that recovery depends on: idempotent append, gap fill,
  // no duplicates on overlap, no loss when the delta lands in chunks.

  function msg(id: string, ts: number, role: "user" | "assistant" = "assistant") {
    return { _id: id, role, content: id, timestamp: ts } as any;
  }

  beforeEach(() => {
    useInboxStore.setState({
      messages: {},
      pendingMessages: {},
      pagination: {},
    });
  });

  it("appends a delta when the server has more messages than the local store", () => {
    const store = useInboxStore.getState();
    store.setMessages("c1", [msg("m1", 1), msg("m2", 2), msg("m3", 3)]);
    store.mergeMessages("c1", [msg("m4", 4), msg("m5", 5)], "append", { initialized: true });

    const out = useInboxStore.getState().messages.c1;
    expect(out.map((m: any) => m._id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("dedupes messages already in the local store (overlap at the boundary)", () => {
    const store = useInboxStore.getState();
    store.setMessages("c1", [msg("m1", 1), msg("m2", 2), msg("m3", 3)]);
    // Server returns m3 (the last local) and the new ones — the watermark
    // fetch uses `>= last_timestamp` semantics in some paths, so overlap
    // happens. The store must not double the boundary message.
    store.mergeMessages("c1", [msg("m3", 3), msg("m4", 4), msg("m5", 5)], "append", { initialized: true });

    const out = useInboxStore.getState().messages.c1;
    expect(out.map((m: any) => m._id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("converges on the server set after a stall + recovery sequence", () => {
    const store = useInboxStore.getState();
    // Initial load: paginated query returns 3 messages.
    store.setMessages("c1", [msg("m1", 1), msg("m2", 2), msg("m3", 3)]);

    // Pagination stalls. Agent writes 50 more messages on the server.
    // Recovery loop fires repeatedly with the current watermark, fetching
    // in chunks until it catches up.
    const allNew: any[] = [];
    for (let i = 4; i <= 53; i++) allNew.push(msg(`m${i}`, i));

    // First recovery page (20 messages).
    store.mergeMessages("c1", allNew.slice(0, 20), "append", { initialized: true });
    expect(useInboxStore.getState().messages.c1.length).toBe(23);

    // Second recovery page (next 20). Real recovery sends `after_timestamp`
    // of the last local, but the store must be safe even if pages overlap.
    store.mergeMessages("c1", allNew.slice(15, 35), "append", { initialized: true });
    expect(useInboxStore.getState().messages.c1.length).toBe(38);

    // Final recovery page.
    store.mergeMessages("c1", allNew.slice(30), "append", { initialized: true });
    const final = useInboxStore.getState().messages.c1;
    expect(final.length).toBe(53);
    // Strictly sorted by timestamp — recovery must not corrupt order.
    for (let i = 1; i < final.length; i++) {
      expect(final[i].timestamp).toBeGreaterThanOrEqual(final[i - 1].timestamp);
    }
    // No duplicate ids.
    expect(new Set(final.map((m: any) => m._id)).size).toBe(53);
  });

  it("setMessages preserves local messages newer than the paginated batch", () => {
    // Real-world race: usePaginatedQuery's first page is stalled at items
    // 1-100 (timestamps 1-100). Recovery loop fetches items 101-105 via
    // getNewMessages and merges them. PaginatedQuery later re-fires with
    // the SAME stale 100-item snapshot — setMessages must not clobber the
    // recovery-added newer items.
    const store = useInboxStore.getState();
    const paginated: any[] = [];
    for (let i = 1; i <= 100; i++) paginated.push(msg(`m${i}`, i));
    store.setMessages("c1", paginated);

    // Recovery merges newer messages.
    store.mergeMessages("c1", [msg("m101", 101), msg("m102", 102)], "append", { initialized: true });
    expect(useInboxStore.getState().messages.c1.length).toBe(102);

    // PaginatedQuery re-fires with the same stale 100-item snapshot.
    store.setMessages("c1", paginated);

    // Recovery-added items must survive.
    const out = useInboxStore.getState().messages.c1;
    expect(out.length).toBe(102);
    expect(out[out.length - 1]._id).toBe("m102");
  });

  it("preserves local messages when a recovery fetch returns nothing new", () => {
    const store = useInboxStore.getState();
    store.setMessages("c1", [msg("m1", 1), msg("m2", 2), msg("m3", 3)]);
    // No-op delta: server returned the same items we already had.
    store.mergeMessages("c1", [msg("m1", 1), msg("m2", 2), msg("m3", 3)], "append", { initialized: true });

    const out = useInboxStore.getState().messages.c1;
    expect(out.map((m: any) => m._id)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("dismiss is absolute — navigation/injection must not resurrect", () => {
  // Bug history: dismissed sessions kept reappearing in prod because
  // navigateToSession and injectSession silently cleared `inbox_dismissed_at`
  // on every navigation (URL deep-link, refresh with ?s= param, command
  // palette jump, sidebar bookmark, /conversation/[id] redirect, desktop
  // window-focus). Each of those dispatched a server patch that wiped
  // dismiss everywhere. These tests pin the invariant: only an explicit
  // user action (unstashSession, or sending a message) clears dismiss.

  const dismissed: InboxSession = {
    ...baseSession,
    _id: "conv-dismissed",
    session_id: "session-dismissed",
    inbox_dismissed_at: 100,
  };
  const alive: InboxSession = {
    ...baseSession,
    _id: "conv-alive",
    session_id: "session-alive",
  };

  beforeEach(() => {
    useInboxStore.setState({
      sessions: {
        [dismissed._id]: { ...dismissed },
        [alive._id]: { ...alive },
      },
      conversations: {
        [dismissed._id]: { _id: dismissed._id, inbox_dismissed_at: 100 } as any,
        [alive._id]: { _id: alive._id } as any,
      },
      currentSessionId: null,
      viewingDismissedId: null,
      clientState: {},
      pending: {},
    });
  });

  it("navigateToSession does NOT clear dismiss on a dismissed session", () => {
    useInboxStore.getState().navigateToSession(dismissed._id);

    const s = useInboxStore.getState();
    expect(isSessionDismissed(s.sessions[dismissed._id])).toBe(true);
    expect(s.sessions[dismissed._id].inbox_dismissed_at).toBe(100);
    expect((s.conversations[dismissed._id] as any).inbox_dismissed_at).toBe(100);
  });

  it("navigateToSession routes a dismissed target through viewingDismissedId, not currentSessionId", () => {
    useInboxStore.getState().navigateToSession(dismissed._id);

    const s = useInboxStore.getState();
    expect(s.viewingDismissedId).toBe(dismissed._id);
    expect(s.currentSessionId).not.toBe(dismissed._id);
  });

  it("navigateToSession still works normally for a live session", () => {
    useInboxStore.getState().navigateToSession(alive._id);

    const s = useInboxStore.getState();
    expect(s.currentSessionId).toBe(alive._id);
    expect(s.viewingDismissedId).toBeNull();
    expect(isSessionDismissed(s.sessions[alive._id])).toBe(false);
  });

  it("injectSession preserves an incoming dismissed session's flag", () => {
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      currentSessionId: null,
      viewingDismissedId: null,
    });
    useInboxStore.getState().injectSession({
      ...baseSession,
      _id: "conv-injected",
      session_id: "sess-injected",
      inbox_dismissed_at: 555,
    } as InboxSession);

    const s = useInboxStore.getState();
    expect(s.sessions["conv-injected"].inbox_dismissed_at).toBe(555);
    expect(isSessionDismissed(s.sessions["conv-injected"])).toBe(true);
  });

  it("injectSession of a live session doesn't accidentally mark it dismissed", () => {
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      currentSessionId: null,
      viewingDismissedId: null,
    });
    useInboxStore.getState().injectSession({
      ...baseSession,
      _id: "conv-fresh",
      session_id: "sess-fresh",
    } as InboxSession);

    const s = useInboxStore.getState();
    expect(isSessionDismissed(s.sessions["conv-fresh"])).toBe(false);
  });

  it("stash then navigate then unstash — dismiss survives the round trip", () => {
    useInboxStore.setState({
      sessions: {
        [alive._id]: { ...alive },
      },
      conversations: {
        [alive._id]: { _id: alive._id } as any,
      },
      currentSessionId: alive._id,
      viewingDismissedId: null,
      clientState: {},
      pending: {},
    });

    useInboxStore.getState().stashSession(alive._id);
    expect(isSessionDismissed(useInboxStore.getState().sessions[alive._id])).toBe(true);

    useInboxStore.getState().navigateToSession(alive._id);
    expect(isSessionDismissed(useInboxStore.getState().sessions[alive._id])).toBe(true);

    useInboxStore.getState().unstashSession(alive._id);
    expect(isSessionDismissed(useInboxStore.getState().sessions[alive._id])).toBe(false);
  });
});

describe("pending user messages must never be lost on reload", () => {
  // Bug history: a sent-but-unconfirmed message vanished on cmd-r. Root cause:
  // `pendingMessages` was absent from the IDB persistence allowlist, so the
  // optimistic write was silently dropped and never rehydrated. These tests
  // pin the two halves of the durability guarantee: the message lands in
  // pendingMessages, and pendingMessages is a persisted key.

  beforeEach(() => {
    useInboxStore.setState({ messages: {}, pendingMessages: {}, pagination: {} });
  });

  it("addOptimisticMessage lands the message in the persisted pendingMessages map", () => {
    const clientId = useInboxStore.getState().addOptimisticMessage("c1", "hello world");

    const pending = useInboxStore.getState().pendingMessages.c1;
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("hello world");
    expect(pending[0]._clientId).toBe(clientId);

    // The half that broke: the key must be durable, or the above is lost on reload.
    expect(isPersistedStoreKey("pendingMessages")).toBe(true);
  });

  it("keeps the message visible after a failed send (never drops it)", () => {
    const store = useInboxStore.getState();
    const clientId = store.addOptimisticMessage("c1", "retry me");
    store.markOptimisticAsFailed("c1", clientId);

    const pending = useInboxStore.getState().pendingMessages.c1;
    expect(pending).toHaveLength(1);
    expect(pending[0]._isFailed).toBe(true);
  });

  it("prunes a pending message only once the server confirms it by client_id", () => {
    const store = useInboxStore.getState();
    const clientId = store.addOptimisticMessage("c1", "delivered");

    // Unrelated server message arrives — the pending message must survive.
    store.setMessages("c1", [{ _id: "s1", role: "assistant", content: "hi", timestamp: 1 } as any]);
    expect(useInboxStore.getState().pendingMessages.c1).toHaveLength(1);

    // The server echoes the user message back with the matching client_id.
    store.setMessages("c1", [
      { _id: "s1", role: "assistant", content: "hi", timestamp: 1 } as any,
      { _id: "s2", role: "user", content: "delivered", client_id: clientId, timestamp: 2 } as any,
    ]);
    expect(useInboxStore.getState().pendingMessages.c1).toHaveLength(0);
  });
});
