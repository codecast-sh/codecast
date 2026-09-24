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
  readProposalOrigin,
  readProposal, performBreachSnapshot, performWriteBreaches,
  performReviseProposal, performSayInThread, formatProposalMessage, callerIsAuthor, performDecideAsk } from "./orgProposals";

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
    expect(d.options.map((o: any) => o.label)).toEqual(["Got it, I will review it on the org page", "Not now"]);
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

  test("a record change carries its record's title: filled from the record at post when the spec left it out, only inside the workspace, never over the analyzer's own", async () => {
    const db = fixtures({
      tasks: [
        { _id: "tasks_ct-1", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "ct-1", title: "Fix the auth race", task_type: "task", status: "open", priority: "medium", created_at: 1, updated_at: 1 },
        { _id: "tasks_ct-2", user_id: ME, team_id: "teams_other", workspace: "team:teams_other", short_id: "ct-2", title: "Another team's task", task_type: "task", status: "open", priority: "medium", created_at: 1, updated_at: 1 },
      ],
      plans: [
        { _id: "plans_loose", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pl-1", title: "Loose", status: "active", doc_id: "docs_loose", created_at: 1, updated_at: 1 },
        { _id: "plans_second", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pl-2", title: "Second plan", status: "active", created_at: 1, updated_at: 1 },
      ],
    });
    const r = await propose(db, [
      change({ kind: "task_status", task: "ct-1", status: "done", reason: "its commit landed" }),
      change({ kind: "task_status", task: "ct-2", status: "done", reason: "its commit landed" }),
      change({ kind: "plan_status", plan: "pl-1", status: "done", reason: "every task closed", title: "What the analyzer called it" }),
      change({ kind: "project_status", project: "Billing", status: "paused", reason: "no commits in 30 days" }),
    ]);
    const stored = await Promise.all(r.ids.map((id: string) => db.get(id as any)));
    expect(stored.map((c: any) => c.change.title)).toEqual(["Fix the auth race", undefined, "What the analyzer called it", undefined]);
    // The line the CLI prints keeps the id; the page's line is the contract's changeLine.
    expect(r.changes[0].line).toBe("mark task ct-1 done");
    // A revise's add is filled the same way.
    const rev = await performReviseProposal(ctxOf(db), ME as any, { proposal: r.short_id, from_session: "s1", ops: [{ op: "add", change: change({ kind: "plan_status", plan: "pl-2", status: "abandoned", reason: "nobody worked it" }) }] });
    const added = await db.get(rev.changes[rev.changes.length - 1].id as any);
    expect(added.change.title).toBe("Second plan");
  });

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
    expect(await decide(4)).toMatchObject({ status: "applied", note: "@growth: turned on starting work on its own" });
    expect((await db.get(GROWTH as any)).trust).toBe("direct"); // decide reads as on and is written as direct (S23.1)
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
    expect(() => editedChange({ kind: "trust", handle: "growth", trust: "understand" }, { trust: "god" })).toThrow("autonomy on is true or false");
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
    expect((await db.get(GROWTH as any)).trust).toBe("direct"); // decide is never written again (S23.1)
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
    expect(await performWriteBreaches(ctx, rows, NOW)).toBe(1);
    expect((await db.get(GROWTH as any)).overload_streak).toBe(1);
    // The next review, one window later (a second post inside the window does not tick).
    const NEXT = NOW + 8 * 86_400_000;
    rows = await performBreachSnapshot(ctx, ME as any, TEAM, NEXT);
    expect(rows).toEqual([{ role_id: GROWTH as any, overload_streak: 2 }]);
    await performWriteBreaches(ctx, rows, NEXT);
    expect(await performWriteBreaches(ctx, rows, NEXT)).toBe(0);
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
    // status vocabulary and stamps the verdict.
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

// A Chief of Staff group: role, routine and adopt in one proposal (S6, S12).
// The role must not provision a fresh session when its adopt rides in the
// same proposal: that left two root agents while the note claimed the anchor
// was adopted. Adopt runs before the routine, which needs the seated session.
describe("orgProposals.acceptAll seats a role through its adopt, never beside it", () => {
  const group = () => [
    change({ kind: "role", name: "Chief of Staff", handle: "chief-of-staff", tenure: { kind: "standing" }, reports_to: "me" }),
    change({ kind: "routine", handle: "chief-of-staff", title: "Company review", prompt: "Run cast org review", every: "7d" }),
    change({ kind: "adopt", handle: "chief-of-staff", conversation: "jxanaly" }),
  ];

  test("role then adopt then routine: one standing session, the adopted one", async () => {
    const db = fixtures({ bot_users: [], managed_sessions: [], daemon_commands: [], devices: [], messages: [], pending_messages: [], role_wakes: [], role_wake_outbox: [] });
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec(group()) });
    const out = await performAcceptAll(ctxOf(db), ME as any, { proposal: r.short_id, provision: true });
    expect(out.results.map((x: any) => [x.line.split(" ")[0], x.status])).toEqual([["create", "applied"], ["adopt", "applied"], ["routine", "applied"]]);
    expect(out.results[0].note).toContain("its standing session is the adopt of jxanaly in this proposal");
    const role = (db as any)._tables.org_roles.find((x: any) => x.handle === "chief-of-staff");
    const standing = (db as any)._tables.conversations.filter((c: any) => String(c.standing_role_id ?? "") === String(role._id));
    expect(standing.map((c: any) => c.short_id)).toEqual(["jxanaly"]);
    const anchors = (db as any)._tables.anchors.filter((a: any) => String(a.org_role_id ?? "") === String(role._id));
    expect(anchors).toHaveLength(1);
    expect(String(anchors[0].conversation_id)).toBe(S1);
  });

  test("skipping the adopt of a role created awaiting it provisions that seat then and says so; the rows name the dependency", async () => {
    const db = fixtures({ bot_users: [], managed_sessions: [], daemon_commands: [], devices: [], messages: [], pending_messages: [], role_wakes: [], role_wake_outbox: [] });
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec(group()) });
    expect(r.changes.map((c: any) => c.depends)).toEqual([
      "created without a standing session; #3 seats it",
      "runs on the session #3 seats",
      "seats the role #1 creates; skip it and that role is provisioned a fresh session instead",
    ]);
    const ctx = ctxOf(db);
    // Accept the role alone: no session yet.
    const role = await performDecideChange(ctx, ME as any, { change_id: String(r.changes[0].id), verdict: "accept", provision: true });
    expect(role.note).toContain("its standing session is the adopt of jxanaly in this proposal");
    const created = (db as any)._tables.org_roles.find((x: any) => x.handle === "chief-of-staff");
    expect(created.anchor_id).toBeUndefined();
    // Skip the adopt: the seat is provisioned fresh, and the note says why.
    const skip = await performDecideChange(ctx, ME as any, { change_id: String(r.changes[2].id), verdict: "skip", provision: true });
    expect(skip.status).toBe("skipped");
    expect(skip.note).toContain("a fresh standing session was provisioned for it instead");
    const after = (db as any)._tables.org_roles.find((x: any) => x.handle === "chief-of-staff");
    expect(after.anchor_id).toBeDefined();
    const standing = (db as any)._tables.conversations.filter((c: any) => String(c.standing_role_id ?? "") === String(after._id));
    expect(standing).toHaveLength(1);
    expect(standing[0].short_id).not.toBe("jxanaly");
    expect((await readProposal(ctx, ME as any, r.short_id)).changes[2].applied_note).toContain("provisioned for it instead");
    // The routine now has a session to run on.
    expect((await performDecideChange(ctx, ME as any, { change_id: String(r.changes[1].id), verdict: "accept", provision: true })).status).toBe("applied");
  });

  test("an adopt onto a role that already has a standing session fails, stays decidable, and says why", async () => {
    const db = fixtures({ bot_users: [], managed_sessions: [], daemon_commands: [], devices: [], messages: [], pending_messages: [], role_wakes: [], role_wake_outbox: [] });
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "adopt", handle: "growth", conversation: "jxanaly" })]) });
    const res = await performDecideChange(ctxOf(db), ME as any, { change_id: String(r.changes[0].id), verdict: "accept", provision: true });
    expect(res.status).toBe("failed");
    expect(res.note).toContain("already has a standing session, so jxanaly was not adopted");
    expect((await db.get(S1 as any)).standing_role_id).toBeUndefined();
  });

  // org-roles-run-work.md R2: a long running session proposed as a role is one
  // change. Accepting it names the session; there is no adopt to skip.
  test("a role that names its session is seated on it in the same apply, with or without provision, and its routine runs there", async () => {
    const db = fixtures({ bot_users: [], managed_sessions: [], daemon_commands: [], devices: [], messages: [], pending_messages: [], role_wakes: [], role_wake_outbox: [] });
    const named = [
      change({ kind: "role", name: "Market growth mandate", handle: "market-growth", seat: { existing: "jxanaly", title: "Market growth mandate", helpers: 391 }, tenure: { kind: "standing" }, reports_to: "me" }),
      change({ kind: "routine", handle: "market-growth", title: "Daily run", prompt: "Run the daily pass", every: "1d" }),
    ];
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec(named) });
    expect(r.changes.map((c: any) => c.depends)).toEqual([undefined, "runs on the session #1 seats"]);
    const out = await performAcceptAll(ctxOf(db), ME as any, { proposal: r.short_id, provision: false });
    expect(out.results.map((x: any) => x.status)).toEqual(["applied", "applied"]);
    expect(out.results[0].note).toContain("jxanaly is its standing session, with its history and its helper sessions as they were");
    const role = (db as any)._tables.org_roles.find((x: any) => x.handle === "market-growth");
    const standing = (db as any)._tables.conversations.filter((c: any) => String(c.standing_role_id ?? "") === String(role._id));
    expect(standing.map((c: any) => c.short_id)).toEqual(["jxanaly"]);
  });

  test("a role that names its session and no parent reports to the person who runs the session, not to whoever accepts", async () => {
    const db = fixtures({ bot_users: [], managed_sessions: [], daemon_commands: [], devices: [], messages: [], pending_messages: [], role_wakes: [], role_wake_outbox: [] });
    await db.patch(S1 as any, { owner_user_id: MATE });
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "role", name: "Market growth mandate", handle: "market-growth", seat: { existing: "jxanaly" } })]) });
    const res = await performDecideChange(ctxOf(db), ME as any, { change_id: String(r.changes[0].id), verdict: "accept", provision: false });
    expect(res.status).toBe("applied");
    const role = (db as any)._tables.org_roles.find((x: any) => x.handle === "market-growth");
    expect(role.reports_to).toEqual({ kind: "user", user_id: MATE });
  });

  test("a role that names a session nobody can find fails with the reason, and no fresh session is started for it", async () => {
    const db = fixtures({ bot_users: [], managed_sessions: [], daemon_commands: [], devices: [], messages: [], pending_messages: [], role_wakes: [], role_wake_outbox: [] });
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "role", name: "Ghost", handle: "ghost-role", seat: { existing: "jxnosuch" }, reports_to: "me" })]) });
    await expect(performDecideChange(ctxOf(db), ME as any, { change_id: String(r.changes[0].id), verdict: "accept", provision: true })).rejects.toThrow("Session not found");
    expect((db as any)._tables.conversations.filter((c: any) => c.standing_role_id).map((c: any) => c.short_id)).toEqual(["jxgrowt"]);
  });
});

