import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { categorizeSessions, computeNewDividerIndex, dropLatchedFeedHasMore, feedPagePersistence, findReusableBlankSession, getSessionRenderKey, isConvexId, isSessionDismissed, isSessionStashed, orchestrationGroupLabelOf, PENDING_SEND_PRUNE_GRACE_MS, pendingSendConsumed, reconcilePendingSendForSession, resolveAssigneeInfo, resolveSessionAuthor, resolveShowOld, seedLiveInboxIdsFromCache, sessionsWithPendingSend, unionHydrate, useInboxStore, worktreeKeyOf, type InboxSession } from "../inboxStore";
import { isPersistedStoreKey } from "../idbCache";
import { declareViewNav } from "../viewNav";

// Test seeds that place the user ON a conversation via raw setState must
// declare a source — undeclared non-null view writes are reverted by the
// view-motion guard (viewNav.ts), in tests exactly as in production.
function seedCurrentSession(partial: Record<string, unknown>) {
  declareViewNav("gesture");
  useInboxStore.setState(partial as any);
}

// Fresh by default: a genuinely-working/active session has a recent updated_at.
// categorizeSessions distrusts an active status that's gone quiet past the trust
// TTL (see isTrustStale), so a stale sentinel would wrongly sweep these fixtures
// into needs-input. Tests that want an AGED session override updated_at.
const baseSession: InboxSession = {
  _id: "conv1",
  session_id: "session-1",
  updated_at: Date.now(),
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
    seedCurrentSession({
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

  it("routes auth-error (pending_api_error) sessions to Needs Input even when the daemon still claims working", () => {
    // A signed-out session whose Stop hook was lost: the daemon re-asserts
    // "working" so is_idle stays false. Without the auth routing it would hide
    // in Working; the pending_api_error flag must surface it for re-login.
    const signedOut: InboxSession = {
      ...baseSession,
      _id: "conv-auth-error",
      session_id: "session-auth-error",
      message_count: 6,
      is_idle: false,
      agent_status: "working",
      pending_api_error: true,
    };
    // Control: same shape, no banner → genuinely working, stays out of Needs Input.
    const working: InboxSession = {
      ...baseSession,
      _id: "conv-working",
      session_id: "session-working",
      message_count: 6,
      is_idle: false,
      agent_status: "working",
    };

    const { needsInput, working: workingBucket } = categorizeSessions(
      {
        [signedOut._id]: signedOut,
        [working._id]: working,
      },
      new Set(),
    );

    expect(needsInput.map((s) => s._id)).toContain("conv-auth-error");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-working");
    expect(workingBucket.map((s) => s._id)).toContain("conv-working");
    expect(workingBucket.map((s) => s._id)).not.toContain("conv-auth-error");
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

  it("moves an idle session with an unconfirmed pending send into Working (local-first)", () => {
    // The durable signal: a sent-but-unconfirmed message lives in
    // pendingMessages. Independent of ConversationView being mounted, that
    // session must show as Working ("pending"), not sit in Needs Input.
    const idleSession: InboxSession = {
      ...baseSession,
      _id: "conv-pending-send",
      session_id: "session-pending-send",
      message_count: 5,
      agent_status: "idle",
      is_idle: true,
      has_pending: false,
    };

    const { needsInput, working } = categorizeSessions(
      { [idleSession._id]: idleSession },
      new Set(),
      new Set(["conv-pending-send"]),
    );

    expect(working.map((s) => s._id)).toContain("conv-pending-send");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-pending-send");
  });

  it("routes an UNRESPONSIVE session with a stuck has_pending to Needs Input, not Working", () => {
    // Regression (iOS-sim case): a message was queued, the daemon then died, and
    // has_pending stayed latched true. The session is idle and the dead daemon
    // can't deliver — it needs the user (resume/restart), so it must NOT keep a
    // "working" badge just because has_pending is set.
    const deadDaemon: InboxSession = {
      ...baseSession,
      _id: "conv-unresponsive",
      session_id: "session-unresponsive",
      message_count: 9,
      is_idle: true,
      has_pending: true,
      is_unresponsive: true,
    };

    const { needsInput, working } = categorizeSessions(
      { [deadDaemon._id]: deadDaemon },
      new Set(),
    );
    expect(needsInput.map((s) => s._id)).toContain("conv-unresponsive");
    expect(working.map((s) => s._id)).not.toContain("conv-unresponsive");
  });

  it("keeps a RESPONSIVE session with has_pending in Working (live daemon will deliver)", () => {
    const liveDaemon: InboxSession = {
      ...baseSession,
      _id: "conv-live-pending",
      session_id: "session-live-pending",
      message_count: 9,
      is_idle: true,
      has_pending: true,
      is_unresponsive: false,
    };

    const { needsInput, working } = categorizeSessions(
      { [liveDaemon._id]: liveDaemon },
      new Set(),
    );
    expect(working.map((s) => s._id)).toContain("conv-live-pending");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-live-pending");
  });

  it("routes a STOPPED session with has_pending to Needs Input (won't pick it up)", () => {
    const stoppedPending: InboxSession = {
      ...baseSession,
      _id: "conv-stopped-pending",
      session_id: "session-stopped-pending",
      message_count: 4,
      is_idle: true,
      has_pending: true,
      agent_status: "stopped",
    };

    const { needsInput, working } = categorizeSessions(
      { [stoppedPending._id]: stoppedPending },
      new Set(),
    );
    expect(needsInput.map((s) => s._id)).toContain("conv-stopped-pending");
    expect(working.map((s) => s._id)).not.toContain("conv-stopped-pending");
  });

  it("moves a brand-new session (0 messages) with a pending first message into Working, out of New", () => {
    const newSession: InboxSession = {
      ...baseSession,
      _id: "conv-new-pending",
      session_id: "session-new-pending",
      message_count: 0,
      is_idle: true,
    };

    const withPending = categorizeSessions(
      { [newSession._id]: newSession },
      new Set(),
      new Set(["conv-new-pending"]),
    );
    expect(withPending.working.map((s) => s._id)).toContain("conv-new-pending");
    expect(withPending.newSessions.map((s) => s._id)).not.toContain("conv-new-pending");

    // Without a pending send the same session stays in New while engaged
    // (here: it's the session being viewed).
    const withoutPending = categorizeSessions(
      { [newSession._id]: newSession },
      new Set(),
      undefined,
      { currentSessionId: "conv-new-pending" },
    );
    expect(withoutPending.newSessions.map((s) => s._id)).toContain("conv-new-pending");
    expect(withoutPending.working.map((s) => s._id)).not.toContain("conv-new-pending");
  });

  it("hides a never-engaged blank (quick-create pre-warm) from every bucket", () => {
    // Regression for the "ghost New Session" stream: every palette summon
    // pre-warms a blank conversation; rendering those as NEW cards trained
    // users to dismiss them, and each dismiss+summon minted another. A blank
    // that is not the current session, has no in-flight create, and no pending
    // send is infrastructure — it must not render anywhere (it stays in the
    // cache for reuse).
    const blank: InboxSession = {
      ...baseSession,
      _id: "conv-prewarm",
      session_id: "session-prewarm",
      message_count: 0,
    };
    const buckets = categorizeSessions({ [blank._id]: blank }, new Set());
    expect(buckets.newSessions).toHaveLength(0);
    expect(buckets.working).toHaveLength(0);
    expect(buckets.needsInput).toHaveLength(0);
    expect(buckets.pinned).toHaveLength(0);
  });

  it("keeps a blank visible in New while its create is in flight", () => {
    const stub = "k2hf8s0dq1xand83hr0e7";
    const blank: InboxSession = {
      ...baseSession,
      _id: stub,
      session_id: stub,
      message_count: 0,
    };
    const buckets = categorizeSessions(
      { [blank._id]: blank },
      new Set(),
      undefined,
      { pendingCreateIds: new Set([stub]) },
    );
    expect(buckets.newSessions.map((s) => s._id)).toContain(stub);
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

  it("a fresh client send moves a poll-blocked LIVE session into Working (pending pill)", () => {
    // The user's complaint: an agent is blocked on an open AskUserQuestion, the
    // user answers via free text (the poll's "Other" path), and that send sits in
    // the durable pendingMessages map (the amber "pending" pill). The user has
    // acted — the session must move to Working, not stay in Needs Input. The
    // client send (pendingSendIds, 3rd arg) overrides awaiting_input on a live
    // daemon. Contrast with the test above: a server-only has_pending with NO
    // client send keeps the poll-deadlock protection.
    const polledWithSend: InboxSession = {
      ...baseSession,
      _id: "conv-poll-sent",
      session_id: "session-poll-sent",
      message_count: 5,
      agent_status: "working",
      is_idle: false,
      awaiting_input: true,
      has_pending: false,
    };

    const { needsInput, working } = categorizeSessions(
      { [polledWithSend._id]: polledWithSend },
      new Set(),
      new Set(["conv-poll-sent"]),
    );

    expect(working.map((s) => s._id)).toContain("conv-poll-sent");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-poll-sent");
  });

  it("a fresh client send moves a permission-blocked LIVE session into Working", () => {
    const blockedWithSend: InboxSession = {
      ...baseSession,
      _id: "conv-perm-sent",
      session_id: "session-perm-sent",
      message_count: 5,
      agent_status: "permission_blocked",
      is_idle: false,
      awaiting_input: false,
    };

    const { needsInput, working } = categorizeSessions(
      { [blockedWithSend._id]: blockedWithSend },
      new Set(),
      new Set(["conv-perm-sent"]),
    );

    expect(working.map((s) => s._id)).toContain("conv-perm-sent");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-perm-sent");
  });

  it("a client send to a STOPPED session stays in Working (pending pill, retried forever)", () => {
    // Invariant: a client pending send (the amber "pending" pill) ALWAYS means
    // Working, even on a stopped daemon. The message is retried forever and a
    // launchd-revived daemon will deliver it; the dedicated "daemon offline"
    // affordance is the global banner, not a per-card bounce into Needs Input. A
    // pending card must never appear outside Working — that mismatch (pill in
    // Needs Input) is the impossible state we're guarding against. Contrast a
    // stale SERVER-only has_pending with NO client send, which still routes a dead
    // daemon to Needs Input (see the unresponsive/stopped has_pending tests above).
    const stoppedWithSend: InboxSession = {
      ...baseSession,
      _id: "conv-dead-sent",
      session_id: "session-dead-sent",
      message_count: 5,
      agent_status: "stopped",
      is_idle: true,
      awaiting_input: false,
    };

    const { needsInput, working } = categorizeSessions(
      { [stoppedWithSend._id]: stoppedWithSend },
      new Set(),
      new Set(["conv-dead-sent"]),
    );

    expect(working.map((s) => s._id)).toContain("conv-dead-sent");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-dead-sent");
  });

  it("a client send to an UNRESPONSIVE session stays in Working (pending pill)", () => {
    // The screenshot state: a card showing the amber "pending" pill must never sit
    // outside Working. A stale daemon heartbeat (is_unresponsive) doesn't change that
    // — the client pending send overrides it, same as the stopped case above.
    const unresponsiveWithSend: InboxSession = {
      ...baseSession,
      _id: "conv-unresp-sent",
      session_id: "session-unresp-sent",
      message_count: 5,
      is_idle: true,
      is_unresponsive: true,
    };

    const { needsInput, working } = categorizeSessions(
      { [unresponsiveWithSend._id]: unresponsiveWithSend },
      new Set(),
      new Set(["conv-unresp-sent"]),
    );

    expect(working.map((s) => s._id)).toContain("conv-unresp-sent");
    expect(needsInput.map((s) => s._id)).not.toContain("conv-unresp-sent");
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

  it("orders pinned by pin time (oldest first) and ignores activity status", () => {
    // Each pinned session has a different live status. If the pinned group
    // inherited the activity-based sort, these would order by working/idle/
    // awaiting_input and reshuffle on every status flicker. They must instead
    // hold a stable order keyed only on inbox_pinned_at.
    const oldestPin: InboxSession = {
      ...baseSession,
      _id: "conv-pin-oldest",
      session_id: "session-pin-oldest",
      message_count: 5,
      is_pinned: true,
      inbox_pinned_at: 100,
      agent_status: "working", // most "active" — would sort last under sortSessions
      is_idle: false,
    };
    const middlePin: InboxSession = {
      ...baseSession,
      _id: "conv-pin-middle",
      session_id: "session-pin-middle",
      message_count: 5,
      is_pinned: true,
      inbox_pinned_at: 200,
      awaiting_input: true, // would sort first under sortSessions
    };
    const newestPin: InboxSession = {
      ...baseSession,
      _id: "conv-pin-newest",
      session_id: "session-pin-newest",
      message_count: 5,
      is_pinned: true,
      inbox_pinned_at: 300,
      agent_status: "idle",
      is_idle: true,
    };

    const sessions = {
      [oldestPin._id]: oldestPin,
      [middlePin._id]: middlePin,
      [newestPin._id]: newestPin,
    };

    const { pinned } = categorizeSessions(sessions, new Set());
    expect(pinned.map((s) => s._id)).toEqual([
      "conv-pin-oldest",
      "conv-pin-middle",
      "conv-pin-newest",
    ]);

    // Flip the live status of every pinned session. Pin time is unchanged, so
    // the order must be byte-for-byte identical — no reshuffle on status churn.
    const churned = {
      [oldestPin._id]: { ...oldestPin, agent_status: "idle" as const, is_idle: true },
      [middlePin._id]: { ...middlePin, awaiting_input: false, agent_status: "working" as const, is_idle: false },
      [newestPin._id]: { ...newestPin, agent_status: "working" as const, is_idle: false },
    };
    const after = categorizeSessions(churned, new Set());
    expect(after.pinned.map((s) => s._id)).toEqual([
      "conv-pin-oldest",
      "conv-pin-middle",
      "conv-pin-newest",
    ]);
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

  it("dedupes exact replayed server messages without UUIDs", () => {
    const store = useInboxStore.getState();
    const original = { ...msg("m1", 1), content: "same assistant text" };
    const replay = { ...msg("m1-replay", 1), content: "same assistant text" };

    store.setMessages("c1", [original, replay]);

    expect(useInboxStore.getState().messages.c1.map((m: any) => m._id)).toEqual(["m1"]);
  });

  it("dedupes exact replayed server messages across recovery merges", () => {
    const store = useInboxStore.getState();
    store.setMessages("c1", [{ ...msg("m1", 1), content: "same assistant text" }]);
    store.mergeMessages("c1", [{ ...msg("m1-replay", 1), content: "same assistant text" }], "append", { initialized: true });

    expect(useInboxStore.getState().messages.c1.map((m: any) => m._id)).toEqual(["m1"]);
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

describe("syncTable sessions — liberal delta cache (never prune by absence)", () => {
  // The inbox is a liberal cache, like tasks/docs: the live listInboxSessions
  // window syncs as a DELTA overlay (isDelta:true on the sessions registry
  // config), so a row the server stops returning is NOT deleted locally. The
  // cache accumulates; sessions leave only when explicitly dismissed (an
  // in-window update that overlays) or killed — never because they aged out of
  // the server's narrow recent window. These pin that invariant plus the
  // cross-device dismissal path.
  const active: InboxSession = { ...baseSession, _id: "a0000000000000000000000000000001", session_id: "s-active" };
  const olderActive: InboxSession = { ...baseSession, _id: "a0000000000000000000000000000002", session_id: "s-older" };
  const dismissed: InboxSession = {
    ...baseSession, _id: "a0000000000000000000000000000003", session_id: "s-dismissed", inbox_dismissed_at: 50,
  };

  beforeEach(() => {
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      pendingMessages: {},
      pending: {},
      currentSessionId: null,
      showMySessions: false,
      clientStateInitialized: false, // skip the transform's auto-select
      clientState: {},
    });
  });

  it("keeps BOTH active and dismissed sessions when a later payload omits them", () => {
    const sync = useInboxStore.getState().syncTable;
    sync("sessions", [active, olderActive, dismissed]);
    expect(Object.keys(useInboxStore.getState().sessions)).toHaveLength(3);

    // A later live window only carries the most-recent active session — the
    // older active one and the dismissed one fell out of the server's window.
    // Delta overlay must retain them: absence is not deletion.
    sync("sessions", [active]);

    const s = useInboxStore.getState();
    expect(s.sessions[active._id]).toBeDefined();
    expect(s.sessions[olderActive._id]).toBeDefined();  // not pruned
    expect(s.sessions[dismissed._id]).toBeDefined();     // not pruned
    expect(isSessionDismissed(s.sessions[dismissed._id])).toBe(true);
  });

  it("applies a dismissal arriving in a later delta (e.g. dismissed on another device)", () => {
    const sync = useInboxStore.getState().syncTable;
    sync("sessions", [active]);
    expect(isSessionDismissed(useInboxStore.getState().sessions[active._id])).toBe(false);

    // Another device dismissed it: the row comes back in-window with the flag
    // set, and the delta overlays the new field onto the cached row.
    sync("sessions", [{ ...active, inbox_dismissed_at: 1234 }]);

    expect(isSessionDismissed(useInboxStore.getState().sessions[active._id])).toBe(true);
  });

  it("a killed session stays gone even though the server still returns it", () => {
    // The explicit-removal counterpart to the liberal cache: under delta, a kill
    // must STICK. markKilling deletes the row inside an action(), so the
    // middleware plants a sessions:<id> exclude. The server still returns the
    // conversation (marked completed, in-window), but the exclude blocks the
    // delta from resurrecting it. (Raw setState skipped the exclude → re-added.)
    const store = useInboxStore.getState();
    store.syncTable("sessions", [active]);
    expect(useInboxStore.getState().sessions[active._id]).toBeDefined();

    store.markKilling(active._id);
    expect(useInboxStore.getState().sessions[active._id]).toBeUndefined();

    store.syncTable("sessions", [active]); // server still sends it
    expect(useInboxStore.getState().sessions[active._id]).toBeUndefined();
  });
});

describe("stash/kill a TEAMMATE's injected session forgets it (can't persist server-side)", () => {
  // A foreign session (user_id ≠ me) only sits in our cache because we opened or
  // searched a teammate's session (injectSession, never-prune). The server's
  // applyPatches owner-gate (dispatch.ts) silently DROPS a hide patch on a
  // conversation we don't own, so inbox_stashed_at/inbox_dismissed_at never
  // persists; the 5-min optimistic lock lapses and the reconcile clear pass
  // resurrects it into the active inbox. Stash/kill on a foreign session must
  // therefore DELETE the injected copy + plant the exclude (durable forget) —
  // not set a doomed flag. Regression for "old sessions keep popping back up".
  const ME = "m".repeat(32);
  const THEM = "u".repeat(32);
  const FOREIGN = "f0000000000000000000000000000001";
  const MINE = "a0000000000000000000000000000001";
  const mk = (id: string, owner: string): InboxSession =>
    ({ ...baseSession, _id: id, session_id: `s-${id}`, user_id: owner });

  beforeEach(() => {
    useInboxStore.setState({
      sessions: { [FOREIGN]: mk(FOREIGN, THEM), [MINE]: mk(MINE, ME) },
      conversations: {
        [FOREIGN]: { _id: FOREIGN, user_id: THEM } as any,
        [MINE]: { _id: MINE, user_id: ME } as any,
      },
      currentUser: { _id: ME } as any,
      pendingMessages: {},
      pending: {},
      currentSessionId: null,
      clientStateInitialized: false,
      clientState: {},
    } as any);
  });

  it("stash deletes the foreign row + plants an exclude (no inbox_stashed_at flag)", () => {
    useInboxStore.getState().stashSession(FOREIGN);
    const s = useInboxStore.getState();
    expect(s.sessions[FOREIGN]).toBeUndefined();
    expect(s.conversations[FOREIGN]).toBeUndefined();
    expect(s.pending[`sessions:${FOREIGN}`]?.type).toBe("exclude");
  });

  it("a later live delta can NOT resurrect the forgotten foreign session", () => {
    useInboxStore.getState().stashSession(FOREIGN);
    useInboxStore.getState().syncTable("sessions", [mk(FOREIGN, THEM)], { isDelta: true });
    expect(useInboxStore.getState().sessions[FOREIGN]).toBeUndefined();
  });

  it("kill on a foreign session also deletes (we can't enqueue a kill we don't own)", () => {
    useInboxStore.getState().killSession(FOREIGN);
    expect(useInboxStore.getState().sessions[FOREIGN]).toBeUndefined();
  });

  it("our OWN session still stashes via the durable flag (not deleted)", () => {
    useInboxStore.getState().stashSession(MINE);
    const s = useInboxStore.getState();
    expect(s.sessions[MINE]).toBeDefined();
    expect(s.sessions[MINE].inbox_stashed_at).toBeTruthy();
  });

  // The prod shape that escaped the user_id-only check: a THIN injected row
  // (no user_id on the session at all) whose conversations meta carries the
  // access resolver's verdict. Ownership must resolve through isForeignSession
  // (session + conv meta), or these rows take the doomed flag path and
  // resurrect every ~5 minutes forever.
  it("a thin foreign row (no session.user_id, conv.is_own=false) is deleted + excluded", () => {
    const THIN = "f0000000000000000000000000000002";
    useInboxStore.setState({
      sessions: { ...useInboxStore.getState().sessions, [THIN]: { ...baseSession, _id: THIN, session_id: `s-${THIN}` } },
      conversations: { ...useInboxStore.getState().conversations, [THIN]: { _id: THIN, is_own: false, user_id: THEM } as any },
    } as any);
    useInboxStore.getState().stashSession(THIN);
    const s = useInboxStore.getState();
    expect(s.sessions[THIN]).toBeUndefined();
    expect(s.conversations[THIN]).toBeUndefined();
    expect(s.pending[`sessions:${THIN}`]?.type).toBe("exclude");
  });

  it("a thin row with NO ownership signal anywhere is assumed mine (flag path)", () => {
    const UNKNOWN = "a0000000000000000000000000000002";
    useInboxStore.setState({
      sessions: { ...useInboxStore.getState().sessions, [UNKNOWN]: { ...baseSession, _id: UNKNOWN, session_id: `s-${UNKNOWN}` } },
    } as any);
    useInboxStore.getState().stashSession(UNKNOWN);
    const s = useInboxStore.getState();
    expect(s.sessions[UNKNOWN]).toBeDefined();
    expect(s.sessions[UNKNOWN].inbox_stashed_at).toBeTruthy();
  });
});

describe("archiveDoc stays gone under delta (docs now protected)", () => {
  // docs is a liberal delta cache; archiveDoc deletes the row inside an
  // action(), so the middleware (docs ∈ COLLECTION_SPECS protected) plants a
  // docs:<id> exclude. A later docs delta sync that still returns the doc must
  // NOT resurrect it — the same guarantee sessions kill got, via the unified
  // collection spec rather than a hand-edited PROTECTED_COLLECTIONS list.
  beforeEach(() => {
    useInboxStore.setState({ docs: {}, docDetails: {}, pending: {} } as any);
  });

  it("an archived doc is not re-added by a later docs delta sync", () => {
    const store = useInboxStore.getState();
    const doc = { _id: "d0000000000000000000000000000001", title: "X", updated_at: 1 } as any;
    store.syncTable("docs", [doc], { isDelta: true });
    expect(useInboxStore.getState().docs[doc._id]).toBeDefined();

    store.archiveDoc(doc._id);
    expect(useInboxStore.getState().docs[doc._id]).toBeUndefined();

    store.syncTable("docs", [doc], { isDelta: true }); // server still returns it
    expect(useInboxStore.getState().docs[doc._id]).toBeUndefined();
  });
});

describe("pruneAbsentScope — a full workspace crawl propagates server deletions", () => {
  // Delta mode treats absence as "unchanged", so server-side hard deletes never
  // reached clients (deleted docs ghosted in the cache forever). The reconcile
  // crawl is the COMPLETE set for its workspace, so it may pass pruneAbsentScope:
  // in-scope rows absent from the payload are removed via an exclude-pending
  // entry (the same deletion contract kill/archive use — which is also what
  // authorizes the IDB diff to delete the row durably instead of resurrecting
  // it on the next hydration).
  beforeEach(() => {
    useInboxStore.setState({ docs: {}, pending: {} } as any);
  });

  const doc = (id: string, team_id?: string) =>
    ({ _id: id, title: id, team_id, updated_at: 1 }) as any;
  const inTeam1 = (d: any) => d.team_id === "team1";

  it("prunes an in-scope doc absent from the crawl, plants an exclude, and stays gone", () => {
    const store = useInboxStore.getState();
    const a = doc("d000000000000000000000000000000a", "team1");
    const b = doc("d000000000000000000000000000000b", "team1");
    store.syncTable("docs", [a, b], { isDelta: true });

    // Full crawl of team1 returns only a → b was deleted server-side.
    store.syncTable("docs", [a], { isDelta: true, pruneAbsentScope: inTeam1 });
    const s = useInboxStore.getState();
    expect(s.docs[a._id]).toBeDefined();
    expect(s.docs[b._id]).toBeUndefined();
    expect((s.pending as any)[`docs:${b._id}`]?.type).toBe("exclude");

    // A later (stale) delta overlay returning b must NOT resurrect it.
    store.syncTable("docs", [b], { isDelta: true });
    expect(useInboxStore.getState().docs[b._id]).toBeUndefined();
  });

  it("keeps out-of-scope docs — the other workspace's cache is untouched", () => {
    const store = useInboxStore.getState();
    const mine = doc("d0000000000000000000000000000010", "team1");
    const other = doc("d0000000000000000000000000000011", "team2");
    const personal = doc("d0000000000000000000000000000012", undefined);
    store.syncTable("docs", [mine, other, personal], { isDelta: true });

    store.syncTable("docs", [mine], { isDelta: true, pruneAbsentScope: inTeam1 });
    const s = useInboxStore.getState();
    expect(s.docs[mine._id]).toBeDefined();
    expect(s.docs[other._id]).toBeDefined();
    expect(s.docs[personal._id]).toBeDefined();
  });

  it("never prunes a doc with pending local state", () => {
    const store = useInboxStore.getState();
    const edited = doc("d0000000000000000000000000000020", "team1");
    store.syncTable("docs", [edited], { isDelta: true });
    useInboxStore.setState({
      pending: { [`docs:${edited._id}:title`]: { type: "field", value: "local edit" } },
    } as any);

    useInboxStore.getState().syncTable("docs", [], { isDelta: true, pruneAbsentScope: inTeam1 });
    expect(useInboxStore.getState().docs[edited._id]).toBeDefined();
  });
});

describe("big id-keyed collections are delta-by-default — a bare sync never wipes the cache", () => {
  // The systemic guarantee behind the "tasks/sessions vanish then stream back"
  // collapses: tasks/docs/plans carry isDelta:true in SYNC_REGISTRY, so EVERY
  // write is an additive overlay — even a BARE syncTable(field, subset) with no
  // opts, which is the shape the reconcile crawl's onComplete and the plans live
  // sync use. A short / windowed / truncated payload can only ADD or UPDATE; it
  // can never snapshot-prune the rows it omits. Deletions still work, but only
  // via the explicit exclude-pending path (kill / archive), never by omission.
  beforeEach(() => {
    useInboxStore.setState({ tasks: {}, docs: {}, plans: {}, pending: {} } as any);
  });

  for (const field of ["tasks", "docs", "plans"] as const) {
    it(`${field}: a bare syncTable with a subset keeps the omitted rows`, () => {
      const store = useInboxStore.getState();
      const rows = [1, 2, 3, 4].map((n) => ({
        _id: `${field}-0000000000000000000000000${n}`,
        title: `row ${n}`,
        updated_at: n,
      }));
      store.syncTable(field, rows as any, { isDelta: true });
      expect(Object.keys((useInboxStore.getState() as any)[field])).toHaveLength(4);

      // No isDelta opt — relies on the registry default to stay additive. If it
      // ever snapshot-pruned again, rows 2-4 would vanish here.
      store.syncTable(field, [rows[0]] as any, {});
      expect(Object.keys((useInboxStore.getState() as any)[field])).toHaveLength(4);
      expect((useInboxStore.getState() as any)[field][rows[3]._id]).toBeDefined();
    });
  }
});

describe("syncOverlay — churny overlay merged onto base rows", () => {
  // The generic "liveness lives in an overlay, not the row" primitive: it
  // annotates existing rows, never creates one, and leaves identity untouched
  // when nothing changed (so a heartbeat tick doesn't re-render every card).
  beforeEach(() => {
    useInboxStore.setState({
      sessions: {}, conversations: {}, pending: {},
      currentSessionId: null, clientStateInitialized: false, clientState: {},
    } as any);
  });

  it("merges fields onto an existing row, skips unknown ids, and is a no-op when unchanged", () => {
    const store = useInboxStore.getState();
    const a = { ...baseSession, _id: "a0000000000000000000000000000099", session_id: "s-a", agent_status: "idle" as const };
    store.syncTable("sessions", [a]);

    // Overlay flips liveness on the known row; the unknown id is ignored.
    store.syncOverlay("sessions", {
      [a._id]: { agent_status: "working" },
      ghost000000000000000000000000000: { agent_status: "working" },
    });
    const after = useInboxStore.getState().sessions[a._id];
    expect(after.agent_status).toBe("working");
    expect(useInboxStore.getState().sessions["ghost000000000000000000000000000"]).toBeUndefined();

    // Re-applying the same value must preserve the row reference (no re-render).
    store.syncOverlay("sessions", { [a._id]: { agent_status: "working" } });
    expect(useInboxStore.getState().sessions[a._id]).toBe(after);
  });
});

describe("preserveFields — base sync must not clobber the liveness overlay", () => {
  // The base listInboxSessions opts out of liveness (include_liveness:false → null),
  // so the sessions config preserves the overlay-owned fields across base syncs: a
  // null in the base fills from prev, but a REAL value (the reconcile crawl runs
  // liveness-on) still applies.
  beforeEach(() => {
    useInboxStore.setState({
      sessions: {}, conversations: {}, pending: {},
      currentSessionId: null, clientStateInitialized: false, clientState: {},
    } as any);
  });

  it("a null-liveness base sync keeps the overlay's value; a real value still applies", () => {
    const store = useInboxStore.getState();
    const id = "a0000000000000000000000000000050";
    // Base seeds the row with NULL liveness (the include_liveness:false shape).
    store.syncTable("sessions", [{ ...baseSession, _id: id, session_id: "s", agent_status: null, is_idle: null }]);
    // Overlay sets the live values.
    store.syncOverlay("sessions", { [id]: { agent_status: "working", is_idle: false } });
    expect(useInboxStore.getState().sessions[id].agent_status).toBe("working");

    // A later base sync (still null liveness, stable field changed) must NOT clobber.
    store.syncTable("sessions", [{ ...baseSession, _id: id, session_id: "s", title: "changed", agent_status: null, is_idle: null }]);
    const after = useInboxStore.getState().sessions[id];
    expect(after.agent_status).toBe("working"); // overlay preserved
    expect(after.is_idle).toBe(false);           // overlay preserved
    expect(after.title).toBe("changed");          // stable applied

    // A base sync carrying a REAL liveness value (crawl path) still applies.
    store.syncTable("sessions", [{ ...baseSession, _id: id, session_id: "s", title: "changed", agent_status: "idle", is_idle: true }]);
    expect(useInboxStore.getState().sessions[id].agent_status).toBe("idle");
  });
});

describe("dismiss is absolute — navigation/injection must not resurrect", () => {
  // Bug history: dismissed sessions kept reappearing in prod because
  // navigateToSession and injectSession silently cleared `inbox_dismissed_at`
  // on every navigation (URL deep-link, refresh with ?s= param, command
  // palette jump, sidebar bookmark, /conversation/[id] redirect, desktop
  // window-focus). Each of those dispatched a server patch that wiped
  // dismiss everywhere. These tests pin the invariant: only an explicit
  // user action (restoreSession, or sending a message) clears dismiss.

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

  it("dismiss then navigate then restore — dismiss survives the round trip", () => {
    // A Convex-shaped id: killSession flags real server sessions but deletes
    // local-only stubs, and this test pins the flag semantics.
    const realId = "c".repeat(32);
    seedCurrentSession({
      sessions: {
        [realId]: { ...alive, _id: realId },
      },
      conversations: {
        [realId]: { _id: realId } as any,
      },
      currentSessionId: realId,
      viewingDismissedId: null,
      clientState: {},
      pending: {},
    });

    useInboxStore.getState().killSession(realId);
    expect(isSessionDismissed(useInboxStore.getState().sessions[realId])).toBe(true);

    useInboxStore.getState().navigateToSession(realId);
    expect(isSessionDismissed(useInboxStore.getState().sessions[realId])).toBe(true);

    useInboxStore.getState().restoreSession(realId);
    expect(isSessionDismissed(useInboxStore.getState().sessions[realId])).toBe(false);
  });

  it("stash then navigate then restore — stash survives the round trip", () => {
    const realId = "d".repeat(32);
    seedCurrentSession({
      sessions: {
        [realId]: { ...alive, _id: realId },
      },
      conversations: {
        [realId]: { _id: realId } as any,
      },
      currentSessionId: realId,
      viewingDismissedId: null,
      clientState: {},
      pending: {},
    });

    useInboxStore.getState().stashSession(realId);
    const afterStash = useInboxStore.getState().sessions[realId];
    expect(isSessionStashed(afterStash)).toBe(true);
    expect(isSessionDismissed(afterStash)).toBe(false);

    // Navigation peeks (viewingDismissedId), never clears the flag.
    useInboxStore.getState().navigateToSession(realId);
    expect(isSessionStashed(useInboxStore.getState().sessions[realId])).toBe(true);
    expect(useInboxStore.getState().viewingDismissedId).toBe(realId);

    useInboxStore.getState().restoreSession(realId);
    expect(isSessionStashed(useInboxStore.getState().sessions[realId])).toBe(false);
  });

  it("dismissing a stashed session moves it to Dismissed (buckets exclusive)", () => {
    const realId = "e".repeat(32);
    seedCurrentSession({
      sessions: { [realId]: { ...alive, _id: realId } },
      conversations: { [realId]: { _id: realId } as any },
      currentSessionId: realId,
      viewingDismissedId: null,
      clientState: {},
      pending: {},
    });

    useInboxStore.getState().stashSession(realId);
    useInboxStore.getState().killSession(realId);
    const s = useInboxStore.getState().sessions[realId];
    expect(isSessionDismissed(s)).toBe(true);
    expect(isSessionStashed(s)).toBe(false);
    expect(s.inbox_stashed_at ?? null).toBeNull();

    const buckets = categorizeSessions({ [realId]: s }, new Set());
    expect(buckets.dismissed.map((x) => x._id)).toEqual([realId]);
    expect(buckets.stashed).toHaveLength(0);
  });

  it("stashed sessions leave the active buckets into `stashed`", () => {
    const realId = "f".repeat(32);
    const sess = { ...alive, _id: realId, inbox_stashed_at: Date.now() } as InboxSession;
    const buckets = categorizeSessions({ [realId]: sess }, new Set());
    expect(buckets.sorted).toHaveLength(0);
    expect(buckets.stashed.map((x) => x._id)).toEqual([realId]);
    expect(buckets.dismissed).toHaveLength(0);
  });
});

describe("kill/stash cascade takes the whole nested group", () => {
  // Bug history: killing an agent-team LEAD swept only its Task subagents
  // (parent_conversation_id), not its teammates (spawned_by + agent_team_name).
  // A teammate with an absent lead deliberately floats as a first-class card —
  // the categorizer can't hide it — so the leftover teammates resurfaced as
  // loose ↳ needs-input rows the user had to dismiss one by one. The cascade
  // must use the SAME nesting definition the renderer does (nestParentIdOf).
  const LEAD = "a".repeat(32);
  const TASK_SUB = "b".repeat(32);
  const TEAMMATE = "c".repeat(32);
  const SPAWN_NO_TEAM = "d".repeat(32);
  const FORK = "e".repeat(32);

  const mk = (id: string, extra: Partial<InboxSession>): InboxSession => ({
    ...baseSession,
    _id: id,
    session_id: `session-${id.slice(0, 4)}`,
    message_count: 5,
    ...extra,
  });

  beforeEach(() => {
    const rows = {
      [LEAD]: mk(LEAD, { agent_team_name: "session-team", agent_name: "team-lead" }),
      [TASK_SUB]: mk(TASK_SUB, { is_subagent: true, parent_conversation_id: LEAD }),
      [TEAMMATE]: mk(TEAMMATE, { spawned_by_conversation_id: LEAD, agent_team_name: "session-team", agent_name: "review-worker" }),
      // cast-spawn lineage: spawned_by WITHOUT a team name stays first-class
      // (nestParentIdOf's agent_team_name gate) — the cascade must not take it.
      [SPAWN_NO_TEAM]: mk(SPAWN_NO_TEAM, { spawned_by_conversation_id: LEAD }),
      [FORK]: mk(FORK, { forked_from: LEAD }),
    };
    useInboxStore.setState({
      sessions: rows,
      conversations: Object.fromEntries(Object.keys(rows).map((id) => [id, { _id: id } as any])),
      currentSessionId: null,
      viewingDismissedId: null,
      clientState: {},
      pending: {},
    });
  });

  it("killing a lead dismisses its Task subagents AND its teammates", () => {
    useInboxStore.getState().killSession(LEAD);

    const s = useInboxStore.getState();
    expect(isSessionDismissed(s.sessions[LEAD])).toBe(true);
    expect(isSessionDismissed(s.sessions[TASK_SUB])).toBe(true);
    expect(isSessionDismissed(s.sessions[TEAMMATE])).toBe(true);
    // First-class lineages are untouched: spawn-without-team and forks.
    expect(isSessionDismissed(s.sessions[SPAWN_NO_TEAM])).toBe(false);
    expect(isSessionDismissed(s.sessions[FORK])).toBe(false);

    // The point of the sweep: nothing from the group floats back into the
    // active buckets as a loose top-level card.
    const buckets = categorizeSessions(s.sessions, new Set());
    const activeIds = buckets.sorted.map((x) => x._id);
    expect(activeIds).not.toContain(LEAD);
    expect(activeIds).not.toContain(TASK_SUB);
    expect(activeIds).not.toContain(TEAMMATE);
  });

  it("stashing a lead stashes the same nested group", () => {
    useInboxStore.getState().stashSession(LEAD);

    const s = useInboxStore.getState();
    expect(isSessionStashed(s.sessions[LEAD])).toBe(true);
    expect(isSessionStashed(s.sessions[TASK_SUB])).toBe(true);
    expect(isSessionStashed(s.sessions[TEAMMATE])).toBe(true);
    expect(isSessionStashed(s.sessions[SPAWN_NO_TEAM])).toBe(false);
    expect(isSessionStashed(s.sessions[FORK])).toBe(false);
  });

  it("killing a teammate that points at itself never recurses onto the lead", () => {
    // Defensive guard in the sweep (s._id !== id): a row whose pointer equals
    // its own id must not re-select itself or confuse the removed set.
    const SELF = "f".repeat(32);
    useInboxStore.setState({
      sessions: {
        [SELF]: mk(SELF, { spawned_by_conversation_id: SELF, agent_team_name: "session-team" }),
      },
      conversations: { [SELF]: { _id: SELF } as any },
    });
    useInboxStore.getState().killSession(SELF);
    expect(isSessionDismissed(useInboxStore.getState().sessions[SELF])).toBe(true);
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

  it("carries an uploading image (preview + spinner flag) on the optimistic bubble", () => {
    const store = useInboxStore.getState();
    store.addOptimisticMessage("c1", "[image]", [
      { media_type: "image/png", preview_url: "blob:fake", uploading: true },
    ]);

    const pending = useInboxStore.getState().pendingMessages.c1;
    expect(pending).toHaveLength(1);
    expect(pending[0].images?.[0]).toMatchObject({ preview_url: "blob:fake", uploading: true });
    expect(pending[0].images?.[0].storage_id).toBeUndefined();
  });

  it("resolvePendingUploads swaps the uploading preview for the real storage record", () => {
    const store = useInboxStore.getState();
    const clientId = store.addOptimisticMessage("c1", "[image]", [
      { media_type: "image/png", preview_url: "blob:fake", uploading: true },
    ]);

    store.resolvePendingUploads("c1", clientId, [
      { media_type: "image/png", storage_id: "kg_real_id" },
    ]);

    const img = useInboxStore.getState().pendingMessages.c1[0].images?.[0];
    expect(img).toMatchObject({ storage_id: "kg_real_id" });
    expect(img.uploading).toBeUndefined();
    expect(img.preview_url).toBeUndefined();
  });

  it("resolvePendingUploads only touches the matching client_id", () => {
    const store = useInboxStore.getState();
    const a = store.addOptimisticMessage("c1", "first", [
      { media_type: "image/png", preview_url: "blob:a", uploading: true },
    ]);
    store.addOptimisticMessage("c1", "second", [
      { media_type: "image/png", preview_url: "blob:b", uploading: true },
    ]);

    store.resolvePendingUploads("c1", a, [{ media_type: "image/png", storage_id: "kg_a" }]);

    const pending = useInboxStore.getState().pendingMessages.c1;
    expect(pending[0].images?.[0]).toMatchObject({ storage_id: "kg_a" });
    expect(pending[1].images?.[0]).toMatchObject({ preview_url: "blob:b", uploading: true });
  });
});

// Regression: a finished agent stuck in "Working" because the sync layer dropped
// the status flip. listInboxSessions derives agent_status/is_idle from
// managed_sessions + an idle grace, so they change WITHOUT bumping updated_at;
// the identity-reuse optimization used to swallow that, pinning the card in the
// wrong bucket. The sessions config now lists those volatileFields. This drives
// the real syncTable("sessions", ...) path end-to-end.
describe("syncTable sessions — status flip without updated_at bump", () => {
  beforeEach(() => {
    useInboxStore.setState({ sessions: {}, conversations: {}, pending: {} } as any);
  });

  it("moves a session from Working to Needs Input when only the status changes", () => {
    const store = useInboxStore.getState();
    // Recent updated_at so the session reads as genuinely working (the staleness
    // net distrusts an active status gone quiet past the trust TTL). The flip
    // below keeps this SAME timestamp — the point is re-bucketing on a status
    // change with no message written / no updated_at bump.
    const recentTs = Date.now();
    const working = {
      ...baseSession, _id: "conv-flip", session_id: "sess-flip",
      message_count: 5, agent_status: "working" as const, is_idle: false,
      has_pending: false, updated_at: recentTs,
    };
    store.syncTable("sessions", [working]);
    let cat = categorizeSessions(useInboxStore.getState().sessions, new Set());
    expect(cat.working.map((s) => s._id)).toContain("conv-flip");

    // Agent finished its turn: server recomputes idle/stopped, but writes no new
    // message, so updated_at is UNCHANGED.
    store.syncTable("sessions", [{
      ...working, agent_status: "idle" as const, is_idle: true, updated_at: recentTs,
    }]);
    cat = categorizeSessions(useInboxStore.getState().sessions, new Set());
    expect(cat.needsInput.map((s) => s._id)).toContain("conv-flip");
    expect(cat.working.map((s) => s._id)).not.toContain("conv-flip");
  });

  it("preserves the session object ref across a heartbeat-only resend", () => {
    const store = useInboxStore.getState();
    const s = {
      ...baseSession, _id: "conv-stable", session_id: "sess-stable",
      message_count: 5, agent_status: "working" as const, is_idle: false,
      has_pending: false, updated_at: 2000,
    };
    store.syncTable("sessions", [s]);
    const first = useInboxStore.getState().sessions["conv-stable"];
    // Same updated_at, same status (a heartbeat resends the whole set) — identity
    // must hold so React.memo doesn't re-render every card.
    store.syncTable("sessions", [{ ...s }]);
    const second = useInboxStore.getState().sessions["conv-stable"];
    expect(second).toBe(first);
  });
});

describe("syncTable sessions — stale optimistic pending-send reconcile", () => {
  const optimistic = (content: string, ts = 1) => ({
    _id: `opt_${ts}`, role: "user" as const, content, timestamp: ts, _isOptimistic: true as const, _clientId: `opt_${ts}`,
  });

  beforeEach(() => {
    useInboxStore.setState({
      sessions: {}, conversations: {}, pending: {}, pendingMessages: {}, currentSessionId: null,
    } as any);
  });

  it("prunes a never-echoed optimistic send (e.g. /model) once the agent goes active", () => {
    const store = useInboxStore.getState();
    useInboxStore.setState({ pendingMessages: { "conv-model": [optimistic("/model")] } } as any);
    // The agent picked up the command → status active. /model never echoes back as
    // a user-message row, so this is the only path that can clear the phantom.
    store.syncTable("sessions", [{
      ...baseSession, _id: "conv-model", session_id: "sess-model",
      message_count: 3, agent_status: "working" as const, is_idle: false, updated_at: 10,
    }]);
    expect(useInboxStore.getState().pendingMessages["conv-model"]).toBeUndefined();
    expect(sessionsWithPendingSend(useInboxStore.getState().pendingMessages).has("conv-model")).toBe(false);
  });

  it("prunes an optimistic send once the session is stopped (dead, won't deliver)", () => {
    const store = useInboxStore.getState();
    useInboxStore.setState({ pendingMessages: { "conv-dead": [optimistic("hello")] } } as any);
    store.syncTable("sessions", [{
      ...baseSession, _id: "conv-dead", session_id: "sess-dead",
      message_count: 3, agent_status: "stopped" as const, is_idle: true, updated_at: 10,
    }]);
    expect(useInboxStore.getState().pendingMessages["conv-dead"]).toBeUndefined();
  });

  it("does NOT prune the focused conversation (setMessages owns it via echo)", () => {
    const store = useInboxStore.getState();
    seedCurrentSession({
      pendingMessages: { "conv-open": [optimistic("typing...")] },
      currentSessionId: "conv-open",
    } as any);
    store.syncTable("sessions", [{
      ...baseSession, _id: "conv-open", session_id: "sess-open",
      message_count: 3, agent_status: "working" as const, is_idle: false, updated_at: 10,
    }]);
    expect(useInboxStore.getState().pendingMessages["conv-open"]?.length).toBe(1);
  });

  it("does NOT prune an in-flight send the server has queued (has_pending=true)", () => {
    const store = useInboxStore.getState();
    useInboxStore.setState({ pendingMessages: { "conv-fresh": [optimistic("just sent")] } } as any);
    // The server accepted the send into its durable queue (has_pending true) but the
    // daemon hasn't picked it up yet (idle) — the optimistic must survive.
    store.syncTable("sessions", [{
      ...baseSession, _id: "conv-fresh", session_id: "sess-fresh",
      message_count: 3, agent_status: "idle" as const, is_idle: true, has_pending: true, updated_at: 10,
    }]);
    expect(useInboxStore.getState().pendingMessages["conv-fresh"]?.length).toBe(1);
  });

  it("prunes a leftover optimistic on an idle session with nothing queued (the /model & late-delivery case)", () => {
    // Regression (Activity-feed footage-app case): a delivered-and-answered send (or
    // a /model that never echoes) lingered on a session that's now idle with no
    // daemon (agent_status undefined) and has_pending=false. is_idle && !has_pending
    // is the server-authoritative "this is stale" signal — must prune even without an
    // active/stopped status.
    const store = useInboxStore.getState();
    useInboxStore.setState({ pendingMessages: { "conv-leftover": [optimistic("/model")] } } as any);
    store.syncTable("sessions", [{
      ...baseSession, _id: "conv-leftover", session_id: "sess-leftover",
      message_count: 50, is_idle: true, has_pending: false, updated_at: 10,
    }]);
    expect(useInboxStore.getState().pendingMessages["conv-leftover"]).toBeUndefined();
  });

  it("keeps a FAILED send so the user can retry, even after the agent goes active", () => {
    const store = useInboxStore.getState();
    useInboxStore.setState({
      pendingMessages: { "conv-failed": [{ ...optimistic("oops"), _isFailed: true as const }] },
    } as any);
    store.syncTable("sessions", [{
      ...baseSession, _id: "conv-failed", session_id: "sess-failed",
      message_count: 3, agent_status: "working" as const, is_idle: false, updated_at: 10,
    }]);
    expect(useInboxStore.getState().pendingMessages["conv-failed"]?.length).toBe(1);
  });

  it("does NOT prune on a STALE pre-send snapshot (the flicker regression)", () => {
    // The flicker: an idle session at updated_at=100 gets a client send. Before the
    // server's sendMessage mutation lands (which sets has_pending + bumps updated_at),
    // a stale snapshot — still updated_at=100, is_idle, has_pending=false — arrives.
    // The absence-prune used to fire on it, dropping the pending pill and bouncing the
    // card out of Working into Needs Input for a beat. The send baseline (=100) must
    // keep it: the server has NOT advanced past the send, so nothing is consumed.
    const store = useInboxStore.getState();
    useInboxStore.setState({
      pendingMessages: { "conv-flicker": [{ ...optimistic("just sent", 101), _sentBaselineTs: 100 }] },
    } as any);
    store.syncTable("sessions", [{
      ...baseSession, _id: "conv-flicker", session_id: "sess-flicker",
      message_count: 5, agent_status: "idle" as const, is_idle: true, has_pending: false, updated_at: 100,
    }]);
    expect(useInboxStore.getState().pendingMessages["conv-flicker"]?.length).toBe(1);
  });

  it("prunes once the server advances PAST the send (idle, nothing queued)", () => {
    // Same baseline=100, but now a snapshot at updated_at=200 proves the server has
    // processed the send and the agent is idle with nothing queued (delivered-and-
    // answered, or a never-echoing /model). Now it's genuinely stale → prune.
    const store = useInboxStore.getState();
    useInboxStore.setState({
      pendingMessages: { "conv-advanced": [{ ...optimistic("/model", 101), _sentBaselineTs: 100 }] },
    } as any);
    store.syncTable("sessions", [{
      ...baseSession, _id: "conv-advanced", session_id: "sess-advanced",
      message_count: 5, is_idle: true, has_pending: false, updated_at: 200,
    }]);
    expect(useInboxStore.getState().pendingMessages["conv-advanced"]).toBeUndefined();
  });
});

describe("pendingSendConsumed — server-advanced gate", () => {
  const idleNoPending = { agent_status: "idle" as const, is_idle: true, has_pending: false };

  it("never consumes via absence before the server advances past the send", () => {
    // updated_at == baseline → stale pre-send snapshot → not consumed.
    expect(pendingSendConsumed({ ...idleNoPending, updated_at: 100 }, 100)).toBe(false);
    // updated_at < baseline → even staler → not consumed.
    expect(pendingSendConsumed({ ...idleNoPending, updated_at: 50 }, 100)).toBe(false);
  });

  it("consumes via absence once updated_at moves past the baseline", () => {
    expect(pendingSendConsumed({ ...idleNoPending, updated_at: 101 }, 100)).toBe(true);
  });

  it("an ACTIVE status consumes immediately, regardless of the baseline gate", () => {
    // The daemon is provably acting — a positive signal, not absence.
    expect(pendingSendConsumed(
      { agent_status: "working", is_idle: false, has_pending: false, updated_at: 1 }, 100,
    )).toBe(true);
  });

  it("a fresh has_pending send is never consumed even after the server advances", () => {
    expect(pendingSendConsumed(
      { agent_status: "idle", is_idle: true, has_pending: true, updated_at: 200 }, 100,
    )).toBe(false);
  });
});

describe("reconcilePendingSendForSession — prune grace window", () => {
  // ACTIVE status → pendingSendConsumed is true immediately; only the grace
  // window stands between a just-dispatched send and the prune.
  const consumedSession = { agent_status: "working", is_idle: false, has_pending: false, updated_at: 999_999 } as any;
  const msg = (over: Record<string, unknown>) =>
    ({ _id: "m1", _clientId: "m1", role: "user", content: "hi", _isOptimistic: true, ...over }) as any;

  it("keeps a just-sent message even when the session already reads consumed", () => {
    // The dispatch retry ladder hasn't had time to fail (and mark _isFailed);
    // pruning now would destroy the only copy of the user's text.
    const pm: Record<string, any[]> = { c1: [msg({ timestamp: Date.now() })] };
    expect(reconcilePendingSendForSession(pm, "c1", consumedSession, null)).toBe(false);
    expect(pm.c1.length).toBe(1);
  });

  it("prunes a consumed send once it is older than the grace window", () => {
    const pm: Record<string, any[]> = { c1: [msg({ timestamp: Date.now() - PENDING_SEND_PRUNE_GRACE_MS - 1 })] };
    expect(reconcilePendingSendForSession(pm, "c1", consumedSession, null)).toBe(true);
    expect(pm.c1).toBeUndefined();
  });

  it("keeps failed sends forever (the user may retry them)", () => {
    const pm: Record<string, any[]> = { c1: [msg({ timestamp: Date.now() - PENDING_SEND_PRUNE_GRACE_MS - 1, _isFailed: true })] };
    expect(reconcilePendingSendForSession(pm, "c1", consumedSession, null)).toBe(false);
    expect(pm.c1.length).toBe(1);
  });
});

describe("session-view recording (MRU order + unread divider anchor)", () => {
  const realNow = Date.now;
  let clock = 1000;

  beforeEach(() => {
    clock = 1000;
    (Date as unknown as { now: () => number }).now = () => clock;
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      clientState: {},
      currentSessionId: null,
      _lastViewedAt: {},
      _seenUpToAt: {},
    });
  });

  afterEach(() => {
    (Date as unknown as { now: () => number }).now = realNow;
  });

  it("records an 'entered at' timestamp every time you switch into a session", () => {
    clock = 1000;
    useInboxStore.getState().setCurrentSession("A");
    expect(useInboxStore.getState()._lastViewedAt.A).toBe(1000);
    // First-ever visit: nothing seen before, so no divider anchor → no "New" line.
    expect(useInboxStore.getState()._seenUpToAt.A).toBeUndefined();
  });

  it("MRU is exact: the session you just opened is strictly the most recent (no tie with the one you left)", () => {
    clock = 1000; useInboxStore.getState().setCurrentSession("A");
    clock = 2000; useInboxStore.getState().setCurrentSession("B");
    clock = 3000; useInboxStore.getState().setCurrentSession("C");

    const { _lastViewedAt } = useInboxStore.getState();
    const order = ["A", "B", "C"].sort((a, b) => (_lastViewedAt[b] ?? 0) - (_lastViewedAt[a] ?? 0));
    expect(order).toEqual(["C", "B", "A"]);
    // The just-left session (B) must NOT share the current session's timestamp.
    expect(_lastViewedAt.B).toBeLessThan(_lastViewedAt.C);
  });

  it("freezes the divider anchor at where you left off, and holds it across the visit", () => {
    clock = 1000; useInboxStore.getState().setCurrentSession("A"); // open A
    clock = 2000; useInboxStore.getState().setCurrentSession("B"); // leave A at 2000
    clock = 5000; useInboxStore.getState().setCurrentSession("A"); // come back to A

    // Anchor for A is the moment you left it last time — messages after t=2000 are "New".
    expect(useInboxStore.getState()._seenUpToAt.A).toBe(2000);
    // MRU still advanced.
    expect(useInboxStore.getState()._lastViewedAt.A).toBe(5000);
  });

  it("re-opening the session you're already on advances MRU but never moves the divider", () => {
    clock = 1000; useInboxStore.getState().setCurrentSession("A");
    clock = 2000; useInboxStore.getState().setCurrentSession("B");
    clock = 5000; useInboxStore.getState().setCurrentSession("A"); // anchor.A = 2000
    clock = 6000; useInboxStore.getState().setCurrentSession("A"); // same session again

    expect(useInboxStore.getState()._seenUpToAt.A).toBe(2000); // divider unchanged
    expect(useInboxStore.getState()._lastViewedAt.A).toBe(6000); // MRU advanced
  });

  it("records views through navigateToSession too (not just setCurrentSession)", () => {
    useInboxStore.setState({
      sessions: {
        A: { ...baseSession, _id: "A" },
        B: { ...baseSession, _id: "B" },
      },
    });
    clock = 1000; useInboxStore.getState().navigateToSession("A");
    clock = 2000; useInboxStore.getState().navigateToSession("B");
    const s = useInboxStore.getState();
    expect(s._lastViewedAt.A).toBe(1000);
    expect(s._lastViewedAt.B).toBe(2000);
    expect(s._seenUpToAt.A).toBe(2000); // leaving A marked it seen
  });

  it("persists both view-tracking maps across a reload", () => {
    expect(isPersistedStoreKey("_lastViewedAt")).toBe(true);
    expect(isPersistedStoreKey("_seenUpToAt")).toBe(true);
  });
});

describe("computeNewDividerIndex — unread band is (seenUpToAt, enteredAt]", () => {
  // Helper: a timeline is just ascending timestamps.
  const tl = (...ts: number[]) => ts.map((t) => ({ timestamp: t }));

  it("anchors the divider above the first message that arrived while away", () => {
    // Left at 2000, returned at 5000; messages at 3000/4000 landed in between.
    expect(computeNewDividerIndex(tl(1000, 3000, 4000), 2000, 5000)).toBe(1);
  });

  it("does NOT split a message you send while focused (the reported bug)", () => {
    // Caught up on entry (all msgs <= anchor), then you send at 6000 while here.
    // entered at 5000, so 6000 is live — no divider.
    expect(computeNewDividerIndex(tl(1000, 2000, 6000), 2000, 5000)).toBe(-1);
  });

  it("does NOT split live agent replies that arrive after you entered", () => {
    // Nothing waiting on entry; agent streams 6000/7000 while you watch.
    expect(computeNewDividerIndex(tl(2000, 6000, 7000), 2000, 5000)).toBe(-1);
  });

  it("keeps the divider above the away-message even as live ones stack below it", () => {
    // 3000 arrived while away; 6000 is a live send after entering at 5000.
    // Divider stays above 3000, not the live message.
    expect(computeNewDividerIndex(tl(1000, 3000, 6000), 2000, 5000)).toBe(1);
  });

  it("re-focusing after messages arrived while blurred surfaces them", () => {
    // Entry re-stamped to 9000 on window-focus; a 7000 msg arrived while blurred.
    expect(computeNewDividerIndex(tl(1000, 7000), 2000, 9000)).toBe(1);
  });

  it("shows no divider on a first-ever visit (no seen anchor yet)", () => {
    expect(computeNewDividerIndex(tl(1000, 2000), 0, 5000)).toBe(-1);
  });

  it("shows no divider when nothing is newer than the seen anchor", () => {
    expect(computeNewDividerIndex(tl(1000, 1500), 2000, 5000)).toBe(-1);
  });

  it("falls back to the open interval when entry time is unknown", () => {
    // Defensive: enteredAt 0 means 'no upper bound' → first unseen wins.
    expect(computeNewDividerIndex(tl(1000, 3000), 2000, 0)).toBe(1);
  });
});

describe("orchestration grouping", () => {
  const WT = "/Users/x/src/codecast/.codecast/worktrees/arch-hardening-top-six";
  const PLAN = { _id: "pl1", short_id: "pl-85", title: "Architecture hardening", status: "done" };
  const mk = (id: string, over: Partial<InboxSession> = {}): InboxSession => ({
    ...baseSession,
    _id: id,
    session_id: `s-${id}`,
    message_count: 5,
    is_idle: false,
    is_connected: true,
    ...over,
  });

  it("worktreeKeyOf parses worktree paths and prefers explicit worktree_name", () => {
    expect(worktreeKeyOf(mk("a", { project_path: WT }))).toBe("arch-hardening-top-six");
    expect(worktreeKeyOf(mk("b", { git_root: "/Users/x/proj/.conductor/fix-auth" }))).toBe("fix-auth");
    expect(worktreeKeyOf(mk("c", { worktree_name: "explicit", project_path: WT }))).toBe("explicit");
    expect(worktreeKeyOf(mk("d", { project_path: "/Users/x/src/codecast" }))).toBeNull();
  });

  it("orchestrationGroupLabelOf prefers the plan, then the worktree, else null", () => {
    expect(orchestrationGroupLabelOf(mk("a", { active_plan: PLAN }))).toBe("pl-85 · Architecture hardening");
    expect(orchestrationGroupLabelOf(mk("b", { project_path: WT }))).toBe("⑂ arch-hardening-top-six");
    // plan wins even when a worktree is also present
    expect(orchestrationGroupLabelOf(mk("c", { active_plan: PLAN, project_path: WT }))).toBe("pl-85 · Architecture hardening");
    expect(orchestrationGroupLabelOf(mk("d", { project_path: "/Users/x/src/codecast" }))).toBeNull();
  });

  it("sessions sharing a plan stay in their status buckets — the status view never clusters by plan", () => {
    // Regression (ct-37908): the status view used to fold ≥2 plan-bound sessions
    // into a collapsed group, hiding a working session from Working and
    // undercounting the sidebar's needs-input badge. Grouping by plan is now
    // exclusively the "By plan" view's job (groupSessionsByPlan).
    const sessions = {
      a: mk("a", { active_plan: PLAN, project_path: "/Users/x/src/codecast", updated_at: 3 }),
      b: mk("b", { active_plan: PLAN, project_path: "/Users/x/src/codecast", updated_at: 2 }),
      wt1: mk("wt1", { project_path: WT, updated_at: 3 }),
      wt2: mk("wt2", { project_path: WT, updated_at: 2 }),
      main: mk("main", { project_path: "/Users/x/src/codecast", updated_at: 4 }),
    };
    const r = categorizeSessions(sessions, new Set());
    const flat = new Set([...r.pinned, ...r.newSessions, ...r.needsInput, ...r.working].map((s) => s._id));
    for (const id of ["a", "b", "wt1", "wt2", "main"]) expect(flat.has(id)).toBe(true);
  });

  it("a plan-bound session nested under a conversation parent still nests, never a loose card", () => {
    const sessions = {
      parent: mk("parent", { project_path: "/Users/x/src/codecast" }),
      a: mk("a", { active_plan: PLAN, parent_conversation_id: "parent" }),
      b: mk("b", { active_plan: PLAN, parent_conversation_id: "parent" }),
    };
    const r = categorizeSessions(sessions, new Set());
    expect(r.subsByParent.get("parent")?.length).toBe(2);
    const flat = new Set([...r.needsInput, ...r.working].map((s) => s._id));
    expect(flat.has("a")).toBe(false);
    expect(flat.has("b")).toBe(false);
  });

  it("pinned plan-bound sessions stay in Pinned", () => {
    const sessions = {
      a: mk("a", { active_plan: PLAN, is_pinned: true, inbox_pinned_at: 5 }),
      b: mk("b", { active_plan: PLAN, is_pinned: true, inbox_pinned_at: 6 }),
    };
    const r = categorizeSessions(sessions, new Set());
    expect(r.pinned.map((s) => s._id).sort()).toEqual(["a", "b"]);
  });
});

describe("isConvexId — the guard for message-id-keyed queries", () => {
  // The client timeline carries synthetic message ids the server never stored:
  //   optimistic_*    — the sender's own local echo (addOptimisticMessage)
  //   serverpending_* — a queued row (e.g. CLI `cast send`) surfaced to every viewer
  // Comment/bookmark/comment-panel guards feed message ids straight into queries
  // validated as v.id("messages"). isConvexId is the whitelist that must reject
  // BOTH prefixes — a serverpending_ id slipping through is what threw
  // ArgumentValidationError on comments.getCommentCount.
  it("accepts a real 32-char Convex document id", () => {
    expect(isConvexId("jx7bymh2ctsex27p4ez7ekrvjh883gr4")).toBe(true);
  });

  it("rejects the optimistic_ echo prefix", () => {
    expect(isConvexId("optimistic_1780684505504_abc123")).toBe(false);
  });

  it("rejects the serverpending_ queued-row prefix", () => {
    expect(isConvexId("serverpending_jx7bymh2ctsex27p4ez7ekrvjh883gr4")).toBe(false);
  });

  it("rejects commit-/pr- timeline ids and the empty string", () => {
    expect(isConvexId("commit-abc123")).toBe(false);
    expect(isConvexId("pr-jx7bymh2ctsex27p4ez7ekrvjh883gr4")).toBe(false);
    expect(isConvexId("")).toBe(false);
  });
});

describe("unionHydrate — cache as the floor (jx799py repro)", () => {
  // Bug: /tasks (and now delta sessions) collapse to the live window on load,
  // then stream back in. IDB holds the full set the whole time; the deferred
  // hydration's empty-gate skipped IDB because a windowed live payload had
  // already filled the store. Union-merge makes the cache the floor.
  it("backfills cached rows the live window omits; live wins per-id", () => {
    // IDB has the full set (N=5). The live payload is a recent-window subset (2).
    const idb = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`t${i}`, { _id: `t${i}`, title: `idb-${i}` }]),
    );
    const liveWindow = {
      t0: { _id: "t0", title: "live-0" },
      t1: { _id: "t1", title: "live-1" },
    };

    const merged = unionHydrate(idb, liveWindow) as Record<string, { _id: string; title: string }>;

    // Full set survives — NOT collapsed to the 2-row live window.
    expect(Object.keys(merged).length).toBe(5);
    // Live rows win per-id; cache backfills the rest.
    expect(merged.t0.title).toBe("live-0");
    expect(merged.t1.title).toBe("live-1");
    expect(merged.t4.title).toBe("idb-4");
  });

  it("returns the cache untouched when no live data has landed yet", () => {
    const idb = { a: { _id: "a" }, b: { _id: "b" } };
    expect(unionHydrate(idb, undefined)).toEqual(idb);
  });

  it("returns the live set when there is no cache", () => {
    const live = { a: { _id: "a" } };
    expect(unionHydrate(undefined, live)).toEqual(live);
  });
});

// The shared path every new-session entry point uses. The bug this guards against:
// a first message sent during session creation that never rendered as pending because
// the conversation was navigated-to by its real id while the optimistic copy lived
// under the stub (or was never inserted at all). These assert the message is inserted
// synchronously and survives the stub→real rekey — so it can never be "gone".
describe("inboxStore.beginOptimisticSession", () => {
  // 32 lowercase-alphanumeric chars → isConvexId() true (a stand-in for a real id).
  const REAL_ID = "abcdefghij0123456789abcdefghij01";

  beforeEach(() => {
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      pendingMessages: {},
      pendingSessionCreates: {},
      drafts: {},
      clientState: {},
      currentSessionId: null,
      pending: {},
      currentConversation: {},
      isolatedWorktreeMode: false,
    });
  });

  it("seeds a local conversation under a non-Convex stub id synchronously", async () => {
    const { stubId, ready } = useInboxStore.getState().beginOptimisticSession({
      agentType: "claude_code",
      projectPath: "/repo",
      create: async () => REAL_ID,
    });
    expect(isConvexId(stubId)).toBe(false);
    const state = useInboxStore.getState();
    expect(state.conversations[stubId]?.title).toBe("New session");
    expect(state.conversations[stubId]?.project_path).toBe("/repo");
    // The inbox session row must be seeded too — the conversation page resolves a
    // stub from sessions[id] (local-first), so without it navigate-to-stub 404s.
    expect(state.sessions[stubId]?.session_id).toBe(stubId);
    // Tracked so a later send can await the real id instead of polling.
    expect(state.pendingSessionCreates[stubId]).toBeDefined();
    await ready; // flush the rekey microtask so it doesn't bleed into the next test
  });

  it("keeps the optimistic first message visible across the stub→real rekey", async () => {
    const store = useInboxStore.getState();
    const { stubId, ready } = store.beginOptimisticSession({
      agentType: "claude_code",
      projectPath: "/repo",
      create: async () => REAL_ID,
    });
    // The first message renders as pending BEFORE the server returns an id —
    // keyed under the stub (no session doc exists yet, exactly like the modal path).
    const clientId = store.addOptimisticMessage(stubId, "hello world");
    expect(useInboxStore.getState().pendingMessages[stubId]?.[0]?.content).toBe("hello world");

    await ready;

    const state = useInboxStore.getState();
    // Conversation, session row, AND pending message migrated to the real id — never dropped.
    expect(state.conversations[stubId]).toBeUndefined();
    expect(state.sessions[stubId]).toBeUndefined();
    expect(state.pendingMessages[stubId]).toBeUndefined();
    expect(state.conversations[REAL_ID]).toBeDefined();
    expect(state.sessions[REAL_ID]?._id).toBe(REAL_ID);
    const migrated = state.pendingMessages[REAL_ID];
    expect(migrated?.length).toBe(1);
    expect(migrated?.[0]?.content).toBe("hello world");
    expect(migrated?.[0]?._clientId).toBe(clientId);
  });

  it("does not leave the stub in New when live sync resolves the real id first", async () => {
    const store = useInboxStore.getState();
    let resolveCreate!: (id: string) => void;
    const { stubId, ready } = store.beginOptimisticSession({
      agentType: "claude_code",
      projectPath: "/repo",
      create: () => new Promise<string>((resolve) => { resolveCreate = resolve; }),
    });
    store.addOptimisticMessage(stubId, "hello world");

    store.syncTable("sessions", [{
      ...baseSession,
      _id: REAL_ID,
      session_id: stubId,
      title: "New session",
      project_path: "/repo",
      message_count: 0,
      is_idle: true,
      has_pending: false,
    }]);

    const state = useInboxStore.getState();
    expect(state.sessions[stubId]).toBeUndefined();
    expect(state.pendingMessages[stubId]).toBeUndefined();
    expect(state.pendingMessages[REAL_ID]?.[0]?.content).toBe("hello world");

    const cat = categorizeSessions(
      state.sessions,
      new Set(),
      sessionsWithPendingSend(state.pendingMessages),
    );
    expect(cat.working.map((s) => s._id)).toEqual([REAL_ID]);
    expect(cat.newSessions.map((s) => s._id)).not.toContain(stubId);
    expect(cat.newSessions.map((s) => s._id)).not.toContain(REAL_ID);

    resolveCreate(REAL_ID);
    await ready;
  });

  it("resolves `ready` to the real id so a queued send can target it", async () => {
    const { ready } = useInboxStore.getState().beginOptimisticSession({
      agentType: "claude_code",
      create: async () => REAL_ID,
    });
    expect(await ready).toBe(REAL_ID);
  });

  // deferCreate — the new-session popup (Ctrl+N / the desktop palette) seeds a
  // local stub on open so the null-state can render, but DEFERS the server create
  // until the first send. Opening then Escaping out must strand nothing: no empty
  // "New session" row, no pre-warmed agent.
  describe("deferCreate", () => {
    it("seeds the stub locally but fires no create until materialize()", () => {
      let creates = 0;
      const { stubId, materialize } = useInboxStore.getState().beginOptimisticSession({
        agentType: "claude_code",
        projectPath: "/repo",
        deferCreate: true,
        create: async () => { creates++; return REAL_ID; },
      });
      const state = useInboxStore.getState();
      // Local rows exist so the popup renders + can hold a draft...
      expect(state.conversations[stubId]?.title).toBe("New session");
      expect(state.sessions[stubId]?.session_id).toBe(stubId);
      // ...but nothing server-side fired, and there's no tracked create — which is
      // exactly what lets pruneGhostSessions hard-drop an abandoned stub.
      expect(creates).toBe(0);
      expect(state.pendingSessionCreates[stubId]).toBeUndefined();
      expect(typeof materialize).toBe("function");
    });

    it("materialize() fires the create exactly once and resolves the real id", async () => {
      let creates = 0;
      const { stubId, materialize } = useInboxStore.getState().beginOptimisticSession({
        agentType: "claude_code",
        projectPath: "/repo",
        deferCreate: true,
        create: async () => { creates++; return REAL_ID; },
      });
      const p1 = materialize();
      // Tracked the instant materialize fires, so a concurrent send (awaitConvexId)
      // resolves against the in-flight create instead of polling.
      expect(useInboxStore.getState().pendingSessionCreates[stubId]).toBeDefined();
      const p2 = materialize(); // idempotent — typed-then-submit must not double-create
      expect(await p1).toBe(REAL_ID);
      expect(await p2).toBe(REAL_ID);
      expect(creates).toBe(1);
    });

    // Swap createSession for a recorder so the (server-dispatching) asyncAction
    // never fires; createSessionFromStub forwards through get().createSession, so a
    // plain setState replacement is what it reads — deterministic, no spy/instance
    // timing to depend on. Restores the original after fn() runs.
    const captureCreate = (fn: () => void | Promise<void>) => {
      const orig = useInboxStore.getState().createSession;
      const calls: any[] = [];
      useInboxStore.setState({ createSession: ((opts: any) => { calls.push(opts); return Promise.resolve(REAL_ID); }) as any });
      const done = (async () => fn())().finally(() => useInboxStore.setState({ createSession: orig as any }));
      return { calls, done };
    };

    // The compose popup (and Ctrl+N) seed a stub at one project, but the user can
    // switch projects in the null-state picker BEFORE the first send. That switch
    // writes the stub row (updateSessionProject); the deferred create must read it
    // back, not the project captured when the popup opened — otherwise the new
    // session is created in the wrong directory ("switching projects doesn't stick").
    it("materialize creates with the SWITCHED project — a switch before the first send sticks", async () => {
      const store = useInboxStore.getState();
      const { stubId, materialize } = store.beginOptimisticSession({
        agentType: "claude_code",
        projectPath: "/repo",
        deferCreate: true,
        // EXACT production wiring (ComposeView / DashboardLayout): the deferred
        // create sources the project from the live stub via createSessionFromStub,
        // never the begin-time `path`.
        create: (sid) => useInboxStore.getState().createSessionFromStub(sid, { agentType: "claude_code", projectPath: "/repo", gitRoot: "/repo" }),
      });
      store.updateSessionProject(stubId, "/other-repo");
      const { calls, done } = captureCreate(() => materialize());
      await done;
      expect(calls.length).toBe(1);
      expect(calls[0]).toMatchObject({ project_path: "/other-repo", git_root: "/other-repo", session_id: stubId });
    });

    it("createSessionFromStub sources project + agent from the live stub row, not the fallback", async () => {
      useInboxStore.setState({
        sessions: { stub1: { _id: "stub1", session_id: "stub1", project_path: "/switched", git_root: "/switched", agent_type: "codex", updated_at: 1, message_count: 0, is_idle: true, has_pending: false } as InboxSession },
        conversations: {},
      });
      const { calls, done } = captureCreate(() => { useInboxStore.getState().createSessionFromStub("stub1", { agentType: "claude_code", projectPath: "/fallback", gitRoot: "/fallback" }); });
      await done;
      expect(calls.length).toBe(1);
      expect(calls[0]).toMatchObject({ project_path: "/switched", git_root: "/switched", agent_type: "codex", session_id: "stub1" });
    });

    it("createSessionFromStub falls back when the stub row is missing", async () => {
      useInboxStore.setState({ sessions: {}, conversations: {} });
      const { calls, done } = captureCreate(() => { useInboxStore.getState().createSessionFromStub("ghost", { agentType: "gemini", projectPath: "/fallback" }); });
      await done;
      expect(calls[0]).toMatchObject({ project_path: "/fallback", git_root: "/fallback", agent_type: "gemini", session_id: "ghost" });
    });

    // The "isolated worktree" toggle is a global mode (isolatedWorktreeMode); the
    // create must fold it in so the daemon makes the git worktree up front. Before
    // this, the toggle silently did nothing on a new session until a later project
    // switch (reconfigureSession was the only path passing `isolated`).
    it("createSessionFromStub forwards isolated when the worktree toggle is on", async () => {
      useInboxStore.setState({
        sessions: { stub1: { _id: "stub1", session_id: "stub1", project_path: "/repo", git_root: "/repo", agent_type: "claude_code", updated_at: 1, message_count: 0, is_idle: true, has_pending: false } as InboxSession },
        isolatedWorktreeMode: true,
      });
      const { calls, done } = captureCreate(() => { useInboxStore.getState().createSessionFromStub("stub1"); });
      await done;
      expect(calls[0]).toMatchObject({ isolated: true, project_path: "/repo", session_id: "stub1" });
    });

    it("createSessionFromStub omits isolated when the worktree toggle is off", async () => {
      useInboxStore.setState({
        sessions: { stub1: { _id: "stub1", session_id: "stub1", project_path: "/repo", git_root: "/repo", agent_type: "claude_code", updated_at: 1, message_count: 0, is_idle: true, has_pending: false } as InboxSession },
        isolatedWorktreeMode: false,
      });
      const { calls, done } = captureCreate(() => { useInboxStore.getState().createSessionFromStub("stub1"); });
      await done;
      expect(calls[0].isolated).toBeUndefined();
    });

    // The in-app new session (Ctrl+N) self-heals its stub through
    // ensureSessionCreated, NOT the compose popup's materialize. Routing it through
    // createSessionFromStub means isolated reaches that path too.
    it("ensureSessionCreated forwards isolated through the self-heal create path", async () => {
      useInboxStore.setState({
        sessions: { stub2: { _id: "stub2", session_id: "stub2", project_path: "/repo", git_root: "/repo", agent_type: "claude_code", updated_at: 1, message_count: 0, is_idle: true, has_pending: false } as InboxSession },
        isolatedWorktreeMode: true,
      });
      const { calls, done } = captureCreate(() => { useInboxStore.getState().ensureSessionCreated("stub2"); });
      await done;
      expect(calls.length).toBe(1);
      expect(calls[0]).toMatchObject({ isolated: true, project_path: "/repo", session_id: "stub2" });
    });

    it("an abandoned (never-materialized) stub is prunable — Escape strands nothing", () => {
      const { stubId } = useInboxStore.getState().beginOptimisticSession({
        agentType: "claude_code",
        projectPath: "/repo",
        deferCreate: true,
        create: async () => REAL_ID,
      });
      // Closing the popup without ever sending.
      useInboxStore.getState().pruneGhostSessions([stubId]);
      const state = useInboxStore.getState();
      expect(state.sessions[stubId]).toBeUndefined();
      expect(state.conversations[stubId]).toBeUndefined();
      // Exclude planted so a cached/IDB copy can't resurrect it as a ghost.
      expect(state.pending[`sessions:${stubId}`]?.type).toBe("exclude");
    });
  });

  // reuse: true — quick-create entry points (Ctrl+N, the compose palette)
  // converge on the existing blank session for the project+agent instead of
  // stranding an empty "New Session" conversation per summon.
  describe("reuse", () => {
    const blank = (extra: Partial<InboxSession> = {}): InboxSession => ({
      ...baseSession,
      _id: REAL_ID,
      session_id: REAL_ID,
      message_count: 0,
      project_path: "/repo",
      agent_type: "claude_code",
      started_at: Date.now() - 60_000,
      ...extra,
    });

    it("reuses a matching blank session — no create fired", async () => {
      useInboxStore.setState({ sessions: { [REAL_ID]: blank() } });
      let created = false;
      const { stubId, ready } = useInboxStore.getState().beginOptimisticSession({
        agentType: "claude_code",
        projectPath: "/repo",
        reuse: true,
        create: async () => { created = true; return "x".repeat(32); },
      });
      expect(stubId).toBe(REAL_ID);
      expect(await ready).toBe(REAL_ID);
      expect(created).toBe(false);
    });

    it("reuses an in-flight stub (double Ctrl+N converges) and returns its create promise", async () => {
      const first = useInboxStore.getState().beginOptimisticSession({
        agentType: "claude_code",
        projectPath: "/repo",
        create: async () => REAL_ID,
      });
      const second = useInboxStore.getState().beginOptimisticSession({
        agentType: "claude_code",
        projectPath: "/repo",
        reuse: true,
        create: async () => { throw new Error("must not create"); },
      });
      expect(second.stubId).toBe(first.stubId);
      expect(await second.ready).toBe(REAL_ID);
    });

    it.each([
      ["different project", { project_path: "/other" }],
      ["different agent", { agent_type: "codex" }],
      ["has messages", { message_count: 4 }],
      ["dismissed", { inbox_dismissed_at: Date.now() }],
      ["pinned", { is_pinned: true }],
      ["worktree", { worktree_name: "wt" }],
      ["subagent", { is_subagent: true }],
      ["a teammate's", { user_id: "u".repeat(32) }],
      ["stale (outside the reuse window)", { started_at: Date.now() - 13 * 60 * 60 * 1000 }],
    ])("creates fresh when the only blank candidate is %s", async (_label, extra) => {
      useInboxStore.setState({ sessions: { [REAL_ID]: blank(extra as Partial<InboxSession>) } });
      const { stubId, ready } = useInboxStore.getState().beginOptimisticSession({
        agentType: "claude_code",
        projectPath: "/repo",
        reuse: true,
        create: async () => "x".repeat(32),
      });
      expect(stubId).not.toBe(REAL_ID);
      await ready;
    });

    it("without reuse, a matching blank session is ignored (modal/isolated path unchanged)", async () => {
      useInboxStore.setState({ sessions: { [REAL_ID]: blank() } });
      const { stubId, ready } = useInboxStore.getState().beginOptimisticSession({
        agentType: "claude_code",
        projectPath: "/repo",
        create: async () => "x".repeat(32),
      });
      expect(stubId).not.toBe(REAL_ID);
      await ready;
    });

    // Regression — the desktop "compose into an existing session" bug. The matcher
    // is only as correct as the `sessions` snapshot it reads. The palette window
    // used to hold a stale IDB snapshot (no live subscription), so a row that had
    // since gained messages still looked blank and the first message landed in
    // that existing conversation. The window now mounts the live list
    // (useLiveInboxSessions); piping it through the SAME syncTable flips the reuse
    // decision the instant the row is revealed non-blank.
    it("a live-list correction drops a now-nonblank session from reuse", () => {
      const reuseArgs = { agentType: "claude_code", projectPath: "/repo" };
      const store = useInboxStore.getState();
      // Stale snapshot: the row looks like a reusable blank.
      store.syncTable("sessions", [blank()]);
      expect(findReusableBlankSession(useInboxStore.getState() as any, reuseArgs)).toBe(REAL_ID);
      // Live list lands showing it actually has messages — reuse must drop it
      // rather than route a first message into that existing conversation.
      store.syncTable("sessions", [blank({ message_count: 4 })]);
      expect(findReusableBlankSession(useInboxStore.getState() as any, reuseArgs)).toBeNull();
    });
  });

  // Regression: the new-session flash/reload. The stub→real rekey deletes the
  // stub rows in the same transaction it flips the current-session pointer,
  // but useDeferredValue consumers (InboxConversation) render one more urgent
  // pass with the stale stub id. useConversationMessages resolves through
  // resolveLiveSessionId, so that pass must land on the live row — a miss here
  // renders the full-pane loader and remounts the whole conversation tree.
  describe("resolveLiveSessionId across the rekey", () => {
    it("maps the dead stub id to the live real id after the create resolves", async () => {
      const { stubId, ready } = useInboxStore.getState().beginOptimisticSession({
        agentType: "claude_code",
        projectPath: "/repo",
        create: async () => REAL_ID,
      });
      // Before the rekey the stub row is live — resolves to itself.
      expect(useInboxStore.getState().resolveLiveSessionId(stubId)).toBe(stubId);

      await ready;

      const state = useInboxStore.getState();
      expect(state.sessions[stubId]).toBeUndefined();
      // The stale id a deferred render still holds must follow the rekey to
      // the live row instead of resolving to nothing.
      expect(state.resolveLiveSessionId(stubId)).toBe(REAL_ID);
      expect(state.conversations[state.resolveLiveSessionId(stubId)]).toBeDefined();
      // Real ids and unknown ids keep their identity (deep links, not-found).
      expect(state.resolveLiveSessionId(REAL_ID)).toBe(REAL_ID);
      expect(state.resolveLiveSessionId("nonexistent-stub")).toBe("nonexistent-stub");
    });
  });
});

// Verified ghost removal — the never-prune sessions cache asks the server which
// blank rows still exist (existingConversationIds) and hard-drops the
// confirmed-gone ones. These pin the store half: rows removed everywhere +
// exclude pendings planted (the durable delete contract), with the local-state
// guards that keep an in-use row safe.
describe("pruneGhostSessions — verified removal of GC'd blanks", () => {
  const GONE = "g".repeat(32);
  const CURRENT = "c".repeat(32);
  const SENDING = "d".repeat(32);
  const STUB = "k2hf8s0dq1xand83hr0e6";
  const CREATING = "p9hf8s0dq1xand83hr0e7";

  beforeEach(() => {
    const mk = (id: string): InboxSession => ({ ...baseSession, _id: id, session_id: id });
    seedCurrentSession({
      sessions: { [GONE]: mk(GONE), [CURRENT]: mk(CURRENT), [SENDING]: mk(SENDING), [STUB]: mk(STUB), [CREATING]: mk(CREATING) },
      conversations: { [GONE]: { _id: GONE } as any, [CURRENT]: { _id: CURRENT } as any },
      messages: { [GONE]: [] },
      pendingMessages: { [SENDING]: [{ _id: "m1", content: "hi" }] as any },
      pendingSessionCreates: { [CREATING]: Promise.resolve("x") },
      pagination: { [GONE]: {} as any },
      currentSessionId: CURRENT,
      pending: {},
    } as any);
  });

  it("drops the row everywhere and plants the exclude pendings", () => {
    useInboxStore.getState().pruneGhostSessions([GONE]);
    const s = useInboxStore.getState();
    expect(s.sessions[GONE]).toBeUndefined();
    expect(s.conversations[GONE]).toBeUndefined();
    expect(s.messages[GONE]).toBeUndefined();
    expect(s.pagination[GONE]).toBeUndefined();
    expect(s.pending[`sessions:${GONE}`]?.type).toBe("exclude");
    expect(s.pending[`conversations:${GONE}`]?.type).toBe("exclude");
  });

  it("drops an orphaned stub (never landed server-side) — local-only cruft", () => {
    useInboxStore.getState().pruneGhostSessions([STUB]);
    const s = useInboxStore.getState();
    expect(s.sessions[STUB]).toBeUndefined();
    // The exclude is what authorizes the durable IDB row delete.
    expect(s.pending[`sessions:${STUB}`]?.type).toBe("exclude");
  });

  it("never touches the current session, queued sends, or an in-flight create", () => {
    useInboxStore.getState().pruneGhostSessions([CURRENT, SENDING, CREATING]);
    const s = useInboxStore.getState();
    expect(s.sessions[CURRENT]).toBeDefined();
    expect(s.sessions[SENDING]).toBeDefined();
    expect(s.sessions[CREATING]).toBeDefined();
    expect(s.pending[`sessions:${CURRENT}`]).toBeUndefined();
  });
});

// Local-first mutation actions: each must (1) mutate the store synchronously so
// the UI updates instantly, and (2) route through the single dispatch pipeline
// (no direct Convex mutation). Conversation-table patches only dispatch for real
// 32-char Convex ids (the stub guard), so these use a realistic id.
describe("inboxStore local-first state mutations", () => {
  const CID = "abcdefghijklmnopqrstuvwxyz123456"; // 32-char convex-shaped id
  let dispatches: Array<{ action: string; args: any; patches: any; result: any }>;

  beforeEach(() => {
    dispatches = [];
    useInboxStore.setState({
      sessions: {}, conversations: {}, plans: {}, projects: {}, favorites: [],
      drafts: {}, clientState: {}, currentSessionId: null, pending: {}, currentConversation: {},
    });
    useInboxStore.getState()._setDispatch(async (action, args, patches, result) => {
      dispatches.push({ action, args, patches, result });
      return null;
    });
  });

  it("patchConversation writes conv + session locally, dispatches a conversations patch, and protects the field", () => {
    useInboxStore.setState({
      sessions: { [CID]: { ...baseSession, _id: CID } },
      conversations: { [CID]: { _id: CID } },
    });
    useInboxStore.getState().patchConversation(CID, { inbox_pinned_at: 123 });
    const s = useInboxStore.getState();
    expect(s.conversations[CID]?.inbox_pinned_at).toBe(123);
    expect(s.sessions[CID]?.inbox_pinned_at).toBe(123);
    // Rides applyPatches (conversations table) — no named side-effect needed.
    const d = dispatches.find((d) => d.action === "patchConversation");
    expect(d?.patches?.conversations?.[CID]?.inbox_pinned_at).toBe(123);
    // Field-protected so the next server sync can't clobber the local value.
    expect(s.pending[`conversations:${CID}:inbox_pinned_at`]).toBeTruthy();
  });

  it("toggleFavorite flips the flag on conv + session and keeps the favorites list in sync", () => {
    useInboxStore.setState({
      sessions: { [CID]: { ...baseSession, _id: CID } },
      conversations: { [CID]: { _id: CID, title: "T", is_favorite: false } },
      favorites: [],
    });
    useInboxStore.getState().toggleFavorite(CID);
    let s = useInboxStore.getState();
    expect(s.conversations[CID]?.is_favorite).toBe(true);
    expect((s.sessions[CID] as any)?.is_favorite).toBe(true);
    expect((s.favorites as any[]).some((f) => f._id === CID)).toBe(true);
    expect(dispatches.find((d) => d.action === "toggleFavorite")?.patches?.conversations?.[CID]?.is_favorite).toBe(true);
    // Toggling back removes it from the list.
    useInboxStore.getState().toggleFavorite(CID);
    s = useInboxStore.getState();
    expect(s.conversations[CID]?.is_favorite).toBe(false);
    expect((s.favorites as any[]).some((f) => f._id === CID)).toBe(false);
  });

  it("setPrivacy updates local privacy and dispatches the setPrivacy side-effect", () => {
    useInboxStore.setState({ conversations: { [CID]: { _id: CID, is_private: false, team_visibility: "summary" } } });
    useInboxStore.getState().setPrivacy(CID, true);
    const s = useInboxStore.getState();
    expect(s.conversations[CID]?.is_private).toBe(true);
    expect(s.conversations[CID]?.team_visibility).toBe("private");
    expect(dispatches.find((d) => d.action === "setPrivacy")?.args).toEqual([CID, true]);
  });

  it("setTeamVisibility clears private and dispatches the side-effect", () => {
    useInboxStore.setState({ conversations: { [CID]: { _id: CID, is_private: true, team_visibility: "private" } } });
    useInboxStore.getState().setTeamVisibility(CID, "full");
    const s = useInboxStore.getState();
    expect(s.conversations[CID]?.is_private).toBe(false);
    expect(s.conversations[CID]?.team_visibility).toBe("full");
    expect(dispatches.find((d) => d.action === "setTeamVisibility")?.args).toEqual([CID, "full"]);
  });

  it("updatePlan mutates the plan by short_id, protects the field, and dispatches updatePlan", () => {
    useInboxStore.setState({ plans: { plan1: { _id: "plan1", short_id: "pl-9", status: "active" } as any } });
    useInboxStore.getState().updatePlan("pl-9", { status: "done" });
    const s = useInboxStore.getState();
    expect(s.plans.plan1?.status).toBe("done");
    expect(s.pending["plans:plan1:status"]).toBeTruthy();
    expect(dispatches.find((d) => d.action === "updatePlan")?.args).toEqual(["pl-9", { status: "done" }]);
  });

  it("updateProject mutates the project by id and dispatches updateProject", () => {
    useInboxStore.setState({ projects: { proj1: { _id: "proj1", title: "P", status: "active" } as any } });
    useInboxStore.getState().updateProject("proj1", { status: "archived" });
    const s = useInboxStore.getState();
    expect(s.projects.proj1?.status).toBe("archived");
    expect(dispatches.find((d) => d.action === "updateProject")?.args).toEqual(["proj1", { status: "archived" }]);
  });

  it("convCommand applies the optimistic session patch and dispatches the command verbatim", async () => {
    useInboxStore.setState({ sessions: { [CID]: { ...baseSession, _id: CID } } });
    await useInboxStore.getState().convCommand(CID, "restartSession", undefined, { status: "starting" } as any);
    const s = useInboxStore.getState();
    expect((s.sessions[CID] as any)?.status).toBe("starting");
    const d = dispatches.find((d) => d.action === "convCommand");
    expect(d?.args?.[0]).toBe(CID);
    expect(d?.args?.[1]).toBe("restartSession");
  });

  it("markNotificationRead flips read locally, protects it, and dispatches", () => {
    useInboxStore.setState({ notifications: { [CID]: { _id: CID, read: false, created_at: 1 } } });
    useInboxStore.getState().markNotificationRead(CID);
    const s = useInboxStore.getState();
    expect(s.notifications[CID]?.read).toBe(true);
    expect(s.pending[`notifications:${CID}:read`]).toBeTruthy();
    expect(dispatches.find((d) => d.action === "markNotificationRead")?.args).toEqual([CID]);
  });

  it("markAllNotificationsRead flips every unread notification and dispatches once", () => {
    useInboxStore.setState({ notifications: {
      a: { _id: "a", read: false, created_at: 1 },
      b: { _id: "b", read: true, created_at: 2 },
      c: { _id: "c", read: false, created_at: 3 },
    } });
    useInboxStore.getState().markAllNotificationsRead();
    const s = useInboxStore.getState();
    expect(s.notifications.a?.read).toBe(true);
    expect(s.notifications.c?.read).toBe(true);
    expect(dispatches.filter((d) => d.action === "markAllNotificationsRead").length).toBe(1);
  });

  // Triage gestures on a session that was never OPENED on this client — no
  // conversations[id] meta row exists. The gesture writes the session row, and
  // the sessions→conversations field-whitelist dispatch mapping must carry it
  // to the server anyway. Before that mapping, the write was silently
  // local-only; the dismiss reconcile's CLEAR pass then read the server's
  // silence as "restored elsewhere" and un-hid the row on every crawl — the
  // "I keep dismissing these and they keep coming back" loop (ct-39383).
  it("killSession on an unopened session (no conversations meta) still dispatches the dismiss", () => {
    useInboxStore.setState({ sessions: { [CID]: { ...baseSession, _id: CID } }, conversations: {} });
    useInboxStore.getState().killSession(CID);
    const s = useInboxStore.getState();
    expect(s.sessions[CID]?.inbox_dismissed_at).toBeTruthy();
    const d = dispatches.find((d) => d.patches?.conversations?.[CID]?.inbox_dismissed_at);
    expect(d?.patches?.conversations?.[CID]?.inbox_dismissed_at).toBeTypeOf("number");
    // The in-flight local value stays protected until the server echo.
    expect(s.pending[`sessions:${CID}:inbox_dismissed_at`]).toBeTruthy();
  });

  it("stashSession on an unopened session still dispatches the stash", () => {
    useInboxStore.setState({ sessions: { [CID]: { ...baseSession, _id: CID } }, conversations: {} });
    useInboxStore.getState().stashSession(CID);
    const d = dispatches.find((d) => d.patches?.conversations?.[CID]?.inbox_stashed_at);
    expect(d?.patches?.conversations?.[CID]?.inbox_stashed_at).toBeTypeOf("number");
  });

  it("pinSession on an unopened session still dispatches the pin", () => {
    useInboxStore.setState({ sessions: { [CID]: { ...baseSession, _id: CID } }, conversations: {} });
    useInboxStore.getState().pinSession(CID);
    const d = dispatches.find((d) => d.patches?.conversations?.[CID]?.inbox_pinned_at !== undefined);
    expect(d?.patches?.conversations?.[CID]?.inbox_pinned_at).toBeTypeOf("number");
  });

  it("deferSession on an unopened session still dispatches the defer", () => {
    useInboxStore.setState({ sessions: { [CID]: { ...baseSession, _id: CID } }, conversations: {} });
    useInboxStore.getState().deferSession(CID);
    const d = dispatches.find((d) => d.patches?.conversations?.[CID]?.inbox_deferred_at !== undefined);
    expect(d?.patches?.conversations?.[CID]?.inbox_deferred_at).toBeTypeOf("number");
  });

  it("restoreSession on an unopened session dispatches the un-dismiss as a null tombstone", () => {
    useInboxStore.setState({
      sessions: { [CID]: { ...baseSession, _id: CID, inbox_dismissed_at: 123 } },
      conversations: {},
    });
    useInboxStore.getState().restoreSession(CID);
    const d = dispatches.find((d) => d.patches?.conversations?.[CID] && "inbox_dismissed_at" in d.patches.conversations[CID]);
    expect(d?.patches?.conversations?.[CID]?.inbox_dismissed_at).toBeNull();
  });

  it("non-triage session field writes do NOT dispatch through the sessions mapping", async () => {
    useInboxStore.setState({ sessions: { [CID]: { ...baseSession, _id: CID } }, conversations: {} });
    await useInboxStore.getState().convCommand(CID, "restartSession", undefined, { status: "starting" } as any);
    for (const d of dispatches) {
      expect(d.patches?.conversations?.[CID]?.status).toBeUndefined();
    }
  });
});

// The 30-day inbox window is a SERVER fetch bound only — the client never prunes.
// An old session opened via click/search is injected into the delta cache and
// stays (isDelta: true, never-prune). This guards that injectSession keeps an
// out-of-window session even when the live/crawl feeds would never resend it.
describe("inbox window — injected old sessions persist", () => {
  beforeEach(() => {
    useInboxStore.setState({ sessions: {}, conversations: {}, currentSessionId: null } as any);
  });

  it("injectSession keeps a >30d-old session in the store and selects it", () => {
    const old = Date.now() - 90 * 24 * 60 * 60 * 1000;
    useInboxStore.getState().injectSession({
      ...baseSession, _id: "old-conv", session_id: "old-sess", updated_at: old,
    });
    const st = useInboxStore.getState();
    expect(st.sessions["old-conv"]).toBeDefined();
    expect(st.currentSessionId).toBe("old-conv");

    // A live-feed delta that omits the old session must NOT evict it (delta cache).
    st.syncTable("sessions", [{
      ...baseSession, _id: "recent", session_id: "recent-sess", updated_at: Date.now(),
    }]);
    expect(useInboxStore.getState().sessions["old-conv"]).toBeDefined();
  });
});

// Bulk-dismiss prompt: markSessionsDismissed stamps inbox_dismissed_at locally on
// exactly the given ids (sessions + their conversation rows), moving them to the
// Dismissed bucket without touching anything else. It's a sync() (no per-row
// server dispatch); the server mutation persists the same set authoritatively.
describe("inbox markSessionsDismissed — bulk local dismiss", () => {
  beforeEach(() => {
    useInboxStore.setState({ sessions: {}, conversations: {}, currentSessionId: null } as any);
  });

  it("dismisses only the listed sessions and leaves the rest active", () => {
    const mk = (id: string): InboxSession => ({ ...baseSession, _id: id, session_id: `s-${id}`, updated_at: 1 });
    useInboxStore.setState({
      sessions: { a: mk("a"), b: mk("b"), keep: mk("keep") },
      conversations: { a: { _id: "a" }, b: { _id: "b" }, keep: { _id: "keep" } },
    } as any);

    useInboxStore.getState().markSessionsDismissed(["a", "b"]);
    const st = useInboxStore.getState();
    expect(isSessionDismissed(st.sessions["a"])).toBe(true);
    expect(isSessionDismissed(st.sessions["b"])).toBe(true);
    expect((st.conversations["a"] as any).inbox_dismissed_at).toBeGreaterThan(0);
    expect(isSessionDismissed(st.sessions["keep"])).toBe(false);

    // Categorization reflects it: a/b in dismissed bucket, keep stays out.
    const cat = categorizeSessions(st.sessions, new Set());
    expect(cat.dismissed.map((x) => x._id).sort()).toEqual(["a", "b"]);
    expect(cat.dismissed.map((x) => x._id)).not.toContain("keep");
  });

  it("does not overwrite an already-dismissed timestamp", () => {
    const st = useInboxStore.getState();
    st.syncTable("sessions", [{ ...baseSession, _id: "d", session_id: "sd", updated_at: 1, inbox_dismissed_at: 555 }]);
    st.markSessionsDismissed(["d"]);
    expect(useInboxStore.getState().sessions["d"].inbox_dismissed_at).toBe(555);
  });
});

// Assignment must feel instant: updateTask sets only the raw `assignee` id, so
// the display must DERIVE the avatar/name from the live roster (not the stored,
// server-enriched assignee_info which lags a round-trip).
describe("resolveAssigneeInfo", () => {
  const members = [{ _id: "u1", name: "Jason", github_avatar_url: "jpg", github_username: "jbenn" }];
  const currentUser = { _id: "u2", name: "Ashot", image: "apng", github_username: "ashot" };

  it("prefers the live roster over a stale stored assignee_info (the instant-reassign case)", () => {
    const stale = { name: "Old Person", image: "old.png" };
    expect(resolveAssigneeInfo("u1", stale, members, currentUser)).toEqual({ name: "Jason", image: "jpg", github_username: "jbenn" });
  });

  it("resolves the current user even when not in the team roster", () => {
    expect(resolveAssigneeInfo("u2", null, members, currentUser)).toEqual({ name: "Ashot", image: "apng", github_username: "ashot" });
  });

  it("returns null for no assignee and falls back to the server value for unknown ids", () => {
    expect(resolveAssigneeInfo(null, { name: "x" }, members, currentUser)).toBe(null);
    expect(resolveAssigneeInfo("u9", { name: "Server Enriched" }, members, currentUser)).toEqual({ name: "Server Enriched" });
  });
});

// Durable cross-device dismiss: a dismiss/un-dismiss made on another device must
// converge here even though it arrived via the lightweight by_user_dismissed
// reconcile (NOT the live subscription, NOT the updated_at-keyed crawl). These pin
// applyDismissedReconcile, the client half of that backstop. Regression for
// "I dismiss on one device but it's still there on another."
describe("applyDismissedReconcile — durable cross-device dismiss", () => {
  // Real server sessions have 32-char Convex ids; the reconcile's CLEAR pass
  // deliberately ignores anything shorter (local-only stubs).
  const A = "a".repeat(32);
  beforeEach(() => {
    useInboxStore.setState({ sessions: {}, conversations: {}, pending: {} } as any);
  });
  const seed = (id: string, extra: Partial<InboxSession> = {}) =>
    useInboxStore.getState().syncTable("sessions", [{ ...baseSession, _id: id, session_id: id, ...extra }]);

  it("SETS dismiss on a cached active session the server reports dismissed", () => {
    seed(A); // active in cache (the stale state on the offline device)
    expect(isSessionDismissed(useInboxStore.getState().sessions[A])).toBe(false);
    useInboxStore.getState().applyDismissedReconcile([{ _id: A, inbox_dismissed_at: 5000 }], true);
    const s = useInboxStore.getState();
    expect(s.sessions[A].inbox_dismissed_at).toBe(5000);
    expect((s.conversations[A] as any).inbox_dismissed_at).toBe(5000);
  });

  it("CLEARS dismiss (final pass) on a cached dismissed session the server no longer reports — un-dismissed elsewhere", () => {
    seed(A, { inbox_dismissed_at: Date.now() - 1000, message_count: 3 });
    expect(isSessionDismissed(useInboxStore.getState().sessions[A])).toBe(true);
    useInboxStore.getState().applyDismissedReconcile([], true); // server's dismissed set is empty
    expect(useInboxStore.getState().sessions[A].inbox_dismissed_at).toBeNull();
  });

  it("never CLEARs a dismissed BLANK session — its absence usually means the empty-conversation GC deleted it", () => {
    // A dismissed 0-message row leaving the server's dismissed set is (almost
    // always) cleanup.gcEmptyConversations hard-deleting it. Un-dismissing
    // would resurrect a ghost "New Session" card into the active inbox — the
    // exact "cruft keeps coming back" loop. It stays dismissed; the verified
    // ghost sweep removes it for real.
    seed(A, { inbox_dismissed_at: Date.now() - 1000, message_count: 0 });
    useInboxStore.getState().applyDismissedReconcile([], true);
    expect(isSessionDismissed(useInboxStore.getState().sessions[A])).toBe(true);
  });

  it("does NOT clear a dismissed session older than the reconcile window (out of server scan range)", () => {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    seed(A, { inbox_dismissed_at: old });
    useInboxStore.getState().applyDismissedReconcile([], true);
    expect(useInboxStore.getState().sessions[A].inbox_dismissed_at).toBe(old);
  });

  it("a per-page (non-final) pass SETs but never CLEARs — CLEAR needs the whole set", () => {
    seed(A, { inbox_dismissed_at: Date.now() - 1000 });
    useInboxStore.getState().applyDismissedReconcile([], false);
    expect(isSessionDismissed(useInboxStore.getState().sessions[A])).toBe(true);
  });

  it("respects a pending local override — an in-flight local unstash is NOT re-dismissed", () => {
    seed(A); // locally active (just un-dismissed, dispatch in flight)
    useInboxStore.setState((s: any) => ({
      pending: { ...s.pending, [`sessions:${A}:inbox_dismissed_at`]: { type: "field", value: null } },
    }));
    // Server still reports it dismissed (hasn't caught up) — local-first must win.
    useInboxStore.getState().applyDismissedReconcile([{ _id: A, inbox_dismissed_at: 5000 }], true);
    expect(isSessionDismissed(useInboxStore.getState().sessions[A])).toBe(false);
  });

  it("respects a pending local override when clearing — an in-flight local dismiss is NOT un-dismissed", () => {
    const now = Date.now();
    seed(A, { inbox_dismissed_at: now }); // locally dismissed, dispatch in flight
    useInboxStore.setState((s: any) => ({
      pending: { ...s.pending, [`sessions:${A}:inbox_dismissed_at`]: { type: "field", value: now } },
    }));
    // Server hasn't caught up (empty set) — must not clear the optimistic dismiss.
    useInboxStore.getState().applyDismissedReconcile([], true);
    expect(isSessionDismissed(useInboxStore.getState().sessions[A])).toBe(true);
  });

  it("never CLEARs a dismissed local-only stub — the server can't vouch for ids it never had", () => {
    // Regression: an orphaned optimistic stub (create failed) was dismissed, the
    // pending lock was later clobbered by another window sharing the IDB, and
    // every final reconcile pass resurrected it ("I keep dismissing this convo
    // and it reappears"). Stub ids must be invisible to the CLEAR pass.
    const stub = "s7fhu67z04khex0okvujt"; // Math.random().toString(36) shape, never 32 chars
    seed(stub, { inbox_dismissed_at: Date.now() - 1000 });
    // No pending lock — the clobbered-lock worst case.
    useInboxStore.setState({ pending: {} } as any);
    useInboxStore.getState().applyDismissedReconcile([], true);
    expect(isSessionDismissed(useInboxStore.getState().sessions[stub])).toBe(true);
  });
});

describe("hiding a local-only stub — stash/dismiss mean delete", () => {
  // A stub from beginOptimisticSession whose server create failed can never be
  // hidden server-side (the dispatch layer skips non-Convex ids), so flagging
  // it locally just feeds the resurrection loop above. Hiding it must remove
  // it outright — store rows gone, exclude pending planted so the IDB row delete
  // persists (same mechanics as a kill).
  const stub = "k2hf8s0dq1xand83hr0e6";
  const real = "b".repeat(32);

  beforeEach(() => {
    seedCurrentSession({
      sessions: {
        [stub]: { ...baseSession, _id: stub, session_id: stub },
        // message_count > 0: a blank `real` would be a hidden pre-warm,
        // invisible to the post-dismiss next-pick by design.
        [real]: { ...baseSession, _id: real, session_id: real, message_count: 3 },
      },
      conversations: {
        [stub]: { _id: stub } as any,
        [real]: { _id: real } as any,
      },
      messages: { [stub]: [] },
      pendingMessages: { [stub]: [] },
      currentSessionId: stub,
      viewingDismissedId: null,
      clientState: {},
      pending: {},
    } as any);
  });

  it("deletes the stub's rows instead of flagging them dismissed", () => {
    useInboxStore.getState().stashSession(stub);
    const s = useInboxStore.getState();
    expect(s.sessions[stub]).toBeUndefined();
    expect(s.conversations[stub]).toBeUndefined();
    expect(s.messages[stub]).toBeUndefined();
    expect(s.pendingMessages[stub]).toBeUndefined();
    // Exclude pending = the durable "row was removed on purpose" marker that
    // lets the IDB diff actually delete it (and blocks any resurrection).
    expect(s.pending[`sessions:${stub}`]?.type).toBe("exclude");
  });

  it("navigates off the deleted stub to the next session", () => {
    useInboxStore.getState().stashSession(stub);
    expect(useInboxStore.getState().currentSessionId).toBe(real);
  });

  it("still flags (not deletes) a real server-backed session", () => {
    useInboxStore.getState().stashSession(real);
    const s = useInboxStore.getState();
    expect(s.sessions[real]).toBeDefined();
    expect(isSessionStashed(s.sessions[real])).toBe(true);
  });

  it("killSession deletes a stub the same way", () => {
    useInboxStore.getState().killSession(stub);
    const s = useInboxStore.getState();
    expect(s.sessions[stub]).toBeUndefined();
    expect(s.pending[`sessions:${stub}`]?.type).toBe("exclude");
  });
});

describe("killSessions — bulk kill from the Stashed bucket", () => {
  it("moves every id to Killed and clears the stash flag", () => {
    const a = "a2".repeat(16);
    const b = "b2".repeat(16);
    const ts = Date.now() - 1000;
    useInboxStore.setState({
      sessions: {
        [a]: { ...baseSession, _id: a, session_id: a, message_count: 2, inbox_stashed_at: ts },
        [b]: { ...baseSession, _id: b, session_id: b, message_count: 2, inbox_stashed_at: ts },
      },
      conversations: { [a]: { _id: a } as any, [b]: { _id: b } as any },
      currentSessionId: null,
      clientState: {},
      pending: {},
    } as any);

    useInboxStore.getState().killSessions([a, b]);
    const s = useInboxStore.getState();
    for (const id of [a, b]) {
      expect(isSessionDismissed(s.sessions[id])).toBe(true);
      expect(isSessionStashed(s.sessions[id])).toBe(false);
    }
    const buckets = categorizeSessions(s.sessions, new Set());
    expect(buckets.stashed).toHaveLength(0);
    expect(buckets.dismissed.map((x) => x._id).sort()).toEqual([a, b].sort());
  });
});

describe("hidden buckets are closed by default", () => {
  // Open ONLY while the flag is explicitly true: unset (fresh user / cleared
  // state) must read as closed, and the first toggle must OPEN. The panel
  // renders `expanded: flag === true`, so these toggles are the whole contract.
  it("toggleShowStashed: unset -> open -> closed", () => {
    useInboxStore.setState({ clientState: {} } as any);
    useInboxStore.getState().toggleShowStashed();
    expect(useInboxStore.getState().clientState.show_stashed).toBe(true);
    useInboxStore.getState().toggleShowStashed();
    expect(useInboxStore.getState().clientState.show_stashed).toBe(false);
  });

  it("toggleShowDismissed: unset -> open -> closed", () => {
    useInboxStore.setState({ clientState: {} } as any);
    useInboxStore.getState().toggleShowDismissed();
    expect(useInboxStore.getState().clientState.show_dismissed).toBe(true);
    useInboxStore.getState().toggleShowDismissed();
    expect(useInboxStore.getState().clientState.show_dismissed).toBe(false);
  });
});

describe("applyStashedReconcile — cross-device stash propagation", () => {
  const realId = "a1".repeat(16);

  beforeEach(() => {
    useInboxStore.setState({
      sessions: {
        [realId]: { ...baseSession, _id: realId, session_id: realId, message_count: 4 },
      },
      conversations: { [realId]: { _id: realId } as any },
      pending: {},
    } as any);
  });

  it("SET overlays a remote stash onto the cached row", () => {
    const ts = Date.now() - 5_000;
    useInboxStore.getState().applyStashedReconcile([{ _id: realId, inbox_stashed_at: ts }], false);
    expect(useInboxStore.getState().sessions[realId].inbox_stashed_at).toBe(ts);
  });

  it("CLEAR (final pass) un-stashes a row the server no longer reports", () => {
    useInboxStore.setState({
      sessions: {
        [realId]: { ...baseSession, _id: realId, session_id: realId, message_count: 4, inbox_stashed_at: Date.now() - 5_000 },
      },
    } as any);
    useInboxStore.getState().applyStashedReconcile([], true);
    expect(useInboxStore.getState().sessions[realId].inbox_stashed_at ?? null).toBeNull();
  });

  it("a pending local override blocks the SET (local-first)", () => {
    useInboxStore.setState({
      pending: { [`sessions:${realId}:inbox_stashed_at`]: { type: "field", ts: Date.now() } },
    } as any);
    useInboxStore.getState().applyStashedReconcile([{ _id: realId, inbox_stashed_at: Date.now() }], false);
    expect(useInboxStore.getState().sessions[realId].inbox_stashed_at ?? null).toBeNull();
  });
});

import { computePlanProgress, mergeLiveTasks, deriveDocDisplayTitle } from "../../lib/liveEntities";

describe("liveEntities derivers (system-level local-first fix)", () => {
  const members = [{ _id: "u1", name: "Jason", github_avatar_url: "j.png" }];

  it("computePlanProgress mirrors server recalcProgress (dropped excluded; backlog→open)", () => {
    const tasks = [{ status: "done" }, { status: "done" }, { status: "in_progress" }, { status: "open" }, { status: "backlog" }, { status: "dropped" }];
    expect(computePlanProgress(tasks)).toEqual({ total: 5, done: 2, in_progress: 1, open: 2 });
  });

  it("mergeLiveTasks overlays live status + re-derives assignee, keeping snapshot-only fields", () => {
    const snapshot = [{ _id: "t1", status: "open", assignee: "u0", assignee_info: { name: "Old" }, origin_session: { x: 1 } }];
    const store = { t1: { _id: "t1", status: "done", assignee: "u1" } };
    const [r] = mergeLiveTasks(snapshot, store as any, members, null);
    expect(r.status).toBe("done");                 // live raw field overlaid
    expect(r.assignee_info).toEqual({ name: "Jason", image: "j.png", github_username: undefined }); // re-derived from roster
    expect(r.origin_session).toEqual({ x: 1 });    // server-only snapshot field preserved
  });

  it("mergeLiveTasks returns the same reference when nothing diverges (memo-stable)", () => {
    const snapshot = [{ _id: "t1", status: "open", assignee: "u1", assignee_info: { name: "Jason", image: "j.png", github_username: undefined } }];
    const store = { t1: { _id: "t1", status: "open", assignee: "u1" } };
    expect(mergeLiveTasks(snapshot, store as any, members, null)[0]).toBe(snapshot[0]);
  });

  it("deriveDocDisplayTitle parses a plan-mode doc heading, else undefined", () => {
    expect(deriveDocDisplayTitle({ source: "plan_mode", content: "# My Plan\nbody" })).toBe("My Plan");
    expect(deriveDocDisplayTitle({ source: "note", content: "# X" })).toBeUndefined();
    expect(deriveDocDisplayTitle({ source: "plan_mode", content: "no heading" })).toBeUndefined();
  });
});

describe("resolveSessionAuthor", () => {
  const me = { _id: "me", name: "Me", image: "me.png" };
  const roster = [
    me,
    { _id: "u2", name: "Jason Park", image: "jason.png" },
    { _id: "u3", email: "kim@x.com" },
  ];

  it("returns null for the current user's own session (user_id === me)", () => {
    expect(resolveSessionAuthor({ user_id: "me" }, null, me, roster)).toBeNull();
  });

  it("returns null when there is no author identity at all (user-scoped default = mine)", () => {
    expect(resolveSessionAuthor({}, null, me, roster)).toBeNull();
  });

  it("resolves a teammate from the live roster by user_id (name + avatar)", () => {
    expect(resolveSessionAuthor({ user_id: "u2" }, null, me, roster)).toEqual({ name: "Jason Park", avatar: "jason.png" });
  });

  it("falls back to email when the roster member has no name", () => {
    expect(resolveSessionAuthor({ user_id: "u3" }, null, me, roster)).toEqual({ name: "kim@x.com", avatar: undefined });
  });

  it("prefers the live roster over the source-provided author fields (instant rename)", () => {
    const r = resolveSessionAuthor({ user_id: "u2", author_name: "Stale Name", author_avatar: "stale.png" }, null, me, roster);
    expect(r).toEqual({ name: "Jason Park", avatar: "jason.png" });
  });

  it("uses source author fields when the author isn't on the roster (cross-team)", () => {
    const r = resolveSessionAuthor({ user_id: "ghost", author_name: "Outsider", author_avatar: "out.png" }, null, me, roster);
    expect(r).toEqual({ name: "Outsider", avatar: "out.png" });
  });

  it("shows the palette author (no user_id, only author_name) — team source already excluded own sessions", () => {
    expect(resolveSessionAuthor({ author_name: "Sam", author_avatar: "sam.png" }, null, me, roster)).toEqual({ name: "Sam", avatar: "sam.png" });
  });

  it("returns null for an unnamed non-roster author (better blank than a raw id)", () => {
    expect(resolveSessionAuthor({ user_id: "ghost" }, null, me, roster)).toBeNull();
  });

  it("before currentUser loads: own synced row (user_id, no author_name) stays unlabeled — no self-flash", () => {
    expect(resolveSessionAuthor({ user_id: "me" }, null, null, roster)).toBeNull();
    expect(resolveSessionAuthor({ user_id: "u2" }, null, undefined, roster)).toBeNull();
  });

  it("before currentUser loads: an explicit author_name still marks not-mine (display stays roster-first)", () => {
    expect(resolveSessionAuthor({ user_id: "u2", author_name: "Stale Name", author_avatar: "stale.png" }, null, null, roster)).toEqual({ name: "Jason Park", avatar: "jason.png" });
    // off-roster author: source fields carry the display
    expect(resolveSessionAuthor({ user_id: "ghost", author_name: "Outsider", author_avatar: "out.png" }, null, null, roster)).toEqual({ name: "Outsider", avatar: "out.png" });
  });

  // -- conversation-meta source: rescues rows cached before injection carried author --

  it("author-less cached row + conv meta (is_own:false, user_id): resolves via roster — the stale-cache fix", () => {
    const conv = { user_id: "u2", is_own: false, user: { name: "Jason Park", avatar_url: "meta.png" } };
    expect(resolveSessionAuthor({}, conv, me, roster)).toEqual({ name: "Jason Park", avatar: "jason.png" });
  });

  it("conv meta user display when author isn't on the roster", () => {
    const conv = { user_id: "ghost", is_own: false, user: { name: "Old Member", avatar_url: "old.png" } };
    expect(resolveSessionAuthor({}, conv, me, roster)).toEqual({ name: "Old Member", avatar: "old.png" });
  });

  it("conv.is_own:true is definitive — never labels my own viewed session, even with a user object", () => {
    const conv = { user_id: "me", is_own: true, user: { name: "Me", avatar_url: "me.png" } };
    expect(resolveSessionAuthor({}, conv, me, roster)).toBeNull();
  });

  it("redirect seed only ({is_own:false}, no user yet): not-mine but unnameable → null until meta lands", () => {
    expect(resolveSessionAuthor({}, { is_own: false }, me, roster)).toBeNull();
  });

  it("conv meta works before currentUser loads (is_own verdict needs no 'me')", () => {
    const conv = { user_id: "u2", is_own: false, user: { name: "Jason Park", avatar_url: "meta.png" } };
    expect(resolveSessionAuthor({}, conv, null, roster)).toEqual({ name: "Jason Park", avatar: "jason.png" });
  });

  it("conv meta without is_own still resolves ownership by user_id comparison", () => {
    const conv = { user_id: "u2", user: { name: "Jason Park", avatar_url: "meta.png" } };
    expect(resolveSessionAuthor({}, conv, me, roster)).toEqual({ name: "Jason Park", avatar: "jason.png" });
    expect(resolveSessionAuthor({}, { user_id: "me", user: { name: "Me" } }, me, roster)).toBeNull();
  });
});

// The team feed's "older pages remain" flag is persisted, and false used to be
// a dead latch: one mid-history empty page (a window of filtered-out rows)
// persisted false, the seed effect (which only writes when the key is absent)
// could never undo it, and feed pagination stayed dead on that device forever.
// Hydration now drops false entries (re-derived as unknown); the trustworthy
// end-of-history marker is feedCursors[key] === null, which loadMore checks
// before any network. Regression for ct-35795.
describe("feed pagination latch — dropLatchedFeedHasMore + feedCursors", () => {
  beforeEach(() => {
    useInboxStore.setState({ feedConversations: {}, feedHasMore: {}, feedCursors: {} });
  });

  it("drops false entries in place and keeps true ones", () => {
    const persisted = { "team1|": false, "team1|dir": true, "team2|": false };
    dropLatchedFeedHasMore(persisted);
    expect(persisted).toEqual({ "team1|dir": true });
  });

  it("tolerates missing or malformed persisted values", () => {
    expect(() => dropLatchedFeedHasMore(undefined)).not.toThrow();
    expect(() => dropLatchedFeedHasMore(null)).not.toThrow();
    expect(() => dropLatchedFeedHasMore("junk")).not.toThrow();
  });

  it("setFeedCursor records the server continuation, including the null end-of-history marker", () => {
    useInboxStore.getState().setFeedCursor("team1|", "12345");
    expect(useInboxStore.getState().feedCursors["team1|"]).toBe("12345");
    useInboxStore.getState().setFeedCursor("team1|", null);
    expect(useInboxStore.getState().feedCursors["team1|"]).toBeNull();
    // Distinguishable from "unknown" (absent key) — the loadMore fallback path.
    expect("team2|" in useInboxStore.getState().feedCursors).toBe(false);
  });

  it("feedCursors is wired for persistence (write side)", () => {
    // Hydrate side is the apply() pick list in inboxStore; a key persisted but
    // never hydrated is a silent cache no-op, so guard the write side here.
    expect(isPersistedStoreKey("feedCursors")).toBe(true);
    expect(isPersistedStoreKey("feedHasMore")).toBe(true);
  });
});

// What pagination state may be persisted off an older-page response. The
// poison case: an unauthenticated/blipped query returns the same empty+null
// shape as a true end of history; persisting that null latched loadMore off
// on the device for good (the cursor twin of the feedHasMore latch above).
// Regression for ct-36577.
describe("feedPagePersistence — null cursor is only durable with evidence", () => {
  it("trusts a continuation cursor unconditionally", () => {
    expect(feedPagePersistence({ rowCount: 0, nextCursor: "abc" })).toEqual({ cursor: "abc", hasMore: true });
    expect(feedPagePersistence({ rowCount: 20, nextCursor: '{"v":2,"m":{}}' })).toEqual({ cursor: '{"v":2,"m":{}}', hasMore: true });
  });

  it("trusts end-of-history only when the final page carried rows", () => {
    expect(feedPagePersistence({ rowCount: 3, nextCursor: null })).toEqual({ cursor: null, hasMore: false });
  });

  it("an empty page with a null cursor keeps the existing resume point", () => {
    expect(feedPagePersistence({ rowCount: 0, nextCursor: null })).toEqual({ cursor: undefined, hasMore: false });
  });
});

// Closing the active tab promotes a background tab. A background tab's stored
// path is typically the canonicalized /conversation/<id> URL (stamped by
// switchTab from window.location), whose pane is a spent RedirectToInbox
// skeleton — every other transition heals that with a freshly-mounted redirect
// targeting the active tab, but close has none, so the survivor showed a
// permanent loader. closeTab must promote it in the inbox deep-link form.
describe("closeTab — promoted tab must not be a redirect-page route", () => {
  const convId = "jx70p2wf110d36kd6y3cdw339x8858c0";
  const tabA = { id: "tab_a", title: "inbox", path: `/conversation/${convId}`, createdAt: 1 };
  const tabB = { id: "tab_b", title: "inbox", path: `/inbox?s=${convId}`, createdAt: 2 };
  const tabC = { id: "tab_c", title: "ashot", path: "/team/ashot", createdAt: 3 };

  beforeEach(() => {
    useInboxStore.setState({ tabs: [tabA, tabB], activeTabId: "tab_b" });
  });

  it("rewrites a promoted /conversation/<id> path to /inbox?s=<id>", () => {
    useInboxStore.getState().closeTab("tab_b");
    const s = useInboxStore.getState();
    expect(s.activeTabId).toBe("tab_a");
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].path).toBe(`/inbox?s=${convId}`);
  });

  it("leaves the promoted tab alone when its path renders real content", () => {
    useInboxStore.setState({ tabs: [tabC, tabB], activeTabId: "tab_b" });
    useInboxStore.getState().closeTab("tab_b");
    const s = useInboxStore.getState();
    expect(s.activeTabId).toBe("tab_c");
    expect(s.tabs[0].path).toBe("/team/ashot");
  });

  it("closing a background tab touches neither the active tab nor any path", () => {
    useInboxStore.getState().closeTab("tab_a");
    const s = useInboxStore.getState();
    expect(s.activeTabId).toBe("tab_b");
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].path).toBe(`/inbox?s=${convId}`);
  });

  it("does not rewrite the diff route — that pane is a real page, not a redirect", () => {
    const diffTab = { id: "tab_d", title: "diff", path: `/conversation/${convId}/diff`, createdAt: 1 };
    useInboxStore.setState({ tabs: [diffTab, tabB], activeTabId: "tab_b" });
    useInboxStore.getState().closeTab("tab_b");
    expect(useInboxStore.getState().tabs[0].path).toBe(`/conversation/${convId}/diff`);
  });
});

describe("inboxStore fork stub lifecycle", () => {
  const STUB = "11111111-2222-4333-8444-555555555555";
  const REAL = "k57abc0000000000000000000000conv";

  beforeEach(() => {
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      messages: {},
      pendingMessages: {},
      pagination: {},
      drafts: {},
      clientState: {},
      currentSessionId: null,
      pending: {},
      currentConversation: {},
      optimisticForkChildren: [],
    });
  });

  function seedStub() {
    seedCurrentSession({
      sessions: { [STUB]: { ...baseSession, _id: STUB, session_id: STUB, forked_from: "parent1" } as InboxSession },
      conversations: { [STUB]: { _id: STUB, session_id: STUB, fork_status: "copying", message_count: 2 } },
      messages: { [STUB]: [{ _id: "m1", role: "user", timestamp: 1 }, { _id: "m2", role: "assistant", timestamp: 2 }] },
      pendingMessages: { [STUB]: [{ _id: "p1", role: "user", timestamp: 3, _isOptimistic: true }] },
      currentSessionId: STUB,
      optimisticForkChildren: [{ _id: STUB, parent_message_uuid: "u2" }],
    } as any);
  }

  it("resolveForkSessionId performs a full stub→real rekey, including navigation and pending messages", () => {
    seedStub();
    useInboxStore.getState().resolveForkSessionId(STUB, REAL);
    const s = useInboxStore.getState();
    expect(s.sessions[STUB]).toBeUndefined();
    expect(s.sessions[REAL]?._id).toBe(REAL);
    // session_id stays the stub UUID — it's the daemon-side session identity.
    expect(s.sessions[REAL]?.session_id).toBe(STUB);
    expect(s.conversations[STUB]).toBeUndefined();
    expect(s.conversations[REAL]?.fork_status).toBe("copying");
    expect(s.messages[REAL]?.length).toBe(2);
    expect(s.messages[STUB]).toBeUndefined();
    expect(s.pendingMessages[REAL]?.length).toBe(1);
    expect(s.currentSessionId).toBe(REAL);
    expect(s.optimisticForkChildren[0]?._id).toBe(REAL);
  });

  it("discardForkStub drops every stub row and returns focus to the parent", () => {
    seedStub();
    useInboxStore.getState().discardForkStub(STUB, "parent1");
    const s = useInboxStore.getState();
    expect(s.sessions[STUB]).toBeUndefined();
    expect(s.conversations[STUB]).toBeUndefined();
    expect(s.messages[STUB]).toBeUndefined();
    expect(s.pendingMessages[STUB]).toBeUndefined();
    expect(s.optimisticForkChildren.length).toBe(0);
    expect(s.currentSessionId).toBe("parent1");
  });
});

