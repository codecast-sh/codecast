import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  editedChange,
  orderForApply,
  performAcceptAll,
  performCreateProposal,
  performDecideChange,
  performWithdrawProposal,
  listProposals,
  readProposal, performBreachSnapshot, performWriteBreaches } from "./orgProposals";

// Staffing proposals (docs/architecture/org-staffing.md S4): create from a
// session or a person, one advisory decision for the addressed person, decide
// change by change with an apply at once through the one apply core, accept
// all in the contract's order, a session caller refused, withdraw.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const P = "projects_growth";
const Q = "projects_billing";
const GROWTH = "org_roles_growth";
const S1 = "conversations_analyzer";
const S_GROWTH = "conversations_standing_growth";

function fixtures(extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [
      { _id: GROWTH, short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth lead", handle: "growth", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchors_growth", created_by: ME, created_at: 1, updated_at: 1 },
    ],
    org_role_history: [],
    anchors: [{ _id: "anchors_growth", name: "Growth lead", scope_type: "team", team_id: TEAM, host_user_id: ME, bot_user_id: MATE, org_role_id: GROWTH, conversation_id: S_GROWTH, status: "active" }],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: 1 },
      { _id: Q, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", created_at: 1, updated_at: 1 },
    ],
    plans: [{ _id: "plans_loose", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pl-1", title: "Loose", status: "active", doc_id: "docs_loose", created_at: 1, updated_at: 1 }],
    tasks: [], docs: [{ _id: "docs_loose", user_id: ME, team_id: TEAM, workspace: WS, title: "Loose", content: "", doc_type: "plan", plan_id: "plans_loose", created_at: 1, updated_at: 1 }], agent_tasks: [], session_owners: [], decision_inbox: [], session_decisions: [], decision_grants: [], org_proposals: [], org_proposal_changes: [],
    conversations: [
      { _id: S1, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Org analyzer", short_id: "jxanaly", session_id: "s1", project_path: "/repo", updated_at: NOW, created_at: 1, message_count: 3 },
      { _id: S_GROWTH, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Growth lead", short_id: "jxgrowt", session_id: "s_growth", project_path: "/repo/growth", standing_role_id: GROWTH, anchor_id: "anchors_growth", persistent: true, updated_at: NOW, created_at: 1, message_count: 0 },
    ],
    ...extra,
  });
}
// A signed in browser: an auth identity and no token. Deciding is refused on
// any other evidence.
const ctxOf = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: "browser" }) } }) as any;
const tokenCtxOf = (db: any) => ({ db, auth: { getUserIdentity: async () => null } }) as any;
const change = (c: any, rationale = "because") => ({ change: c, rationale, evidence: [{ label: "ct-1", href: "/tasks/ct-1" }] });
const spec = (changes: any[], over: Record<string, any> = {}) => ({ title: "Reshape growth", summary_md: "Two moves.", mode: "review", changes, ...over });

describe("orgProposals.create", () => {
  test("a session's proposal stores its changes in order and queues one advisory decision for the person", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } }), change({ kind: "retire", handle: "growth" })]) });
    expect(r).toMatchObject({ short_id: "op-1", status: "open", author: { kind: "session", id: S1 }, link: "/org?proposal=op-1" });
    expect(r.changes.map((c: any) => [c.seq, c.line])).toEqual([[1, "budget @growth wakes 12/day"], [2, "retire @growth"]]);
    expect(r.decision_error).toBeUndefined();
    const d = await db.get(r.decision.id);
    expect(d).toMatchObject({ status: "pending", blocking: false, default_option: 0, conversation_id: S1, category: "allocation" });
    expect(d.question).toBe("Org analyzer proposes 2 changes: Reshape growth");
    expect(d.options.map((o: any) => o.label)).toEqual(["Review on the org page", "Not now"]);
    // A pointer, not a question (S4): answering clears the card and delivers nothing.
    expect(d.silent).toBe(true);
    expect(d.context_md).toContain("/org?proposal=op-1");
    expect((await db.query("decision_inbox").collect()).map((x: any) => [x.user_id, x.status])).toEqual([[ME, "pending"]]);
    expect((await db.get(r.id)).decision_id).toBe(r.decision.id);
  });

  test("a role's standing session authors as the role; a person authors as a user and gets no card", async () => {
    const db = fixtures();
    const asRole = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s_growth", spec: spec([change({ kind: "trust", handle: "growth", trust: "decide" })]) });
    expect(asRole.author).toEqual({ kind: "role", id: GROWTH });
    expect(asRole.decision).toBeDefined();
    const asUser = await performCreateProposal(ctxOf(db), ME as any, { spec: spec([change({ kind: "projects", changes: [{ op: "create", title: "Platform" }] })]) });
    expect(asUser).toMatchObject({ short_id: "op-2", author: { kind: "user", id: ME }, decision: undefined });
    expect((await db.get(asUser.id))).toMatchObject({ scope_user_id: ME, team_id: undefined });
  });

  test("an invalid spec is refused with every fault named", async () => {
    const db = fixtures();
    await expect(performCreateProposal(ctxOf(db), ME as any, { spec: spec([{ change: { kind: "budget", handle: "growth" }, rationale: "" }]) })).rejects.toThrow(/changes\[0\] \(budget\).*caps[\s\S]*rationale is required/);
    expect(await db.query("org_proposals").collect()).toEqual([]);
  });
});