// Review findings, each with its regression: a streak ticks once per review
// window; accept all applies in chunks that each commit; a retire of a handle
// nobody holds fails instead of reading applied; a close clears a stuck hand.
describe("orgProposals review regressions", () => {
  const blocked = (i: number) => ({ _id: `tasks_b${i}`, user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: `ct-b${i}`, title: `t${i}`, task_type: "task", status: "in_progress", execution_status: "blocked", priority: "medium", created_at: 1, updated_at: NOW });

  test("the breach streak ticks once per review window, and a run broken for two windows restarts at 1", async () => {
    const { BREACH_WINDOW_MS } = await import("./orgProposals");
    const db = fixtures({ tasks: Array.from({ length: 4 }, (_, i) => blocked(i)) });
    const ctx = ctxOf(db);
    await performWriteBreaches(ctx, await performBreachSnapshot(ctx, ME as any, TEAM, NOW), NOW);
    expect((await db.get(GROWTH as any)).overload_streak).toBe(1);
    // A second review an hour later (withdrawn and reposted): still one.
    expect(await performBreachSnapshot(ctx, ME as any, TEAM, NOW + 3_600_000)).toEqual([{ role_id: GROWTH as any, overload_streak: 1 }]);
    // The next window: two.
    const next = NOW + BREACH_WINDOW_MS + 1;
    await performWriteBreaches(ctx, await performBreachSnapshot(ctx, ME as any, TEAM, next), next);
    expect((await db.get(GROWTH as any)).overload_streak).toBe(2);
    // Two windows of silence, then a breach: a new run.
    expect(await performBreachSnapshot(ctx, ME as any, TEAM, next + 2 * BREACH_WINDOW_MS + 1)).toEqual([{ role_id: GROWTH as any, overload_streak: 1 }]);
  });

  test("accept all applies one chunk, schedules the rest with what it tried, and a failed row is not retried", async () => {
    const { ACCEPT_ALL_CHUNK } = await import("./orgProposals");
    const n = ACCEPT_ALL_CHUNK + 3;
    const db = fixtures({ tasks: Array.from({ length: n }, (_, i) => ({ ...blocked(i), execution_status: undefined })) });
    const changes = [change({ kind: "retire", handle: "nobody" }), ...Array.from({ length: n }, (_, i) => change({ kind: "task_status", task: `ct-b${i}`, status: "open", reason: "never worked" }))];
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec(changes) });
    const scheduled: any[] = [];
    const ctx = { ...ctxOf(db), scheduler: { runAfter: async (_d: number, _f: unknown, args: any) => { scheduled.push(args); } } };
    const first = await performAcceptAll(ctx, ME as any, { proposal: r.short_id, provision: false });
    expect(first.results).toHaveLength(ACCEPT_ALL_CHUNK);
    expect(first.remaining).toBe(n + 1 - ACCEPT_ALL_CHUNK);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].tried).toHaveLength(ACCEPT_ALL_CHUNK);
    // The continuation: the same act, no human gate, the rest applied, the failed retire left alone.
    const second = await performAcceptAll(ctxOf(db), ME as any, { proposal: r.short_id, provision: false, tried: scheduled[0].tried, continuation: true, log_head: scheduled[0].log_head });
    const batches = await db.query("org_change_batches").collect();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ gesture: "accept_all", row_count: n });
    expect(second.remaining).toBe(0);
    expect(second.results.length + first.results.length).toBe(n + 1);
    const rows = (await readProposal(ctxOf(db), ME as any, r.short_id)).changes;
    expect(rows.filter((c: any) => c.status === "applied")).toHaveLength(n);
    const retire = rows.find((c: any) => c.line === "retire @nobody");
    expect(retire.status).toBe("failed");
    expect(retire.applied_note).toContain("No live role @nobody");
  });

  test("closing a task clears a hand's blocked report, so a closed row never reads as a live stall", async () => {
    const db = fixtures({ tasks: [blocked(0)] });
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "task_status", task: "ct-b0", status: "dropped", reason: "abandoned" })]) });
    await performDecideChange(ctxOf(db), ME as any, { change_id: String(r.changes[0].id), verdict: "accept", provision: false });
    const t = await db.get("tasks_b0" as any);
    expect(t.status).toBe("dropped");
    expect(t.execution_status).toBeUndefined();
  });
});

