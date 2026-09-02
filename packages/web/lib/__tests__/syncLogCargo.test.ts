import { describe, expect, test } from "bun:test";
import { ENRICH_TRIGGER_FIELDS, planCargoApply } from "../syncLogCargo";

// Pure adapter from raw log cargo to store row fields (sync-log-cargo E6/E7).

describe("planCargoApply — tasks/docs/plans/projects", () => {
  test("raw fields land as-is; unset passes through", () => {
    const p = planCargoApply("tasks", { patch: { title: "t", status: "done" }, unset: ["closed_at"] }, { _id: "t1" });
    expect(p.fields).toEqual({ title: "t", status: "done" });
    expect(p.unset).toEqual(["closed_at"]);
    expect(p.refetch).toBe(false);
  });
  test("partial cargo and enrichment triggers request a refetch, fields still apply", () => {
    expect(planCargoApply("tasks", { patch: { title: "x" }, partial: true }, {}).refetch).toBe(true);
    const p = planCargoApply("tasks", { patch: { plan_id: "p9" } }, {});
    expect(p.fields).toEqual({ plan_id: "p9" });
    expect(p.refetch).toBe(true);
    expect(ENRICH_TRIGGER_FIELDS.docs.has("plan_id")).toBe(true);
  });
  test("tasks: session_count derives from conversation_ids; last_comment_at (a joined comment) refetches", () => {
    expect(planCargoApply("tasks", { patch: { conversation_ids: ["a", "b"] } }, {}).fields.session_count).toBe(2);
    expect(planCargoApply("tasks", { patch: { updated_at: 5, last_comment_at: 5 } }, {}).refetch).toBe(true);
    expect(planCargoApply("tasks", { patch: { updated_at: 5, title: "t" } }, {}).refetch).toBe(false);
  });
  test("docs: an omitted content change refetches only for plan-mode docs (display_title derives from the body)", () => {
    expect(planCargoApply("docs", { patch: {}, omitted: ["content"] }, { source: "plan_mode" }).refetch).toBe(true);
    expect(planCargoApply("docs", { patch: {}, omitted: ["content"] }, { source: "manual" }).refetch).toBe(false);
  });
  test("docs/plans: team_id derives from workspace (the list channels stamp the effective team)", () => {
    expect(planCargoApply("docs", { patch: { workspace: "team:T" } }, {}).fields.team_id).toBe("T");
    const personal = planCargoApply("plans", { patch: { workspace: "user:u1" } }, {});
    expect(personal.fields.team_id).toBeUndefined();
    expect(personal.unset).toContain("team_id");
  });
});

describe("planCargoApply — sessions adapter", () => {
  test("fact fields are never written (the liveness overlay is the single writer)", () => {
    const p = planCargoApply("sessions", { patch: { title: "t", updated_at: 9, message_count: 3, agent_status: "working" } }, { updated_at: 1 });
    expect(p.fields).toEqual({ title: "t" });
  });
  test("renames and null normalization", () => {
    const p = planCargoApply("sessions", {
      patch: { has_pending_messages: true, unresolved_comment_count: 2, last_message_preview: "hi", loop_state: { status: "stopped" } },
      unset: ["subtitle"],
    }, {});
    expect(p.fields).toMatchObject({ has_pending: true, open_comment_threads: 2, last_user_message: "hi", loop_state: null, subtitle: null });
    expect(p.unset).toEqual([]); // sessions null instead of delete
  });
  test("derived twins recompute from the merged row with the shared helpers", () => {
    const existing = { updated_at: 100, inbox_dormant_at: null };
    let p = planCargoApply("sessions", { patch: { inbox_pinned_at: 5 } }, existing);
    expect(p.fields.is_pinned).toBe(true);
    p = planCargoApply("sessions", { patch: { inbox_pinned_at: null } }, existing);
    expect(p.fields.is_pinned).toBe(false);
    p = planCargoApply("sessions", { patch: { inbox_dormant_at: 200 } }, existing);
    expect(p.fields.is_dormant).toBe(true); // 200 >= updated_at 100
    p = planCargoApply("sessions", { patch: { inbox_dormant_at: 50 } }, existing);
    expect(p.fields.is_dormant).toBe(false);
    p = planCargoApply("sessions", { patch: { settle_verdict: "done", settle_verdict_at: 150 } }, existing);
    expect(p.fields.settle_verdict).toBe("done");
    p = planCargoApply("sessions", { patch: { settle_verdict: "done", settle_verdict_at: 50 } }, existing);
    expect(p.fields.settle_verdict).toBeNull();
    p = planCargoApply("sessions", { patch: { inbox_deferred_at: 150 } }, existing);
    expect(p.fields.is_deferred).toBe(true);
  });
  test("a status that byIds would omit forces the refetch that prunes it", () => {
    expect(planCargoApply("sessions", { patch: { status: "deleted" } }, {}).refetch).toBe(true);
    expect(planCargoApply("sessions", { patch: { status: "active" } }, {}).refetch).toBe(false);
    expect(planCargoApply("sessions", { patch: { status: "completed" } }, {}).refetch).toBe(false);
    expect(planCargoApply("sessions", { patch: { title: "x" } }, {}).refetch).toBe(false);
  });
});
