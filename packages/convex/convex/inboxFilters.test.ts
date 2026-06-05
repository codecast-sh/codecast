import { describe, expect, test } from "bun:test";
import {
  isNoiseTitle,
  isOrphanOrSubagent,
  shouldShowInInbox,
  isViableInboxParent,
  isSessionIdle,
  nextAgentStatusOnAddMessages,
  isApiErrorBanner,
  apiErrorBatchAction,
  AGENT_IDLE_GRACE_MS,
  type ConversationDoc,
  type SessionIdleInput,
} from "./inboxFilters";

function conv(partial: Partial<ConversationDoc> = {}): ConversationDoc {
  return {
    _id: "cvx_default" as any,
    _creationTime: 0,
    user_id: "usr_default" as any,
    session_id: "sess_default",
    title: "Session",
    status: "active",
    message_count: 5,
    updated_at: 100,
    started_at: 100,
    ...partial,
  } as ConversationDoc;
}

describe("isNoiseTitle", () => {
  test("plain title is not noise", () => {
    expect(isNoiseTitle("Fix the bug")).toBe(false);
  });
  test("empty/undefined is not noise", () => {
    expect(isNoiseTitle("")).toBe(false);
    expect(isNoiseTitle(undefined)).toBe(false);
    expect(isNoiseTitle("   ")).toBe(false);
  });
  test("warmup is noise (case-insensitive, trimmed)", () => {
    expect(isNoiseTitle("warmup")).toBe(true);
    expect(isNoiseTitle("WARMUP")).toBe(true);
    expect(isNoiseTitle("  Warmup  ")).toBe(true);
  });
  test("[Using: prefix is noise", () => {
    expect(isNoiseTitle("[Using: gpt-4] hello")).toBe(true);
  });
  test("[Request prefix is noise", () => {
    expect(isNoiseTitle("[Request interrupted]")).toBe(true);
    expect(isNoiseTitle("[Request cancelled]")).toBe(true);
  });
  test("[SUGGESTION MODE: prefix is noise", () => {
    expect(isNoiseTitle("[SUGGESTION MODE: foo]")).toBe(true);
  });
  test("lowercase [suggestion is NOT noise — prefix match is case-sensitive", () => {
    expect(isNoiseTitle("[suggestion mode: foo]")).toBe(false);
  });
});

describe("isOrphanOrSubagent", () => {
  test("plain conversation is neither", () => {
    expect(isOrphanOrSubagent(conv())).toBe(false);
  });
  test("is_subagent true → orphan", () => {
    expect(isOrphanOrSubagent(conv({ is_subagent: true }))).toBe(true);
  });
  test("is_workflow_sub true → orphan", () => {
    expect(isOrphanOrSubagent(conv({ is_workflow_sub: true }))).toBe(true);
  });
  test("parent_conversation_id set without parent_message_uuid → orphan", () => {
    expect(isOrphanOrSubagent(conv({ parent_conversation_id: "p1" as any }))).toBe(true);
  });
  test("parent_conversation_id WITH parent_message_uuid is NOT orphan (legitimate fork)", () => {
    expect(isOrphanOrSubagent(conv({
      parent_conversation_id: "p1" as any,
      parent_message_uuid: "m1",
    }))).toBe(false);
  });
  test("agent-switch child is NOT orphan", () => {
    expect(isOrphanOrSubagent(conv({
      parent_conversation_id: "p1" as any,
      parent_message_uuid: "agent-switch",
    }))).toBe(false);
  });
  test("is_subagent false is not orphan", () => {
    expect(isOrphanOrSubagent(conv({ is_subagent: false }))).toBe(false);
  });
});

describe("isViableInboxParent", () => {
  const USER = "usr_default";
  test("null/undefined parent → not viable", () => {
    expect(isViableInboxParent(null, USER)).toBe(false);
    expect(isViableInboxParent(undefined, USER)).toBe(false);
  });
  test("ordinary active session owned by user → viable", () => {
    expect(isViableInboxParent(conv(), USER)).toBe(true);
  });
  test("parent owned by a different user → not viable", () => {
    expect(isViableInboxParent(conv({ user_id: "usr_other" as any }), USER)).toBe(false);
  });
  test("dismissed parent → not viable (children of a dismissed parent aren't surfaced)", () => {
    expect(isViableInboxParent(conv({ inbox_dismissed_at: 100 }), USER)).toBe(false);
  });
  test("parent that is itself a subagent → not viable", () => {
    expect(isViableInboxParent(conv({ is_subagent: true }), USER)).toBe(false);
  });
  test("killed (not pinned) parent → not viable", () => {
    expect(isViableInboxParent(conv({ inbox_killed_at: 100 }), USER)).toBe(false);
  });
  test("completed parent with no messages → not viable", () => {
    expect(isViableInboxParent(conv({ status: "completed", message_count: 0 }), USER)).toBe(false);
  });
});