// Where a proposal came from (S15), as the queue card reads it: the author
// named, and no change rows. Same access rule as the full read.
describe("the light origin read", () => {
  test("names a session author and a role author, carries no changes, and refuses a stranger", async () => {
    const db = fixtures({ users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }, { _id: "u".repeat(31) + "x", name: "Stranger", email: "s@x.ai" }] });
    const ctx = ctxOf(db);
    const bySession = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "retire", handle: "growth" })]) });
    const byRole = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s_growth", spec: spec([change({ kind: "trust", handle: "growth", trust: "decide" })]) });
    const a = await readProposalOrigin(ctx, ME as any, bySession.short_id);
    expect(a).toEqual({ short_id: bySession.short_id, status: "open", author: { kind: "session", id: S1, title: "Org analyzer", name: "Org analyzer", short_id: "jxanaly" } });
    expect(Object.keys(a!)).not.toContain("changes");
    const b = await readProposalOrigin(ctx, ME as any, byRole.short_id);
    expect(b!.author).toMatchObject({ kind: "role", id: GROWTH, name: "Growth lead", handle: "growth", short_id: "or-1" });
    expect(await readProposalOrigin(ctx, ("u".repeat(31) + "x") as any, bySession.short_id)).toBeNull();
    expect(await readProposalOrigin(ctx, ME as any, "op-404")).toBeNull();
  });
});

// ── S18: the conversation is part of the proposal ───────────────────────────
// The author revises its own open proposal (remove, amend, add) on changes
// nobody has decided; the proposal names the thread a person talks to; a
// person's words ride the pending message rail into it, naming the change.

