import { describe, expect, test } from "bun:test";
import {
  isNoiseTitle,
  isOrphanOrSubagent,
  shouldShowInInbox,
  isSessionIdle,
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

  test("killed + pinned → hide", () => {
    expect(shouldShowInInbox(conv({
      inbox_killed_at: 100,
      inbox_pinned_at: 200,
    }))).toBe(false);
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