describe("orgProposals.decide", () => {
  async function propose(db: any, changes: any[]) {
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec(changes) });
    return { ...r, ids: r.changes.map((c: any) => String(c.id)) };
  }

  test("each change kind applies at once through the apply core; skip and edits are honored; the proposal resolves and its card clears", async () => {
    const db = fixtures();
    const p = await propose(db, [
      change({ kind: "projects", changes: [{ op: "create", title: "Platform", project_path: "/repo/platform" }] }),
      change({ kind: "role", name: "Landing lead", handle: "landing", scope: { projects: ["pr-1"] }, reports_to: "@growth" }),
      change({ kind: "scope", handle: "growth", add: ["pr-2"] }),
      change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } }),
      change({ kind: "trust", handle: "growth", trust: "decide" }),
      change({ kind: "routine", handle: "growth", title: "Weekly review", prompt: "Run cast org review", every: "7d" }),
      change({ kind: "project_meta", project: "pr-1", goal: "Bring users in", priority: "p1", owner: "@growth", success_metrics: ["100 signups"] }),
      change({ kind: "move", handle: "growth", reports_to: "Mate" }),
      change({ kind: "adopt", handle: "growth", conversation: "jxnosuch" }),
      change({ kind: "retire", handle: "growth" }),
    ]);
    const ctx = ctxOf(db);
    const decide = (i: number, verdict: "accept" | "skip" = "accept", edits?: unknown) => performDecideChange(ctx, ME as any, { change_id: p.ids[i], verdict, edits, provision: false });

    expect(await decide(0)).toMatchObject({ status: "applied", note: expect.stringContaining('created project "Platform"'), resolved: false });
    expect(await decide(1)).toMatchObject({ status: "applied", role: { handle: "landing" } });
    const landing = (await db.query("org_roles").collect()).find((r: any) => r.handle === "landing");
    expect(landing).toMatchObject({ reports_to: { kind: "role", role_id: GROWTH }, scope: { project_ids: [P], plan_ids: [] } });
    expect(await decide(2)).toMatchObject({ status: "applied", note: "@growth: scope +pr-2" });
    expect((await db.get(GROWTH as any)).scope.project_ids).toEqual([P, Q]);
    // Edits ride over the proposed change: 9 wakes, not 12.
    expect(await decide(3, "accept", { caps: { wakes_per_day: 9 } })).toMatchObject({ status: "applied", note: "@growth: wakes 40 → 9/day" });
    expect((await db.get(GROWTH as any)).caps).toEqual({ hands_per_day: 6, wakes_per_day: 9, tokens_per_day: 400_000 });
    expect((await db.get(p.ids[3] as any)).edits).toEqual({ caps: { wakes_per_day: 9 } });
    expect(await decide(4)).toMatchObject({ status: "applied", note: "@growth: trust understand → decide" });
    expect((await db.get(GROWTH as any)).trust).toBe("decide");
    expect(await decide(5)).toMatchObject({ status: "applied", note: expect.stringContaining('routine "Weekly review" every 7d (tr-1)') });
    const routine = (await db.query("agent_tasks").collect())[0];
    expect(routine).toMatchObject({ target_conversation_id: S_GROWTH, originating_conversation_id: S_GROWTH, schedule_type: "recurring", interval_ms: 7 * 86_400_000, prompt: "Run cast org review", status: "scheduled", user_id: ME });
    expect(routine.run_at).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(await decide(6)).toMatchObject({ status: "applied", note: 'project "Growth": goal, success metrics, p1, owner @growth' });
    expect(await db.get(P as any)).toMatchObject({ goal: "Bring users in", priority: "p1", owner_role_id: GROWTH, success_metrics: ["100 signups"] });
    expect(await decide(7)).toMatchObject({ status: "applied", note: "@growth: now reports to Mate" });
    expect((await db.get(GROWTH as any)).reports_to).toEqual({ kind: "user", user_id: MATE });
    // The move is in the role's history, so org.health reads it as last_move_at.
    expect((await db.query("org_role_history").collect()).map((h: any) => h.action)).toEqual(["scope", "move"]);
    // A refusal thrown inside the core escapes the mutation, named by change, so
    // Convex discards the call's writes and the row stays decidable.
    await expect(decide(8)).rejects.toThrow("op-1#9 (adopt session jxnosuch as @growth's standing session): Session not found");
    await db.patch(p.ids[8] as any, { status: "proposed" }); // what Convex's rollback leaves behind; the fake db keeps writes
    expect(await decide(8, "skip")).toMatchObject({ status: "skipped", resolved: false });
    expect(await decide(9, "skip")).toMatchObject({ status: "skipped", resolved: true });
    expect((await db.get(GROWTH as any)).status).toBe("active");

    const proposal = await db.get(p.id);
    expect(proposal).toMatchObject({ status: "resolved" });
    expect(proposal.resolved_at).toBeGreaterThan(0);
    expect((await db.get(p.decision.id)).status).toBe("withdrawn");
    expect((await db.query("decision_inbox").collect())[0].status).toBe("done");
    const read = await readProposal(ctx, ME as any, "op-1");
    expect(read.counts).toEqual({ total: 10, decided: 10, applied: 8, failed: 0, skipped: 2 });
    // A decided change cannot be decided twice.
    await expect(decide(0)).rejects.toThrow("op-1 is resolved");
  });

  test("a session caller, a token caller and a caller with no browser identity are refused; a plain member is refused; op-N#seq resolves", async () => {
    const db = fixtures();
    const p = await propose(db, [change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } })]);
    const ctx = ctxOf(db);
    await expect(performDecideChange(ctx, ME as any, { change_id: p.ids[0], verdict: "accept", from_session: "s1" })).rejects.toThrow("a person's act");
    await expect(performAcceptAll(ctx, ME as any, { proposal: "op-1", from_session: "s_growth" })).rejects.toThrow("a person's act");
    // The T4 rule: a token is a terminal's, and a terminal can be a hand's.
    await expect(performDecideChange(ctx, ME as any, { change_id: p.ids[0], verdict: "accept", api_token: "tok" })).rejects.toThrow("human only");
    await expect(performAcceptAll(ctx, ME as any, { proposal: "op-1", api_token: "tok" })).rejects.toThrow("human only");
    await expect(performDecideChange(tokenCtxOf(db), ME as any, { change_id: p.ids[0], verdict: "skip" })).rejects.toThrow("human only");
    await expect(performDecideChange(ctx, MATE as any, { change_id: "op-1#1", verdict: "accept" })).rejects.toThrow("team admin");
    expect((await db.get(p.ids[0] as any)).status).toBe("proposed");
    expect((await db.get(GROWTH as any)).caps).toBeUndefined();
    expect(await performDecideChange(ctx, ME as any, { change_id: "op-1#1", verdict: "accept" })).toMatchObject({ status: "applied" });
  });

  test("a change the core refuses as a value stays failed and decidable; the proposal waits for it", async () => {
    const db = fixtures();
    const p = await propose(db, [change({ kind: "role", name: "Growth again", handle: "growth" }), change({ kind: "retire", handle: "growth" })]);
    const ctx = ctxOf(db);
    const first = await performDecideChange(ctx, ME as any, { change_id: p.ids[0], verdict: "accept", provision: false });
    expect(first).toMatchObject({ status: "failed", note: expect.stringContaining("@growth is already or-1"), resolved: false });
    expect(await performDecideChange(ctx, ME as any, { change_id: p.ids[1], verdict: "skip" })).toMatchObject({ status: "skipped", resolved: false });
    expect((await db.get(p.id)).status).toBe("open");
    expect((await db.get(p.decision.id)).status).toBe("pending");
    // Retry with edits: the failed row is decided again, and only then does the proposal resolve.
    const retry = await performDecideChange(ctx, ME as any, { change_id: p.ids[0], verdict: "accept", edits: { handle: "growth-2" }, provision: false });
    expect(retry).toMatchObject({ status: "applied", role: { handle: "growth-2" }, resolved: true });
    expect((await db.get(p.decision.id)).status).toBe("withdrawn");
  });

  test("edits must leave a valid change; an edit to one cap keeps the others", () => {
    expect(editedChange({ kind: "trust", handle: "growth", trust: "understand" }, { trust: "direct" })).toEqual({ kind: "trust", handle: "growth", trust: "direct" });
    // The inline form sends only the field that changed, nested; the merge
    // is one level deep so hands_per_day survives a tokens edit.
    expect(editedChange({ kind: "budget", handle: "growth", caps: { hands_per_day: 4, tokens_per_day: 400_000 } }, { caps: { tokens_per_day: 800_000 } })).toEqual({ kind: "budget", handle: "growth", caps: { hands_per_day: 4, tokens_per_day: 800_000 } });
    expect(editedChange({ kind: "role", name: "R", handle: "rr", scope: { projects: ["pr-1"] } }, { scope: { plans: ["pl-1"] }, reports_to: "@growth" })).toEqual({ kind: "role", name: "R", handle: "rr", scope: { projects: ["pr-1"], plans: ["pl-1"] }, reports_to: "@growth" });
    expect(() => editedChange({ kind: "trust", handle: "growth", trust: "understand" }, { trust: "god" })).toThrow("trust is one of");
    expect(() => editedChange({ kind: "trust", handle: "growth", trust: "understand" }, { kind: "retire" })).not.toThrow();
    expect(editedChange({ kind: "trust", handle: "growth", trust: "understand" }, { kind: "retire" }).kind).toBe("trust");
  });
});