describe("orgProposals.revise", () => {
  const three = () => spec([
    change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } }),
    change({ kind: "trust", handle: "growth", trust: "decide" }),
    change({ kind: "retire", handle: "growth" }),
  ]);
  const seeded = async (from_session = "s1") => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session, spec: three() });
    return { db, r };
  };
  // What a page that read the proposal after its revises sends with a verdict (S18).
  const seenNow = async (db: any) => ({ revised_at: Math.max(0, ...(await db.query("org_proposal_changes").collect()).map((c: any) => c.revision?.at ?? 0)) });

  test("the posting session removes, amends and adds; rows keep their ids, the journal and the stamps say what happened, counts shrink", async () => {
    const { db, r } = await seeded();
    const out = await performReviseProposal(ctxOf(db), ME as any, {
      proposal: "op-1", from_session: "s1",
      ops: [
        { op: "remove", seq: 3, note: "growth is not dead yet" },
        { op: "amend", seq: 1, edits: { caps: { wakes_per_day: 6 } }, rationale: "half the wakes", note: "halved" },
        { op: "add", change: change({ kind: "scope", handle: "growth", add: ["pr-2"] }) },
      ],
    });
    expect(out.proposal).toBe("op-1");
    expect(out.revisions.map((j: any) => [j.op, j.seq, j.line, j.was, j.note])).toEqual([
      ["removed", 3, "retire @growth", undefined, "growth is not dead yet"],
      ["amended", 1, "budget @growth wakes 6/day", "budget @growth wakes 12/day", "halved"],
      ["added", 4, "scope @growth +pr-2", undefined, undefined],
    ]);
    expect(out.revisions.every((j: any) => j.by.kind === "session" && j.by.id === S1 && j.at > 0)).toBe(true);
    // The rows: the removed one stays as `removed`, the amended one keeps its
    // id and `before`, the added one is a new row with the next seq.
    const rows = await db.query("org_proposal_changes").collect();
    const byId = Object.fromEntries(r.changes.map((c: any) => [c.seq, c.id]));
    expect(rows.find((c: any) => c._id === byId[3])).toMatchObject({ status: "removed", revision: { kind: "removed", note: "growth is not dead yet" } });
    expect(rows.find((c: any) => c._id === byId[1])).toMatchObject({ status: "proposed", change: { kind: "budget", caps: { wakes_per_day: 6 } }, rationale: "half the wakes", revision: { kind: "amended", note: "halved", before: { kind: "budget", caps: { wakes_per_day: 12 } } } });
    expect(rows.find((c: any) => c.seq === 4)).toMatchObject({ status: "proposed", change: { kind: "scope", handle: "growth" }, revision: { kind: "added", note: "added" } });
    expect(out.counts).toEqual({ total: 3, decided: 0, applied: 0, failed: 0, skipped: 0 });
    // The proposal carries the journal and stays open; the read hands it back.
    const read = await readProposal(ctxOf(db), ME as any, "op-1");
    expect(read.status).toBe("open");
    expect(read.revisions.length).toBe(3);
    expect(read.counts.total).toBe(3);
    // The queue card now says three changes and lists what is left.
    const d = await db.get(r.decision.id);
    expect(d.question).toBe("Org analyzer proposes 3 changes: Reshape growth");
    expect(d.context_md).toContain("- scope @growth +pr-2");
    expect(d.context_md).not.toContain("- retire @growth");
  });

  test("a default note names what happened when the author gives none", async () => {
    const { db } = await seeded();
    const out = await performReviseProposal(ctxOf(db), ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "remove", seq: 3 }, { op: "amend", seq: 1, rationale: "rewritten" }, { op: "amend", seq: 2, edits: { trust: "understand" } }] });
    expect(out.changes.map((c: any) => c.revision?.note)).toEqual(["rationale rewritten", "was: autonomy @growth on", "removed"]);
    expect(out.changes.map((c: any) => c.line)).toEqual(["budget @growth wakes 12/day", "autonomy @growth off", "retire @growth"]);
  });

  test("the role's standing session revises the role's proposal; a person revises their own without a session", async () => {
    const db = fixtures();
    const byRole = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s_growth", spec: three() });
    expect(byRole.author).toEqual({ kind: "role", id: GROWTH });
    const out = await performReviseProposal(ctxOf(db), ME as any, { proposal: byRole.short_id, from_session: "s_growth", ops: [{ op: "remove", seq: 3 }] });
    expect(out.revisions[0]).toMatchObject({ op: "removed", by: { kind: "role", id: GROWTH } });
    const byMe = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, spec: three() });
    expect((await performReviseProposal(ctxOf(db), ME as any, { proposal: byMe.short_id, ops: [{ op: "remove", seq: 2 }] })).counts.total).toBe(2);
    // Anyone else, by name.
    await expect(performReviseProposal(ctxOf(db), ME as any, { proposal: byMe.short_id, from_session: "s1", ops: [{ op: "remove", seq: 1 }] })).rejects.toThrow(`Only ${byMe.short_id}'s author may revise it`);
    await expect(performReviseProposal(ctxOf(db), ME as any, { proposal: byRole.short_id, from_session: "s1", ops: [{ op: "remove", seq: 1 }] })).rejects.toThrow("author may revise it");
    await expect(performReviseProposal(ctxOf(db), ME as any, { proposal: byRole.short_id, ops: [{ op: "remove", seq: 1 }] })).rejects.toThrow("author may revise it");
    await expect(performReviseProposal(ctxOf(db), MATE as any, { proposal: byMe.short_id, ops: [{ op: "remove", seq: 1 }] })).rejects.toThrow("author may revise it");
    expect(await callerIsAuthor(ctxOf(db), ME as any, await db.get(byRole.id), "s_growth")).toBe(true);
    expect(await callerIsAuthor(ctxOf(db), ME as any, await db.get(byRole.id), "s1")).toBe(false);
  });

  test("refused: a closed proposal, a decided change by name, an unknown change, a bad edit, a bad op, a repeated subject; and one bad op writes nothing", async () => {
    const { db, r } = await seeded();
    const ctx = ctxOf(db);
    // A decided change is named in the refusal, and the whole revise writes nothing.
    await performDecideChange(ctx, ME as any, { change_id: String(r.changes[1].id), verdict: "skip" });
    await expect(performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "remove", seq: 3 }, { op: "amend", seq: 2, edits: { trust: "direct" } }] }))
      .rejects.toThrow("amend: op-1#2 (autonomy @growth on) is already skipped; a revise never touches a change a person decided");
    expect((await db.get(r.changes[2].id)).status).toBe("proposed");
    expect((await db.get(r.id)).revisions).toBeUndefined();
    await expect(performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "remove", seq: 2 }] })).rejects.toThrow("is already skipped");
    await expect(performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "remove", seq: 9 }] })).rejects.toThrow("remove: op-1#9 does not exist");
    // The amend runs the edit validator, so a revised change cannot be invalid.
    await expect(performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "amend", seq: 1, edits: { caps: { wakes_per_day: -1 } } }] })).rejects.toThrow("The edited change is not valid");
    await expect(performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "amend", seq: 1 }] })).rejects.toThrow("amend: give edits, a rationale, or both");
    await expect(performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "add", change: { change: { kind: "nope" }, rationale: "x" } }] })).rejects.toThrow("ops[0]: add:");
    await expect(performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "explode", seq: 1 }] })).rejects.toThrow("op is one of remove, amend, add");
    await expect(performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [] })).rejects.toThrow("ops is a non-empty list");
    // One change per subject, the create rule, holds through a revise.
    await expect(performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "add", change: change({ kind: "retire", handle: "growth" }) }] })).rejects.toThrow("add: retire @growth repeats #3: one change per subject");
    // Removing frees the subject for a fresh add in the same revise.
    const out = await performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "remove", seq: 3 }, { op: "add", change: change({ kind: "retire", handle: "growth" }, "again") }] });
    expect(out.changes.map((c: any) => [c.seq, c.status])).toEqual([[1, "proposed"], [2, "skipped"], [3, "removed"], [4, "proposed"]]);
    // Closed: withdrawn, then refused.
    await performWithdrawProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1" });
    await expect(performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "remove", seq: 1 }] })).rejects.toThrow("op-1 is withdrawn; only an open proposal can be revised");
    await expect(performReviseProposal(ctx, ME as any, { proposal: "op-77", from_session: "s1", ops: [{ op: "remove", seq: 1 }] })).rejects.toThrow("Proposal not found: op-77");
  });

  test("removing the last undecided change leaves the proposal open; a removed change is never decided, and the next decision resolves what is left", async () => {
    const { db, r } = await seeded();
    const ctx = ctxOf(db);
    await performDecideChange(ctx, ME as any, { change_id: String(r.changes[1].id), verdict: "skip" });
    await performDecideChange(ctx, ME as any, { change_id: String(r.changes[2].id), verdict: "skip" });
    const out = await performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "remove", seq: 1 }] });
    expect(out.status).toBe("open");
    expect((await db.get(r.id)).status).toBe("open");
    expect(out.counts).toEqual({ total: 2, decided: 2, applied: 0, failed: 0, skipped: 2 });
    await expect(performDecideChange(ctx, ME as any, { change_id: String(r.changes[0].id), verdict: "skip" })).rejects.toThrow("op-1#1 is already removed");
    // The author asks again on a subject the person already skipped (#2 was
    // trust @growth); the person skips that too, and the decision resolves.
    await performReviseProposal(ctx, ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "add", change: change({ kind: "trust", handle: "growth", trust: "direct" }) }] });
    const added = (await db.query("org_proposal_changes").collect()).find((c: any) => c.seq === 4);
    expect(await performDecideChange(ctx, ME as any, { change_id: String(added._id), verdict: "skip", seen: await seenNow(db) })).toMatchObject({ resolved: true });
    expect((await db.get(r.id)).status).toBe("resolved");
    // Accept all over a proposal with nothing left to decide is a person's act, and it resolves; a revise never does.
    const { db: db2, r: r2 } = await seeded();
    await performReviseProposal(ctxOf(db2), ME as any, { proposal: "op-1", from_session: "s1", ops: [{ op: "remove", seq: 1 }, { op: "remove", seq: 2 }, { op: "remove", seq: 3 }] });
    expect((await db2.get(r2.id)).status).toBe("open");
    expect(await performAcceptAll(ctxOf(db2), ME as any, { proposal: "op-1", provision: false, seen: await seenNow(db2) })).toMatchObject({ resolved: true });
  });
});

