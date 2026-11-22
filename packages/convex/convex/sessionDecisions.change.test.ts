import { describe, expect, test } from "bun:test";
import { askCore, guardClientResolution, settleClientResolution } from "./sessionDecisions";
import { HOST, BOSS, NOW, seed, twoOptions } from "./testDecisions";

// Changing a settled answer (answerChangeable): which rows take a person's
// new answer on the dispatch rail, and what the settle hook records.
describe("changing a settled answer", () => {
  test("dispatch guard: a settled answer that only steered the agent takes a person's new answer, never a dismiss", () => {
    const patch = { status: "answered", answer_index: 1, resolved_at: 2, answer_revision: 1 };
    expect(guardClientResolution({ status: "answered", blocking: false, answered_by: { kind: "policy" } }, patch)).toEqual(patch);
    expect(guardClientResolution({ status: "answered", blocking: false, answered_by: { kind: "user" } }, patch)).toEqual(patch);
    expect(guardClientResolution({ status: "answered", blocking: true, answered_by: { kind: "user" } }, patch)).toEqual(patch);
    expect(guardClientResolution({ status: "answered", blocking: true, answered_by: { kind: "role" } }, patch)).toEqual(patch);
    expect(guardClientResolution({ status: "dismissed", blocking: true }, patch)).toEqual(patch);
    expect(guardClientResolution({ status: "answered", blocking: false, answered_by: { kind: "user" } }, { status: "dismissed", resolved_at: 2 })).toEqual({});
    expect(guardClientResolution({ status: "answered", blocking: false, workflow_run_id: "workflow_runs_1", answered_by: { kind: "user" } }, patch)).toEqual({});
    expect(guardClientResolution({ status: "answered", blocking: true, card: {} } as any, patch)).toEqual({});
    expect(guardClientResolution({ status: "answered", blocking: true, run: { state: "done" } } as any, patch)).toEqual({});
    expect(guardClientResolution({ status: "answered", blocking: true, silent: true } as any, patch)).toEqual({});
    expect(guardClientResolution({ status: "answered", blocking: true, category: "access" } as any, patch)).toEqual({});
    expect(guardClientResolution({ status: "withdrawn", blocking: false }, patch)).toEqual({});
    // A change names the next revision: a stale answer (no revision) or a second change racing the first is dropped.
    expect(guardClientResolution({ status: "answered", blocking: true }, { ...patch, answer_revision: undefined })).toEqual({});
    expect(guardClientResolution({ status: "answered", blocking: true, answer_revision: 1 }, patch)).toEqual({});
    expect(guardClientResolution({ status: "answered", blocking: true, answer_revision: 1 }, { ...patch, answer_revision: 2 })).toEqual({ ...patch, answer_revision: 2 });
  });

  test("changing a blocking answer keeps the replaced one and scores a granted role's answer as an override", async () => {
    const { ctx, tables } = seed();
    const a = await askCore(ctx, { userId: HOST }, { session_id: "sess-ask", question: "Q", options: twoOptions, context_md: "ctx", category: "approach" });
    const grant = await ctx.db.insert("decision_grants", { role_id: "org_roles_lead", category: "approach", scope_key: "k", granted_by: BOSS, granted_at: NOW, expires_at: NOW + 1e9, override_streak: 1 });
    await ctx.db.patch(a.id, { status: "answered", answer_index: 0, resolved_at: NOW, answered_by: { kind: "role", id: "org_roles_lead" }, grant_id: grant });
    const before = { ...tables.session_decisions[0] };
    await ctx.db.patch(a.id, { status: "answered", answer_index: 1, resolved_at: NOW + 5 });
    await settleClientResolution(ctx, before as any, { status: "answered", answer_index: 1 }, BOSS, NOW + 5);
    const row = tables.session_decisions[0];
    expect(row.answered_by).toEqual({ kind: "user", id: BOSS });
    expect(row.grant_id).toBeUndefined();
    expect(row.answer_history).toEqual([{ status: "answered", answer_index: 0, answered_by: { kind: "role", id: "org_roles_lead" }, resolved_at: NOW, replaced_at: NOW + 5, replaced_by: BOSS }]);
    expect(tables.decision_grants[0].revoked_at).toBe(NOW + 5);
  });

  test("a dismissed decision can still be answered, and the dismissal stays on record", async () => {
    const { ctx, tables } = seed();
    const a = await askCore(ctx, { userId: HOST }, { session_id: "sess-ask", question: "Q", options: twoOptions, context_md: "ctx", category: "approach" });
    await ctx.db.patch(a.id, { status: "dismissed", resolved_at: NOW, answered_by: { kind: "user", id: BOSS } });
    const before = { ...tables.session_decisions[0] };
    await ctx.db.patch(a.id, { status: "answered", answer_index: 1, resolved_at: NOW + 5 });
    await settleClientResolution(ctx, before as any, { status: "answered", answer_index: 1 }, BOSS, NOW + 5);
    expect(tables.session_decisions[0].answer_history?.[0]).toMatchObject({ status: "dismissed", replaced_by: BOSS });
    expect(tables.pending_messages).toHaveLength(0);
  });

  test("changing an advisory answer stamps who answered last and runs no side effects again", async () => {
    const { ctx, tables } = seed();
    const a = await askCore(ctx, { userId: HOST }, { session_id: "sess-ask", question: "Q", options: twoOptions, context_md: "ctx", category: "approach", blocking: false, default_option: 0 });
    await ctx.db.patch(a.id, { status: "answered", answer_index: 0, resolved_at: NOW, answered_by: { kind: "policy", id: "stack:x" } });
    const before = { ...tables.session_decisions[0] };
    await ctx.db.patch(a.id, { status: "answered", answer_index: 1, resolved_at: NOW + 5 });
    await settleClientResolution(ctx, before as any, { status: "answered", answer_index: 1 }, BOSS, NOW + 5);
    expect(tables.session_decisions[0].answered_by).toEqual({ kind: "user", id: BOSS });
    expect(tables.session_decisions[0].answer_index).toBe(1);
    expect(tables.pending_messages).toHaveLength(0);
  });
});