describe("orgProposals.acceptAll", () => {
  test("applies in the contract's order: projects, roles parents first, then moves, scope, budget, trust, routines, adopt, retire", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([
      change({ kind: "retire", handle: "growth" }),
      change({ kind: "budget", handle: "ops", caps: { hands_per_day: 2 } }),
      change({ kind: "role", name: "Ops hand", handle: "ops-hand", reports_to: "@ops" }),
      change({ kind: "role", name: "Ops", handle: "ops", scope: { projects: ["pr-2"] } }),
      change({ kind: "projects", changes: [{ op: "create", title: "Platform" }] }),
      change({ kind: "scope", handle: "ops", add: ["Platform"] }),
      change({ kind: "file", plan: "pl-1", project: "Platform" }),
    ]) });
    const out = await performAcceptAll(ctxOf(db), ME as any, { proposal: r.short_id, provision: false });
    expect(out.results.map((x: any) => [x.seq, x.status])).toEqual([[5, "applied"], [7, "applied"], [4, "applied"], [3, "applied"], [6, "applied"], [2, "applied"], [1, "applied"]]);
    expect(out).toMatchObject({ applied: 7, failed: 0, resolved: true });
    const platform = (await db.query("projects").collect()).find((x: any) => x.title === "Platform");
    expect(out.results[1].note).toBe('filed pl-1 "Loose" under "Platform"');
    expect((await db.get("plans_loose" as any)).project_id).toBe(platform._id);
    expect((await db.get("docs_loose" as any)).project_id).toBe(platform._id);
    const roles = await db.query("org_roles").collect();
    const ops = roles.find((x: any) => x.handle === "ops");
    expect(roles.find((x: any) => x.handle === "ops-hand").reports_to).toEqual({ kind: "role", role_id: ops._id });
    expect(ops.caps.hands_per_day).toBe(2);
    expect(ops.scope.project_ids.length).toBe(2);
    expect((await db.get(GROWTH as any)).status).toBe("retired");
  });

  test("one change whose apply throws lands failed with the message; the others still apply, in their own transactions", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([
      change({ kind: "file", plan: "pl-999", project: "pr-1" }),
      change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } }),
      change({ kind: "trust", handle: "growth", trust: "decide" }),
    ]) });
    // The real ctx runs each change through runMutation (a sub-transaction
    // Convex rolls back on a throw); the harness hands one that runs the
    // change inline against the same db, which is the same thing for a
    // refusal thrown before any write.
    const calls: string[] = [];
    const ctx = { ...ctxOf(db), runMutation: async (_ref: unknown, args: any) => {
      calls.push(String(args.change_id));
      const proposal = await db.get(args.proposal_id);
      const change = await db.get(args.change_id);
      const { acceptOneForTest } = await import("./orgProposals");
      return acceptOneForTest(ctxOf(db), args.user_id, proposal, change, args.now, args.provision);
    } };
    const out = await performAcceptAll(ctx, ME as any, { proposal: "op-1", provision: false });
    expect(calls).toHaveLength(3);
    expect(out.results.map((x: any) => x.status)).toEqual(["failed", "applied", "applied"]);
    expect(out).toMatchObject({ applied: 2, failed: 1, resolved: false });
    const rows = (await db.query("org_proposal_changes").collect()).sort((a: any, b: any) => a.seq - b.seq);
    expect(rows.map((c: any) => c.status)).toEqual(["failed", "applied", "applied"]);
    expect(rows[0].applied_note).toContain('No plan "pl-999"');
    expect((await db.get(GROWTH as any)).caps.wakes_per_day).toBe(12);
    expect((await db.get(GROWTH as any)).trust).toBe("decide");
    // The failed one is still decidable: skipping it resolves the proposal.
    expect(await performDecideChange(ctxOf(db), ME as any, { change_id: String(rows[0]._id), verdict: "skip" })).toMatchObject({ status: "skipped", resolved: true });
    // Without runMutation (the plain harness) the same accept all lands the same way.
    const db2 = fixtures();
    await performCreateProposal(ctxOf(db2), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "file", plan: "pl-999", project: "pr-1" }), change({ kind: "trust", handle: "growth", trust: "decide" })]) });
    const out2 = await performAcceptAll(ctxOf(db2), ME as any, { proposal: "op-1", provision: false });
    expect(out2.results.map((x: any) => x.status)).toEqual(["failed", "applied"]);
  });

  test("orderForApply keeps a child role after its parent whatever the spec order", () => {
    const rows = [
      { seq: 1, change: { kind: "role", handle: "c", name: "C", reports_to: "@b" } },
      { seq: 2, change: { kind: "role", handle: "b", name: "B", reports_to: "@a" } },
      { seq: 3, change: { kind: "move", handle: "x" } },
      { seq: 4, change: { kind: "role", handle: "a", name: "A" } },
    ];
    expect(orderForApply(rows).map((r) => r.seq)).toEqual([4, 2, 1, 3]);
  });
});

