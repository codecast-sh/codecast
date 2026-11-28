import { describe, expect, test } from "bun:test";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { resumeFailedRunCore } from "./failedRunResume";
import { landAgainCore, reaskRunCore } from "./workflow_runs";
import { restartRunFresh } from "./lineTrial";
import { MERGE_AUTHORITY_ID, checkMergeCore, clearForMergeCore, mergeAllowance, performSetLineMerge, prUrlFromEvidence, mergeProofCore, recordCiVerdictCore, recordMergeCore, recordReviewVerdictCore, recordRunPrCore, recordStationRebaseCore } from "./orgLineMerge";
import { lineOfRole } from "./orgRoles";

// The line's merge step on the server (the-line.md L12): the allowance read
// from the role row, the switch a person flips, and the record after a merge.

const HOST = "u".repeat(31) + "h";
const TEAM = "teams_acme" as any;
const ROLE = "org_roles_growth";
const STANDING = "conversations_standing";
const NOW = Date.now();
const DAY = 86_400_000;
const HEAD = "a".repeat(40);

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
    // Off names the role whose switch it is, and the command that lets its hands merge.
    expect(mergeAllowance({ handle: "release" }, NOW).reason).toBe("@release's merge is off: `cast role line @release --merge on` lets its hands merge");
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

  // `cast flow landed` finds where the change landed; it made no merge, so it spends no allowance.
  test("an observed landing stamps the run only: no count, no task comment, no word to the role", async () => {
    const { ctx, tables, role } = world({ line_merge: true, authority: [grant()] });
    const out = await recordMergeCore(ctx, HOST as any, { run_id: "workflow_runs_1", sha: "abc123def4567890", branch: "codecast/line-ct-7", into: "main", observed: true }, NOW);
    expect(out).toEqual({ observed: true });
    expect(tables.workflow_runs[0].merge).toEqual({ sha: "abc123def4567890", branch: "codecast/line-ct-7", into: "main", at: NOW });
    expect(role().counters?.merges ?? 0).toBe(0);
    expect(tables.task_comments ?? []).toEqual([]);
    expect((tables.pending_messages ?? []).filter((p) => p.conversation_id === STANDING)).toEqual([]);
  });

  test("an observed landing fills an empty merge only, never replacing one already recorded", async () => {
    const { ctx, tables } = world({ line_merge: true, authority: [grant()] });
    const recorded = { sha: "aaa111", branch: "codecast/line-ct-7", into: "main", at: NOW - 5 };
    tables.workflow_runs[0].merge = recorded;
    expect(await recordMergeCore(ctx, HOST as any, { run_id: "workflow_runs_1", sha: "bbb222", branch: "x", into: "main", observed: true }, NOW)).toEqual({ observed: true, kept: "aaa111" });
    expect(tables.workflow_runs[0].merge).toEqual(recorded);
  });

  test("only the run's own runner records an observed landing, before any role or authorization is read", async () => {
    const { ctx, tables } = world({ line_merge: true, authority: [grant()] });
    await expect(recordMergeCore(ctx, "users_someone_else" as any, { run_id: "workflow_runs_1", sha: "bbb222", branch: "x", into: "main", observed: true }, NOW)).rejects.toThrow("Forbidden");
    expect(tables.workflow_runs[0].merge).toBeUndefined();
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
      conversations: [
        { _id: "conversations_hand", session_id: "hand", user_id: HOST, team_id: TEAM, status: "active", title: "Implement", agent_type: "claude_code", message_count: 1, updated_at: NOW, owner_device_id: "dev" },
        { _id: "conversations_rev", short_id: "jx7revw", session_id: "rev-agent-uuid", user_id: HOST, team_id: TEAM, status: "active", title: "Review", agent_type: "claude_code", message_count: 1, updated_at: NOW },
      ],
      tasks: [{ _id: "tasks_1", short_id: "ct-7", title: "Add the thing", status: "open", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, created_at: 1, updated_at: 1 }],
      // The composed graph the runner pushed at start: CI and Intent gate are script stations, the rest are sessions';
      // CI and the reviewer both lead to the gate.
      workflows: [{ _id: "workflows_change", user_id: HOST, name: "change", slug: "change", edges: [
        { from: "ci", to: "verdicts" }, { from: "review__review", to: "verdicts" }, { from: "verdicts", to: "intent_gate" },
      ], nodes: [
        { id: "ci", label: "CI", shape: "parallelogram", type: "command", script: "cast flow ci --pr 5 --dir \"$run_dir\"" },
        { id: "review__review", label: "Review", shape: "box", type: "agent", reviewer: true },
        { id: "verdicts", label: "Verdicts", shape: "tripleoctagon", type: "fanin" },
        { id: "intent_gate", label: "Land without asking?", shape: "parallelogram", type: "command", script: "bun gate.ts" },
        { id: "fix_review", label: "Address review", shape: "box", type: "agent", backend: "subject" },
        { id: "implement", label: "Implement", shape: "box", type: "agent" },
        { id: "rebase", label: "Rebase", shape: "parallelogram", type: "command", script: "@line/rebase.sh" },
      ] }],
      workflow_runs: [{ _id: "workflow_runs_1", user_id: HOST, task_id: "tasks_1", workflow_id: "workflows_change", primary_conversation_id: "conversations_hand", status: "running", workspace: `team:${TEAM}`, team_id: TEAM, runner_device: "dev",
        ci_verdict: { node_id: "ci", green: true, head_sha: HEAD, at: NOW, attempt: NOW },
        review_verdict: { node_id: "review__review", verdict: "ship", head_sha: HEAD, round: "r1", at: NOW, attempt: NOW },
        current_node_id: "intent_gate", node_statuses: [
          { node_id: "ci", status: "completed", outcome: "success", completed_at: NOW },
          { node_id: "review__review", status: "completed", outcome: "success", session_id: "rev", completed_at: NOW },
          { node_id: "intent_gate", status: "running" },
        ], created_at: NOW, updated_at: NOW }],
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
  const clear = (ctx: any, why = "founder-intent read: ship", head_sha = HEAD) => clearForMergeCore(ctx, HOST as any, { run_id: "workflow_runs_1", why, head_sha }, NOW + 1);

  // A run with no role behind it, no approval card and no clear stamp. Its observed landing authorizes nothing, so it records.
  test("a run nothing authorizes may still record an observed landing", async () => {
    const { ctx, run } = solo();
    await expect(check(ctx)).rejects.toThrow("nothing authorizes the merge");
    expect(await recordMergeCore(ctx, HOST as any, { ...merged, observed: true }, NOW)).toEqual({ observed: true });
    expect(run().merge).toEqual({ sha: merged.sha, branch: merged.branch, into: "main", at: NOW });
  });

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

  test("only a running script station of the run, on its own runner's account, clears it; an agent account is no person", async () => {
    const other = solo();
    await expect(clearForMergeCore(other.ctx, "users_someone" as any, { run_id: "workflow_runs_1", why: "x" })).rejects.toThrow("Only the run's own runner");
    const agent = solo();
    Object.assign(agent.run(), { current_node_id: "implement", node_statuses: [{ node_id: "implement", status: "running", session_id: "impl" }] });
    await expect(clear(agent.ctx)).rejects.toThrow("implement is not a script station of the run's graph");
    // A fix station hands work back to the change's own session: the runner reports it running with no session of
    // its own, waiting on that session. In a flow with no Decide, a stamp from there would land unasked.
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

  test("a clearance stands on a green CI verdict the server holds for the head it merges, and a reviewer session that ran; files cannot fake either", async () => {
    // A one-node flow that writes its own ci.json has no verdict on the server.
    const lone = solo();
    lone.tables.workflows[0] = { _id: "workflows_change", user_id: HOST, name: "inline", slug: "inline", edges: [], nodes: [
      { id: "merge", label: "Merge", shape: "parallelogram", type: "command", script: "echo '{\"green\":true}' > \"$run_dir/ci.json\"; cast flow merge --pr 5" },
    ] };
    Object.assign(lone.run(), { current_node_id: "merge", ci_verdict: undefined, node_statuses: [{ node_id: "merge", status: "running" }] });
    await expect(clear(lone.ctx)).rejects.toThrow("merge cannot clear the run: no CI verdict was recorded in this attempt");
    expect(lone.run().merge_cleared).toBeUndefined();

    // A verdict from an earlier attempt, a red one, or one on another head does not count.
    const stale = solo();
    stale.run().visits_reset_at = NOW + 1;
    await expect(clear(stale.ctx)).rejects.toThrow("no CI verdict was recorded in this attempt");
    const red = solo();
    red.run().ci_verdict.green = false;
    await expect(clear(red.ctx)).rejects.toThrow(`CI recorded red on ${HEAD.slice(0, 10)}`);
    const other = solo();
    await expect(clear(other.ctx, "x", "b".repeat(40))).rejects.toThrow(`CI's green is on ${HEAD.slice(0, 10)}, not on the head being merged (bbbbbbbbbb)`);
    await expect(clearForMergeCore(other.ctx, HOST as any, { run_id: "workflow_runs_1", why: "x" }, NOW + 1)).rejects.toThrow("none named");

    // The reviewer's ship must be recorded in this attempt, and its station must lead here.
    const unreviewed = solo();
    delete unreviewed.run().review_verdict;
    await expect(clear(unreviewed.ctx)).rejects.toThrow("no reviewer verdict was recorded in this attempt");
    const changes = solo();
    changes.run().review_verdict.verdict = "changes";
    await expect(clear(changes.ctx)).rejects.toThrow("the reviewer said changes");
    const apart = solo();
    apart.tables.workflows[0].edges = [{ from: "ci", to: "verdicts" }, { from: "verdicts", to: "intent_gate" }];
    await expect(clear(apart.ctx)).rejects.toThrow("the review station review__review does not lead to it");
    const ciApart = solo();
    ciApart.tables.workflows[0].edges = [{ from: "review__review", to: "verdicts" }, { from: "verdicts", to: "intent_gate" }];
    await expect(clear(ciApart.ctx)).rejects.toThrow("the CI station ci does not lead to it");
  });

  test("the PR station records the run's pull request and keeps the first head it pushed; the review records its mechanism answer", async () => {
    const s = solo();
    Object.assign(s.run(), { current_node_id: "ci", node_statuses: [{ node_id: "ci", status: "running", started_at: NOW + 1 }] });
    const report = (head: string, user = HOST) => recordRunPrCore(s.ctx, user as any, { run_id: "workflow_runs_1", repository: "Union-AI/Union-Mobile", number: 12, head_sha: head }, NOW + 3);
    expect(await report(HEAD)).toEqual({ first_head_sha: HEAD });
    expect(await report("b".repeat(40))).toEqual({ first_head_sha: HEAD });
    expect(s.run().pr).toEqual({ repository: "union-ai/union-mobile", number: 12, first_head_sha: HEAD, head_sha: "b".repeat(40), at: NOW + 3 });
    await expect(report(HEAD, "users_someone")).rejects.toThrow("Only the run's own runner");
    Object.assign(s.run(), { current_node_id: "review__review", node_statuses: [{ node_id: "review__review", status: "running", started_at: NOW + 1, session_id: "jx7revw" }] });
    await expect(report(HEAD)).rejects.toThrow("is not a running script station");
    await recordReviewVerdictCore(s.ctx, HOST as any, { session_id: "rev-agent-uuid", verdict: "ship", head_sha: HEAD, mechanism: true }, NOW + 4);
    expect(s.run().review_verdict).toMatchObject({ verdict: "ship", mechanism: true });
  });

  test("the CI verdict is recorded only by the run's runner, from a script station running now in this attempt", async () => {
    const posted = (s: ReturnType<typeof solo>, over: Record<string, any> = {}, user = HOST) =>
      recordCiVerdictCore(s.ctx, user as any, { run_id: "workflow_runs_1", node_id: "ci", green: true, head_sha: HEAD, ...over }, NOW + 2);
    const ok = solo();
    Object.assign(ok.run(), { ci_verdict: undefined, current_node_id: "ci", node_statuses: [{ node_id: "ci", status: "running", started_at: NOW + 1 }] });
    expect(await posted(ok)).toEqual({ attempt: NOW });
    expect(ok.run().ci_verdict).toEqual({ node_id: "ci", green: true, head_sha: HEAD, at: NOW + 2, attempt: NOW });

    await expect(posted(ok, {}, "users_someone")).rejects.toThrow("Only the run's own runner");
    await expect(posted(ok, { head_sha: "main" })).rejects.toThrow("is not a commit sha");
    // Not running now, a session station, or a node the graph does not name as a script station.
    const done = solo();
    await expect(posted(done)).rejects.toThrow("ci is not a running script station");
    const session = solo();
    Object.assign(session.run(), { node_statuses: [{ node_id: "review__review", status: "running", started_at: NOW + 1, session_id: "rev" }] });
    await expect(posted(session, { node_id: "review__review" })).rejects.toThrow("review__review is not a running script station");
    // Running since before a resume moved the attempt: an old visit's report.
    const before = solo();
    Object.assign(before.run(), { visits_reset_at: NOW + 5, node_statuses: [{ node_id: "ci", status: "running", started_at: NOW + 1 }] });
    await expect(posted(before)).rejects.toThrow("ci is not a running script station");
  });

  // The verifier's repro: the reviewer ships R, someone pushes X, the run retests, CI goes green on X.
  test("a review binds to the head it read: a head pushed after review is refused; the station's own rebase of the reviewed head is covered", async () => {
    const R = "1".repeat(40), X = "2".repeat(40), REBASED = "3".repeat(40);
    const at = (s: ReturnType<typeof solo>, node: string, extra: Record<string, any> = {}) =>
      Object.assign(s.run(), { current_node_id: node, node_statuses: [...s.run().node_statuses.filter((n: any) => n.node_id !== node), { node_id: node, status: "running", started_at: NOW + 1, ...extra }] });
    const merging = (s: ReturnType<typeof solo>) => Object.assign(s.run(), { current_node_id: "intent_gate", node_statuses: [
      { node_id: "ci", status: "completed", outcome: "success", completed_at: NOW + 5 },
      { node_id: "review__review", status: "completed", outcome: "success", session_id: "jx7revw", started_at: NOW + 1, completed_at: NOW + 3 },
      { node_id: "intent_gate", status: "running", started_at: NOW + 6 },
    ] });
    const ciOn = async (s: ReturnType<typeof solo>, head: string) => { at(s, "ci"); await recordCiVerdictCore(s.ctx, HOST as any, { run_id: "workflow_runs_1", node_id: "ci", green: true, head_sha: head }, NOW + 4); };
    const reviewed = async () => {
      const s = solo();
      Object.assign(s.run(), { ci_verdict: undefined, review_verdict: undefined, node_statuses: [] });
      // The reviewer's own session, by its agent session id alone, reports ship on R.
      at(s, "review__review", { session_id: "jx7revw" });
      await recordReviewVerdictCore(s.ctx, HOST as any, { session_id: "rev-agent-uuid", verdict: "ship", head_sha: R, round: "r1" }, NOW + 2);
      return s;
    };

    // Someone pushed X after the review; CI goes green on X: no clearance.
    const pushed = await reviewed();
    await ciOn(pushed, X);
    merging(pushed);
    await expect(clear(pushed.ctx, "ship", X)).rejects.toThrow(`the reviewer read ${R.slice(0, 10)}, not the head being merged (${X.slice(0, 10)}), and no rebase of the station's own turned one into the other`);
    expect(pushed.run().merge_cleared).toBeUndefined();
    // A record from some other head does not cover it either.
    await recordStationRebaseCore(pushed.ctx, HOST as any, { run_id: "workflow_runs_1", from: "4".repeat(40), to: X }, NOW + 7);
    merging(pushed);
    await expect(clear(pushed.ctx, "ship", X)).rejects.toThrow("the reviewer read");

    // The flow as it runs: CI green on R, Merge rebases R and records it, CI green on the rebase, then main moves and
    // the PR station rebases again (R to X to Y, link by link), CI green on Y, Merge clears it.
    const own = await reviewed();
    await ciOn(own, R);
    merging(own);
    await recordStationRebaseCore(own.ctx, HOST as any, { run_id: "workflow_runs_1", from: R, to: REBASED }, NOW + 7);
    await recordStationRebaseCore(own.ctx, HOST as any, { run_id: "workflow_runs_1", from: REBASED, to: X }, NOW + 8);
    await ciOn(own, X);
    merging(own);
    expect(await clear(own.ctx, "ship", X)).toMatchObject({ node_id: "intent_gate" });

    const plain = await reviewed();
    await ciOn(plain, R);
    merging(plain);
    expect(await clear(plain.ctx, "ship", R)).toMatchObject({ node_id: "intent_gate" });
  });

  test("the review verdict is recorded only from the exact session the runner reported on the reviewer node in this attempt", async () => {
    const reviewing = () => {
      const s = solo();
      Object.assign(s.run(), { review_verdict: undefined, current_node_id: "review__review", node_statuses: [{ node_id: "review__review", status: "running", started_at: NOW + 1, session_id: "jx7revw" }] });
      return s;
    };
    const say = (s: ReturnType<typeof solo>, over: Record<string, any> = {}) =>
      recordReviewVerdictCore(s.ctx, HOST as any, { session_id: "rev-agent-uuid", verdict: "ship", head_sha: HEAD, round: "r2", ...over }, NOW + 2);
    // Neither run nor node named: the server finds them from the session, composed node id and all.
    const ok = reviewing();
    expect(await say(ok)).toEqual({ run_id: "workflow_runs_1", node_id: "review__review", attempt: NOW });
    expect(ok.run().review_verdict).toEqual({ node_id: "review__review", verdict: "ship", head_sha: HEAD, round: "r2", at: NOW + 2, attempt: NOW });
    // The conversation's own id works too; a prefix of its short id, another session, or none does not.
    expect(await say(reviewing(), { session_id: "conversations_rev" })).toMatchObject({ node_id: "review__review" });
    await expect(say(reviewing(), { session_id: "jx7rev" })).rejects.toThrow("is not one of your sessions");
    await expect(say(reviewing(), { session_id: "hand" })).rejects.toThrow("no running run's reviewer station in this attempt");
    await expect(say(reviewing(), { session_id: undefined })).rejects.toThrow("is not one of your sessions");
    // The node must be a reviewer session node that ran in this attempt.
    const notReviewer = reviewing();
    notReviewer.run().node_statuses[0].node_id = "implement";
    await expect(say(notReviewer)).rejects.toThrow("no running run's reviewer station");
    const resumed = reviewing();
    resumed.run().visits_reset_at = NOW + 5;
    await expect(say(resumed)).rejects.toThrow("in this attempt");
    await expect(say(reviewing(), { verdict: "lgtm" })).rejects.toThrow("is not a verdict");
  });

  // An account holds thousands of running runs parked at a queue, far more than any scan of them reads.
  test("the reviewer's run is read by key, whatever the account's other running runs", async () => {
    const crowded = (opts: { parkedNewer: boolean; parentRun?: string }) => {
      const s = solo({ indexes: true });
      const parked = Array.from({ length: 201 }, (_, i) => {
        const at = opts.parkedNewer ? NOW + 10 + i : i + 1;
        return { _id: `workflow_runs_parked${i}`, _creationTime: at, user_id: HOST, workflow_id: "workflows_change", status: "running", workspace: `team:${TEAM}`, current_node_id: "queue", node_statuses: [{ node_id: "queue", status: "running", started_at: 1 }], created_at: at, updated_at: at };
      });
      Object.assign(s.run(), { _creationTime: NOW, review_verdict: undefined, current_node_id: "review__review", node_statuses: [{ node_id: "review__review", status: "running", started_at: NOW + 1, session_id: "jx7revw" }] });
      s.tables.workflow_runs.unshift(...parked);
      if (opts.parentRun) {
        // The station runs nested under the run's own session, which names the run (or, for a session that launched
        // several runs, the newest of them).
        Object.assign(s.tables.conversations.find((c: any) => c._id === "conversations_hand"), { workflow_run_id: opts.parentRun });
        Object.assign(s.tables.conversations.find((c: any) => c._id === "conversations_rev"), { parent_conversation_id: "conversations_hand" });
      }
      return s;
    };
    const say = (s: ReturnType<typeof solo>, over: Record<string, any> = {}) => recordReviewVerdictCore(s.ctx, HOST as any, { session_id: "rev-agent-uuid", verdict: "ship", head_sha: HEAD, ...over }, NOW + 2);
    const runOf = (s: ReturnType<typeof solo>) => s.tables.workflow_runs.find((r: any) => r._id === "workflow_runs_1");

    // Every other running run is newer than the reviewer's: only the key the station's session holds finds it.
    const linked = crowded({ parkedNewer: true, parentRun: "workflow_runs_1" });
    expect(await say(linked)).toMatchObject({ run_id: "workflow_runs_1", node_id: "review__review" });
    expect(runOf(linked).review_verdict).toMatchObject({ verdict: "ship", head_sha: HEAD });

    // The session launched a newer run since, so its pointer names that one: the session's running runs, read by their
    // primary, still hold the reviewer's; and the run the station reports names its run itself.
    const relaunched = crowded({ parkedNewer: true, parentRun: "workflow_runs_parked200" });
    expect(await say(relaunched)).toMatchObject({ run_id: "workflow_runs_1", node_id: "review__review" });
    expect(await say(crowded({ parkedNewer: true, parentRun: "workflow_runs_parked200" }), { run_id: "workflow_runs_1" })).toMatchObject({ run_id: "workflow_runs_1", node_id: "review__review" });
    // A named run is still held to the same rules: the caller must be its reviewer station in this attempt.
    await expect(say(crowded({ parkedNewer: true }), { run_id: "workflow_runs_parked0" })).rejects.toThrow("no running run's reviewer station");

    // A station whose conversation names no run is found by the fallback scan, newest first.
    expect(await say(crowded({ parkedNewer: false }))).toMatchObject({ run_id: "workflow_runs_1", node_id: "review__review" });
  });

  test("merge proof: the runner reads this attempt's reviewed head and rebase links, nothing older and nobody else", async () => {
    const s = solo();
    Object.assign(s.run(), { station_rebases: [{ from: "1".repeat(40), to: "2".repeat(40), at: NOW, attempt: NOW - 1 }, { from: HEAD, to: "c".repeat(40), at: NOW, attempt: NOW }] });
    expect(await mergeProofCore(s.ctx, HOST as any, "workflow_runs_1")).toEqual({ review: { verdict: "ship", head_sha: HEAD, node_id: "review__review" }, rebases: [{ from: HEAD, to: "c".repeat(40) }], ci_shipped: false });
    // A person's Ship on the run's own card in this attempt: the change flow asks nobody again for the same CI edit.
    s.tables.session_decisions.push(card("session_decisions_1", { workflow_run_id: "workflow_runs_1", resolved_at: NOW + 1 }));
    expect(await mergeProofCore(s.ctx, HOST as any, "workflow_runs_1")).toMatchObject({ ci_shipped: true });
    s.run().visits_reset_at = NOW + 2;
    expect(await mergeProofCore(s.ctx, HOST as any, "workflow_runs_1")).toEqual({ review: null, rebases: [], ci_shipped: false });
    await expect(mergeProofCore(s.ctx, "users_someone" as any, "workflow_runs_1")).rejects.toThrow("Only the run's own runner");
  });

  test("a rebase is recorded only by the run's runner from the script station running now (Merge, or the PR station waiting for main)", async () => {
    const rebase = (s: ReturnType<typeof solo>, user = HOST) => recordStationRebaseCore(s.ctx, user as any, { run_id: "workflow_runs_1", from: HEAD, to: "c".repeat(40) }, NOW + 2);
    const merging = solo();
    expect(await rebase(merging)).toEqual({ attempt: NOW });
    expect(merging.run().station_rebases).toEqual([{ from: HEAD, to: "c".repeat(40), at: NOW + 2, attempt: NOW }]);
    await expect(rebase(solo(), "users_someone")).rejects.toThrow("Only the run's own runner");
    // A session station (the reviewer, the change's own session) cannot; neither can a station that is not running.
    const atReview = solo();
    Object.assign(atReview.run(), { current_node_id: "review__review", node_statuses: [{ node_id: "review__review", status: "running", started_at: NOW + 1, session_id: "jx7revw" }] });
    await expect(rebase(atReview)).rejects.toThrow("review__review is not a running script station");
    const stopped = solo();
    stopped.run().status = "paused";
    await expect(rebase(stopped)).rejects.toThrow("is not a running script station");
    await expect(recordStationRebaseCore(solo().ctx, HOST as any, { run_id: "workflow_runs_1", from: HEAD, to: HEAD }, NOW)).rejects.toThrow("two different commit shas");
  });

  test("a recorded rebase re-posts the run's pull request status, which the push may have worked out before the link was stored", async () => {
    const s = solo();
    s.tables.github_app_installations = [{ _id: "inst1", installation_id: 42, account_login: "union-ai", approval_gate: [{ repository: "union-ai/union-mobile", judges_path: "outreach/line/change/judges.txt", mode: "required" }] }];
    s.run().pr = { repository: "union-ai/union-mobile", number: 12, first_head_sha: HEAD, head_sha: HEAD, at: NOW };
    const posts: any[] = [];
    s.ctx.scheduler.runAfter = async (_ms: number, _fn: unknown, args: unknown) => { posts.push(args); };
    await recordStationRebaseCore(s.ctx, HOST as any, { run_id: "workflow_runs_1", from: HEAD, to: "c".repeat(40) }, NOW + 2);
    expect(posts).toEqual([{ repository: "union-ai/union-mobile", pr_number: 12, post: true }]);
  });

  test("a change that edits CI clears only once a person answered Ship on this run's own card in this attempt", async () => {
    const refusal = "this change edits CI; a person must answer Ship on this run's card";
    const flagged = solo();
    flagged.run().ci_verdict.ci_changed = true;
    await expect(clear(flagged.ctx)).rejects.toThrow(refusal);
    // The station's own word counts too, when the verdict predates the flag.
    await expect(clearForMergeCore(solo().ctx, HOST as any, { run_id: "workflow_runs_1", why: "x", head_sha: HEAD, ci_changed: true }, NOW + 1)).rejects.toThrow(refusal);
    // A role's Ship, or a person's from before this attempt, is not it.
    const role = solo();
    role.run().ci_verdict.ci_changed = true;
    role.tables.session_decisions.push(card("session_decisions_1", { workflow_run_id: "workflow_runs_1", answered_by: { kind: "role", id: "or-1" }, resolved_at: NOW + 1 }));
    await expect(clear(role.ctx)).rejects.toThrow(refusal);
    const old = solo();
    old.run().ci_verdict.ci_changed = true;
    old.tables.session_decisions.push(card("session_decisions_1", { workflow_run_id: "workflow_runs_1", resolved_at: NOW - 1 }));
    await expect(clear(old.ctx)).rejects.toThrow(refusal);
    const shipped = solo();
    shipped.run().ci_verdict.ci_changed = true;
    shipped.tables.session_decisions.push(card("session_decisions_1", { workflow_run_id: "workflow_runs_1", resolved_at: NOW + 1 }));
    expect(await clear(shipped.ctx)).toMatchObject({ node_id: "intent_gate" });
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

  test("Approve merge, the approval card's button, authorizes as Ship does, on the run's card and on an earlier run's", async () => {
    const options = [{ label: "Approve merge" }, { label: "Revise" }, { label: "Drop" }];
    const own = solo();
    Object.assign(own.run(), { gate_node_id: "decide__decide", gate_decision_id: "sd_1" });
    own.tables.session_decisions.push(card("sd_1", { workflow_run_id: "workflow_runs_1", options }));
    expect(await check(own.ctx)).toMatchObject({ allowed: true, authorized: { user_id: HOST, why: "ship on card sd-1" } });
    const earlier = solo();
    earlier.tables.session_decisions.push(card("sd_2", { workflow_run_id: "workflow_runs_0", options }));
    expect(await check(earlier.ctx)).toMatchObject({ allowed: true, authorized: { user_id: HOST, why: "ship on earlier run's card sd-2" } });
    // Revise on the same card is still no yes.
    const revised = solo();
    revised.tables.session_decisions.push(card("sd_3", { workflow_run_id: "workflow_runs_0", options, answer_index: 1 }));
    await expect(check(revised.ctx)).rejects.toThrow("nothing authorizes the merge");
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