describe("orgProposals thread (S18)", () => {
  test("a session's proposal points at its conversation, a role's at its standing session, a person's at nothing; rows from before the field derive it", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const bySession = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "retire", handle: "growth" })]) });
    const byRole = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s_growth", spec: spec([change({ kind: "retire", handle: "growth" })]) });
    const byMe = await performCreateProposal(ctx, ME as any, { team_id: TEAM, spec: spec([change({ kind: "retire", handle: "growth" })]) });
    expect((await db.get(bySession.id)).thread_conversation_id).toBe(S1);
    expect((await db.get(byRole.id)).thread_conversation_id).toBe(S_GROWTH);
    expect((await db.get(byMe.id)).thread_conversation_id).toBeUndefined();
    expect((await readProposal(ctx, ME as any, bySession.short_id)).thread).toEqual({ conversation_id: S1, short_id: "jxanaly", title: "Org analyzer" });
    expect((await readProposal(ctx, ME as any, byRole.short_id)).thread).toEqual({ conversation_id: S_GROWTH, short_id: "jxgrowt", title: "Growth lead" });
    expect((await readProposal(ctx, ME as any, byMe.short_id)).thread).toBeNull();
    const listed = await listProposals(ctx, ME as any, { team_id: TEAM });
    expect(listed.map((p: any) => [p.short_id, p.thread?.conversation_id ?? null]).sort()).toEqual([[bySession.short_id, S1], [byRole.short_id, S_GROWTH], [byMe.short_id, null]]);
    // Before the field: derived from the author, so an older open proposal still has its thread.
    await db.patch(bySession.id, { thread_conversation_id: undefined });
    await db.patch(byRole.id, { thread_conversation_id: undefined });
    expect((await readProposal(ctx, ME as any, bySession.short_id)).thread.conversation_id).toBe(S1);
    expect((await readProposal(ctx, ME as any, byRole.short_id)).thread.conversation_id).toBe(S_GROWTH);
  });
});

describe("orgProposals.say", () => {
  test("the words land in the thread as a turn, wrapped like a chat mention, naming the proposal and the change", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const p = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } }), change({ kind: "retire", handle: "growth" })]) });
    const out = await performSayInThread(ctx, ME as any, { proposal: p.short_id, change: 2, body: "growth is dead, drop it", client_id: "c1" });
    expect(out).toMatchObject({ proposal: "op-1", change: 2, thread: { conversation_id: S1, short_id: "jxanaly" } });
    const row = await db.get(out.message_id);
    expect(row).toMatchObject({ conversation_id: S1, from_user_id: ME, owner_user_id: ME, client_id: "c1", status: "pending" });
    expect(row.content).toBe(formatProposalMessage({ short_id: "op-1", title: "Reshape growth", change: { seq: 2, line: "retire @growth" }, from: "Me", body: "growth is dead, drop it" }));
    expect(row.content.split("\n")).toEqual([
      '<proposal-message proposal="op-1" change="2" from="Me">',
      'About op-1 change 2 ("retire @growth"):',
      "",
      "growth is dead, drop it",
      "",
      "(Reply here; the org page shows this thread beside op-1. To change the proposal run `cast org revise op-1 --remove <n>`, `--amend <n> --edits '{...}'` or `--add change.json`. Accepting stays the person's.)",
      "</proposal-message>",
    ]);
    // No change named: the header names the proposal.
    const whole = await performSayInThread(ctx, ME as any, { proposal: p.short_id, body: "why growth at all?" });
    expect((await db.get(whole.message_id)).content).toContain('<proposal-message proposal="op-1" from="Me">\nAbout op-1 ("Reshape growth"):\n\nwhy growth at all?');
  });

  test("refused: a person's proposal has no agent to talk to, an unknown change, an empty body, a proposal the caller cannot read", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const byMe = await performCreateProposal(ctx, ME as any, { team_id: TEAM, spec: spec([change({ kind: "retire", handle: "growth" })]) });
    await expect(performSayInThread(ctx, ME as any, { proposal: byMe.short_id, body: "hi" })).rejects.toThrow("op-1 was posted by a person, so there is no agent to talk to about it");
    const p = await performCreateProposal(ctx, ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "retire", handle: "growth" })]) });
    await expect(performSayInThread(ctx, ME as any, { proposal: p.short_id, change: 5, body: "hi" })).rejects.toThrow("op-2#5 does not exist");
    await expect(performSayInThread(ctx, ME as any, { proposal: p.short_id, body: "  " })).rejects.toThrow("Message body is empty");
    await expect(performSayInThread(ctx, ME as any, { proposal: "op-9", body: "hi" })).rejects.toThrow("Proposal not found: op-9");
  });
});