// A session may withdraw only what it posted itself; a person decides or
// withdraws anything else on the org page or at a plain shell.
describe("orgProposals.withdraw by a session", () => {
  test("the authoring session or role may withdraw its own proposal; any other session is refused", async () => {
    const db = fixtures();
    const bySession = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } })]) });
    const byRole = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s_growth", spec: spec([change({ kind: "trust", handle: "growth", trust: "decide" })]) });
    await expect(performWithdrawProposal(ctxOf(db), ME as any, { proposal: bySession.short_id, from_session: "s_growth" })).rejects.toThrow("A session may withdraw only the proposal it posted");
    await expect(performWithdrawProposal(ctxOf(db), ME as any, { proposal: byRole.short_id, from_session: "s1" })).rejects.toThrow("A session may withdraw only the proposal it posted");
    expect(await performWithdrawProposal(ctxOf(db), ME as any, { proposal: bySession.short_id, from_session: "s1" })).toEqual({ proposal: bySession.short_id, status: "withdrawn" });
    expect(await performWithdrawProposal(ctxOf(db), ME as any, { proposal: byRole.short_id, from_session: "s_growth" })).toEqual({ proposal: byRole.short_id, status: "withdrawn" });
  });
});

// A review is the tick of the stability clock: creating one schedules the
// breach recording (a query snapshot, then a small write), which extends the
// streak of every role over the model and resets the others.
describe("orgProposals.create records the overload streak", () => {
  // Load, not ledger: four hands that reported blocked this week are four
  // stalls the role must unstick, past the model's three. Twenty six open
  // tasks would be a wide ledger, which never records a breach.
  const openTask = (i: number) => ({ _id: `tasks_o${i}`, user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: `ct-o${i}`, title: `t${i}`, task_type: "task", status: "in_progress", execution_status: "blocked", priority: "medium", created_at: 1, updated_at: NOW });
  test("a review schedules the recording; a request does not", async () => {
    const scheduled: any[] = [];
    const ctx = { ...ctxOf(fixtures()), scheduler: { runAfter: async (_delay: number, _fn: unknown, args: unknown) => { scheduled.push(args); } } };
    await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } })]) });
    expect(scheduled).toEqual([{ user_id: ME, team_id: TEAM }]);
    await performCreateProposal(ctx, ME as any, { team_id: TEAM, spec: spec([change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 14 } })], { mode: "request" }) });
    expect(scheduled).toHaveLength(1);
  });
  test("the snapshot extends a flagged role's streak and resets an unflagged one; the write patches only what changed", async () => {
    const db = fixtures({ tasks: Array.from({ length: 4 }, (_, i) => openTask(i)) });
    const ctx = ctxOf(db);
    let rows = await performBreachSnapshot(ctx, ME as any, TEAM, NOW);
    expect(rows).toEqual([{ role_id: GROWTH as any, overload_streak: 1 }]);
    expect(await performWriteBreaches(ctx, rows)).toBe(1);
    expect((await db.get(GROWTH as any)).overload_streak).toBe(1);
    rows = await performBreachSnapshot(ctx, ME as any, TEAM, NOW);
    expect(rows).toEqual([{ role_id: GROWTH as any, overload_streak: 2 }]);
    await performWriteBreaches(ctx, rows);
    expect(await performWriteBreaches(ctx, rows)).toBe(0);
    const quiet = fixtures();
    await quiet.patch(GROWTH as any, { overload_streak: 2 });
    const reset = await performBreachSnapshot(ctxOf(quiet), ME as any, TEAM, NOW);
    expect(reset).toEqual([{ role_id: GROWTH as any, overload_streak: 0 }]);
    await performWriteBreaches(ctxOf(quiet), reset);
    expect((await quiet.get(GROWTH as any)).overload_streak).toBe(0);
  });
});

