import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { MERGE_AUTHORITY_ID, checkMergeCore, mergeAllowance, performSetLineMerge, prUrlFromEvidence, recordMergeCore } from "./orgLineMerge";
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
    session_decisions: [], projects: [],
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

  test("an agent session may flip it", async () => {
    const { ctx, role } = world();
    await performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: true, per_day: 1, from_session: "standing" });
    expect(role().line_merge).toBe(true);
  });
});

// A run with no role behind it: no role's standing session spawned it, and its hand works for none.
function noRole() {
  const w = world();
  w.tables.workflow_runs[0].spawner_conversation_id = undefined;
  w.tables.conversations[1].org_role_id = undefined;
  return w;
}
const merged = { run_id: "workflow_runs_1", sha: "abc123def456", branch: "codecast/line-ct-7", into: "main" };
// A gate card on the task, answered Ship by the host unless the test says otherwise.
const card = (id: string, short: string, over: Record<string, any> = {}) => ({
  _id: id, short_id: short, task_id: "tasks_1", status: "answered", answer_index: 0, options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }],
  answered_by: { kind: "user", id: HOST }, created_at: NOW - DAY, resolved_at: NOW - DAY, ...over,
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
    expect(String(told.content)).toContain("The flow merged ct-7 (Add the thing) from codecast/line-ct-7 into main at abc123def4: merge 1 of 2 today");
    expect(String(told.content)).toContain("Report it in one line to the person you report to");
    // The second merge of the day fills the limit; the allowance then refuses the next.
    await recordMergeCore(ctx, HOST as any, { run_id: "workflow_runs_1", sha: "bbb", branch: "b2", into: "main" }, NOW + 1);
    expect(mergeAllowance(role(), NOW + 2)).toMatchObject({ allowed: false, used: 2 });
  });

  test("a run no role started merges on a person's Ship at its card, and a role's Ship is no person's", async () => {
    const { ctx, tables } = noRole();
    // It stopped at its gate and asked: a role answering Ship is not a person's authorization.
    tables.workflow_runs[0].gate_node_id = "decide__decide";
    tables.session_decisions.push(card("sd_1", "sd-1", { workflow_run_id: "workflow_runs_1", answered_by: { kind: "role", id: ROLE } }));
    tables.workflow_runs[0].gate_decision_id = "sd_1";
    await expect(recordMergeCore(ctx, HOST as any, merged)).rejects.toThrow("no person answered Ship on its card, so nothing authorizes the merge");

    // A person's Ship authorizes it, records who and why on the run and the task, and counts against no role.
    tables.session_decisions[0].answered_by = { kind: "user", id: HOST };
    const out = await recordMergeCore(ctx, HOST as any, merged);
    expect(out).toMatchObject({ used: 0, limit: null, over: false, authorized: { user_id: HOST, why: "ship on card sd-1" } });
    expect(tables.workflow_runs[0].merge).toMatchObject({ sha: "abc123def456", into: "main", authorized: { user_id: HOST, why: "ship on card sd-1" } });
    expect(tables.task_comments.at(-1).text).toBe("merged codecast/line-ct-7 into main at abc123def4: authorized by ship on card sd-1");
    expect(tables.org_roles[0].counters?.merges ?? 0).toBe(0);
  });

  test("a Ship on an earlier run's card authorizes a rerun of the task until a person answers otherwise on a later card", async () => {
    const { ctx, tables } = noRole();
    // Run 0 asked and a person answered Ship; this run (a rerun of the same task) asks nothing.
    tables.workflow_runs.unshift({ _id: "workflow_runs_0", user_id: HOST, task_id: "tasks_1", status: "failed", gate_decision_id: "sd_1", gate_node_id: "decide__decide", created_at: NOW - DAY, updated_at: NOW - DAY });
    tables.session_decisions.push(card("sd_1", "sd-1", { workflow_run_id: "workflow_runs_0", resolved_at: NOW - DAY }));
    expect(await checkMergeCore(ctx, HOST as any, "workflow_runs_1")).toMatchObject({ allowed: true, role: null, authorized: { user_id: HOST, why: "ship on earlier run's card sd-1" } });

    // A later card of the task answered Revise by a person revokes it, whichever run asked it.
    tables.session_decisions.push(card("sd_2", "sd-2", { workflow_run_id: "workflow_runs_0", answer_index: 1, resolved_at: NOW - 1000 }));
    await expect(checkMergeCore(ctx, HOST as any, "workflow_runs_1")).rejects.toThrow("a person answered Revise on sd-2, the task's newest answer, so nothing authorizes the merge");

    // This run then asks its own card: while it waits nothing merges, and a person's Ship on it authorizes the merge.
    tables.workflow_runs[1].gate_node_id = "decide__decide";
    tables.workflow_runs[1].gate_decision_id = "sd_3";
    tables.session_decisions.push(card("sd_3", "sd-3", { workflow_run_id: "workflow_runs_1", status: "pending", answer_index: undefined, answered_by: undefined, resolved_at: undefined }));
    await expect(checkMergeCore(ctx, HOST as any, "workflow_runs_1")).rejects.toThrow("its card sd-3 is still waiting on a person, so nothing authorizes the merge");
    Object.assign(tables.session_decisions[2], { status: "answered", answer_index: 0, answered_by: { kind: "user", id: HOST }, resolved_at: NOW });
    expect(await checkMergeCore(ctx, HOST as any, "workflow_runs_1")).toMatchObject({ allowed: true, authorized: { why: "ship on card sd-3" } });
  });

  test("a run its own graph cleared to land with no card merges under the person who started it", async () => {
    const { ctx, tables } = noRole();
    expect(await checkMergeCore(ctx, HOST as any, "workflow_runs_1")).toMatchObject({ allowed: true, role: null, authorized: { user_id: HOST, why: "cleared by the run's own graph, started by Host" } });
    const out = await recordMergeCore(ctx, HOST as any, merged);
    expect(out.authorized).toEqual({ user_id: HOST, why: "cleared by the run's own graph, started by Host" });
    expect(tables.task_comments.at(-1).text).toBe("merged codecast/line-ct-7 into main at abc123def4: authorized by cleared by the run's own graph, started by Host");
    expect(tables.org_roles[0].counters?.merges ?? 0).toBe(0);
  });

  test("a run that asked a card, or that nothing shows asked none, is not cleared", async () => {
    // It stopped at a gate whose card never posted, or whose card was withdrawn: it asked, and nobody said Ship.
    const gated = noRole();
    gated.tables.workflow_runs[0].gate_node_id = "decide__decide";
    await expect(checkMergeCore(gated.ctx, HOST as any, "workflow_runs_1")).rejects.toThrow("no person answered Ship on its card");
    const withdrawn = noRole();
    withdrawn.tables.session_decisions.push(card("sd_1", "sd-1", { workflow_run_id: "workflow_runs_1", status: "withdrawn", answer_index: undefined, answered_by: undefined }));
    await expect(checkMergeCore(withdrawn.ctx, HOST as any, "workflow_runs_1")).rejects.toThrow("no person answered Ship on its card");
    // A run with no task has no cards to read.
    const taskless = noRole();
    taskless.tables.workflow_runs[0].task_id = undefined;
    await expect(checkMergeCore(taskless.ctx, HOST as any, "workflow_runs_1")).rejects.toThrow("it has no task whose cards show it asked none");
    // An agent account is no person.
    const bot = noRole();
    bot.tables.users[0].is_bot = true;
    await expect(checkMergeCore(bot.ctx, HOST as any, "workflow_runs_1")).rejects.toThrow("an agent account started it");
  });

  test("a trial project's run never merges, cleared or shipped", async () => {
    const { ctx, tables } = noRole();
    tables.projects.push({ _id: "projects_trial", title: "Trial", user_id: HOST, line_trial: { since: 1, by: HOST } });
    tables.tasks[0].project_id = "projects_trial";
    expect(await checkMergeCore(ctx, HOST as any, "workflow_runs_1")).toMatchObject({ allowed: false, reason: "a trial project's run stops at the card: nothing merges" });
    tables.session_decisions.push(card("sd_1", "sd-1", { workflow_run_id: "workflow_runs_1" }));
    tables.workflow_runs[0].gate_decision_id = "sd_1";
    expect(await checkMergeCore(ctx, HOST as any, "workflow_runs_1")).toMatchObject({ allowed: false, reason: "a trial project's run stops at the card: nothing merges" });
  });
});