// S19: a proposal is a few asks with its changes folded inside each. Create
// stores the author's asks, the reads return them resolved (stored, else
// derived), and deciding an ask is the accept all core narrowed to its seqs.
describe("orgProposals asks (S19)", () => {
  const asked = () => spec([
    change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } }),
    change({ kind: "projects", changes: [{ op: "create", title: "Platform" }] }),
    change({ kind: "file", plan: "pl-1", project: "Platform" }),
    change({ kind: "role", name: "Ops", handle: "ops", scope: { projects: ["pr-2"] } }),
  ], { asks: [
    { title: "Start a Platform area and file the loose plan under it", why: "The plan has no home.", effect: "One plan moves.", seqs: [3, 2] },
    { title: "Add an agent for billing", why: "Nobody watches it.", effect: "One more agent.", seqs: [4] },
    { title: "Let the growth agent start up more often", why: "It hit its limit.", effect: "12 starts a day.", seqs: [1] },
  ] });

  test("create stores the asks; get and list return them; a proposal without asks derives them on read", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: asked() });
    expect((await db.get(r.id)).asks.map((a: any) => a.seqs)).toEqual([[2, 3], [4], [1]]);
    const got = await readProposal(ctxOf(db), ME as any, r.short_id);
    expect(got.asks.map((a: any) => a.title)).toEqual(["Start a Platform area and file the loose plan under it", "Add an agent for billing", "Let the growth agent start up more often"]);
    expect((await listProposals(ctxOf(db), ME as any, { team_id: TEAM }))[0].asks.length).toBe(3);
    // No asks written: the records, each role and the rest derive.
    const plain = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "retire", handle: "growth" }), change({ kind: "file", plan: "pl-1", project: "pr-2" })]) });
    expect((await db.get(plain.id)).asks).toBeUndefined();
    expect((await readProposal(ctxOf(db), ME as any, plain.short_id)).asks.map((a: any) => [a.title, a.seqs])).toEqual([["Retire growth", [1]], ["1 smaller change: filing, goals and settings", [2]]]);
  });

  test("a spec whose asks leave a change out is refused at create, naming the change", async () => {
    const bad = asked(); bad.asks.pop();
    await expect(performCreateProposal(ctxOf(fixtures()), ME as any, { team_id: TEAM, from_session: "s1", spec: bad })).rejects.toThrow("changes[0] (budget @growth wakes 12/day) is in no ask");
  });

  test("accepting an ask applies only its changes, in apply order; skipping an ask skips only its changes; a session is refused", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: asked() });
    await expect(performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 0, verdict: "accept", from_session: "s_growth" })).rejects.toThrow("a person's act");
    await expect(performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 7, verdict: "accept" })).rejects.toThrow("has 3 asks; there is no ask 7");
    const out = await performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 0, verdict: "accept", provision: false });
    // The project is created before the plan is filed under it, whatever order the ask listed them in.
    expect(out.results.map((x: any) => [x.seq, x.status])).toEqual([[2, "applied"], [3, "applied"]]);
    expect(out).toMatchObject({ ask: 0, title: "Start a Platform area and file the loose plan under it", applied: 2, failed: 0, resolved: false });
    const batches = await db.query("org_change_batches").collect();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ gesture: "accept_ask", row_count: 2, ask: { index: 0, title: out.title } });
    const after = await readProposal(ctxOf(db), ME as any, r.short_id);
    expect(after.changes.map((c: any) => [c.seq, c.status])).toEqual([[1, "proposed"], [2, "applied"], [3, "applied"], [4, "proposed"]]);
    const skipped = await performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 1, verdict: "skip" });
    expect(skipped).toMatchObject({ skipped: 1, resolved: false });
    expect(skipped.results.map((x: any) => [x.seq, x.status])).toEqual([[4, "skipped"]]);
    expect((await db.query("org_roles").collect()).some((x: any) => x.handle === "ops")).toBe(false);
    const last = await performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 2, verdict: "accept", provision: false });
    expect(last).toMatchObject({ applied: 1, resolved: true });
  });

  test("a reply from an ask's card carries the ask: the index decideAsk takes in the tag, the card's number and title in the header, parsed back", async () => {
    const { parseProposalMessage } = await import("@codecast/shared/contracts");
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: asked() });
    const out = await performSayInThread(ctxOf(db), ME as any, { proposal: r.short_id, ask: 1, body: "billing is handled by the accountant, drop this", client_id: "c9" });
    expect(out).toMatchObject({ proposal: "op-1", ask: 1 });
    const content = (await db.get(out.message_id)).content;
    expect(content.split("\n").slice(0, 4)).toEqual([
      '<proposal-message proposal="op-1" ask="1" from="Me">',
      'About op-1 ask 2 ("Add an agent for billing"):',
      "",
      "billing is handled by the accountant, drop this",
    ]);
    expect(parseProposalMessage(content)).toEqual({ proposal: "op-1", change: null, ask: 1, from: "Me", about: 'About op-1 ask 2 ("Add an agent for billing"):', body: "billing is handled by the accountant, drop this" });
    await expect(performSayInThread(ctxOf(db), ME as any, { proposal: r.short_id, ask: 9, body: "x" })).rejects.toThrow("op-1 has no ask 9");
  });
});

