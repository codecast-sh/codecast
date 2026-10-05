import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { MERGE_AUTHORITY_ID, mergeAllowance, performSetLineMerge, prUrlFromEvidence, recordMergeCore } from "./orgLineMerge";
import { lineOfRole } from "./orgRoles";

// The line's merge step on the server (the-line.md L12): the allowance read
// from the role row, the switch a person flips, and the record after a merge.

const HOST = "u".repeat(31) + "h";
const TEAM = "teams_acme" as any;
const ROLE = "org_roles_growth";
const STANDING = "conversations_standing";
const NOW = Date.now();
const DAY = 86_400_000;

const grant = (over: Record<string, any> = {}) => ({ id: MERGE_AUTHORITY_ID, kind: "write", label: "Merge", limit: { per_day: 2 }, granted_by: HOST, granted_at: NOW - DAY, ...over });

function world(role: Record<string, any> = {}, extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: HOST, name: "Host", email: "host@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: HOST, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    org_roles: [{
      _id: ROLE, short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: HOST, name: "Growth lead", handle: "growth",
      scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: HOST }, status: "active", trust: "direct", anchor_id: "anchors_growth",
      created_by: HOST, created_at: 1, updated_at: 1, ...role,
    }],
    anchors: [{ _id: "anchors_growth", team_id: TEAM, bot_user_id: "users_bot", host_user_id: HOST, conversation_id: STANDING, project_path: "/srv/growth", status: "active" }],
    conversations: [
      { _id: STANDING, session_id: "standing", user_id: HOST, team_id: TEAM, status: "active", title: "Growth lead", agent_type: "claude_code", message_count: 1, standing_role_id: ROLE, anchor_id: "anchors_growth", updated_at: NOW },
      { _id: "conversations_hand", session_id: "hand", user_id: HOST, team_id: TEAM, status: "active", title: "Implement", agent_type: "claude_code", message_count: 1, org_role_id: ROLE, updated_at: NOW },
    ],
    tasks: [{ _id: "tasks_1", short_id: "ct-7", title: "Add the thing", status: "done", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, verification_evidence: "Done.\n\nPR: https://github.com/o/r/pull/5", created_at: 1, updated_at: 1 }],
    workflow_runs: [{ _id: "workflow_runs_1", user_id: HOST, task_id: "tasks_1", spawner_conversation_id: STANDING, primary_conversation_id: "conversations_hand", status: "running", created_at: NOW, updated_at: NOW }],
    task_comments: [], pending_messages: [], org_role_history: [], org_changes: [], docs: [], counters: [], thread_reads: [], entity_subscriptions: [],
    ...extra,
  };
  const db = makeFakeDb(tables);
  const ctx: any = { db, scheduler: { runAfter: async () => {} }, auth: { getUserIdentity: async () => ({ subject: HOST }) } };
  return { ctx, tables, role: () => tables.org_roles[0] };
}

describe("mergeAllowance", () => {
  test("off by default; on needs a live merge grant; the daily limit counts merges only", () => {
    expect(mergeAllowance({}, NOW)).toMatchObject({ on: false, allowed: false, reason: expect.stringContaining("merge is off") });
    expect(mergeAllowance({ line_merge: true }, NOW)).toMatchObject({ allowed: false, reason: "the role holds no merge authority" });
    expect(mergeAllowance({ line_merge: true, authority: [grant({ expires_at: NOW - 1 })] }, NOW)).toMatchObject({ allowed: false, reason: "the role's merge authority has expired" });
    expect(mergeAllowance({ line_merge: true, authority: [grant()] }, NOW)).toMatchObject({ allowed: true, reason: null, used: 0, limit: 2 });
    const today = new Date(NOW).toISOString().slice(0, 10);
    expect(mergeAllowance({ line_merge: true, authority: [grant()], counters: { day: today, hands: 5, wakes: 0, tokens: 0, merges: 2 } }, NOW)).toMatchObject({ allowed: false, used: 2, limit: 2, reason: "the role has reached its daily merge limit (2 of 2)" });
    // Yesterday's merges do not count today.
    expect(mergeAllowance({ line_merge: true, authority: [grant()], counters: { day: "2020-01-01", hands: 0, wakes: 0, tokens: 0, merges: 2 } }, NOW).allowed).toBe(true);
    expect(mergeAllowance({ line_merge: true, authority: [grant()], status: "paused" }, NOW).reason).toBe("the role is paused");
    // A grant with no per_day limit allows without counting a cap.
    expect(mergeAllowance({ line_merge: true, authority: [grant({ limit: undefined })] }, NOW)).toMatchObject({ allowed: true, limit: null });
  });

  test("the PR a handoff named in its evidence", () => {
    expect(prUrlFromEvidence("Done.\n\nPR: https://github.com/o/r/pull/5")).toBe("https://github.com/o/r/pull/5");
    expect(prUrlFromEvidence("no pr here")).toBeNull();
  });
});