describe("hidden-reconcile stale override release (ct-36973)", () => {
  // A dismiss plants a pending field override that normally clears when the
  // server echoes the same value. But dismissed rows leave the live channel,
  // so a hide overturned ELSEWHERE (other device / server-side restore) never
  // produces a matching echo — the override pinned the row hidden forever.
  // Past the settle window the reconcile's authoritative set must win.
  const ID = "jx70000000000000000000000000abcd";
  const seed = (overrideAgeMs: number, dismissedAt = Date.now() - 60_000) => {
    useInboxStore.setState({
      sessions: { [ID]: { _id: ID, session_id: "s1", inbox_dismissed_at: dismissedAt, message_count: 5 } as any },
      conversations: { [ID]: { _id: ID, inbox_dismissed_at: dismissedAt } as any },
      pending: {
        [`sessions:${ID}:inbox_dismissed_at`]: { type: "field", value: dismissedAt, ts: Date.now() - overrideAgeMs },
      } as any,
    });
  };

  it("fresh override still wins — an in-flight local dismiss is protected", () => {
    seed(5_000);
    const seededAt = (useInboxStore.getState().sessions[ID] as any).inbox_dismissed_at;
    useInboxStore.getState().applyDismissedReconcile([], true);
    const s = useInboxStore.getState();
    expect((s.sessions[ID] as any).inbox_dismissed_at).toBe(seededAt);
    expect(s.pending[`sessions:${ID}:inbox_dismissed_at`]).toBeDefined();
  });

  it("stale override releases: server's authoritative un-hide lands and the lock is deleted", () => {
    seed(10 * 60 * 1000);
    useInboxStore.getState().applyDismissedReconcile([], true);
    const s = useInboxStore.getState();
    expect((s.sessions[ID] as any).inbox_dismissed_at).toBeNull();
    expect((s.conversations[ID] as any).inbox_dismissed_at).toBeNull();
    expect(s.pending[`sessions:${ID}:inbox_dismissed_at`]).toBeUndefined();
  });

  it("stale override also releases for the SET direction (remote re-dismiss lands)", () => {
    useInboxStore.setState({
      sessions: { [ID]: { _id: ID, session_id: "s1", inbox_dismissed_at: null, message_count: 5 } as any },
      conversations: { [ID]: { _id: ID, inbox_dismissed_at: null } as any },
      pending: {
        [`sessions:${ID}:inbox_dismissed_at`]: { type: "field", value: null, ts: Date.now() - 10 * 60 * 1000 },
      } as any,
    });
    useInboxStore.getState().applyDismissedReconcile([{ _id: ID, inbox_dismissed_at: 2222 } as any], false);
    const s = useInboxStore.getState();
    expect((s.sessions[ID] as any).inbox_dismissed_at).toBe(2222);
    expect(s.pending[`sessions:${ID}:inbox_dismissed_at`]).toBeUndefined();
  });
});

