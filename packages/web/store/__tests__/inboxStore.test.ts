import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { categorizeSessions, computeNewDividerIndex, getSessionRenderKey, isConvexId, isSessionDismissed, orchestrationGroupLabelOf, pendingSendConsumed, sessionsWithPendingSend, unionHydrate, useInboxStore, worktreeKeyOf, type InboxSession } from "../inboxStore";
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

    // Without a pending send the same session stays in New.
    const withoutPending = categorizeSessions(
      { [newSession._id]: newSession },
      new Set(),
    );
    expect(withoutPending.newSessions.map((s) => s._id)).toContain("conv-new-pending");
    expect(withoutPending.working.map((s) => s._id)).not.toContain("conv-new-pending");
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
    const working = {
      ...baseSession, _id: "conv-flip", session_id: "sess-flip",
      message_count: 5, agent_status: "working" as const, is_idle: false,
      has_pending: false, updated_at: 1000,
    };
    store.syncTable("sessions", [working]);
    let cat = categorizeSessions(useInboxStore.getState().sessions, new Set());
    expect(cat.working.map((s) => s._id)).toContain("conv-flip");

    // Agent finished its turn: server recomputes idle/stopped, but writes no new
    // message, so updated_at is UNCHANGED.
    store.syncTable("sessions", [{
      ...working, agent_status: "idle" as const, is_idle: true, updated_at: 1000,
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
    useInboxStore.setState({
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

  it("clusters >=2 plan workers (main-repo path) under the plan label", () => {
    // The real shape: workers carry active_plan but a plain main-repo project_path.
    const sessions = {
      a: mk("a", { active_plan: PLAN, project_path: "/Users/x/src/codecast", updated_at: 3 }),
      b: mk("b", { active_plan: PLAN, project_path: "/Users/x/src/codecast", updated_at: 2 }),
      main: mk("main", { project_path: "/Users/x/src/codecast", updated_at: 4 }),
    };
    const r = categorizeSessions(sessions, new Set());
    expect(r.orchestrationGroups.get("pl-85 · Architecture hardening")?.map((s) => s._id).sort())
      .toEqual(["a", "b"]);
    const flat = new Set([...r.pinned, ...r.newSessions, ...r.needsInput, ...r.working].map((s) => s._id));
    expect(flat.has("a")).toBe(false);
    expect(flat.has("b")).toBe(false);
    // a plain main-repo session (no plan) is never grouped and stays flat
    expect(flat.has("main")).toBe(true);
  });

  it("clusters >=2 same-worktree workers (no plan) under the worktree label", () => {
    const sessions = {
      a: mk("a", { project_path: WT, updated_at: 3 }),
      b: mk("b", { project_path: WT, updated_at: 2 }),
      main: mk("main", { project_path: "/Users/x/src/codecast", updated_at: 4 }),
    };
    const r = categorizeSessions(sessions, new Set());
    expect(r.orchestrationGroups.get("⑂ arch-hardening-top-six")?.map((s) => s._id).sort())
      .toEqual(["a", "b"]);
    expect(new Set([...r.needsInput, ...r.working].map((s) => s._id)).has("main")).toBe(true);
  });

  it("leaves a lone worker (cluster of 1) inline", () => {
    const sessions = {
      a: mk("a", { active_plan: PLAN, project_path: "/Users/x/src/codecast" }),
      main: mk("main", { project_path: "/Users/x/src/codecast" }),
    };
    const r = categorizeSessions(sessions, new Set());
    expect(r.orchestrationGroups.size).toBe(0);
    const flat = new Set([...r.needsInput, ...r.working].map((s) => s._id));
    expect(flat.has("a")).toBe(true);
  });

  it("does not group a worker already nested under a conversation parent", () => {
    const sessions = {
      parent: mk("parent", { project_path: "/Users/x/src/codecast" }),
      a: mk("a", { active_plan: PLAN, parent_conversation_id: "parent" }),
      b: mk("b", { active_plan: PLAN, parent_conversation_id: "parent" }),
    };
    const r = categorizeSessions(sessions, new Set());
    expect(r.orchestrationGroups.size).toBe(0);
    expect(r.subsByParent.get("parent")?.length).toBe(2);
  });

  it("does not pull pinned workers into an orchestration group", () => {
    const sessions = {
      a: mk("a", { active_plan: PLAN, is_pinned: true, inbox_pinned_at: 5 }),
      b: mk("b", { active_plan: PLAN, is_pinned: true, inbox_pinned_at: 6 }),
    };
    const r = categorizeSessions(sessions, new Set());
    expect(r.orchestrationGroups.size).toBe(0);
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