describe("performSetLineMerge", () => {
  test("on with --per-day writes the merge grant through the authority path and flips the switch; off keeps the grant", async () => {
    const { ctx, tables, role } = world();
    await expect(performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: true, human_decision: "yes" })).rejects.toThrow("--per-day");
    const on = await performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: true, per_day: 3, human_decision: "yes" });
    expect(role().line_merge).toBe(true);
    expect(role().authority).toHaveLength(1);
    expect(role().authority[0]).toMatchObject({ id: "merge", kind: "write", limit: { per_day: 3 }, granted_by: HOST });
    expect(role().authority[0].expires_at).toBeGreaterThan(NOW + 80 * DAY);
    expect(on.merge).toMatchObject({ on: true, allowed: true, limit: 3, used: 0 });
    expect(tables.org_role_history.filter((h) => h.action === "line_merge").map((h) => [h.old_value, h.new_value])).toEqual([["false", "true"]]);
    expect((await lineOfRole(ctx, HOST as any, { role_id: "or-1" })).merge).toMatchObject({ on: true, limit: 3 });

    const off = await performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: false, human_decision: "yes" });
    expect(role().line_merge).toBeUndefined();
    expect(role().authority).toHaveLength(1);
    expect(off.merge.on).toBe(false);
    // A role already holding the grant turns on without a limit named.
    await performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: true, human_decision: "yes" });
    expect(role().line_merge).toBe(true);
  });

  test("an agent session may not flip it", async () => {
    const { ctx } = world();
    await expect(performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: true, per_day: 1, from_session: "standing" })).rejects.toThrow(/human only/);
  });
});

describe("recordMergeCore", () => {
  test("counts the merge for today, stamps the run, comments on the task as the role, and tells the role to report it", async () => {
    const { ctx, tables, role } = world({ line_merge: true, authority: [grant()] });
    const out = await recordMergeCore(ctx, HOST as any, { run_id: "workflow_runs_1", sha: "abc123def4567890", branch: "codecast/line-ct-7", into: "main", pr_url: "https://github.com/o/r/pull/5" }, NOW);
    expect(out).toMatchObject({ used: 1, limit: 2, over: false, reported: true });
    expect(role().counters).toMatchObject({ merges: 1 });
    expect(tables.workflow_runs[0].merge).toEqual({ sha: "abc123def4567890", branch: "codecast/line-ct-7", into: "main", at: NOW, pr_url: "https://github.com/o/r/pull/5" });
    const comment = tables.task_comments.find((c) => c.task_id === "tasks_1");
    expect(comment).toMatchObject({ author: "@growth", comment_type: "review" });
    expect(comment.text).toBe("merged codecast/line-ct-7 into main at abc123def4 (https://github.com/o/r/pull/5): merge 1 of 2 today");
    const told = tables.pending_messages.find((p) => p.conversation_id === STANDING);
    expect(String(told.content)).toContain("The line merged ct-7 (Add the thing) from codecast/line-ct-7 into main at abc123def4: merge 1 of 2 today");
    expect(String(told.content)).toContain("Report it in one line to the person you report to");
    // The second merge of the day fills the limit; the allowance then refuses the next.
    await recordMergeCore(ctx, HOST as any, { run_id: "workflow_runs_1", sha: "bbb", branch: "b2", into: "main" }, NOW + 1);
    expect(mergeAllowance(role(), NOW + 2)).toMatchObject({ allowed: false, used: 2 });
  });

  test("a run no role started has no authority to merge under until a person answers Ship", async () => {
    const { ctx, tables } = world();
    tables.workflow_runs[0].spawner_conversation_id = undefined;
    tables.conversations[1].org_role_id = undefined;
    await expect(recordMergeCore(ctx, HOST as any, { run_id: "workflow_runs_1", sha: "a", branch: "b", into: "main" })).rejects.toThrow("nothing authorizes the merge");

    // A role answering Ship is not a person's authorization.
    tables.session_decisions = [{ _id: "sd_1", status: "answered", answer_index: 0, options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }], answered_by: { kind: "role", id: ROLE } }];
    tables.workflow_runs[0].gate_decision_id = "sd_1";
    await expect(recordMergeCore(ctx, HOST as any, { run_id: "workflow_runs_1", sha: "a", branch: "b", into: "main" })).rejects.toThrow("nothing authorizes the merge");

    // A person's Ship authorizes it, records it on the run and the task, and counts against no role.
    tables.session_decisions[0].answered_by = { kind: "user", id: HOST };
    const out = await recordMergeCore(ctx, HOST as any, { run_id: "workflow_runs_1", sha: "abc123def456", branch: "codecast/line-ct-7", into: "main" });
    expect(out).toMatchObject({ used: 0, limit: null, over: false });
    expect(tables.workflow_runs[0].merge).toMatchObject({ sha: "abc123def456", into: "main" });
    expect(tables.task_comments.at(-1).text).toBe("merged codecast/line-ct-7 into main at abc123def4, shipped at the card");
    expect(tables.org_roles[0].counters?.merges ?? 0).toBe(0);
  });
});