// Inbox visibility is now a single filter. Dismissed conversations stay in the
// inbox — clients categorize them via the `inbox_dismissed_at` field.
describe("shouldShowInInbox", () => {
  test("active session with messages → show", () => {
    expect(shouldShowInInbox(conv())).toBe(true);
  });

  test("dismissed → still in inbox (client buckets via inbox_dismissed_at)", () => {
    expect(shouldShowInInbox(conv({ inbox_dismissed_at: 100 }))).toBe(true);
  });

  test("dismissed + pinned → in inbox", () => {
    expect(shouldShowInInbox(conv({
      inbox_dismissed_at: 100,
      inbox_pinned_at: 200,
    }))).toBe(true);
  });

  test("killed → hide (kill is terminal)", () => {
    expect(shouldShowInInbox(conv({ inbox_killed_at: 100 }))).toBe(false);
  });

  // Pin revives a killed conversation, mirroring "dismissed + pinned" above.
  // See 8f9490f7 "revive killed conversations on send or pin"; the filter only
  // hides a killed conv when it is NOT pinned (inbox_killed_at && !inbox_pinned_at).
  test("killed + pinned → in inbox (pin revives)", () => {
    expect(shouldShowInInbox(conv({
      inbox_killed_at: 100,
      inbox_pinned_at: 200,
    }))).toBe(true);
  });

  test("killed + dismissed → hide", () => {
    expect(shouldShowInInbox(conv({
      inbox_killed_at: 100,
      inbox_dismissed_at: 100,
    }))).toBe(false);
  });

  test("subagent → hide", () => {
    expect(shouldShowInInbox(conv({ is_subagent: true }))).toBe(false);
  });

  test("workflow sub → hide", () => {
    expect(shouldShowInInbox(conv({ is_workflow_sub: true }))).toBe(false);
  });

  test("orphan → hide", () => {
    expect(shouldShowInInbox(conv({ parent_conversation_id: "p1" as any }))).toBe(false);
  });

  test("completed + zero messages → hide", () => {
    expect(shouldShowInInbox(conv({ status: "completed", message_count: 0 }))).toBe(false);
  });

  test("active + zero messages → show (new session)", () => {
    expect(shouldShowInInbox(conv({ status: "active", message_count: 0 }))).toBe(true);
  });

  test("completed + has messages → show", () => {
    expect(shouldShowInInbox(conv({ status: "completed", message_count: 5 }))).toBe(true);
  });

  test("warmup title → hide", () => {
    expect(shouldShowInInbox(conv({ title: "warmup" }))).toBe(false);
  });

  test("noise-prefixed title → hide", () => {
    expect(shouldShowInInbox(conv({ title: "[Request interrupted]" }))).toBe(false);
  });
});

describe("isSessionIdle", () => {
  const NOW = 1_000_000_000;
  function idleInput(partial: Partial<SessionIdleInput> = {}): SessionIdleInput {
    return {
      agentStatus: "idle",
      agentStatusUpdatedAt: NOW - 2 * AGENT_IDLE_GRACE_MS, // settled by default
      hasPending: false,
      lastRoleIsUser: false,
      recentlyUpdated: false,
      daemonAlive: true,
      now: NOW,
      ...partial,
    };
  }

  test("REGRESSION: finished agent stays idle while a message backlog churns updated_at", () => {
    // The bug: a done agent (status idle past the grace) was pinned in "working"
    // because conv.updated_at kept advancing as a 285→552 message backlog synced
    // in, holding recentlyUpdated=true. The grace must key off the status-change
    // time instead, so the churn no longer matters.
    expect(isSessionIdle(idleInput({ recentlyUpdated: true }))).toBe(true);
  });

  test("settled idle ignores a lagging last_message_role (final turn not synced yet)", () => {
    expect(isSessionIdle(idleInput({ lastRoleIsUser: true }))).toBe(true);
  });

  test("stopped agent past the grace is idle", () => {
    expect(isSessionIdle(idleInput({ agentStatus: "stopped", recentlyUpdated: true }))).toBe(true);
  });

  test("within the grace, a just-finished agent is NOT idle (anti-flicker preserved)", () => {
    expect(
      isSessionIdle(
        idleInput({ agentStatusUpdatedAt: NOW - 1000, recentlyUpdated: true }),
      ),
    ).toBe(false);
  });

  test("pending work keeps a settled-idle agent out of idle", () => {
    expect(isSessionIdle(idleInput({ hasPending: true }))).toBe(false);
  });

  test("active statuses are never idle, regardless of timestamps", () => {
    for (const agentStatus of ["working", "thinking", "compacting", "connected", "starting", "resuming"]) {
      expect(isSessionIdle(idleInput({ agentStatus }))).toBe(false);
    }
  });

  test("missing status timestamp falls back to conv.updated_at recency", () => {
    // Legacy session with no agent_status_updated_at: old behavior.
    expect(
      isSessionIdle(idleInput({ agentStatusUpdatedAt: undefined, recentlyUpdated: true })),
    ).toBe(false);
    expect(
      isSessionIdle(idleInput({ agentStatusUpdatedAt: undefined, recentlyUpdated: false })),
    ).toBe(true);
  });

  test("no daemon status: defers to liveness + recency", () => {
    expect(isSessionIdle(idleInput({ agentStatus: undefined, daemonAlive: true, recentlyUpdated: true }))).toBe(false);
    expect(isSessionIdle(idleInput({ agentStatus: undefined, daemonAlive: true, recentlyUpdated: false }))).toBe(true);
    // Dead daemon, not recently updated → idle (needs user attention).
    expect(isSessionIdle(idleInput({ agentStatus: undefined, daemonAlive: false, recentlyUpdated: false }))).toBe(true);
  });
});

