import { describe, expect, test } from "bun:test";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { resumeFailedRunCore } from "./failedRunResume";
import { landAgainCore, reaskRunCore } from "./workflow_runs";
import { restartRunFresh } from "./lineTrial";
import { MERGE_AUTHORITY_ID, checkMergeCore, clearForMergeCore, mergeAllowance, performSetLineMerge, prUrlFromEvidence, recordMergeCore } from "./orgLineMerge";
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

  test("an agent session may flip it", async () => {
    const { ctx, role } = world();
    await performSetLineMerge(ctx, HOST as any, { role_id: "or-1", on: true, per_day: 1, from_session: "standing" });
    expect(role().line_merge).toBe(true);
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
    expect(String(told.content)).toContain("The flow merged ct-7 (Add the thing) from codecast/line-ct-7 into main at abc123def4: merge 1 of 2 today");
    expect(String(told.content)).toContain("Report it in one line to the person you report to");
    // The second merge of the day fills the limit; the allowance then refuses the next.
    await recordMergeCore(ctx, HOST as any, { run_id: "workflow_runs_1", sha: "bbb", branch: "b2", into: "main" }, NOW + 1);
    expect(mergeAllowance(role(), NOW + 2)).toMatchObject({ allowed: false, used: 2 });
  });

});