// A verdict is read against the proposal as the page showed it (S18): the
// call carries `seen` (the latest revise the page had painted and, for an ask,
// the seqs its card held), and a proposal the author revised since is
// refused whole. Found by the adversarial review of pl-707 (jx75v5d): an ask
// was named by position only, and a revise that empties an earlier ask moves
// every later one up a place, so a stale Accept on "Trust growth" retired
// growth. The review's own test asserted that retirement; this is it, inverted.
describe("a verdict the author revised under the reader is refused (S18)", () => {
  const { latestOrgRevisionAt } = require("@codecast/shared/contracts/orgProposal");
  const threeAsks = () => spec(
    [
      change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } }),
      change({ kind: "trust", handle: "growth", trust: "decide" }),
      change({ kind: "retire", handle: "growth" }),
    ],
    { asks: [
      { title: "Raise growth's budget", why: "It hit its cap.", effect: "12 starts a day.", seqs: [1] },
      { title: "Trust growth to decide", why: "It has earned it.", effect: "Fewer confirmations.", seqs: [2] },
      { title: "Retire growth", why: "The area is folding.", effect: "The role and its session end.", seqs: [3] },
    ] },
  );
  /** What a page that painted `p` sends with a verdict on its ask `i`. */
  const seenOf = (p: any, i?: number) => ({ revised_at: latestOrgRevisionAt(p.changes), ...(i !== undefined ? { seqs: p.asks[i].seqs } : {}) });
  const growth = async (db: any) => (await db.query("org_roles").collect()).find((x: any) => x.handle === "growth");

  test("a stale accept on an ask whose position moved is refused; nothing is applied; a fresh read accepts what the person meant", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: threeAsks() });
    // The person opens the page: index 1 is "Trust growth to decide".
    const page = await readProposal(ctxOf(db), ME as any, r.short_id);
    expect(page.asks.map((a: any) => a.title)).toEqual(["Raise growth's budget", "Trust growth to decide", "Retire growth"]);
    const stale = seenOf(page, 1);
    expect(stale).toEqual({ revised_at: 0, seqs: [2] });
    // The author removes the budget change: ask 0 empties, every later ask moves up a place.
    await performReviseProposal(ctxOf(db), ME as any, { proposal: r.short_id, from_session: "s1", ops: [{ op: "remove", seq: 1 }] });
    expect((await readProposal(ctxOf(db), ME as any, r.short_id)).asks.map((a: any) => a.title)).toEqual(["Trust growth to decide", "Retire growth"]);
    // The person, still on the old page, presses Accept on "Trust growth to decide" at index 1.
    await expect(performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 1, verdict: "accept", provision: false, seen: stale }))
      .rejects.toThrow("op-1 was revised after this page read it; a verdict never lands on a change the person has not seen");
    // Nothing landed: growth is not retired, and neither change was decided.
    expect((await growth(db)).status).toBe("active");
    const after = await readProposal(ctxOf(db), ME as any, r.short_id);
    expect(after.changes.map((c: any) => [c.seq, c.status])).toEqual([[1, "removed"], [2, "proposed"], [3, "proposed"]]);
    // A skip is read the same way, and a caller that says nothing is refused once anything was revised.
    await expect(performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 0, verdict: "skip", seen: stale })).rejects.toThrow("was revised after this page read it");
    await expect(performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 0, verdict: "skip" })).rejects.toThrow("was revised after this page read it");
    // The page reads the revised list and presses Accept on "Trust growth to decide", now index 0.
    const out = await performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 0, verdict: "accept", provision: false, seen: seenOf(after, 0) });
    expect(out).toMatchObject({ ask: 0, title: "Trust growth to decide", applied: 1 });
    expect((await growth(db)).trust).toBe("direct"); // decide is never written again (S23.1)
    expect((await growth(db)).status).toBe("active");
    // A position past the revised list, read against the revised list, is a bad index, not a moved list.
    await expect(performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 5, verdict: "accept", seen: { revised_at: after.asks && latestOrgRevisionAt(after.changes), seqs: [] } })).rejects.toThrow("there is no ask 5");
  });

  test("one change: an amend keeps the row's id, so a verdict read before it is refused; a caller that says nothing is taken on an unrevised proposal", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: threeAsks() });
    const page = await readProposal(ctxOf(db), ME as any, r.short_id);
    const budget = page.changes.find((c: any) => c.seq === 1);
    // Nothing revised yet: a verdict with no `seen` still stands.
    const skipped = await performDecideChange(ctxOf(db), ME as any, { change_id: page.changes.find((c: any) => c.seq === 3)._id, verdict: "skip" });
    expect(skipped.status).toBe("skipped");
    await performReviseProposal(ctxOf(db), ME as any, { proposal: r.short_id, from_session: "s1", ops: [{ op: "amend", seq: 1, edits: { caps: { wakes_per_day: 40 } } }] });
    await expect(performDecideChange(ctxOf(db), ME as any, { change_id: budget._id, verdict: "accept", provision: false, seen: seenOf(page) })).rejects.toThrow("op-1 was revised after this page read it");
    await expect(performDecideChange(ctxOf(db), ME as any, { change_id: budget._id, verdict: "accept", provision: false })).rejects.toThrow("was revised after this page read it");
    expect((await db.get(budget._id)).status).toBe("proposed");
    const fresh = await readProposal(ctxOf(db), ME as any, r.short_id);
    const out = await performDecideChange(ctxOf(db), ME as any, { change_id: budget._id, verdict: "accept", provision: false, seen: seenOf(fresh) });
    expect(out.status).toBe("applied");
    expect((await growth(db)).caps).toMatchObject({ wakes_per_day: 40 });
  });

  test("accept all: the person's call is read against what it saw; the server's own continuation is not re-read", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: threeAsks() });
    const page = await readProposal(ctxOf(db), ME as any, r.short_id);
    await performReviseProposal(ctxOf(db), ME as any, { proposal: r.short_id, from_session: "s1", ops: [{ op: "remove", seq: 3, note: "not yet" }] });
    await expect(performAcceptAll(ctxOf(db), ME as any, { proposal: r.short_id, provision: false, seen: seenOf(page) })).rejects.toThrow("op-1 was revised after this page read it");
    expect((await readProposal(ctxOf(db), ME as any, r.short_id)).changes.map((c: any) => c.status)).toEqual(["proposed", "proposed", "removed"]);
    const fresh = await readProposal(ctxOf(db), ME as any, r.short_id);
    const out = await performAcceptAll(ctxOf(db), ME as any, { proposal: r.short_id, provision: false, seen: seenOf(fresh) });
    expect(out).toMatchObject({ applied: 2, failed: 0, resolved: true });
  });

  test("two revises in one millisecond carry different stamps, so a verdict can name the one it read", async () => {
    const db = fixtures();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: threeAsks() });
    const realNow = Date.now;
    Date.now = () => 1_800_000_000_000;
    try {
      await performReviseProposal(ctxOf(db), ME as any, { proposal: r.short_id, from_session: "s1", ops: [{ op: "amend", seq: 1, edits: { caps: { wakes_per_day: 6 } } }] });
      const first = latestOrgRevisionAt((await readProposal(ctxOf(db), ME as any, r.short_id)).changes);
      await performReviseProposal(ctxOf(db), ME as any, { proposal: r.short_id, from_session: "s1", ops: [{ op: "amend", seq: 2, edits: { trust: "direct" } }] });
      const second = latestOrgRevisionAt((await readProposal(ctxOf(db), ME as any, r.short_id)).changes);
      expect(first).toBe(1_800_000_000_000);
      expect(second).toBe(first + 1);
    } finally {
      Date.now = realNow;
    }
  });
});