describe("orgProposals.withdraw and list", () => {
  test("withdraw closes the proposal and clears its card; list puts open first and get is boundary scoped", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const a = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "retire", handle: "growth" })], { title: "A" }) });
    const b = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "retire", handle: "growth" })], { title: "B" }) });
    await expect(performWithdrawProposal(ctx, MATE as any, { proposal: a.short_id })).rejects.toThrow("author or a team admin");
    expect(await performWithdrawProposal(ctx, ME as any, { proposal: a.short_id })).toEqual({ proposal: "op-1", status: "withdrawn" });
    expect((await db.get(a.decision.id)).status).toBe("withdrawn");
    await expect(performWithdrawProposal(ctx, ME as any, { proposal: a.short_id })).rejects.toThrow("already withdrawn");
    await expect(performDecideChange(ctx, ME as any, { change_id: `${a.short_id}#1`, verdict: "skip" })).rejects.toThrow("is withdrawn");
    const listed = await listProposals(ctx, ME as any, { team_id: TEAM });
    expect(listed.map((p: any) => [p.short_id, p.status, p.counts.total])).toEqual([["op-2", "open", 1], ["op-1", "withdrawn", 1]]);
    expect((await listProposals(ctx, ME as any, { team_id: TEAM, status: "open" })).map((p: any) => p.short_id)).toEqual([b.short_id]);
    // A team member reads the team's proposals; a personal read finds none.
    expect((await readProposal(ctx, MATE as any, b.short_id)).changes[0].line).toBe("retire @growth");
    expect(await listProposals(ctx, ME as any, {})).toEqual([]);
  });
});