// A run no role is behind merges on a person's word (orgLineMerge.personAuthorized): a Ship on a card of the task,
// or the stamp a script station of its own graph wrote (clearForMergeCore) in its current attempt.
describe("a merge no role is behind", () => {
  function solo(opts: { indexes?: boolean } = {}) {
    const tables: Record<string, any[]> = {
      users: [{ _id: HOST, name: "Host", email: "host@x.ai" }],
      team_memberships: [{ _id: "m1", user_id: HOST, team_id: TEAM, role: "admin", joined_at: 1 }],
      teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
      org_roles: [], anchors: [],
      conversations: [{ _id: "conversations_hand", session_id: "hand", user_id: HOST, team_id: TEAM, status: "active", title: "Implement", agent_type: "claude_code", message_count: 1, updated_at: NOW, owner_device_id: "dev" }],
      tasks: [{ _id: "tasks_1", short_id: "ct-7", title: "Add the thing", status: "open", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, created_at: 1, updated_at: 1 }],
      // The composed graph the runner pushed at start: Intent gate is a script station, the rest are sessions'.
      workflows: [{ _id: "workflows_change", user_id: HOST, name: "change", slug: "change", edges: [], nodes: [
        { id: "review__review", label: "Review", shape: "box", type: "agent" },
        { id: "intent_gate", label: "Land without asking?", shape: "parallelogram", type: "command", script: "bun gate.ts" },
        { id: "fix_review", label: "Address review", shape: "box", type: "agent", backend: "subject" },
        { id: "implement", label: "Implement", shape: "box", type: "agent" },
        { id: "rebase", label: "Rebase", shape: "parallelogram", type: "command", script: "@line/rebase.sh" },
      ] }],
      workflow_runs: [{ _id: "workflow_runs_1", user_id: HOST, task_id: "tasks_1", workflow_id: "workflows_change", primary_conversation_id: "conversations_hand", status: "running", workspace: `team:${TEAM}`, team_id: TEAM, runner_device: "dev",
        current_node_id: "intent_gate", node_statuses: [{ node_id: "review__review", status: "completed", session_id: "rev" }, { node_id: "intent_gate", status: "running" }], created_at: NOW, updated_at: NOW }],
      session_decisions: [], projects: [], daemon_commands: [], managed_sessions: [],
      task_comments: [], pending_messages: [], org_role_history: [], org_changes: [], docs: [], counters: [], thread_reads: [], entity_subscriptions: [],
    };
    const db = makeFakeDb(tables, opts.indexes ? { indexes: schemaIndexes(schema as any) } : {});
    const ctx: any = { db, scheduler: { runAfter: async () => {} } };
    return { ctx, tables, run: () => tables.workflow_runs[0] };
  }
  // A gate card on the task, answered Ship by the host unless the test says otherwise.
  const card = (id: string, over: Record<string, any> = {}) => ({
    _id: id, short_id: id.replace("_", "-"), task_id: "tasks_1", status: "answered", answer_index: 0, options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }],
    answered_by: { kind: "user", id: HOST }, created_at: NOW - DAY, resolved_at: NOW - DAY, user_id: HOST, conversation_id: "conversations_hand", session_id: "hand", question: "Ship?", blocking: true, ...over,
  });
  const merged = { run_id: "workflow_runs_1", sha: "abc123def456", branch: "codecast/line-ct-7", into: "main" };
  const check = (ctx: any) => checkMergeCore(ctx, HOST as any, "workflow_runs_1");
  const clear = (ctx: any, why = "founder-intent read: ship") => clearForMergeCore(ctx, HOST as any, { run_id: "workflow_runs_1", why }, NOW + 1);

  test("a run its graph cleared merges under the person who started it, recorded with the station's words", async () => {
    const { ctx, tables, run } = solo();
    await expect(check(ctx)).rejects.toThrow("its graph did not clear it to land, and no person answered Ship on a card, so nothing authorizes the merge");
    expect(await clear(ctx)).toEqual({ run_id: "workflow_runs_1", node_id: "intent_gate", attempt: NOW });
    expect(run().merge_cleared).toMatchObject({ node_id: "intent_gate", why: "founder-intent read: ship", by: HOST, attempt: NOW });
    const why = "cleared by the run's own graph at intent_gate (founder-intent read: ship), started by Host";
    expect(await check(ctx)).toMatchObject({ allowed: true, role: null, authorized: { user_id: HOST, why } });
    const out = await recordMergeCore(ctx, HOST as any, merged);
    expect(out).toMatchObject({ used: 0, limit: null, authorized: { user_id: HOST, why } });
    expect(run().merge).toMatchObject({ sha: "abc123def456", authorized: { user_id: HOST, why } });
    expect(tables.task_comments.at(-1).text).toBe(`merged codecast/line-ct-7 into main at abc123def4: authorized by ${why}`);
  });

  test("a clear on the starter's cited word merges under them and says which line it rests on", async () => {
    const { ctx, tables, run } = solo();
    const cited = { cite: { conversation_short_id: "jx7b0m0", line: 115 }, quote: "Yes, ship this", name: "Host" };
    await clearForMergeCore(ctx, HOST as any, { run_id: "workflow_runs_1", why: "they said ship", cited }, NOW + 1);
    expect(run().merge_cleared).toMatchObject({ node_id: "intent_gate", cite: cited.cite, quote: "Yes, ship this", attempt: NOW });
    expect(tables.task_comments.at(-1).text).toBe(`Cleared to land on Host's word: "Yes, ship this" (jx7b0m0:115), no card.`);
    expect(await check(ctx)).toMatchObject({ allowed: true, authorized: { user_id: HOST, why: `Host's own word "Yes, ship this" (jx7b0m0:115), checked at intent_gate` } });
  });

  test("only a running script station of the run, on its own runner's account, clears it; an agent account is no person", async () => {
    const other = solo();
    await expect(clearForMergeCore(other.ctx, "users_someone" as any, { run_id: "workflow_runs_1", why: "x" })).rejects.toThrow("Only the run's own runner");
    const agent = solo();
    Object.assign(agent.run(), { current_node_id: "implement", node_statuses: [{ node_id: "implement", status: "running", session_id: "impl" }] });
    await expect(clear(agent.ctx)).rejects.toThrow("implement is not a script station of the run's graph");
    // A fix station hands work back to the change's own session: the runner reports it running with no session of
    // its own, waiting on that session. In quick-change (no Decide) a stamp from there would land unasked.
    const fix = solo();
    Object.assign(fix.run(), { current_node_id: "fix_review", waiting_on_session: { node_id: "fix_review", conversation_id: "conversations_hand", since: NOW, note: "Address the review" },
      node_statuses: [{ node_id: "fix_review", status: "running" }] });
    await expect(clear(fix.ctx)).rejects.toThrow("fix_review is not a script station of the run's graph: only a flow's script station clears a run to land");
    expect(fix.run().merge_cleared).toBeUndefined();
    await expect(check(fix.ctx)).rejects.toThrow("its graph did not clear it to land");
    // The graph is the signal, not the report: a session station with no session reported and no wait is still refused.
    delete fix.run().waiting_on_session;
    await expect(clear(fix.ctx)).rejects.toThrow("fix_review is not a script station");
    // A script station the run waits on its session from, and a station the graph does not name, are refused too.
    const waiting = solo();
    waiting.run().waiting_on_session = { node_id: "intent_gate", conversation_id: "conversations_hand", since: NOW, note: "x" };
    await expect(clear(waiting.ctx)).rejects.toThrow("intent_gate is not a script station");
    const unknown = solo();
    Object.assign(unknown.run(), { current_node_id: "mystery", node_statuses: [{ node_id: "mystery", status: "running" }] });
    await expect(clear(unknown.ctx)).rejects.toThrow("mystery is not a script station");
    const paused = solo();
    paused.run().status = "paused";
    await expect(clear(paused.ctx)).rejects.toThrow("only a running station clears it");
    const blank = solo();
    await expect(clear(blank.ctx, "  ")).rejects.toThrow("--why");
    const bot = solo();
    bot.tables.users[0].is_bot = true;
    await clear(bot.ctx);
    await expect(check(bot.ctx)).rejects.toThrow("an agent account started it");
  });

  test("a run that failed before its gate and is resumed at Land does not count as cleared, and a resume drops a stamp", async () => {
    // Probe A: the library change run failed at Check and was resumed --at the ship station. Nothing cleared it.
    const failed = solo();
    Object.assign(failed.run(), { status: "failed", current_node_id: "check", fail_reason: "max_visits=3 exceeded on fix_check",
      node_statuses: [{ node_id: "check__check", status: "completed", outcome: "failure" }, { node_id: "fix_check", status: "completed" }] });
    await resumeFailedRunCore(failed.ctx, HOST as any, "workflow_runs_1" as any, "ship__rebase", {}, NOW + 1);
    expect(failed.run()).toMatchObject({ status: "running", current_node_id: "ship__rebase" });
    await expect(check(failed.ctx)).rejects.toThrow("its graph did not clear it to land");

    // A run cleared on its last attempt, then failed and resumed, is not cleared on the new one.
    const resumed = solo();
    await clear(resumed.ctx);
    Object.assign(resumed.run(), { status: "failed", current_node_id: "ship__ship", fail_reason: "push failed" });
    await resumeFailedRunCore(resumed.ctx, HOST as any, "workflow_runs_1" as any, "ship__rebase", {}, NOW + 2);
    expect(resumed.run().merge_cleared).toBeUndefined();
    await expect(check(resumed.ctx)).rejects.toThrow("its graph did not clear it to land");
    // A stamp from another attempt does not hold even when a path forgets to drop it.
    Object.assign(resumed.run(), { merge_cleared: { at: NOW, node_id: "intent_gate", why: "x", by: HOST, attempt: NOW } });
    expect(resumed.run().visits_reset_at).toBe(NOW + 2);
    await expect(check(resumed.ctx)).rejects.toThrow("its graph did not clear it to land");
  });

  test("a person's Ship on the run's own card authorizes it; while the card waits nothing merges", async () => {
    const { ctx, tables, run } = solo();
    Object.assign(run(), { gate_node_id: "decide__decide", gate_decision_id: "sd_1" });
    tables.session_decisions.push(card("sd_1", { workflow_run_id: "workflow_runs_1", status: "pending", answer_index: undefined, answered_by: undefined, resolved_at: undefined }));
    await expect(check(ctx)).rejects.toThrow("its card sd-1 is still waiting on a person, so nothing authorizes the merge");
    Object.assign(tables.session_decisions[0], { status: "answered", answer_index: 0, answered_by: { kind: "user", id: HOST }, resolved_at: NOW });
    expect(await check(ctx)).toMatchObject({ allowed: true, authorized: { user_id: HOST, why: "ship on card sd-1" } });
  });

  test("the run's own card decides whoever answered it: a role's Ship is no person's, and an older person's Ship does not override it", async () => {
    // Probe C.
    const { ctx, tables, run } = solo();
    tables.session_decisions.push(card("sd_1", { workflow_run_id: "workflow_runs_0" }));
    tables.session_decisions.push(card("sd_2", { workflow_run_id: "workflow_runs_1", answered_by: { kind: "role", id: "org_roles_x" }, resolved_at: NOW - 10 }));
    Object.assign(run(), { gate_node_id: "decide__decide", gate_decision_id: "sd_2" });
    await expect(check(ctx)).rejects.toThrow("a role answered Ship on its card sd-2, so nothing authorizes the merge");
    // Even a stamp does not outrank the run's own card.
    await clear(ctx);
    await expect(check(ctx)).rejects.toThrow("a role answered Ship on its card sd-2");
  });

  test("a Ship on an earlier run's card carries to a rerun until a person's later verdict on the task says otherwise", async () => {
    const { ctx, tables } = solo();
    tables.session_decisions.push(card("sd_1", { workflow_run_id: "workflow_runs_0" }));
    expect(await check(ctx)).toMatchObject({ allowed: true, authorized: { user_id: HOST, why: "ship on earlier run's card sd-1" } });
    tables.session_decisions.push(card("sd_2", { workflow_run_id: "workflow_runs_0", answer_index: 1, resolved_at: NOW - 1000 }));
    await expect(check(ctx)).rejects.toThrow("a person answered Revise on sd-2, the task's newest verdict, so nothing authorizes the merge");
    // A later verdict outranks a stamp too: a change a person sent back comes back to a person.
    await clear(ctx);
    await expect(check(ctx)).rejects.toThrow("answered Revise on sd-2");
    // A role's answer on another run's card is no verdict either way.
    tables.session_decisions.push(card("sd_3", { workflow_run_id: "workflow_runs_0", answered_by: { kind: "role", id: "org_roles_x" }, resolved_at: NOW - 10 }));
    await expect(check(ctx)).rejects.toThrow("answered Revise on sd-2");
  });

  test("a person's dismissal is a verdict that is not Ship, on the run's own card or an earlier one", async () => {
    // Probe B: the own card dismissed by a person, with an earlier Ship on the task.
    const own = solo();
    own.tables.session_decisions.push(card("sd_1", { workflow_run_id: "workflow_runs_0" }));
    own.tables.session_decisions.push(card("sd_2", { workflow_run_id: "workflow_runs_1", status: "dismissed", answer_index: undefined, answered_by: undefined, resolved_at: NOW - 10, resolved_by: HOST }));
    Object.assign(own.run(), { gate_node_id: "decide__decide", gate_decision_id: "sd_2" });
    await expect(check(own.ctx)).rejects.toThrow("a person dismissed its card sd-2, so nothing authorizes the merge");
    const earlier = solo();
    earlier.tables.session_decisions.push(card("sd_1", { workflow_run_id: "workflow_runs_0" }));
    earlier.tables.session_decisions.push(card("sd_2", { workflow_run_id: "workflow_runs_0", status: "dismissed", answer_index: undefined, answered_by: { kind: "user", id: HOST }, resolved_at: NOW - 10 }));
    await expect(check(earlier.ctx)).rejects.toThrow("a person dismissed sd-2, the task's newest verdict");
    // A withdrawal names nobody: the asker took its question back, and the Ship stands.
    earlier.tables.session_decisions[1] = card("sd_2", { workflow_run_id: "workflow_runs_0", status: "withdrawn", answer_index: undefined, answered_by: undefined, resolved_at: NOW - 10 });
    expect(await check(earlier.ctx)).toMatchObject({ allowed: true, authorized: { why: "ship on earlier run's card sd-1" } });
  });

  test("the newest verdict is read newest first off the index, past any number of older answers", async () => {
    // Probe D: 500 older Ships, then a Revise; the real index order, not the seed's.
    const { ctx, tables } = solo({ indexes: true });
    let t = 1000;
    for (let i = 0; i < 500; i++) tables.session_decisions.push({ ...card(`sd_${i}`, { workflow_run_id: "workflow_runs_0", resolved_at: NOW - DAY + i }), _creationTime: t++ });
    tables.session_decisions.push({ ...card("sd_new", { workflow_run_id: "workflow_runs_0", answer_index: 1, resolved_at: NOW - 5 }), _creationTime: t++ });
    await expect(check(ctx)).rejects.toThrow("answered Revise on sd-new, the task's newest verdict");
  });

  test("a card that offered no Ship is no word on shipping; another run's waiting card does not hold this one", async () => {
    // Probe E: a runner failure card answered Reopen neither revokes a Ship nor stops a cleared run.
    const reopen = solo();
    reopen.tables.session_decisions.push(card("sd_1", { workflow_run_id: "workflow_runs_0", options: [{ label: "Reopen for another implement round" }, { label: "Drop the task" }, { label: "I will take it myself" }] }));
    await clear(reopen.ctx);
    expect(await check(reopen.ctx)).toMatchObject({ allowed: true, authorized: { why: expect.stringContaining("cleared by the run's own graph") } });
    // Probe F: run A's card still waiting on the same task.
    const waiting = solo();
    waiting.tables.session_decisions.push(card("sd_1", { workflow_run_id: "workflow_runs_0", status: "pending", answer_index: undefined, answered_by: undefined, resolved_at: undefined }));
    await clear(waiting.ctx);
    expect(await check(waiting.ctx)).toMatchObject({ allowed: true });
  });

  test("reask, land-again and a trial rebuild each drop the stamp, though none moves the attempt", async () => {
    // Reask: the run waits at its card; asked again, it picks up at the gate with nothing it was cleared for.
    const reask = solo();
    await clear(reask.ctx);
    Object.assign(reask.run(), { status: "paused", gate_node_id: "decide__decide", current_node_id: "decide__decide" });
    await reaskRunCore(reask.ctx, HOST as any, "workflow_runs_1" as any, {}, NOW + 2);
    expect(reask.run()).toMatchObject({ status: "running", current_node_id: "decide__decide" });
    expect(reask.run().visits_reset_at).toBeUndefined();
    expect(reask.run().merge_cleared).toBeUndefined();

    // Land again: an ended run answered Ship whose landing step was refused for being behind picks up at Rebase.
    const land = solo();
    await clear(land.ctx);
    Object.assign(land.run(), { status: "completed", gate_response: "S", node_statuses: [{ node_id: "ship", status: "failed", result_preview: "line: codecast/line-ct-7 is behind origin/main; rebase it first" }] });
    await landAgainCore(land.ctx, HOST as any, "workflow_runs_1" as any);
    expect(land.run()).toMatchObject({ status: "running", current_node_id: "rebase" });
    expect(land.run().merge_cleared).toBeUndefined();
    await expect(check(land.ctx)).rejects.toThrow("its graph did not clear it to land");

    // A trial card's rebuild puts the run back at its fresh station.
    const rebuild = solo();
    await clear(rebuild.ctx);
    await restartRunFresh(rebuild.ctx, "workflow_runs_1" as any, {}, "fresh", NOW + 3);
    expect(rebuild.run()).toMatchObject({ status: "running", current_node_id: "fresh", fresh_branch: true });
    expect(rebuild.run().merge_cleared).toBeUndefined();
  });

  test("a trial project's run never merges, cleared or shipped", async () => {
    const { ctx, tables, run } = solo();
    tables.projects.push({ _id: "projects_trial", title: "Trial", user_id: HOST, line_trial: { since: 1, by: HOST } });
    tables.tasks[0].project_id = "projects_trial";
    await clear(ctx);
    expect(await check(ctx)).toMatchObject({ allowed: false, reason: "a trial project's run stops at the card: nothing merges" });
    tables.session_decisions.push(card("sd_1", { workflow_run_id: "workflow_runs_1" }));
    run().gate_decision_id = "sd_1";
    expect(await check(ctx)).toMatchObject({ allowed: false, reason: "a trial project's run stops at the card: nothing merges" });
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