// The merge step on the measured rate (regret.md R7).
describe("merge on the rate", () => {
  const measured = (o: Partial<{ settled: number; regretted: number; partial: number; rate: number | null }> = {}) => ({ settled: 30, regretted: 2, partial: 4, rate: 28 / 30, ...o });
  const rateRole = { line_merge: true, authority: [grant()], line_merge_rate: { bar: 0.9, min: 20 } };

  test("merges while the rate holds its bar over the minimum, with the daily cap kept", () => {
    expect(mergeAllowance(rateRole, NOW, measured())).toMatchObject({ allowed: true, mode: "rate", bar: { bar: 0.9, min: 20 } });
    expect(mergeAllowance(rateRole, NOW, measured({ settled: 12, rate: 1 }))).toMatchObject({ allowed: false, reason: "only 12 of the 20 finished changes the rate needs" });
    expect(mergeAllowance(rateRole, NOW, measured({ rate: 0.8 }))).toMatchObject({ allowed: false, reason: "the role's regret-free rate is 80%, under its bar of 90%" });
    expect(mergeAllowance(rateRole, NOW, null)).toMatchObject({ allowed: false, reason: "the role's regret-free rate could not be read" });
    const today = new Date(NOW).toISOString().slice(0, 10);
    expect(mergeAllowance({ ...rateRole, counters: { day: today, hands: 0, wakes: 0, tokens: 0, merges: 2 } }, NOW, measured()).reason).toBe("the role has reached its daily merge limit (2 of 2)");
    // The default stays the count: no bar, no rate read.
    expect(mergeAllowance({ line_merge: true, authority: [grant()] }, NOW)).toMatchObject({ allowed: true, mode: "count", bar: null, measured: null });
  });

  test("a person sets and clears it from the settings; a token or a session may not", async () => {
    const { ctx, tables, role } = world({ line_merge: true, authority: [grant()] });
    await expect(performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: true, rate: { bar: 0.9, min: 20 }, api_token: "t" })).rejects.toThrow("Only a person");
    await expect(performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: true, rate: { bar: 0.9, min: 20 }, from_session: "standing" })).rejects.toThrow("Only a person");
    await expect(performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: true, rate: { bar: 1.5, min: 20 } })).rejects.toThrow("bar");
    const set = await performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: true, rate: { bar: 0.9, min: 20 } });
    expect(role().line_merge_rate).toMatchObject({ bar: 0.9, min: 20, set_by: HOST });
    expect(set.merge).toMatchObject({ mode: "rate", allowed: false });
    // Flipping the switch alone leaves the mode where it is.
    await performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: true, from_session: "standing" });
    expect(role().line_merge_rate).toBeDefined();
    await performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: true, rate: null });
    expect(role().line_merge_rate).toBeUndefined();
    expect(tables.org_role_history.filter((h) => h.field === "line_merge_rate").map((h) => [h.old_value, h.new_value])).toEqual([["count", "0.9/20"], ["0.9/20", "count"]]);
  });
});