// W7 review, finding 7: every change of an accept all runs through
// ctx.runMutation, and a nested mutation spends its parent's read budget, so
// what has to fit 4,096 reads is the chunk. A change that takes sessions over
// costs hundreds of reads; a chunk holds at most one, and it is the last.
describe("accept all chunks by cost: one takeover change a transaction", () => {
  const own = (n: number, path: string) => ({ _id: `conversations_w${n}`, short_id: `jx7w00${n}`, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: `Work ${n}`, project_path: path, message_count: 3, last_message_role: "assistant", updated_at: Date.now() - 60_000, created_at: 1 });
  const extra = () => ({
    role_wakes: [], role_wake_outbox: [], managed_sessions: [], messages: [], user_presence: [], pending_messages: [], devices: [],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: 1 },
      { _id: Q, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", project_path: "/repo/billing", created_at: 1, updated_at: 1 },
    ],
  });
  // The host's two sessions on billing's path, beside the fixture's own rows.
  const seeded = () => { const db: any = fixtures(extra()); db._tables.conversations.push(own(1, "/repo/billing"), own(2, "/repo/billing")); return db; };
  const roleOfSession = (db: any, n: number) => db._tables.conversations.find((c: any) => c._id === `conversations_w${n}`).org_role_id;

  test("the chunk ends with the first change that takes sessions over", async () => {
    const { acceptAllChunk, ACCEPT_ALL_CHUNK } = await import("./orgProposals");
    const light = { change: { kind: "budget", handle: "growth", caps: { wakes_per_day: 3 } } } as any;
    const scope = { change: { kind: "scope", handle: "growth", add: ["pr-2"] } } as any;
    const role = { change: { kind: "role", name: "Ops", handle: "ops", scope: { projects: ["pr-2"] } } } as any;
    expect(acceptAllChunk([light, scope, role, light])).toEqual([light, scope]);
    expect(acceptAllChunk([role, scope])).toEqual([role]);
    // A scope change that only removes, a role over the whole workspace and a
    // change that already leaves the sessions cost what a record change costs.
    const cheap = [{ change: { kind: "scope", handle: "growth", remove: ["pr-1"] } }, { change: { kind: "role", name: "Ops", handle: "ops" } }, { change: { kind: "scope", handle: "growth", add: ["pr-2"], leave_sessions: true } }] as any[];
    expect(acceptAllChunk(cheap)).toEqual(cheap);
    expect(acceptAllChunk(Array.from({ length: ACCEPT_ALL_CHUNK + 5 }, () => light))).toHaveLength(ACCEPT_ALL_CHUNK);
  });

  test("two scoped changes in one accept all land in two transactions, and both apply", async () => {
    const db = seeded();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "scope", handle: "growth", add: ["pr-2"] }), change({ kind: "role", name: "Ops", handle: "ops", scope: { projects: ["pr-1"] } })]) });
    const scheduled: any[] = [];
    const ctx = { ...ctxOf(db), scheduler: { runAfter: async (_d: number, _f: unknown, args: any) => { scheduled.push(args); } } };
    const first = await performAcceptAll(ctx, ME as any, { proposal: r.short_id, provision: false });
    expect(first.results).toHaveLength(1);
    expect(first.remaining).toBe(1);
    expect(scheduled).toHaveLength(1);
    const second = await performAcceptAll(ctx, ME as any, { proposal: r.short_id, provision: false, tried: scheduled[0].tried, continuation: true });
    expect(second.results).toHaveLength(1);
    expect(second.remaining).toBe(0);
    expect([...first.results, ...second.results].map((x: any) => x.status)).toEqual(["applied", "applied"]);
  });

  test("an ask accepted whole with leave the sessions: the scope lands, the sessions stay, and the row records the edit", async () => {
    const db = seeded();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "scope", handle: "growth", add: ["pr-2"] }), change({ kind: "budget", handle: "growth", caps: { wakes_per_day: 12 } })]) });
    const asks = (await readProposal(ctxOf(db), ME as any, r.short_id)).asks;
    const at = asks.findIndex((a: any) => a.seqs.includes(1));
    const out = await performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: at, verdict: "accept", provision: false, leave_sessions: true });
    expect(out.failed).toBe(0);
    expect((await db.get(GROWTH as any)).scope.project_ids.map(String)).toEqual([P, Q]);
    expect(roleOfSession(db, 1)).toBeUndefined();
    const rows = (await readProposal(ctxOf(db), ME as any, r.short_id)).changes;
    expect(rows.find((c: any) => c.seq === 1).edits).toEqual({ leave_sessions: true });
    // The edit rides only the change it means something on.
    expect(rows.find((c: any) => c.seq === 2)?.edits).toBeUndefined();
  });

  test("the same ask accepted as proposed moves them", async () => {
    const db = seeded();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([change({ kind: "scope", handle: "growth", add: ["pr-2"] })]) });
    await performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 0, verdict: "accept", provision: false });
    expect(String(roleOfSession(db, 1))).toBe(GROWTH);
  });
});

// The company's goals (initiatives-projects-role-page.md "I1, revised"): a
// review proposes an initiative, a project into one and an owner for one as
// changes; the goals ask holds them; accepting makes them through the
// initiatives module's own cores; the page reads where the goal came from.
describe("goal changes in a proposal", () => {
  const goals = () => fixtures({ initiatives: [{ _id: "initiatives_win", user_id: ME, team_id: TEAM, workspace: WS, short_id: "in-2", title: "Win the private network", project_ids: [Q], status: "active", health: "none", created_at: 1, updated_at: 1 }], counters: [] });
  test("the goals ask is derived, titles fill from the record, and accepting it sets the goal, adds the project and names the owner through the log", async () => {
    const { recordOrigin } = await import("./orgChanges");
    const db = goals();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, from_session: "s1", spec: spec([
      change({ kind: "initiative", title: "Grow trades", description: "Trades grow month over month without paid spend.", projects: ["pr-1"], owner: "@growth" }, "Growth's own goal says so."),
      change({ kind: "initiative_projects", initiative: "in-2", projects: ["Growth"] }),
      change({ kind: "initiative_owner", initiative: "in-2", owner: "Me" }),
      change({ kind: "task_status", task: "ct-1", status: "done", reason: "landed", title: "t" }),
    ]) });
    // The initiative's title travels with the two changes to it (a reader's store may not hold the row).
    expect(r.changes.map((c: any) => c.change.title ?? null)).toEqual(["Grow trades", "Win the private network", "Win the private network", "t"]);
    expect((await readProposal(ctxOf(db), ME as any, r.short_id)).asks.map((a: any) => [a.title, a.seqs])).toEqual([
      ["Bring 1 record up to date", [4]],
      ["1 goal to set, and 2 changes to the goals that exist", [1, 2, 3]],
    ]);
    const out = await performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 1, verdict: "accept", provision: false });
    expect(out.results.map((x: any) => x.status)).toEqual(["applied", "applied", "applied"]);
    const made = db._tables.initiatives.find((i: any) => i.title === "Grow trades");
    expect(made).toMatchObject({ status: "proposed", workspace: WS, project_ids: [P], owner: { kind: "role", role_id: GROWTH } });
    expect((await db.get("initiatives_win")).project_ids).toEqual([Q, P]);
    expect((await db.get("initiatives_win")).owner).toEqual({ kind: "user", user_id: ME });
    // Three log rows, one per change, in the proposal's batch; the page reads the goal's origin from the first.
    const rows = db._tables.org_changes.filter((c: any) => c.subject.type === "initiative");
    expect(rows.map((c: any) => c.kind)).toEqual(["initiative", "initiative_projects", "initiative_owner"]);
    const origin = await recordOrigin(ctxOf(db), ME as any, String(made._id));
    expect(origin).toMatchObject({ proposal: { short_id: r.short_id }, undone: false });
    expect(await recordOrigin(ctxOf(db), ME as any, "initiatives_win")).toBeNull();
    expect(await recordOrigin(ctxOf(db), MATE as any, String(made._id))).toMatchObject({ proposal: { short_id: r.short_id } });
  });
  test("a goal that already exists, a project already in it and an owner already named are applied as no-ops, never twins", async () => {
    const db = goals();
    const r = await performCreateProposal(ctxOf(db), ME as any, { team_id: TEAM, spec: spec([
      change({ kind: "initiative", title: "win the private network", description: "d", projects: ["pr-1"] }),
      change({ kind: "initiative_projects", initiative: "Win the private network", projects: ["pr-2"] }),
    ]) });
    const out = await performDecideAsk(ctxOf(db), ME as any, { proposal: r.short_id, ask: 0, verdict: "accept", provision: false });
    expect(out.results.map((x: any) => [x.status, x.note])).toEqual([["applied", 'the goal "Win the private network" already exists (in-2)'], ["applied", 'in-2 "Win the private network" already carries pr-2']]);
    expect(db._tables.initiatives).toHaveLength(1);
  });
});