// Bring records in line (docs/architecture/org-staffing.md S9): the three sync
// change kinds apply through the same status paths a person uses.
describe("orgProposals.decide status changes (S9)", () => {
  async function propose(db: any, changes: any[]) {
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec(changes) });
    return { ...r, ids: r.changes.map((c: any) => String(c.id)) };
  }
  test("a stale plan, task and project are marked through decide, with the reason recorded", async () => {
    const db = fixtures({
      plans: [{ _id: "plans_loose", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pl-1", title: "Loose", status: "active", created_at: 1, updated_at: 1 }],
      tasks: [{ _id: "tasks_open", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "ct-9", title: "Ship it", task_type: "task", status: "open", priority: "medium", created_at: 1, updated_at: 1 }],
    });
    const p = await propose(db, [
      change({ kind: "plan_status", plan: "pl-1", status: "done", reason: "every task closed" }),
      change({ kind: "task_status", task: "ct-9", status: "done", reason: "commits landed, still open" }),
      change({ kind: "project_status", project: "pr-2", status: "paused", reason: "no activity 30d" }),
    ]);
    const ctx = ctxOf(db);
    const decide = (i: number) => performDecideChange(ctx, ME as any, { change_id: p.ids[i], verdict: "accept", provision: false });
    expect(await decide(0)).toMatchObject({ status: "applied", note: expect.stringContaining("pl-1") });
    expect((await db.get("plans_loose" as any)).status).toBe("done");
    expect(await decide(1)).toMatchObject({ status: "applied", note: expect.stringContaining("ct-9") });
    const task = await db.get("tasks_open" as any);
    expect(task.status).toBe("done");
    // A person's approve is outside every role, so the close passes the
    // independent review rule and stamps the verdict.
    expect(task.review_verdict).toMatchObject({ verdict: "approve" });
    expect(await decide(2)).toMatchObject({ status: "applied" });
    expect((await db.get(Q as any)).status).toBe("paused");
  });
});