describe("nextAgentStatusOnAddMessages", () => {
  test("answering an AskUserQuestion (user tool_result) clears a stuck permission_blocked", () => {
    // The core regression: the resume "working" hook was lost, so the session
    // is latched in permission_blocked. The synced answer (user + tool_result)
    // must clear it to "working".
    expect(nextAgentStatusOnAddMessages("permission_blocked", false, true)).toBe("working");
  });

  test("the poll card itself (assistant, no user tool_result) never clears permission_blocked", () => {
    // The synthetic AskUserQuestion poll is written as a role:"assistant" msg.
    // It must NOT clear the block it represents.
    expect(nextAgentStatusOnAddMessages("permission_blocked", true, false)).toBeNull();
  });

  test("a genuinely pending prompt is untouched by a free-form user chat", () => {
    // Free-form user chat carries no tool_results, so hasToolResultReply=false.
    expect(nextAgentStatusOnAddMessages("permission_blocked", false, false)).toBeNull();
  });

  test("assistant turn bumps an idle (grace-parked) session back to working", () => {
    expect(nextAgentStatusOnAddMessages("idle", true, false)).toBe("working");
  });

  test("does not disturb already-active or other statuses", () => {
    expect(nextAgentStatusOnAddMessages("working", true, true)).toBeNull();
    expect(nextAgentStatusOnAddMessages("thinking", true, false)).toBeNull();
    expect(nextAgentStatusOnAddMessages("stopped", false, true)).toBeNull();
    // assistant msg does not clear permission_blocked (only a tool_result does)
    expect(nextAgentStatusOnAddMessages("permission_blocked", true, false)).toBeNull();
    // tool_result does not bump idle (only an assistant turn does)
    expect(nextAgentStatusOnAddMessages("idle", false, true)).toBeNull();
  });

  test("no managed session status (undefined) is a no-op", () => {
    expect(nextAgentStatusOnAddMessages(undefined, true, true)).toBeNull();
  });
});

describe("isApiErrorBanner", () => {
  test("matches the real-world login/401 banner", () => {
    expect(isApiErrorBanner("Please run /login · API Error: 401 Invalid authentication credentials")).toBe(true);
  });

  test("matches other Claude Code error banners", () => {
    expect(isApiErrorBanner("Not logged in · Please run /login")).toBe(true);
    expect(isApiErrorBanner("API Error: 529 Overloaded")).toBe(true);
    expect(isApiErrorBanner("API Error: Connection error.")).toBe(true);
    expect(isApiErrorBanner("Invalid API key · Please run /login")).toBe(true);
    expect(isApiErrorBanner("Credit balance is too low")).toBe(true);
    expect(isApiErrorBanner("  please run /login  ")).toBe(true); // trimmed + case-insensitive
  });

  test("ignores empty / nullish content", () => {
    expect(isApiErrorBanner(undefined)).toBe(false);
    expect(isApiErrorBanner(null)).toBe(false);
    expect(isApiErrorBanner("")).toBe(false);
    expect(isApiErrorBanner("   ")).toBe(false);
  });

  test("does not flag a real assistant turn that merely discusses an API error", () => {
    expect(isApiErrorBanner("The API error 401 you saw earlier means the token expired; here is how to refresh it.")).toBe(false);
    expect(isApiErrorBanner("Let me check why the login flow returns a 401.")).toBe(false);
    // Long content is never a banner even if it opens with the phrase.
    expect(isApiErrorBanner("API Error: 500 ".concat("x".repeat(500)))).toBe(false);
  });
});

describe("apiErrorBatchAction", () => {
  test("real turn after a pending banner -> supersede", () => {
    expect(apiErrorBatchAction({ batchHasRealTurn: true, batchHasBanner: false, conversationPending: true })).toBe("supersede");
  });

  test("banner and real turn in the same batch -> supersede", () => {
    expect(apiErrorBatchAction({ batchHasRealTurn: true, batchHasBanner: true, conversationPending: false })).toBe("supersede");
  });

  test("banner-only batch -> mark_pending", () => {
    expect(apiErrorBatchAction({ batchHasRealTurn: false, batchHasBanner: true, conversationPending: false })).toBe("mark_pending");
  });

  test("ordinary traffic (no banner, not pending) -> none, so no DB scan", () => {
    expect(apiErrorBatchAction({ batchHasRealTurn: true, batchHasBanner: false, conversationPending: false })).toBe("none");
    expect(apiErrorBatchAction({ batchHasRealTurn: false, batchHasBanner: false, conversationPending: false })).toBe("none");
  });

  test("a still-erroring session (pending, banner-only) does not supersede", () => {
    expect(apiErrorBatchAction({ batchHasRealTurn: false, batchHasBanner: true, conversationPending: true })).toBe("mark_pending");
  });
});
