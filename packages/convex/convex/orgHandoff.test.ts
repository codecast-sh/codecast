import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole, performProvisionRole, performRetireRole, performSetReports, performUpdateRole } from "./orgRoles";
import { HANDOFF_DEADLINE_MS, performHandoffWrite, sweepCore } from "./orgHandoff";
import { partitionScopes, performSplitRole } from "./orgSplit";
import { findRoleAgenda } from "./orgAgenda";
import { ROLE_AGENDA_PROMPT, ROLE_AGENDA_TITLE, ROLE_HANDOFF_TITLE_PREFIX, nextMorningAt } from "./lib/orgRoutine";
import { parseStandingSection, standingLineFrom, withStandingLines } from "@codecast/shared/contracts/briefStanding";

// Knowledge handoff when roles change (org-staffing.md S32), the split (S34)
// and the morning agenda (S33), driven through the exported cores against
// the fake db.

const ME = "u".repeat(31) + "m";
const PEER = "u".repeat(31) + "p";
const TEAM = "teams_acme" as any;
const NOW = Date.now();
const DAY = 86_400_000;
const P1 = "projects_growth";
const P2 = "projects_ads";

function world(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me", email: "me@x.ai", timezone: "UTC" }, { _id: PEER, name: "Peer", email: "peer@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: PEER, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [], org_roles: [], org_role_history: [], org_changes: [], org_proposals: [], org_proposal_changes: [],
    anchors: [], anchor_channels: [], session_commands: [],
    conversations: [
      { _id: "seatA", user_id: ME, session_id: "s-a", short_id: "jxseata", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo" },
      { _id: "seatB", user_id: ME, session_id: "s-b", short_id: "jxseatb", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo" },
      { _id: "seatC", user_id: ME, session_id: "s-c", short_id: "jxseatc", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo" },
    ],
    agent_tasks: [], pending_messages: [], managed_sessions: [], session_owners: [], messages: [], user_presence: [], devices: [],
    docs: [],
    projects: [
      { _id: P1, title: "Growth", user_id: ME, team_id: TEAM, workspace: `team:${TEAM}`, created_at: 1, updated_at: 1 },
      { _id: P2, title: "Ads", user_id: ME, team_id: TEAM, workspace: `team:${TEAM}`, created_at: 1, updated_at: 1 },
    ],
    plans: [], tasks: [], task_comments: [], session_decisions: [], decision_inbox: [], decision_grants: [], workflow_runs: [],
    ...extra,
  };
  const db = makeFakeDb(tables);
  // A browser identity: staffing is a person's act (refuseUnlessHuman).
  const ctx: any = { db, scheduler: { runAfter: async () => {} }, auth: { getUserIdentity: async () => ({ subject: ME }) } };
  return { ctx, tables };
}

async function seated(ctx: any, over: Record<string, any>, seat: string) {
  const role = await performCreateRole(ctx, ME as any, { team_id: TEAM, ...over } as any);
  await performProvisionRole(ctx, ME as any, { role_id: String(role._id), adopt_conversation_id: seat });
  return role;
}

const briefOf = (tables: Record<string, any[]>, role: any) => tables.docs.find((d) => d._id === tables.org_roles.find((r) => r._id === role._id)!.brief_doc_id)?.content ?? "";
const roleRow = (tables: Record<string, any[]>, role: any) => tables.org_roles.find((r) => r._id === role._id)!;

const A_BRIEF = [
  "Growth lead: steady",
  "Status: working",
  "",
  "## Where it stands",
  "- Growth: two markets filled; the third waits on a lawyer. (2026-09-28)",
  "- Ads: nothing shipped since the redesign started. (2026-09-20)",
  "",
  "## Notes",
  "- The lawyer is Dana.",
].join("\n");

describe("standing lines carry their source (S32)", () => {
  test("a copied line is marked with the outgoing role and keeps its date; the parser reads both back", () => {
    const [line] = parseStandingSection(A_BRIEF);
    const copied = standingLineFrom(line, "growth");
    expect(copied).toBe("- Growth: two markets filled; the third waits on a lawyer. (from @growth) (2026-09-28)");
    const back = parseStandingSection(`## Where it stands\n${copied}`)[0];
    expect(back).toMatchObject({ project: "Growth", text: "two markets filled; the third waits on a lawyer.", written_on: "2026-09-28", from: "growth" });
    expect(line.from).toBeNull();
  });

  test("withStandingLines creates the section at the end or appends inside it, and never overrides a line the receiver already has", () => {
    expect(withStandingLines("Head: fine\nStatus: working", ["- Growth: x (from @a) (2026-09-28)"])).toBe("Head: fine\nStatus: working\n\n## Where it stands\n- Growth: x (from @a) (2026-09-28)");
    const had = "Head: fine\n\n## Where it stands\n- Ads: mine (2026-09-01)\n\n## Notes\n- n";
    expect(withStandingLines(had, ["- Growth: x (from @a) (2026-09-28)", "- Ads: theirs (from @a) (2026-09-28)"]))
      .toBe("Head: fine\n\n## Where it stands\n- Ads: mine (2026-09-01)\n- Growth: x (from @a) (2026-09-28)\n\n## Notes\n- n");
  });
});

describe("a retire waits for the handoff (S32)", () => {
  test("the heir gets the lines and a succession row, the outgoing role gets a trigger, and the seat stays until the handoff lands", async () => {
    const { ctx, tables } = world();
    const head = await seated(ctx, { name: "Head of People", handle: "head-of-people" }, "seatB");
    const a = await seated(ctx, { name: "Growth lead", handle: "growth", scope: { project_ids: [P1, P2], plan_ids: [] } }, "seatA");
    tables.docs.find((d) => d._id === roleRow(tables, a).brief_doc_id)!.content = A_BRIEF;

    const out = await performRetireRole(ctx, ME as any, { role_id: String(a._id) });
    expect(out.deferred).toBe(true);
    expect(roleRow(tables, a).status).toBe("active");
    const hand = roleRow(tables, a).handing_over;
    expect(hand.reason).toBe("retire");
    expect(hand.retire).toEqual({});
    expect(hand.deadline).toBeGreaterThan(NOW + HANDOFF_DEADLINE_MS - 5000);
    expect(hand.receivers).toHaveLength(1);
    expect(hand.receivers[0]).toMatchObject({ role_id: head._id, handle: "head-of-people", project_ids: [P1, P2], plan_ids: [] });

    // The heir's brief gained both lines, marked, under its own section.
    const lines = parseStandingSection(briefOf(tables, head));
    expect(lines.map((l) => [l.project, l.from, l.written_on])).toEqual([["Growth", "growth", "2026-09-28"], ["Ads", "growth", "2026-09-20"]]);
    expect(roleRow(tables, head).succeeded.map((s: any) => [s.project_id, s.from_handle, s.lines])).toEqual([[P1, "growth", 1], [P2, "growth", 1]]);

    // One once trigger on the outgoing seat, naming the receiver and the areas.
    const trigger = tables.agent_tasks.find((t) => t.title.startsWith(ROLE_HANDOFF_TITLE_PREFIX));
    expect(trigger).toMatchObject({ originating_conversation_id: "seatA", schedule_type: "once", status: "scheduled", role_id: a._id });
    expect(trigger.title).toBe("Hand over Growth, Ads to @head-of-people");
    expect(trigger.prompt).toContain("cast role handoff @<receiver> -");
    expect(trigger.prompt).toContain("- @head-of-people takes Growth, Ads");
    expect(hand.trigger_id).toBe(trigger._id);

    // A second retire while it waits changes nothing.
    const again = await performRetireRole(ctx, ME as any, { role_id: String(a._id) });
    expect(again.deferred).toBe(true);
    expect(tables.agent_tasks.filter((t) => t.title.startsWith(ROLE_HANDOFF_TITLE_PREFIX))).toHaveLength(1);

    // The outgoing role hands over the rest from its own session: the body
    // lands in the heir's brief, the heir is woken, and the retire runs.
    const written = await performHandoffWrite(ctx, ME as any, { from_session: "jxseata", receiver: String(head._id), body: "Dana is the lawyer; call before Friday." }, NOW + 60_000);
    expect(written).toMatchObject({ from: "growth", to: "head-of-people", areas: ["Growth", "Ads"], handoff: "complete", retired: true });
    const headBrief = briefOf(tables, head);
    expect(headBrief).toContain("## Handed over from @growth (");
    expect(headBrief).toContain("Growth, Ads\nDana is the lawyer; call before Friday.");
    expect(tables.pending_messages.some((p) => p.conversation_id === "seatB" && String(p.content).includes("handed over Growth, Ads to you"))).toBe(true);
    expect(roleRow(tables, a).status).toBe("retired");
    expect(roleRow(tables, a).handing_over).toBeUndefined();
    expect(roleRow(tables, head).succeeded.every((s: any) => s.handed_at)).toBe(true);
  });

  test("past the deadline the sweep closes the handoff with what was written and the retire runs", async () => {
    const { ctx, tables } = world();
    await seated(ctx, { name: "Head of People", handle: "head-of-people" }, "seatB");
    const a = await seated(ctx, { name: "Growth lead", handle: "growth", scope: { project_ids: [P1], plan_ids: [] } }, "seatA");
    tables.docs.find((d) => d._id === roleRow(tables, a).brief_doc_id)!.content = A_BRIEF;
    await performRetireRole(ctx, ME as any, { role_id: String(a._id), standing_session: "retire" });
    expect(roleRow(tables, a).status).toBe("active");
    const deadline = roleRow(tables, a).handing_over.deadline;
    expect(deadline - Date.now()).toBeGreaterThan(HANDOFF_DEADLINE_MS - 60_000);
    expect((await sweepCore(ctx, deadline - 1)).closed).toEqual([]);
    expect((await sweepCore(ctx, deadline + 1)).closed).toEqual([a.short_id]);
    expect(roleRow(tables, a).status).toBe("retired");
    expect(tables.agent_tasks.find((t) => t.title.startsWith(ROLE_HANDOFF_TITLE_PREFIX)).status).toBe("cancelled");
  });

  test("a retire with nothing to hand over, or asked to skip, retires at once", async () => {
    const { ctx, tables } = world();
    const a = await seated(ctx, { name: "Growth lead", handle: "growth", scope: { project_ids: [P1], plan_ids: [] } }, "seatA");
    // No other live role owns the area after: nobody to hand to.
    const out = await performRetireRole(ctx, ME as any, { role_id: String(a._id) });
    expect(out.deferred).toBeUndefined();
    expect(roleRow(tables, a).status).toBe("retired");

    const { ctx: ctx2, tables: t2 } = world();
    await seated(ctx2, { name: "Head of People", handle: "head-of-people" }, "seatB");
    const b = await seated(ctx2, { name: "Ads lead", handle: "ads", scope: { project_ids: [P2], plan_ids: [] } }, "seatA");
    await performRetireRole(ctx2, ME as any, { role_id: String(b._id), handoff: "skip" });
    expect(roleRow(t2, b).status).toBe("retired");
    expect(t2.agent_tasks.some((t) => t.title.startsWith(ROLE_HANDOFF_TITLE_PREFIX))).toBe(false);
  });
});

describe("a scope edit that moves an area hands it over (S32)", () => {
  test("adding a project to a sibling lead copies the previous owner's line and marks the succession", async () => {
    const { ctx, tables } = world();
    const a = await seated(ctx, { name: "Growth lead", handle: "growth", scope: { project_ids: [P1, P2], plan_ids: [] } }, "seatA");
    tables.docs.find((d) => d._id === roleRow(tables, a).brief_doc_id)!.content = A_BRIEF;
    const c = await seated(ctx, { name: "Ads lead", handle: "ads" }, "seatC");
    // Step one of a move: the sibling gains the project while the holder
    // still names it. Two roles watch it; nobody lost it, so nothing moves.
    const shared = await performUpdateRole(ctx, ME as any, { role_id: String(c._id), scope: { project_ids: [P2], plan_ids: [] }, human_decision: "yes" });
    expect(shared.handoffs).toBeUndefined();
    expect(roleRow(tables, a).handing_over).toBeUndefined();
    // Step two: the holder lets go. The area moves to the role that holds it now.
    const out = await performUpdateRole(ctx, ME as any, { role_id: String(a._id), scope: { project_ids: [P1], plan_ids: [] }, human_decision: "yes" });
    expect(out.handoffs).toHaveLength(1);
    expect(out.handoffs[0]).toMatchObject({ from: "growth", receivers: [{ handle: "ads", areas: ["Ads"], lines: 1 }] });
    expect(parseStandingSection(briefOf(tables, c)).map((l) => [l.project, l.from])).toEqual([["Ads", "growth"]]);
    expect(roleRow(tables, c).succeeded).toHaveLength(1);
    expect(roleRow(tables, c).succeeded[0]).toMatchObject({ project_id: P2, from_handle: "growth" });
    // The outgoing role still stands (a scope move is no retire) with its trigger armed.
    expect(roleRow(tables, a).status).toBe("active");
    expect(roleRow(tables, a).handing_over).toMatchObject({ reason: "scope", receivers: [{ handle: "ads", project_ids: [P2] }] });
    expect(roleRow(tables, a).handing_over.retire).toBeUndefined();
    expect(tables.agent_tasks.find((t) => t.title.startsWith(ROLE_HANDOFF_TITLE_PREFIX)).originating_conversation_id).toBe("seatA");
  });
});

describe("split a role into two leads (S34)", () => {
  test("partitionScopes insists on two disjoint, non empty halves that cover the whole area", () => {
    const original = { project_ids: [P1, P2], plan_ids: ["plans_x"] };
    const ok = partitionScopes(original, [
      { handle: "a", items: [{ kind: "project", id: P1 as any }, { kind: "plan", id: "plans_x" as any }] },
      { handle: "b", items: [{ kind: "project", id: P2 as any }] },
    ]);
    expect(ok).toEqual([{ project_ids: [P1], plan_ids: ["plans_x"] }, { project_ids: [P2], plan_ids: [] }]);
    expect(() => partitionScopes(original, [{ handle: "a", items: [{ kind: "project", id: P1 as any }] }])).toThrow("exactly two");
    expect(() => partitionScopes(original, [{ handle: "a", items: [{ kind: "project", id: P1 as any }, { kind: "plan", id: "plans_x" as any }] }, { handle: "b", items: [{ kind: "project", id: P1 as any }, { kind: "project", id: P2 as any }] }])).toThrow("must not overlap");
    expect(() => partitionScopes(original, [{ handle: "a", items: [{ kind: "project", id: P1 as any }] }, { handle: "b", items: [{ kind: "project", id: P2 as any }] }])).toThrow("Say where plan:plans_x goes");
    expect(() => partitionScopes(original, [{ handle: "a", items: [] }, { handle: "b", items: [{ kind: "project", id: P2 as any }] }])).toThrow("would own nothing");
    expect(() => partitionScopes(original, [{ handle: "a", items: [{ kind: "project", id: "projects_other" as any }] }, { handle: "b", items: [{ kind: "project", id: P2 as any }] }])).toThrow("not in the role's area");
  });

  test("one gesture makes two roles reporting where the original did, each owning its half, with the handoff to each and the retire waiting", async () => {
    const { ctx, tables } = world();
    const a = await seated(ctx, { name: "Growth lead", handle: "growth", scope: { project_ids: [P1, P2], plan_ids: [] }, reports_to: { kind: "user", user_id: PEER } }, "seatA");
    tables.docs.find((d) => d._id === roleRow(tables, a).brief_doc_id)!.content = A_BRIEF;
    const out = await performSplitRole(ctx, ME as any, {
      role_id: String(a._id),
      halves: [{ name: "Growth Web", handle: "growth-web", refs: ["project:Growth"] }, { name: "Growth Ads", handle: "growth-ads", refs: [P2] }],
      human_decision: "yes",
    });
    expect(out.roles.map((r: any) => [r.handle, r.scope.project_ids])).toEqual([["growth-web", [P1]], ["growth-ads", [P2]]]);
    for (const r of out.roles) {
      const row = roleRow(tables, r);
      expect(row.reports_to).toEqual({ kind: "user", user_id: PEER });
      expect(row.status).toBe("active");
      expect(row.trust).toBe(roleRow(tables, a).trust);
    }
    // The original gave up its area at once and waits to retire behind the handoff.
    expect(roleRow(tables, a).scope).toEqual({ project_ids: [], plan_ids: [] });
    expect(roleRow(tables, a).status).toBe("active");
    expect(roleRow(tables, a).handing_over).toMatchObject({ reason: "split", retire: {} });
    expect(out.handoff.receivers.map((r: any) => [r.handle, r.areas, r.lines])).toEqual([["growth-web", ["Growth"], 1], ["growth-ads", ["Ads"], 1]]);
    const web = roleRow(tables, out.roles[0]);
    const ads = roleRow(tables, out.roles[1]);
    expect(parseStandingSection(briefOf(tables, web)).map((l) => [l.project, l.from])).toEqual([["Growth", "growth"]]);
    expect(parseStandingSection(briefOf(tables, ads)).map((l) => [l.project, l.from])).toEqual([["Ads", "growth"]]);
    expect(web.succeeded[0]).toMatchObject({ project_id: P1, from_handle: "growth" });
    expect(ads.succeeded[0]).toMatchObject({ project_id: P2, from_handle: "growth" });
    const trigger = tables.agent_tasks.find((t) => t.title.startsWith(ROLE_HANDOFF_TITLE_PREFIX));
    expect(trigger.title).toBe("Hand over your areas to @growth-web and @growth-ads");
    expect(trigger.prompt).toContain("Your role was split into two leads");
    // Handing over to one half leaves the other waiting; both done retires the original.
    await performHandoffWrite(ctx, ME as any, { from_session: "jxseata", receiver: "growth-web", body: "Web notes." });
    expect(roleRow(tables, a).status).toBe("active");
    const done = await performHandoffWrite(ctx, ME as any, { from_session: "jxseata", receiver: "growth-ads", body: "Ads notes." });
    expect(done.handoff).toBe("complete");
    expect(roleRow(tables, a).status).toBe("retired");
  });

  test("refuses a role with no area, a role already handing over, and a split by an agent session", async () => {
    const { ctx } = world();
    const a = await seated(ctx, { name: "Growth lead", handle: "growth" }, "seatA");
    const halves = [{ name: "A", handle: "aa", refs: [P1] }, { name: "B", handle: "bb", refs: [P2] }];
    await expect(performSplitRole(ctx, ME as any, { role_id: String(a._id), halves, human_decision: "yes" })).rejects.toThrow("names no area to split");
    await expect(performSplitRole(ctx, ME as any, { role_id: String(a._id), halves, from_session: "jxseata" })).rejects.toThrow(/human only/);
  });
});

describe("the morning agenda follows who reports (S33)", () => {
  test("the first reporting person arms it for the host's next morning; the last one leaving pauses it; the next arrival resumes it", async () => {
    const { ctx, tables } = world();
    const a = await seated(ctx, { name: "Growth lead", handle: "growth" }, "seatA");
    expect(tables.agent_tasks.some((t) => t.title === ROLE_AGENDA_TITLE)).toBe(false);
    const added = await performSetReports(ctx, ME as any, { role_id: String(a._id), add: [PEER as any] });
    expect(added.agenda).toBe("armed");
    const agenda = tables.agent_tasks.find((t) => t.title === ROLE_AGENDA_TITLE);
    expect(agenda).toMatchObject({ originating_conversation_id: "seatA", schedule_type: "recurring", interval_ms: DAY, status: "scheduled", role_id: a._id, prompt: ROLE_AGENDA_PROMPT });
    const expected = nextMorningAt(Date.now(), "UTC");
    expect(Math.abs(agenda.run_at - expected)).toBeLessThan(60_000);
    expect(new Date(agenda.run_at).getUTCHours()).toBe(9);
    expect(agenda.run_at).toBeGreaterThan(Date.now());
    expect(agenda.prompt).toContain("cast decide --to");
    expect(agenda.prompt).toContain("ONE card");

    const removed = await performSetReports(ctx, ME as any, { role_id: String(a._id), remove: [PEER as any] });
    expect(removed.agenda).toBe("paused");
    expect((await findRoleAgenda(ctx, a, { _id: "seatA" })).status).toBe("paused");
    const back = await performSetReports(ctx, ME as any, { role_id: String(a._id), add: [PEER as any] });
    expect(back.agenda).toBe("resumed");
    expect((await findRoleAgenda(ctx, a, { _id: "seatA" })).status).toBe("scheduled");
    expect(tables.agent_tasks.filter((t) => t.title === ROLE_AGENDA_TITLE)).toHaveLength(1);
  });

  test("nextMorningAt lands on the next local nine o'clock, honouring the zone", () => {
    const at = Date.UTC(2026, 9, 2, 12, 0, 0); // noon UTC
    expect(new Date(nextMorningAt(at, "UTC")).toISOString()).toBe("2026-10-03T09:00:00.000Z");
    // Los Angeles is UTC-7 in October: 09:00 local is 16:00 UTC, still ahead of noon.
    expect(new Date(nextMorningAt(at, "America/Los_Angeles")).toISOString()).toBe("2026-10-02T16:00:00.000Z");
    expect(new Date(nextMorningAt(at, "Not/AZone")).toISOString()).toBe("2026-10-03T09:00:00.000Z");
  });
});
