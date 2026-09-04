import { openTasksVouchForWaiting, OPEN_TASKS_FRESH_MS, isTransientRateLimit429, throttleBannerContent, THROTTLE_BANNER_PREFIX, BLOCKED_BANNER_KINDS, CONTINUE_BANNER_KINDS } from "@codecast/shared/contracts";
import { describe, expect, test } from "bun:test";
// The REAL web helpers, imported so the cross-check below enforces the
// convex/web agreement instead of restating it.
import { isSessionStashed, isSessionKilled, isSessionDismissed } from "../../web/store/inboxStore";
import {
  isNoiseTitle,
  isOrphanOrSubagent,
  shouldShowInInbox,
  isViableInboxParent,
  isSessionIdle,
  nextAgentStatusOnAddMessages,
  isApiErrorBanner,
  classifyApiErrorBanner,
  CLIENT_ERROR_BANNER_PREFIX,
  apiErrorBatchAction,
  nextPendingApiError,
  newestSignificantMessage,
  isBannerTurn,
  isRealTurn,
  classifyWorkState,
  classifyRetirement,
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
// stashed / dismissed / killed were reported to `cast sessions` as one
// "dismissed" figure, hiding the difference that matters operationally: a
// stashed agent is still RUNNING, a dismissed one was torn down.
describe("classifyRetirement", () => {
  test("a live session is not retired", () => {
    expect(classifyRetirement(conv())).toBe(null);
  });

  test("stashed (agent alive) is its own state", () => {
    expect(classifyRetirement(conv({ inbox_stashed_at: 100 }))).toBe("stashed");
  });

  test("dismissed (agent torn down) is its own state", () => {
    expect(classifyRetirement(conv({ inbox_dismissed_at: 100 }))).toBe("dismissed");
  });

  test("killed is its own state", () => {
    expect(classifyRetirement(conv({ inbox_killed_at: 100 }))).toBe("killed");
  });

  // The precedence that makes the two kill surfaces agree. applyHideTransition
  // (cast kill, dismiss→kill) stamps BOTH fields; the killSession command stamps
  // the marker alone. Without killed-first, one user-visible state would be
  // reported under two different names depending on which surface did the kill.
  test("cast kill's two stamps still classify as killed, not dismissed", () => {
    expect(classifyRetirement(conv({ inbox_dismissed_at: 100, inbox_killed_at: 100 })))
      .toBe("killed");
  });

  test("the killSession command's lone marker classifies the same way", () => {
    expect(classifyRetirement(conv({ inbox_killed_at: 100 }))).toBe("killed");
  });

  test("killed outranks stashed too", () => {
    expect(classifyRetirement(conv({ inbox_stashed_at: 100, inbox_killed_at: 100 })))
      .toBe("killed");
  });

  // Dismiss outranks stash, matching isSessionStashed in the web's inboxStore
  // ("Dismiss wins: a stashed session that later gets dismissed renders in the
  // Dismissed bucket, never both"). The ordering is not arbitrary taste — a row
  // reported as "stashed" here and "dismissed" there would be exactly the
  // two-surfaces-disagree defect this classifier exists to remove. Dismiss is
  // also the stronger claim: the agent was torn down, so a surviving stash stamp
  // is stale history and "stashed" would assert a live agent there isn't one.
  test("a stashed row that was later dismissed is dismissed, matching the web", () => {
    expect(classifyRetirement(conv({ inbox_stashed_at: 100, inbox_dismissed_at: 200 })))
      .toBe("dismissed");
  });

  // Exactly one bucket per row is what keeps the three counts from double-counting.
  test("a row is never in two states at once", () => {
    const both = conv({ inbox_dismissed_at: 100, inbox_stashed_at: 100, inbox_killed_at: 100 });
    const state = classifyRetirement(both);
    expect(["killed", "dismissed", "stashed"]).toContain(state!);
    expect(state).toBe("killed");
  });
});

// Enforces the scope of the web-agreement claim in classifyRetirement's comment
// rather than leaving it asserted. Imports the REAL web helpers, so a change to
// either side's rule breaks this instead of drifting silently.
//
// The two models differ by construction: the web carries a bucket
// (active | dismissed | stashed) PLUS an orthogonal isSessionKilled flag, while
// classifyRetirement is a single-axis partition because it feeds counts. They
// agree on every UNKILLED combination — that is the part that must not drift —
// and diverge on every killed one, which is intended and pinned below so a
// future reader meets it as a documented design choice, not a surprise.
describe("classifyRetirement vs the web's bucketing", () => {
  // Every rule here comes from the web helpers — none is re-implemented, or the
  // cross-check would silently stop covering whichever one was copied.
  const webBucket = (c: any): "dismissed" | "stashed" | null =>
    isSessionStashed(c) ? "stashed" : isSessionDismissed(c) ? "dismissed" : null;

  const STAMPS = [
    { inbox_dismissed_at: undefined, inbox_stashed_at: undefined },
    { inbox_dismissed_at: 100, inbox_stashed_at: undefined },
    { inbox_dismissed_at: undefined, inbox_stashed_at: 100 },
    { inbox_dismissed_at: 100, inbox_stashed_at: 100 },
  ];

  test("agrees with the web bucket for every UNKILLED stamp combination", () => {
    for (const stamps of STAMPS) {
      const row = conv(stamps as any);
      expect(isSessionKilled(row as any)).toBe(false);
      expect(classifyRetirement(row)).toBe(webBucket(row) as any);
    }
  });

  test("diverges on killed rows BY DESIGN — single axis here, two axes there", () => {
    for (const stamps of STAMPS) {
      const row = conv({ ...stamps, inbox_killed_at: 100 } as any);
      // Here: one answer, killed wins.
      expect(classifyRetirement(row)).toBe("killed");
      // There: the kill flag is orthogonal, so the bucket survives underneath.
      expect(isSessionKilled(row as any)).toBe(true);
    }
    // The concrete reachable case: stash a session, then kill it — killSession
    // stamps the marker alone and never clears inbox_stashed_at.
    const stashedThenKilled = conv({ inbox_stashed_at: 100, inbox_killed_at: 200 });
    expect(classifyRetirement(stashedThenKilled)).toBe("killed");
    expect(webBucket(stashedThenKilled)).toBe("stashed");
  });
});

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
    // Org-billed form (2026-09-03): an apostrophe between "your" and "limit".
    // Unrecognized, the park is never stamped, so a resume re-sources the
    // spent account's setup-token instead of the account the device moved to.
    expect(isApiErrorBanner("You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 7:40pm (America/New_York)")).toBe(true);
    expect(isApiErrorBanner("You’ve hit your weekly limit · resets 3am (America/New_York)")).toBe(true); // curly apostrophe
    expect(isApiErrorBanner("Claude usage limit reached. Your limit will reset at 3am (America/New_York).")).toBe(true);
    // Sentence-shaped spend-limit variant, admitted by its /usage-credits tail.
    expect(isApiErrorBanner("You've hit your monthly spend limit. Run /usage-credits to manage your limit and keep using Fable 5 or switch models to continue this chat.")).toBe(true);
    // "reached" variant with a model-name limit, same /usage-credits tail.
    expect(isApiErrorBanner("You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.")).toBe(true);
    expect(classifyApiErrorBanner("You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.")).toBe("limit");
  });

  test("a burst-throttle 429 the parser rewrote is kind throttle, not limit", () => {
    // Claude Code renders the provider's transient 429 with the weekly-limit
    // words; the daemon's parser rewrites it into the marked form from the
    // entry's errorDetails (2026-09-04: two account rotations chased a burst).
    const raw = "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";
    const details = `429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."},"request_id":"req_011CeiuuRePE7mL29UARczgV"}`;
    expect(isTransientRateLimit429(429, details)).toBe(true);
    expect(isTransientRateLimit429(429, `429 {"type":"error","error":{"type":"exceeded_limit","message":"weekly"}}`)).toBe(false);
    expect(isTransientRateLimit429(500, details)).toBe(false);
    expect(isTransientRateLimit429(429, undefined)).toBe(false);
    const banner = throttleBannerContent(raw);
    expect(banner.startsWith(THROTTLE_BANNER_PREFIX)).toBe(true);
    expect(banner).toContain("Claude Code showed: You've reached your Fable limit.");
    expect(banner.includes("\n")).toBe(false);
    expect(classifyApiErrorBanner(banner)).toBe("throttle");
    expect(BLOCKED_BANNER_KINDS.has("throttle")).toBe(true);
    expect(CONTINUE_BANNER_KINDS).toContain("throttle");
    // The untouched CLI words still read as a limit park — a real weekly
    // exhaustion writes the same line and no transient errorDetails.
    expect(classifyApiErrorBanner(raw)).toBe("limit");
    // Prose that merely opens with the words is not a banner.
    expect(classifyApiErrorBanner("Rate limited · here is why\nand more prose")).toBe(null);
  });

  test("does not flag prose that merely opens like a limit banner", () => {
    // Real assistant sentences seen in transcripts — same prefix, but they
    // continue as prose instead of the single-line `· detail` banner shape.
    expect(isApiErrorBanner("You've hit your usage limit on the free plan, so video generation is paused right here.")).toBe(false);
    expect(isApiErrorBanner("You've hit your trial usage limit. I can activate your full Pro subscription right now.")).toBe(false);
    expect(isApiErrorBanner("You've hit your usage limit — the ad is fully planned, cast, and ready to generate.")).toBe(false);
    expect(isApiErrorBanner("You've hit your session limit · resets 11:30pm\nWait, actually let me reconsider the approach here.")).toBe(false);
    // Sentence continuation without the /usage-credits tail stays prose.
    expect(isApiErrorBanner("You've hit your monthly spend limit. You could raise it in settings or wait for the reset.")).toBe(false);
    expect(isApiErrorBanner("You've reached your usage limit, so I'll pause the generation work here.")).toBe(false);
  });

  test("classifies marked opencode/pi provider errors (auth vs generic), and never a normal reply", () => {
    const P = CLIENT_ERROR_BANNER_PREFIX;
    // Real opencode error texts → auth (the user fixes an account/setup then retries).
    expect(classifyApiErrorBanner(`${P} Google Vertex location setting is missing. Pass it using the 'location' parameter or the GOOGLE_VERTEX_LOCATION environment variable.`)).toBe("auth");
    expect(classifyApiErrorBanner(`${P} No API key found for provider anthropic`)).toBe("auth");
    expect(classifyApiErrorBanner(`${P} 401 Unauthorized: invalid api key`)).toBe("auth");
    // pi's pane auth prompt, once emitted as a marked message.
    expect(classifyApiErrorBanner(`${P} Authentication failed for anthropic. Run /login anthropic.`)).toBe("auth");
    // A non-auth provider failure → generic "error" (shown, not actioned).
    expect(classifyApiErrorBanner(`${P} The model returned an unexpected empty response.`)).toBe("error");
    // The marker gates it: the SAME provider-key wording WITHOUT the marker (a real
    // opencode/pi assistant reply that merely discusses keys) is never a banner.
    expect(classifyApiErrorBanner("You'll need to set your anthropic api key first, then re-run.")).toBe(null);
    expect(classifyApiErrorBanner("Here's how authentication works with the /login command.")).toBe(null);
  });

  test("classifies banner kinds for the badge label", () => {
    expect(classifyApiErrorBanner("Please run /login · API Error: 401 Invalid authentication credentials")).toBe("auth");
    expect(classifyApiErrorBanner("You've hit your session limit · resets 11:30pm (America/New_York)")).toBe("limit");
    expect(classifyApiErrorBanner("You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 7:40pm (America/New_York)")).toBe("limit");
    expect(classifyApiErrorBanner("You've hit your monthly spend limit. Run /usage-credits to manage your limit and keep using Fable 5 or switch models to continue this chat.")).toBe("limit");
    expect(classifyApiErrorBanner("API Error: 529 Overloaded")).toBe("error");
    expect(classifyApiErrorBanner("All good, deploy finished.")).toBe(null);
  });

  test("statusless connection drops classify as connection, retryable statuses stay error", () => {
    // No status code = the provider never replied; the turn died at the
    // prompt and a plain continue resumes it — the blocked/revive set.
    expect(classifyApiErrorBanner("API Error: Connection closed mid-response. The response above may be incomplete.")).toBe("connection");
    expect(classifyApiErrorBanner("API Error: Connection error.")).toBe("connection");
    expect(classifyApiErrorBanner("API Error: Request timed out.")).toBe("connection");
    // Statuses the CLI retries on its own (408/409/429/5xx) stay out of the
    // blocked set — badging them paints a mid-retry session as blocked.
    expect(classifyApiErrorBanner("API Error: 500 Internal server error")).toBe("error");
    expect(classifyApiErrorBanner('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe("error");
    expect(classifyApiErrorBanner("API Error: 429 Too many requests")).toBe("error");
    expect(classifyApiErrorBanner("API Error: 408 Request timeout")).toBe("error");
  });

  test("a 429 carrying the subscription exceeded_limit payload is a limit park, not a transient", () => {
    // 2026-08-15: the raw refusal for a pegged 5h window while 7d sat at 39% —
    // longer than the prose cap, and retrying it until resets_at is pure waste.
    const payload =
      'API Error: 429 {"type":"exceeded_limit","resetsAt":1786814400,"remaining":null,"perModelLimit":false,' +
      '"representativeClaim":"five_hour","overageDisabledReason":"org_level_disabled","overageInUse":false,' +
      '"windows":{"5h":{"status":"exceeded_limit","resets_at":1786814400,"utilization":1.0,"surpassed_threshold":1.0},' +
      '"7d":{"status":"within_limit","resets_at":1786852800,"utilization":0.39}},' +
      '"resolved":{"status":"exceeded","limit":{"kind":"session","group":"session","percent":100,"severity":"critical",' +
      '"resets_at":"2026-08-15T17:20:00+00:00","scope":null,"is_active":true},"spend":null,"disabled_reason":"org_level_disabled"}}';
    expect(payload.length).toBeGreaterThan(400);
    expect(classifyApiErrorBanner(payload)).toBe("limit");
    // The marker must be the payload's own quoted key: a bare mention in a
    // transient 429 body, another status, or multi-line prose about the
    // payload never promotes to limit.
    expect(classifyApiErrorBanner("API Error: 429 exceeded_limit rate limited, retry later")).toBe("error");
    expect(classifyApiErrorBanner('API Error: 529 {"type":"exceeded_limit"}')).toBe("error");
    expect(classifyApiErrorBanner('API Error: 429 {"type":"exceeded_limit"}\nSo the account is rationed — here is what I found:')).toBe("error");
    expect(classifyApiErrorBanner('The tool failed with {"type":"exceeded_limit"} — the account hit its five-hour window.')).toBe(null);
  });

  test("terminal statuses the CLI won't retry classify as fatal (blocked set), 401/403 as auth", () => {
    // A 400 kills the turn — the CLI gives up and the session sits parked at
    // the prompt exactly like a connection drop; continue retries it.
    expect(classifyApiErrorBanner('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}')).toBe("fatal");
    expect(classifyApiErrorBanner("API Error: 404 Not found")).toBe("fatal");
    expect(classifyApiErrorBanner("API Error: 413 Payload too large")).toBe("fatal");
    // A bare 401/403 is the provider refusing the credential — /login is the
    // cure, so it routes to the auth card even without the "/login" lead-in.
    expect(classifyApiErrorBanner("API Error: 401 Invalid bearer token")).toBe("auth");
    expect(classifyApiErrorBanner("API Error: 403 Forbidden")).toBe("auth");
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

describe("nextPendingApiError", () => {
  test("a banner as the newest message parks the session", () => {
    expect(nextPendingApiError({ newestIsBanner: true, batchHasRealTurn: false, conversationPending: false })).toBe(true);
  });

  test("a real turn releases a parked session", () => {
    expect(nextPendingApiError({ newestIsBanner: false, batchHasRealTurn: true, conversationPending: true })).toBe(false);
  });

  test("a system notice after a banner keeps the session parked", () => {
    // e.g. "Remote Control disconnected" landing after "Usage limit reached":
    // not a turn, so the block did not lift and the card must not read resolved.
    expect(nextPendingApiError({ newestIsBanner: false, batchHasRealTurn: false, conversationPending: true })).toBe(true);
  });

  test("a system notice on an unparked session leaves it unparked", () => {
    expect(nextPendingApiError({ newestIsBanner: false, batchHasRealTurn: false, conversationPending: false })).toBe(false);
  });
});

describe("newestSignificantMessage", () => {
  type M = { role: string; content: string; timestamp: number };
  const BANNER = "You've hit your session limit · resets 2:10am (America/New_York)";

  test("a system notice newer than the banner does not outrank it", () => {
    // The daemon's retry flush: older tool results, the limit banner, then
    // "Remote Control disconnected" — all in one batch. The banner must win.
    const batch: M[] = [
      { role: "user", content: "tool result", timestamp: 100 },
      { role: "assistant", content: BANNER, timestamp: 200 },
      { role: "system", content: "Remote Control disconnected", timestamp: 260 },
    ];
    const newest = newestSignificantMessage(batch);
    expect(newest?.timestamp).toBe(200);
    expect(newest && isBannerTurn(newest)).toBe(true);
  });

  test("a real turn newer than the banner outranks it", () => {
    const batch: M[] = [
      { role: "assistant", content: BANNER, timestamp: 200 },
      { role: "user", content: "continue", timestamp: 300 },
    ];
    expect(newestSignificantMessage(batch)?.timestamp).toBe(300);
  });

  test("a batch of only notices and empty rows has no significant row", () => {
    const batch: M[] = [
      { role: "system", content: "Remote Control disconnected", timestamp: 260 },
      { role: "user", content: "", timestamp: 270 },
    ];
    expect(newestSignificantMessage(batch)).toBeUndefined();
  });

  test("ties keep the later row", () => {
    const batch: M[] = [
      { role: "user", content: "a", timestamp: 100 },
      { role: "user", content: "b", timestamp: 100 },
    ];
    expect(newestSignificantMessage(batch)?.content).toBe("b");
  });
});

describe("isRealTurn", () => {
  test("assistant text, tool calls, user text, tool results and images are turns", () => {
    expect(isRealTurn({ role: "assistant", content: "hi" })).toBe(true);
    expect(isRealTurn({ role: "assistant", content: "", tool_calls: [{}] })).toBe(true);
    expect(isRealTurn({ role: "user", content: "go" })).toBe(true);
    expect(isRealTurn({ role: "user", tool_results: [{}] })).toBe(true);
    expect(isRealTurn({ role: "user", images: [{}] })).toBe(true);
  });

  test("banners, system notices and empty rows are not turns", () => {
    expect(isRealTurn({ role: "assistant", content: "You've hit your session limit" })).toBe(false);
    expect(isRealTurn({ role: "system", content: "Remote Control disconnected" })).toBe(false);
    expect(isRealTurn({ role: "user", content: "  " })).toBe(false);
  });
  test("the CLI's synthetic no-response stub is not a turn", () => {
    expect(isRealTurn({ role: "assistant", content: "No response requested." })).toBe(false);
    expect(isRealTurn({ role: "assistant", content: "  No response requested.\n" })).toBe(false);
    // A real reply that happens to start the same way still counts.
    expect(isRealTurn({ role: "assistant", content: "No response requested. Moving on to the next step." })).toBe(true);
  });
  test("a limit banner followed by the resume hook's stub keeps the session parked", () => {
    // What the parked transcript holds after the hook pokes it: banner, then
    // the injected "Continue" meta prompt (skipped by the parser), then the
    // synthetic stub at the same timestamp, then a Remote Control notice.
    const batch = [
      { role: "assistant", content: "You've hit your session limit · resets 10:30pm (America/New_York)", timestamp: 100 },
      { role: "assistant", content: "No response requested.", timestamp: 170 },
      { role: "system", content: "Remote Control disconnected — Claude.ai login was rejected", timestamp: 200 },
    ];
    const newest = newestSignificantMessage(batch);
    expect(newest?.timestamp).toBe(100);
    expect(nextPendingApiError({
      newestIsBanner: newest != null && isBannerTurn(newest),
      batchHasRealTurn: batch.some(isRealTurn),
      conversationPending: false,
    })).toBe(true);
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

  test("waiting (turn ended, background task open) files as DORMANT once settled", () => {
    // The daemon reports "waiting" when a turn ended with a live run_in_background
    // command or Monitor — the harness will re-invoke the agent, so the ball is
    // NOT in the user's court (never NEEDS INPUT) — but the agent is not producing
    // either, so it is parked, not WORKING: it must not inflate the "N agents
    // running" count.
    expect(classifyWorkState(wsi({ agentStatus: "waiting", isIdle: true }))).toBe("dormant");
    // Mid-grace right after the turn (isIdle not yet settled) it still reads as
    // in flight, like any settle.
    expect(classifyWorkState(wsi({ agentStatus: "waiting", isIdle: false }))).toBe("working");
  });

  test("declared settle verdicts: dormant / done are the agent's own answer to who acts next", () => {
    expect(classifyWorkState(wsi({ agentStatus: "dormant", isIdle: true }))).toBe("dormant");
    expect(classifyWorkState(wsi({ agentStatus: "done", isIdle: true }))).toBe("done");
    // Blank sessions never rest anywhere.
    expect(classifyWorkState(wsi({ agentStatus: "done", isIdle: true, messageCount: 0 }))).toBe("idle");
  });

  test("hard blocks outrank every rest verdict", () => {
    expect(classifyWorkState(wsi({ agentStatus: "dormant", isIdle: true, awaitingInput: true }))).toBe("needs_input");
    expect(classifyWorkState(wsi({ agentStatus: "done", isIdle: true, isUnresponsive: true }))).toBe("needs_input");
    expect(classifyWorkState(wsi({ isIdle: true, userDormant: true, awaitingInput: true }))).toBe("needs_input");
    expect(classifyWorkState(wsi({ isIdle: true, armedTriggerHome: true, isUnresponsive: true }))).toBe("needs_input");
    // A killed row is retired, whatever it declared.
    expect(classifyWorkState(wsi({ killed: true, agentStatus: "dormant", isIdle: true }))).toBe("idle");
  });

  test("structural + user dormancy: an armed inject trigger's home, or the user's park stamp", () => {
    expect(classifyWorkState(wsi({ isIdle: true, armedTriggerHome: true }))).toBe("dormant");
    expect(classifyWorkState(wsi({ isIdle: true, userDormant: true }))).toBe("dormant");
    // Dormant beats done: a session that both delivered and parked is parked.
    expect(classifyWorkState(wsi({ agentStatus: "done", isIdle: true, armedTriggerHome: true }))).toBe("dormant");
    // …but a wake in flight is working, whatever the home's standing state.
    expect(classifyWorkState(wsi({ isIdle: false, hasPending: true, armedTriggerHome: true }))).toBe("working");
  });

  test("armed ONCE inject trigger: demotes only a done rest to dormant", () => {
    // Delivered + a named wake = parked, through every door done arrives by:
    // the daemon-carried declaration, the row's own pinned declaration with no
    // daemon status, and the settle classifier's verdict.
    expect(classifyWorkState(wsi({ agentStatus: "done", isIdle: true, armedOnceTriggerHome: true }))).toBe("dormant");
    expect(classifyWorkState(wsi({ isIdle: true, declaredStatus: "done", armedOnceTriggerHome: true }))).toBe("dormant");
    expect(classifyWorkState(wsi({ agentStatus: "idle", isIdle: true, settleVerdict: "done", armedOnceTriggerHome: true }))).toBe("dormant");
    // A reminder never hides an open ask: unclassified settles, blocked pins,
    // and hard blocks all keep the human's claim.
    expect(classifyWorkState(wsi({ isIdle: true, armedOnceTriggerHome: true }))).toBe("needs_input");
    expect(classifyWorkState(wsi({ isIdle: true, declaredStatus: "blocked", armedOnceTriggerHome: true }))).toBe("needs_input");
    expect(classifyWorkState(wsi({ agentStatus: "done", isIdle: true, isUnresponsive: true, armedOnceTriggerHome: true }))).toBe("needs_input");
    // …and a wake in flight is working, same as standing homes.
    expect(classifyWorkState(wsi({ isIdle: false, hasPending: true, armedOnceTriggerHome: true }))).toBe("working");
  });

  test("a blocked pin outranks the classifier's soft verdict", () => {
    // The pin is the agent's explicit claim on the human (it un-stashes, see
    // setThreadState); a model reading prose never softens it to done.
    expect(classifyWorkState(wsi({ agentStatus: "idle", isIdle: true, declaredStatus: "blocked", settleVerdict: "done" }))).toBe("needs_input");
    expect(classifyWorkState(wsi({ isIdle: true, declaredStatus: "blocked", settleVerdict: "done" }))).toBe("needs_input");
    // …but the agent's own next declaration overrides its old pin.
    expect(classifyWorkState(wsi({ agentStatus: "done", isIdle: true, declaredStatus: "blocked" }))).toBe("done");
  });

  test("the settle classifier speaks only for an UNDECLARED settle", () => {
    expect(classifyWorkState(wsi({ isIdle: true, settleVerdict: "done" }))).toBe("done");
    // The classifier never parks a session: dormancy needs a verifiable wake, so
    // a stored "dormant" verdict (pre-rule rows) is ignored.
    expect(classifyWorkState(wsi({ agentStatus: "idle", isIdle: true, settleVerdict: "dormant" }))).toBe("needs_input");
    expect(classifyWorkState(wsi({ isIdle: true, settleVerdict: "needs_input" }))).toBe("needs_input");
    // A declaration always outranks it.
    expect(classifyWorkState(wsi({ agentStatus: "dormant", isIdle: true, settleVerdict: "done" }))).toBe("dormant");
    expect(classifyWorkState(wsi({ agentStatus: "done", isIdle: true, settleVerdict: "needs_input" }))).toBe("done");
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
    // matches; "idle" is reserved for blank (or killed) sessions.
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

  // A killed row is triaged — the user retired it. It used to read as "working"
  // off a stale has_pending_messages flag (a message queued before the kill that
  // outlived it) or off an agent_status from a worker a daemon bug revived, so
  // the inbox showed a dead session busily working. Kill outranks all of it.
  test("a KILLED row never classifies as working, whatever stale flags it carries", () => {
    expect(classifyWorkState(wsi({ killed: true, hasPending: true }))).toBe("idle");
    expect(classifyWorkState(wsi({ killed: true, agentStatus: "working" }))).toBe("idle");
    expect(classifyWorkState(wsi({ killed: true, isIdle: false }))).toBe("idle");
    // …and it stops demanding attention too: the user already dealt with it.
    expect(classifyWorkState(wsi({ killed: true, isIdle: true }))).toBe("idle");
    expect(classifyWorkState(wsi({ killed: true, awaitingInput: true }))).toBe("idle");
    // A revived session clears inbox_killed_at (pendingMessages.enqueue), so an
    // un-killed row classifies normally again.
    expect(classifyWorkState(wsi({ killed: false, hasPending: true }))).toBe("working");
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
    // "waiting" is the settle verdict of a finished turn parked on live
    // background work, so the alias follows the agent status into dormant.
    expect(normalizeWorkStateFilter("waiting")).toBe("dormant");
    expect(normalizeWorkStateFilter("parked")).toBe("dormant");
    expect(normalizeWorkStateFilter("done")).toBe("done");
    expect(normalizeWorkStateFilter("delivered")).toBe("done");
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

  test("a VERIFIED waiting (daemon-checked open tasks, fresh report) skips the quiet-time decay", () => {
    // Unverified: a transcript guess decays like an active status.
    expect(trustedAgentStatus("waiting", NOW - STATUS_TRUST_TTL_MS, NOW, true)).toBe("idle");
    // Verified: a five-hour build poll stays parked.
    expect(trustedAgentStatus("waiting", NOW - 5 * 60 * 60 * 1000, NOW, true, true)).toBe("waiting");
    // …but a dead daemon still coerces it — nobody is watching the shell now.
    expect(trustedAgentStatus("waiting", NOW - 5 * 60 * 60 * 1000, NOW, false, true)).toBe("stopped");
    // The vouch is specific to "waiting": an active status decays regardless.
    expect(trustedAgentStatus("working", NOW - STATUS_TRUST_TTL_MS, NOW, true, true)).toBe("idle");
  });

  test("openTasksVouchForWaiting: fresh + non-empty only", () => {
    expect(openTasksVouchForWaiting(NOW - 60_000, 1, NOW)).toBe(true);
    expect(openTasksVouchForWaiting(NOW - 60_000, 0, NOW)).toBe(false);
    expect(openTasksVouchForWaiting(NOW - OPEN_TASKS_FRESH_MS, 1, NOW)).toBe(false);
    expect(openTasksVouchForWaiting(null, 1, NOW)).toBe(false);
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