// A plan close cascades to its open tasks (S9): accepted once, applied through
// the one task path, listed in the applied note; a task the proposal marks
// done on its own lands first and stays done; open and backlog reopen a row
// that was filed in bulk and never worked.
describe("orgProposals.decide plan close cascade and reopen (S9)", () => {
  const T = (id: string, over: Record<string, any> = {}) => ({ _id: `tasks_${id}`, user_id: ME, team_id: TEAM, workspace: WS, project_id: P, plan_id: "plans_loose", short_id: id, title: id, task_type: "task", status: "in_progress", priority: "medium", created_at: 1, updated_at: 1, conversation_ids: [], ...over });
  async function propose(db: any, changes: any[]) {
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec(changes) });
    return { ...r, ids: r.changes.map((c: any) => String(c.id)) };
  }

  test("closing a plan drops its still open tasks in the same apply and names them; a task marked done in the proposal is done, not dropped", async () => {
    const db = fixtures({
      tasks: [T("ct-1"), T("ct-2", { status: "open" }), T("ct-3", { status: "done", updated_at: 5 }), T("ct-10", { status: "in_review" }), T("ct-9", { conversation_ids: [S1] })],
      conversations: [
        { _id: S1, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Org analyzer", short_id: "jxanaly", session_id: "s1", project_path: "/repo", updated_at: NOW, created_at: 1, message_count: 3, active_task_id: "tasks_ct-9" },
        { _id: S_GROWTH, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Growth lead", short_id: "jxgrowt", session_id: "s_growth", project_path: "/repo/growth", standing_role_id: GROWTH, anchor_id: "anchors_growth", persistent: true, updated_at: NOW, created_at: 1, message_count: 0 },
      ],
    });
    const p = await propose(db, [
      change({ kind: "plan_status", plan: "pl-1", status: "abandoned", reason: "0 of 16 done, no session, untouched 25 days" }),
      change({ kind: "task_status", task: "ct-1", status: "done", reason: "its commit landed" }),
    ]);
    const ctx = ctxOf(db);
    // Accept all follows the apply order: the task's own status first, then the plan.
    const r = await performAcceptAll(ctx, ME as any, { proposal: p.short_id, provision: false });
    expect(r.results.map((x: any) => [x.line, x.status])).toEqual([["mark task ct-1 done", "applied"], ["mark plan pl-1 abandoned", "applied"]]);
    expect(r.results[1].note).toBe('pl-1 "Loose": active → abandoned; dropped its 3 open tasks: ct-2, ct-9, ct-10');
    expect((await db.get("plans_loose" as any)).status).toBe("abandoned");
    expect((await db.get("tasks_ct-1" as any)).status).toBe("done");
    expect((await db.get("tasks_ct-3" as any)).status).toBe("done");
    for (const id of ["ct-2", "ct-9", "ct-10"]) {
      const t = await db.get(`tasks_${id}` as any);
      expect(t.status, id).toBe("dropped");
      expect(t.closed_at, id).toBeGreaterThan(0);
    }
    // The session bound to a dropped task is released.
    expect((await db.get(S1 as any)).active_task_id).toBeUndefined();
    // The change row carries the cascade in its applied note for the pane.
    const rows = (await readProposal(ctx, ME as any, p.short_id)).changes;
    expect(rows.find((c: any) => c.line === "mark plan pl-1 abandoned").applied_note).toContain("dropped its 3 open tasks: ct-2, ct-9, ct-10");
  });

  test("marking a plan done with no open tasks leaves no cascade; marking it active never cascades", async () => {
    const db = fixtures({ tasks: [T("ct-1", { status: "done" }), T("ct-2", { status: "dropped" })] });
    const p = await propose(db, [change({ kind: "plan_status", plan: "pl-1", status: "done", reason: "every task closed" })]);
    const r = await performDecideChange(ctxOf(db), ME as any, { change_id: p.ids[0], verdict: "accept", provision: false });
    expect(r.note).toBe('pl-1 "Loose": active → done');
  });

  test("re-asserting done on a plan already done sweeps the rows still open under it; a suggestion under it is left alone", async () => {
    const db = fixtures({
      plans: [{ _id: "plans_loose", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pl-1", title: "Loose", status: "done", created_at: 1, updated_at: 1 }],
      tasks: [T("ct-1", { status: "open" }), T("ct-2", { status: "done" }), T("ct-3", { status: "open", source: "insight", triage_status: "suggested" })],
    });
    const p = await propose(db, [change({ kind: "plan_status", plan: "pl-1", status: "done", reason: "done months ago, one row still open" })]);
    const r = await performDecideChange(ctxOf(db), ME as any, { change_id: p.ids[0], verdict: "accept", provision: false });
    expect(r.note).toBe("pl-1 is already done; dropped its 1 open task: ct-1");
    expect((await db.get("tasks_ct-1" as any)).status).toBe("dropped");
    expect((await db.get("tasks_ct-3" as any)).status).toBe("open");
    expect((await db.get("plans_loose" as any)).status).toBe("done");
  });

  test("open and backlog put a never worked in progress row back through the team status rule", async () => {
    const db = fixtures({ tasks: [T("ct-1"), T("ct-2", { started_at: 5 })] });
    const p = await propose(db, [
      change({ kind: "task_status", task: "ct-1", status: "open", reason: "in progress, no session 14d" }),
      change({ kind: "task_status", task: "ct-2", status: "backlog", reason: "in progress, no session 14d" }),
    ]);
    const ctx = ctxOf(db);
    expect(await performDecideChange(ctx, ME as any, { change_id: p.ids[0], verdict: "accept", provision: false })).toMatchObject({ status: "applied", note: 'ct-1 "ct-1": in_progress → open' });
    const t = await db.get("tasks_ct-1" as any);
    expect(t.status).toBe("open");
    expect(t.closed_at).toBeUndefined();
    expect(t.review_verdict).toBeUndefined();
    // Backlog is a status category of every board (shared/tasks/statuses), so
    // it is always a valid write; a team's own status names refine it.
    expect(await performDecideChange(ctx, ME as any, { change_id: p.ids[1], verdict: "accept", provision: false })).toMatchObject({ status: "applied", note: 'ct-2 "ct-2": in_progress → backlog' });
    const b = await db.get("tasks_ct-2" as any);
    expect(b.status).toBe("backlog");
    expect(b.status_id).toBeUndefined();
  });
});

// Supersession (S4): a newer review names the proposal it replaces at
// create. Only the older proposal's own author may: the same session, the
// same role, a role over a session that spoke for it, the same person. The
// older row is stamped back and both reads carry both pointers, so the pane
// can say "Replaced by op-2" and offer Withdraw, which stays the human gate.
describe("supersession", () => {
  const specA = (title = "A") => spec([change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } })], { title });

  test("the same session replaces its own earlier proposal; both reads carry both pointers", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const older = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: specA("Older") });
    const newer = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: specA("Newer"), supersedes: older.short_id });
    expect(newer.supersedes).toMatchObject({ short_id: older.short_id, status: "open" });
    const olderRow = await readProposal(ctx, ME as any, older.short_id);
    const newerRow = await readProposal(ctx, ME as any, newer.short_id);
    expect(olderRow.superseded_by).toMatchObject({ id: newer.id, short_id: newer.short_id, status: "open" });
    expect(olderRow.supersedes).toBeUndefined();
    expect(newerRow.supersedes).toMatchObject({ id: older.id, short_id: older.short_id });
    expect(newerRow.superseded_by).toBeUndefined();
    const listed = await listProposals(ctx, ME as any, { team_id: TEAM });
    expect(listed.find((p: any) => p.short_id === older.short_id).superseded_by.short_id).toBe(newer.short_id);
    expect(listed.find((p: any) => p.short_id === newer.short_id).supersedes.short_id).toBe(older.short_id);
    // Both stay open: withdrawing the older one is the person's act.
    expect([olderRow.status, newerRow.status]).toEqual(["open", "open"]);
    expect(await performWithdrawProposal(ctx, ME as any, { proposal: older.short_id })).toEqual({ proposal: older.short_id, status: "withdrawn" });
    expect((await readProposal(ctx, ME as any, newer.short_id)).supersedes.status).toBe("withdrawn");
  });

  test("a role replaces its own proposal and one its standing session posted as a plain session; the same person replaces their own", async () => {
    const db = fixtures({ org_proposals: [
      { _id: "org_proposals_old", short_id: "op-90", team_id: TEAM, author: { kind: "session", id: S_GROWTH }, created_by: ME, title: "Standing session, before it spoke as the role", summary_md: "x", mode: "review", status: "open", created_at: 1, updated_at: 1 },
    ] });
    const ctx = ctxOf(db);
    const byRole = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s_growth", spec: specA("Role 1") });
    expect(byRole.author.kind).toBe("role");
    const again = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s_growth", spec: specA("Role 2"), supersedes: byRole.short_id });
    expect(again.supersedes.short_id).toBe(byRole.short_id);
    const overSession = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s_growth", spec: specA("Role 3"), supersedes: "op-90" });
    expect(overSession.supersedes.short_id).toBe("op-90");
    expect((await db.get("org_proposals_old")).superseded_by).toBe(overSession.id);
    const byMe = await performCreateProposal(ctx, ME as any, { spec: specA("Mine") });
    const byMeAgain = await performCreateProposal(ctx, ME as any, { spec: specA("Mine 2"), supersedes: byMe.short_id });
    expect(byMeAgain.supersedes.short_id).toBe(byMe.short_id);
  });

  test("an author that does not own the older proposal is refused, as are another workspace and a closed one", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const bySession = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: specA("Session") });
    const byRole = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s_growth", spec: specA("Role") });
    const personal = await performCreateProposal(ctx, ME as any, { spec: specA("Personal") });
    await expect(performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s_growth", spec: specA("x"), supersedes: bySession.short_id })).rejects.toThrow("was not posted by this author");
    await expect(performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: specA("x"), supersedes: byRole.short_id })).rejects.toThrow("was not posted by this author");
    await expect(performCreateProposal(ctx, ME as any, { team_id: TEAM, spec: specA("x"), supersedes: bySession.short_id })).rejects.toThrow("was not posted by this author");
    await expect(performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: specA("x"), supersedes: personal.short_id })).rejects.toThrow("is in another workspace");
    await expect(performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: specA("x"), supersedes: "op-404" })).rejects.toThrow("proposal not found");
    await performWithdrawProposal(ctx, ME as any, { proposal: bySession.short_id, from_session: "s1" });
    await expect(performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: specA("x"), supersedes: bySession.short_id })).rejects.toThrow("is withdrawn");
    // Nothing was stamped by a refusal.
    expect((await readProposal(ctx, ME as any, byRole.short_id)).superseded_by).toBeUndefined();
  });
});