describe("dismiss/kill advances in the ACTIVE view order, like j/k", () => {
  // Three waiting-for-input sessions whose grouped order and time order
  // DISAGREE, so the test can tell which ordering the advance used.
  // Grouped (needsInput: earliest-updated first): A, B, C → next after A = B.
  // Time view (started_at desc):                  A, C, B → next after A = C.
  const A = "a".repeat(32);
  const B = "b".repeat(32);
  const C = "c".repeat(32);
  const waiting = (id: string, updated_at: number, started_at: number): InboxSession => ({
    ...baseSession,
    _id: id,
    session_id: `sess-${id.slice(0, 1)}`,
    message_count: 5,
    is_idle: true,
    updated_at,
    started_at,
  });

  // seedCurrentSession declares the nav source so the view-motion guard
  // doesn't revert currentSessionId (undeclared non-null view writes are
  // reverted in tests exactly as in production).
  const seed = (viewMode?: "grouped" | "time") => {
    seedCurrentSession({
      sessions: {
        [A]: waiting(A, 100, 200),
        [B]: waiting(B, 200, 100),
        [C]: waiting(C, 300, 150),
      },
      conversations: {
        [A]: { _id: A } as any,
        [B]: { _id: B } as any,
        [C]: { _id: C } as any,
      },
      currentSessionId: A,
      clientState: viewMode ? { ui: { inbox_view_mode: viewMode } } : {},
      pending: {},
      bucketAssignments: {},
      buckets: {},
    });
  };

  it("grouped view: kill advances to the next row of the grouped layout", () => {
    seed("grouped");
    useInboxStore.getState().killSession(A);
    expect(useInboxStore.getState().currentSessionId).toBe(B);
  });

  it("time view: kill advances to the next row of the time sort, not the grouped order", () => {
    seed("time");
    useInboxStore.getState().killSession(A);
    expect(useInboxStore.getState().currentSessionId).toBe(C);
  });

  it("time view: stash advances the same way (shared hide path)", () => {
    seed("time");
    useInboxStore.getState().stashSession(A);
    expect(useInboxStore.getState().currentSessionId).toBe(C);
  });

  it("time view: markKilling advances the same way", () => {
    seed("time");
    useInboxStore.getState().markKilling(A);
    expect(useInboxStore.getState().currentSessionId).toBe(C);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authoritative active set (hide-old): categorizeSessions must render exactly the
// server's live inbox set (liveInboxIds) in the active buckets when showOld is off
// — the invariant that converges the inbox across web / desktop / mobile and keeps
// aged-out cruft out of Needs Input while it stays in the cache for search/open.
// See inbox_no_authoritative_sessions_floor / the fold in categorizeSessions.
// ─────────────────────────────────────────────────────────────────────────────
describe("categorizeSessions — authoritative active set (hide-old)", () => {
  const cid = (tag: string) => tag.padEnd(32, "0").slice(0, 32).toLowerCase();
  // An idle session with messages classifies as needs-input (see the stopped/idle
  // test above). Fresh updated_at so the trust-TTL sweep never touches it.
  const needsInputRow = (tag: string, ageMs = 0): InboxSession => ({
    ...baseSession,
    _id: cid(tag),
    session_id: `sess-${tag}`,
    message_count: 4,
    agent_status: "idle",
    is_idle: true,
    updated_at: Date.now() - ageMs,
  });

  it("hides cached rows absent from liveInboxIds; keeps live-set rows; counts old", () => {
    const live = needsInputRow("liveactive");
    const old = needsInputRow("oldcruft", 40 * 24 * 60 * 60 * 1000); // 40d stale
    const sessions = { [live._id]: live, [old._id]: old };
    const liveInboxIds = new Set([live._id]);

    const hidden = categorizeSessions(sessions, new Set(), undefined, { liveInboxIds, showOld: false });
    expect(hidden.needsInput.map((s) => s._id)).toEqual([live._id]);
    expect(hidden.needsInput.map((s) => s._id)).not.toContain(old._id);
    expect(hidden.oldCount).toBe(1);

    // The old row is only hidden from the buckets — it is still in the input map
    // (categorize never mutates it), so search/open still resolve it.
    expect(sessions[old._id]).toBe(old);
  });

  it("showOld: true reveals the old rows and reports oldCount 0", () => {
    const live = needsInputRow("liveactive2");
    const old = needsInputRow("oldcruft2", 40 * 24 * 60 * 60 * 1000);
    const sessions = { [live._id]: live, [old._id]: old };
    const res = categorizeSessions(sessions, new Set(), undefined, {
      liveInboxIds: new Set([live._id]),
      showOld: true,
    });
    expect(res.needsInput.map((s) => s._id).sort()).toEqual([live._id, old._id].sort());
    expect(res.oldCount).toBe(0);
  });

  it("no liveInboxIds → safe fallback: show everything (pre-live-payload / legacy callers)", () => {
    const a = needsInputRow("rowa");
    const b = needsInputRow("rowb", 40 * 24 * 60 * 60 * 1000);
    const sessions = { [a._id]: a, [b._id]: b };
    // omitted opts (legacy call sites)
    expect(categorizeSessions(sessions, new Set()).needsInput.length).toBe(2);
    // explicit empty set (cold start, before the first live payload) also shows all
    const cold = categorizeSessions(sessions, new Set(), undefined, { liveInboxIds: new Set(), showOld: false });
    expect(cold.needsInput.length).toBe(2);
    expect(cold.oldCount).toBe(0);
  });

  it("never hides a working session (working rows are always newest → always in the live set)", () => {
    const working = { ...needsInputRow("workingnow"), agent_status: "working", is_idle: false };
    // Even if a race left it momentarily out of liveInboxIds, it must not vanish
    // from Working — but in practice it is always present. Assert the guaranteed
    // case: a working row IN the live set stays in Working under hide-old.
    const sessions = { [working._id]: working };
    const res = categorizeSessions(sessions, new Set(), undefined, {
      liveInboxIds: new Set([working._id]),
      showOld: false,
    });
    expect(res.working.map((s) => s._id)).toEqual([working._id]);
    expect(res.oldCount).toBe(0);
  });

  it("pinned rows are exempt from hide-old even when absent from the live set", () => {
    const pinned = { ...needsInputRow("pinnedold", 60 * 24 * 60 * 60 * 1000), is_pinned: true, inbox_pinned_at: Date.now() };
    const sessions = { [pinned._id]: pinned };
    const res = categorizeSessions(sessions, new Set(), undefined, { liveInboxIds: new Set(["someotherid".padEnd(32, "0")]), showOld: false });
    expect(res.pinned.map((s) => s._id)).toEqual([pinned._id]);
    expect(res.oldCount).toBe(0);
  });

  it("the sidebar/dashboard count path matches the panel (same authoritative set)", () => {
    // Regression for the divergence: the badges used raw s.sessions (no partition),
    // so their counts included cruft the panel hid. With the fold both paths use the
    // same opts → identical needsInput length.
    const live = needsInputRow("livea");
    const old1 = needsInputRow("old1", 40 * 24 * 60 * 60 * 1000);
    const old2 = needsInputRow("old2", 40 * 24 * 60 * 60 * 1000);
    const sessions = { [live._id]: live, [old1._id]: old1, [old2._id]: old2 };
    const opts = { liveInboxIds: new Set([live._id]), showOld: false };
    const panel = categorizeSessions(sessions, new Set(), undefined, opts).needsInput.length;
    const badge = categorizeSessions(sessions, new Set(), undefined, opts).needsInput.length;
    expect(panel).toBe(1);
    expect(badge).toBe(panel);
  });
});

describe("liveInboxIds persistence + synced show-old", () => {
  beforeEach(() => {
    useInboxStore.setState({
      liveInboxIds: new Set<string>(),
      liveInboxIdList: [],
      clientState: {},
      clientStateInitialized: true,
      pending: {},
    });
  });

  it("setLiveInboxIds keeps the in-memory Set and its persisted twin in lockstep", () => {
    useInboxStore.getState().setLiveInboxIds(["a", "b"]);
    const st = useInboxStore.getState();
    expect([...st.liveInboxIds].sort()).toEqual(["a", "b"]);
    expect([...st.liveInboxIdList].sort()).toEqual(["a", "b"]);

    useInboxStore.getState().setLiveInboxIds(["c"]);
    const st2 = useInboxStore.getState();
    expect([...st2.liveInboxIds]).toEqual(["c"]);
    expect(st2.liveInboxIdList).toEqual(["c"]);
  });

  it("cold-boot seed lands the persisted twin into liveInboxIds", () => {
    seedLiveInboxIdsFromCache(["x", "y"]);
    const st = useInboxStore.getState();
    expect([...st.liveInboxIds].sort()).toEqual(["x", "y"]);
    expect([...st.liveInboxIdList].sort()).toEqual(["x", "y"]);
  });

  it("cold-boot seed never clobbers a live payload that raced hydration", () => {
    useInboxStore.getState().setLiveInboxIds(["fresh"]);
    seedLiveInboxIdsFromCache(["stale1", "stale2"]);
    expect([...useInboxStore.getState().liveInboxIds]).toEqual(["fresh"]);
  });

  it("cold-boot seed ignores junk cache values (non-array / empty / non-strings)", () => {
    seedLiveInboxIdsFromCache(undefined);
    seedLiveInboxIdsFromCache({});
    seedLiveInboxIdsFromCache([]);
    seedLiveInboxIdsFromCache([42, null]);
    expect(useInboxStore.getState().liveInboxIds.size).toBe(0);
  });

  it("liveInboxIdList is persisted; no transient show-old store key exists", () => {
    // The twin must survive reloads (first-frame correctness). Show-old lives
    // in clientState.ui.inbox_show_old (stamped LWW) — never as a bare store
    // field, which could drift from what actually syncs.
    expect(isPersistedStoreKey("liveInboxIdList")).toBe(true);
    expect(isPersistedStoreKey("showOldSessions")).toBe(false);
    expect("showOldSessions" in useInboxStore.getState()).toBe(false);
    // The raw Set itself must not be registered either — it doesn't survive the
    // native JSON round-trip; only its array twin does.
    expect(isPersistedStoreKey("liveInboxIds")).toBe(false);
  });

  it("setShowOldSessions writes the synced ui key with a ts stamp (sticky per-user view)", () => {
    const before = Date.now();
    expect(resolveShowOld(useInboxStore.getState().clientState.ui)).toBe(false);
    useInboxStore.getState().setShowOldSessions(true);
    const ui = useInboxStore.getState().clientState.ui as Record<string, any>;
    expect(ui.inbox_show_old).toBe(true);
    expect(ui["inbox_show_old:ts"]).toBeGreaterThanOrEqual(before);
    expect(resolveShowOld(ui)).toBe(true);
  });

  it("an OFF toggled on another device (newer stamp) wins on sync — sticky can't become stuck", () => {
    useInboxStore.getState().setShowOldSessions(true);
    const newer = Date.now() + 5_000;
    useInboxStore.getState().syncTable("clientState", {
      ui: { inbox_show_old: false, "inbox_show_old:ts": newer },
    });
    expect(resolveShowOld(useInboxStore.getState().clientState.ui)).toBe(false);
  });

  it("a local toggle survives a stale server echo (no flicker)", () => {
    useInboxStore.getState().setShowOldSessions(true);
    useInboxStore.getState().syncTable("clientState", {
      ui: { inbox_show_old: false, "inbox_show_old:ts": Date.now() - 60_000 },
    });
    expect(resolveShowOld(useInboxStore.getState().clientState.ui)).toBe(true);
  });

  it("the legacy show_old_sessions key is never read — a stale server `true` cannot resurrect cruft mode", () => {
    // The pre-LWW synced flag once turned one browse click into a permanent
    // all-clients cruft mode; stale `true` values still linger in server
    // client_state docs. resolveShowOld must ignore them forever.
    useInboxStore.getState().syncTable("clientState", { ui: { show_old_sessions: true } });
    expect(resolveShowOld(useInboxStore.getState().clientState.ui)).toBe(false);
  });
});
