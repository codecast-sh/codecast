import { describe, expect, test } from "bun:test";
import {
  isNoiseTitle,
  isOrphanOrSubagent,
  shouldShowInIdle,
  shouldShowInDismissed,
  type ConversationDoc,
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
  test("is_subagent false is not orphan", () => {
    expect(isOrphanOrSubagent(conv({ is_subagent: false }))).toBe(false);
  });
});

describe("shouldShowInIdle", () => {
  test("active session with messages → show", () => {
    expect(shouldShowInIdle(conv())).toBe(true);
  });

  test("dismissed → hide", () => {
    expect(shouldShowInIdle(conv({ inbox_dismissed_at: 100 }))).toBe(false);
  });

  test("dismissed + pinned → show (pin overrides dismiss)", () => {
    expect(shouldShowInIdle(conv({
      inbox_dismissed_at: 100,
      inbox_pinned_at: 200,
    }))).toBe(true);
  });

  test("killed → hide", () => {
    expect(shouldShowInIdle(conv({ inbox_killed_at: 100 }))).toBe(false);
  });

  test("killed + pinned → hide (kill is terminal, pin does not override)", () => {
    expect(shouldShowInIdle(conv({
      inbox_killed_at: 100,
      inbox_pinned_at: 200,
    }))).toBe(false);
  });

  test("killed + dismissed → hide", () => {
    expect(shouldShowInIdle(conv({
      inbox_killed_at: 100,
      inbox_dismissed_at: 100,
    }))).toBe(false);
  });

  test("subagent → hide", () => {
    expect(shouldShowInIdle(conv({ is_subagent: true }))).toBe(false);
  });

  test("workflow sub → hide", () => {
    expect(shouldShowInIdle(conv({ is_workflow_sub: true }))).toBe(false);
  });

  test("orphan → hide", () => {
    expect(shouldShowInIdle(conv({ parent_conversation_id: "p1" as any }))).toBe(false);
  });

  test("completed + zero messages → hide", () => {
    expect(shouldShowInIdle(conv({ status: "completed", message_count: 0 }))).toBe(false);
  });

  test("active + zero messages → show (new session)", () => {
    expect(shouldShowInIdle(conv({ status: "active", message_count: 0 }))).toBe(true);
  });

  test("completed + has messages → show", () => {
    expect(shouldShowInIdle(conv({ status: "completed", message_count: 5 }))).toBe(true);
  });

  test("warmup title → hide", () => {
    expect(shouldShowInIdle(conv({ title: "warmup" }))).toBe(false);
  });

  test("noise-prefixed title → hide", () => {
    expect(shouldShowInIdle(conv({ title: "[Request interrupted]" }))).toBe(false);
  });

  // --- RESURRECTION INVARIANT ---
  // Before the absolute-flag fix, `inbox_dismissed_at >= updated_at` was the
  // dismiss check, so any writer of `updated_at` (addMessage, linkSessions,
  // heartbeat, plan-handoff, etc.) could resurrect a dismissed session. The
  // fix makes dismiss truthy-only; these tests lock the new behavior.

  test("RESURRECTION: dismissed stays dismissed when updated_at is bumped past it", () => {
    expect(shouldShowInIdle(conv({
      inbox_dismissed_at: 100,
      updated_at: 200,
    }))).toBe(false);
  });

  test("RESURRECTION: dismissed stays dismissed with huge updated_at gap", () => {
    expect(shouldShowInIdle(conv({
      inbox_dismissed_at: 1,
      updated_at: Date.now(),
    }))).toBe(false);
  });

  test("RESURRECTION: dismissed stays dismissed even when updated_at equals it", () => {
    expect(shouldShowInIdle(conv({
      inbox_dismissed_at: 100,
      updated_at: 100,
    }))).toBe(false);
  });
});

describe("shouldShowInDismissed", () => {
  test("not dismissed → hide", () => {
    expect(shouldShowInDismissed(conv())).toBe(false);
  });

  test("dismissed → show", () => {
    expect(shouldShowInDismissed(conv({ inbox_dismissed_at: 100 }))).toBe(true);
  });

  test("dismissed + killed → hide", () => {
    expect(shouldShowInDismissed(conv({
      inbox_dismissed_at: 100,
      inbox_killed_at: 200,
    }))).toBe(false);
  });

  test("dismissed + pinned → show (pin does not suppress from dismissed list)", () => {
    expect(shouldShowInDismissed(conv({
      inbox_dismissed_at: 100,
      inbox_pinned_at: 200,
    }))).toBe(true);
  });

  test("dismissed + subagent → hide", () => {
    expect(shouldShowInDismissed(conv({
      inbox_dismissed_at: 100,
      is_subagent: true,
    }))).toBe(false);
  });

  test("dismissed + workflow sub → hide", () => {
    expect(shouldShowInDismissed(conv({
      inbox_dismissed_at: 100,
      is_workflow_sub: true,
    }))).toBe(false);
  });

  test("dismissed + orphan → hide", () => {
    expect(shouldShowInDismissed(conv({
      inbox_dismissed_at: 100,
      parent_conversation_id: "p1" as any,
    }))).toBe(false);
  });

  test("dismissed + warmup title → hide", () => {
    expect(shouldShowInDismissed(conv({
      inbox_dismissed_at: 100,
      title: "warmup",
    }))).toBe(false);
  });

  test("dismissed + noise-prefixed title → hide", () => {
    expect(shouldShowInDismissed(conv({
      inbox_dismissed_at: 100,
      title: "[Using: gpt-4]",
    }))).toBe(false);
  });

  // --- RESURRECTION INVARIANT ---
  test("RESURRECTION: stays in dismissed list even when updated_at is far newer", () => {
    expect(shouldShowInDismissed(conv({
      inbox_dismissed_at: 100,
      updated_at: Date.now(),
    }))).toBe(true);
  });
});

// --- DISJOINTNESS / OVERLAP PROPERTIES ---
// These are not strict "both must be true" or "both must be false"
// assertions — the lists overlap intentionally for pinned-dismissed.
// Here we lock the documented exceptions.

describe("overlap semantics", () => {
  test("pinned-dismissed appears in BOTH lists (recoverability for pinned)", () => {
    const c = conv({ inbox_dismissed_at: 100, inbox_pinned_at: 200 });
    expect(shouldShowInIdle(c)).toBe(true);
    expect(shouldShowInDismissed(c)).toBe(true);
  });

  test("killed session is invisible in BOTH lists", () => {
    const c = conv({ inbox_killed_at: 100, inbox_dismissed_at: 100 });
    expect(shouldShowInIdle(c)).toBe(false);
    expect(shouldShowInDismissed(c)).toBe(false);
  });

  test("active session is in idle only", () => {
    const c = conv();
    expect(shouldShowInIdle(c)).toBe(true);
    expect(shouldShowInDismissed(c)).toBe(false);
  });

  test("dismissed-not-pinned is in dismissed only", () => {
    const c = conv({ inbox_dismissed_at: 100 });
    expect(shouldShowInIdle(c)).toBe(false);
    expect(shouldShowInDismissed(c)).toBe(true);
  });
});
