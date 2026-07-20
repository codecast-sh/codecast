import { describe, expect, test } from "bun:test";
import {
  isNoiseTitle,
  isOrphanOrSubagent,
  shouldShowInInbox,
  isViableInboxParent,
  isSessionIdle,
  nextAgentStatusOnAddMessages,
  isApiErrorBanner,
  classifyApiErrorBanner,
  apiErrorBatchAction,
  classifyWorkState,
  normalizeWorkStateFilter,
  trustedAgentStatus,
  subagentKeepsParentWorking,
  SUBAGENT_PRODUCING_GRACE_MS,
  STATUS_TRUST_TTL_MS,
  AGENT_IDLE_GRACE_MS,
  HEARTBEAT_ALIVE_MS,
  type ConversationDoc,
  type SessionIdleInput,
  type WorkStateInput,
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

  test("matches real-world usage/session-limit banners", () => {
    expect(isApiErrorBanner("You've hit your session limit · resets 11:30pm (America/New_York)")).toBe(true);
    expect(isApiErrorBanner("You've hit your session limit")).toBe(true);
    expect(isApiErrorBanner("You've hit your monthly spend limit · raise it at claude.ai/settings/usage")).toBe(true);
    expect(isApiErrorBanner("You’ve hit your weekly limit · resets 3am (America/New_York)")).toBe(true); // curly apostrophe
    expect(isApiErrorBanner("Claude usage limit reached. Your limit will reset at 3am (America/New_York).")).toBe(true);
  });

  test("does not flag prose that merely opens like a limit banner", () => {
    // Real assistant sentences seen in transcripts — same prefix, but they
    // continue as prose instead of the single-line `· detail` banner shape.
    expect(isApiErrorBanner("You've hit your usage limit on the free plan, so video generation is paused right here.")).toBe(false);
    expect(isApiErrorBanner("You've hit your trial usage limit. I can activate your full Pro subscription right now.")).toBe(false);
    expect(isApiErrorBanner("You've hit your usage limit — the ad is fully planned, cast, and ready to generate.")).toBe(false);
    expect(isApiErrorBanner("You've hit your session limit · resets 11:30pm\nWait, actually let me reconsider the approach here.")).toBe(false);
  });

  test("classifies banner kinds for the badge label", () => {
    expect(classifyApiErrorBanner("Please run /login · API Error: 401 Invalid authentication credentials")).toBe("auth");
    expect(classifyApiErrorBanner("You've hit your session limit · resets 11:30pm (America/New_York)")).toBe("limit");
    expect(classifyApiErrorBanner("API Error: 529 Overloaded")).toBe("error");
    expect(classifyApiErrorBanner("All good, deploy finished.")).toBe(null);
  });

  test("statusless connection drops classify as connection, statusful failures stay error", () => {
    // No status code = the provider never replied; the turn died at the
    // prompt and a plain continue resumes it — the blocked/revive set.
    expect(classifyApiErrorBanner("API Error: Connection closed mid-response. The response above may be incomplete.")).toBe("connection");
    expect(classifyApiErrorBanner("API Error: Connection error.")).toBe("connection");
    expect(classifyApiErrorBanner("API Error: Request timed out.")).toBe("connection");
    // A status code = an HTTP response came back; the CLI retries these
    // itself, so they stay out of the blocked set.
    expect(classifyApiErrorBanner("API Error: 500 Internal server error")).toBe("error");
    expect(classifyApiErrorBanner('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe("error");
  });

  test("expired-grant banner forms classify as auth", () => {
    expect(classifyApiErrorBanner("Login expired · Please run /login")).toBe("auth");
    expect(classifyApiErrorBanner("Login expired · run /login")).toBe("auth");
    expect(classifyApiErrorBanner("Login expired")).toBe("auth");
    // Prose about someone's login is not this session's banner.
    expect(classifyApiErrorBanner("Logins expired for three users last week, so we rotated keys.")).toBe(null);
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

describe("classifyWorkState", () => {
  function wsi(partial: Partial<WorkStateInput> = {}): WorkStateInput {
    return {
      agentStatus: undefined,
      isIdle: false,
      awaitingInput: false,
      hasPending: false,
      isUnresponsive: false,
      messageCount: 5,
      ...partial,
    };
  }

  test("active agent statuses → working", () => {
    for (const agentStatus of ["working", "thinking", "compacting", "connected", "starting", "resuming"]) {
      expect(classifyWorkState(wsi({ agentStatus }))).toBe("working");
    }
  });

  test("deliverable pending work on a live daemon → working", () => {
    expect(classifyWorkState(wsi({ hasPending: true }))).toBe("working");
  });

  test("permission_blocked with content → needs_input", () => {
    expect(classifyWorkState(wsi({ agentStatus: "permission_blocked" }))).toBe("needs_input");
  });

  test("open AskUserQuestion poll → needs_input (even if daemon raced back to working)", () => {
    expect(classifyWorkState(wsi({ agentStatus: "working", awaitingInput: true }))).toBe("needs_input");
  });

  test("dead (stopped) session with output → needs_input", () => {
    expect(classifyWorkState(wsi({ agentStatus: "stopped", isIdle: true }))).toBe("needs_input");
  });

  test("THE RULE: a settled session with content → needs_input (matches the web inbox)", () => {
    // The web inbox has no "idle with content" bucket — a finished turn waiting
    // to be read is the user's ball, so it files under NEEDS INPUT. The CLI
    // matches; "idle" is reserved for blank sessions.
    expect(classifyWorkState(wsi({ isIdle: true }))).toBe("needs_input");
  });

  test("not yet idle with no active status (mid-grace / just-sent user message) → working", () => {
    expect(classifyWorkState(wsi({ isIdle: false }))).toBe("working");
  });

  test("a pinned session that is actively working stays working (pin doesn't force needs_input)", () => {
    expect(classifyWorkState(wsi({ agentStatus: "working", isIdle: false }))).toBe("working");
  });

  test("empty sessions never demand input (no content to read / answer)", () => {
    // permission_blocked / stopped / settled-idle all require content to become
    // needs_input; with zero messages they fall through to idle (startup noise).
    expect(classifyWorkState(wsi({ messageCount: 0, agentStatus: "permission_blocked" }))).toBe("idle");
    expect(classifyWorkState(wsi({ messageCount: 0, isIdle: true }))).toBe("idle");
    expect(classifyWorkState(wsi({ messageCount: 0, agentStatus: "stopped", isIdle: true }))).toBe("idle");
    expect(classifyWorkState(wsi({ messageCount: 0, isIdle: false }))).toBe("idle");
    // ...but an actively-working empty session (just spawned) is still working.
    expect(classifyWorkState(wsi({ messageCount: 0, agentStatus: "starting" }))).toBe("working");
  });

  test("an unresponsive (dead-daemon) session with queued work does NOT count as working", () => {
    // canDeliver is false, so has_pending can't route it to working; with
    // content it needs a human to read/restart it.
    expect(classifyWorkState(wsi({ hasPending: true, isUnresponsive: true, isIdle: true }))).toBe("needs_input");
  });
});

describe("normalizeWorkStateFilter", () => {
  test("canonical tokens pass through", () => {
    expect(normalizeWorkStateFilter("working")).toBe("working");
    expect(normalizeWorkStateFilter("needs_input")).toBe("needs_input");
    expect(normalizeWorkStateFilter("idle")).toBe("idle");
    expect(normalizeWorkStateFilter("pinned")).toBe("pinned");
    expect(normalizeWorkStateFilter("live")).toBe("live");
  });

  test("friendly aliases + spacing/casing normalize", () => {
    expect(normalizeWorkStateFilter("needs-input")).toBe("needs_input");
    expect(normalizeWorkStateFilter("needs input")).toBe("needs_input");
    expect(normalizeWorkStateFilter("Blocked")).toBe("needs_input");
    expect(normalizeWorkStateFilter("attention")).toBe("needs_input");
    expect(normalizeWorkStateFilter("BUSY")).toBe("working");
    expect(normalizeWorkStateFilter("running")).toBe("live");
  });

  test("unset / unknown / all → null (no filter)", () => {
    expect(normalizeWorkStateFilter(undefined)).toBeNull();
    expect(normalizeWorkStateFilter("")).toBeNull();
    expect(normalizeWorkStateFilter("all")).toBeNull();
    expect(normalizeWorkStateFilter("garbage")).toBeNull();
  });
});

describe("trustedAgentStatus (stale 'working' trust TTL)", () => {
  const NOW = 10_000_000;

  test("fresh active status is trusted unchanged", () => {
    expect(trustedAgentStatus("working", NOW - 60_000, NOW)).toBe("working");
    expect(trustedAgentStatus("thinking", NOW - (STATUS_TRUST_TTL_MS - 1), NOW)).toBe("thinking");
  });

  test("an active status with no synced activity past the TTL collapses to idle", () => {
    expect(trustedAgentStatus("working", NOW - STATUS_TRUST_TTL_MS, NOW)).toBe("idle");
    expect(trustedAgentStatus("working", NOW - 24 * 60 * 60 * 1000, NOW)).toBe("idle");
    // applies to every active status, not just "working"
    for (const s of ["compacting", "thinking", "connected", "starting", "resuming"]) {
      expect(trustedAgentStatus(s, NOW - STATUS_TRUST_TTL_MS, NOW)).toBe("idle");
    }
  });

  test("non-active statuses are never coerced, however stale", () => {
    for (const s of ["idle", "stopped", "permission_blocked"]) {
      expect(trustedAgentStatus(s, NOW - 24 * 60 * 60 * 1000, NOW)).toBe(s);
    }
  });

  test("undefined status / unknown updatedAt are left alone", () => {
    expect(trustedAgentStatus(undefined, NOW - 24 * 60 * 60 * 1000, NOW)).toBeUndefined();
    expect(trustedAgentStatus("working", undefined, NOW)).toBe("working");
  });

  // End-to-end: the exact composition enrichInboxSessionRow uses — coerce the
  // status, recompute idle from it, then classify. This is the regression: a
  // frozen "working" on a long-quiet conversation must NOT land in working.
  function workStateFor(rawStatus: string, ageMs: number): string {
    const now = NOW;
    const updatedAt = now - ageMs;
    const agentStatus = trustedAgentStatus(rawStatus, updatedAt, now);
    const isIdle = isSessionIdle({
      agentStatus,
      agentStatusUpdatedAt: updatedAt, // status last changed at turn start
      hasPending: false,
      lastRoleIsUser: false,
      recentlyUpdated: now - updatedAt < AGENT_IDLE_GRACE_MS,
      daemonAlive: true,
      now,
    });
    return classifyWorkState({
      agentStatus,
      isIdle,
      awaitingInput: false,
      hasPending: false,
      isUnresponsive: false,
      messageCount: 5,
    });
  }

  test("a genuinely active session (recent activity) still reads working", () => {
    expect(workStateFor("working", 30_000)).toBe("working");
  });

  test("a session frozen in 'working' for hours reads needs_input (finished), not working", () => {
    expect(workStateFor("working", 18 * 60 * 60 * 1000)).toBe("needs_input");
  });

  // Regression for feedForCLI's classifyConv (powers `cast sessions` / the
  // global feed): classifying on the RAW managed status — skipping the coercion
  // — is exactly the bug that pinned long-quiet sessions in WORKING. This locks
  // in that the feed path must coerce before it classifies, matching the inbox.
  test("classifying the RAW status without coercion is the working-forever bug", () => {
    const now = NOW;
    const updatedAt = now - 12 * 60 * 60 * 1000; // quiet 12h, daemon still heartbeating
    const rawWorkState = classifyWorkState({
      agentStatus: "working", // raw managed_sessions.agent_status, re-asserted on heartbeat
      isIdle: isSessionIdle({
        agentStatus: "working",
        agentStatusUpdatedAt: updatedAt,
        hasPending: false,
        lastRoleIsUser: false,
        recentlyUpdated: false,
        daemonAlive: true,
        now,
      }),
      awaitingInput: false,
      hasPending: false,
      isUnresponsive: false,
      messageCount: 5,
    });
    expect(rawWorkState).toBe("working"); // the symptom
    expect(workStateFor("working", 12 * 60 * 60 * 1000)).toBe("needs_input"); // the coerced fix
  });
});

describe("trustedAgentStatus (lapsed heartbeat)", () => {
  const NOW = 10_000_000;

  test("stale heartbeat + quiet conversation coerces an active status to stopped", () => {
    expect(trustedAgentStatus("working", NOW - HEARTBEAT_ALIVE_MS, NOW, false)).toBe("stopped");
    expect(trustedAgentStatus("thinking", NOW - 10 * 60 * 1000, NOW, false)).toBe("stopped");
    // no activity timestamp at all: nothing vouches for the process — stopped
    expect(trustedAgentStatus("working", undefined, NOW, false)).toBe("stopped");
  });

  test("stale heartbeat + quiet past the TTL still reads stopped, not idle", () => {
    // A dead daemon stays dead however long ago it died; the TTL's "idle"
    // (alive-but-finished) must not win over the missing heartbeat.
    expect(trustedAgentStatus("working", NOW - STATUS_TRUST_TTL_MS, NOW, false)).toBe("stopped");
  });

  test("REGRESSION 2026-07-20: fresh message traffic vetoes the stopped coercion", () => {
    // The daemon's heartbeat sender shared a guard with multi-minute maintenance
    // passes, so the whole fleet's last_heartbeat aged past the liveness window
    // while agents were syncing messages every few seconds. Activity on the
    // conversation is proof of life: the active status must survive.
    expect(trustedAgentStatus("working", NOW - 15_000, NOW, false)).toBe("working");
    expect(trustedAgentStatus("thinking", NOW - (HEARTBEAT_ALIVE_MS - 1), NOW, false)).toBe("thinking");
  });

  test("fresh heartbeat keeps the pre-existing behavior (default arg true)", () => {
    expect(trustedAgentStatus("working", NOW - 10 * 60 * 1000, NOW, true)).toBe("working");
    expect(trustedAgentStatus("working", NOW - STATUS_TRUST_TTL_MS, NOW, true)).toBe("idle");
  });

  test("non-active statuses pass through untouched regardless of heartbeat", () => {
    for (const s of ["idle", "stopped", "permission_blocked"]) {
      expect(trustedAgentStatus(s, NOW - 24 * 60 * 60 * 1000, NOW, false)).toBe(s);
    }
    expect(trustedAgentStatus(undefined, NOW - 1000, NOW, false)).toBeUndefined();
  });

  // The full inbox composition for the observed incident: a busy session
  // (messages < grace window old) whose heartbeat lapsed must classify as
  // WORKING, and a genuinely dead daemon (conversation quiet too) as
  // needs_input via "stopped".
  function workStateWithHeartbeat(rawStatus: string, convAgeMs: number, heartbeatAlive: boolean): string {
    const now = NOW;
    const updatedAt = now - convAgeMs;
    const agentStatus = trustedAgentStatus(rawStatus, updatedAt, now, heartbeatAlive);
    const isIdle = isSessionIdle({
      agentStatus,
      agentStatusUpdatedAt: updatedAt,
      hasPending: false,
      lastRoleIsUser: false,
      recentlyUpdated: now - updatedAt < AGENT_IDLE_GRACE_MS,
      daemonAlive: heartbeatAlive,
      now,
    });
    return classifyWorkState({
      agentStatus,
      isIdle,
      awaitingInput: false,
      hasPending: false,
      isUnresponsive: false,
      messageCount: 5,
    });
  }

  test("busy session with lapsed heartbeat files under WORKING, dead one under needs_input", () => {
    expect(workStateWithHeartbeat("working", 15_000, false)).toBe("working"); // the incident
    expect(workStateWithHeartbeat("working", HEARTBEAT_ALIVE_MS + 1000, false)).toBe("needs_input"); // truly dead
    expect(workStateWithHeartbeat("working", 15_000, true)).toBe("working"); // healthy baseline
  });
});

describe("subagentKeepsParentWorking", () => {
  const NOW = 10_000_000;
  const base = {
    isSubagent: true,
    convStatus: "active",
    updatedAt: NOW - 30 * 60 * 1000, // 30m ago: well past the producing grace
    isLive: false,
    agentStatus: "idle" as string | undefined,
    now: NOW,
  };

  test("non-subagent children never pin the parent", () => {
    expect(subagentKeepsParentWorking({ ...base, isSubagent: false, isLive: true, agentStatus: "working" })).toBe(false);
  });

  test("a completed-conversation child never pins the parent", () => {
    expect(subagentKeepsParentWorking({ ...base, convStatus: "completed", isLive: true, agentStatus: "working" })).toBe(false);
  });

  // The actual bug: a forked subagent that finished (agent idle) but whose
  // daemon keeps heartbeating — live, but not producing — must NOT keep its
  // long-finished parent stuck in "working".
  test("a live-but-idle subagent does NOT keep the parent working", () => {
    expect(subagentKeepsParentWorking({ ...base, isLive: true, agentStatus: "idle" })).toBe(false);
  });

  test("a live subagent whose agent is genuinely active keeps the parent working", () => {
    expect(subagentKeepsParentWorking({ ...base, isLive: true, agentStatus: "working" })).toBe(true);
    expect(subagentKeepsParentWorking({ ...base, isLive: true, agentStatus: "thinking" })).toBe(true);
  });

  test("an active agent_status that isn't live (dead daemon) doesn't pin the parent", () => {
    expect(subagentKeepsParentWorking({ ...base, isLive: false, agentStatus: "working" })).toBe(false);
  });

  // Recent output is its own proof of work — covers Task-tool subagents with no
  // managed session (no agent_status to read, never "live").
  test("a subagent that produced output within the grace keeps the parent working", () => {
    expect(subagentKeepsParentWorking({
      ...base,
      updatedAt: NOW - (SUBAGENT_PRODUCING_GRACE_MS - 1_000),
      isLive: false,
      agentStatus: undefined,
    })).toBe(true);
  });

  test("just past the producing grace with no live-active session, the parent settles", () => {
    expect(subagentKeepsParentWorking({
      ...base,
      updatedAt: NOW - (SUBAGENT_PRODUCING_GRACE_MS + 1_000),
      isLive: false,
      agentStatus: undefined,
    })).toBe(false);
  });
});
