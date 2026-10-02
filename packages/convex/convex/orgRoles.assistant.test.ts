import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { EXECUTIVE_ASSISTANT_HANDLE, HEAD_OF_PEOPLE_HANDLE, LEGACY_HEAD_OF_PEOPLE_HANDLE } from "@codecast/shared/contracts/orgLead";
import { executiveAssistantCharter, defaultAssistantHandle, ensureRoleRoutine, headOfPeopleCharter, performCreateRole, performHireAssistant, performProvisionRole, performStaff } from "./orgRoles";
import { liveRoleByHandle } from "./lib/orgAccess";
import { findExistingAnchor, isWorkspaceAgentRole, roleBootstrapOf } from "./anchors";
import { performRenameHeadOfPeople, performSeatExecutiveAssistant } from "./migrations";
import { resolveChatMentions } from "./lib/mentionResolve";

// The Head of People rename and the Executive Assistant as the person's right hand
// (docs/architecture/org-staffing.md S30): the old handle keeps naming the
// Head of People, an assistant owns no work and lives in its own boundary, the
// workspace's agent is the assistant when one stands, and the migrations
// convert a personal root or seat a named role, and put everything back on
// reverse.

const ME = "u".repeat(31) + "m";
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function world(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [],
    org_roles: [],
    anchors: [],
    conversations: [
      { _id: "mine", user_id: ME, session_id: "s-mine", short_id: "jxmine1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo" },
      { _id: "home", user_id: ME, session_id: "s-home", short_id: "jxhome1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 4, project_path: "/repo", is_private: true },
    ],
    agent_tasks: [],
    pending_messages: [],
    managed_sessions: [],
    session_owners: [],
    messages: [],
    user_presence: [],
    devices: [],
    docs: [],
    projects: [],
    plans: [],
    tasks: [],
    session_decisions: [],
    chat_channels: [],
    ...extra,
  };
  const db = makeFakeDb(tables);
  const ctx: any = { db, scheduler: { runAfter: async () => {} } };
  return { ctx, tables };
}

describe("the legacy handle", () => {
  test("@chief-of-staff finds the Head of People under either handle, with or without an assistant", async () => {
    const { ctx, tables } = world();
    await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    expect(tables.org_roles[0].handle).toBe(HEAD_OF_PEOPLE_HANDLE);
    const byOld = await liveRoleByHandle(ctx, { team_id: TEAM }, LEGACY_HEAD_OF_PEOPLE_HANDLE);
    expect(byOld?._id).toBe(tables.org_roles[0]._id);
    // A row still carrying the old handle (prod before the migration) answers to the new one.
    tables.org_roles[0].handle = LEGACY_HEAD_OF_PEOPLE_HANDLE;
    const byNew = await liveRoleByHandle(ctx, { team_id: TEAM }, HEAD_OF_PEOPLE_HANDLE);
    expect(byNew?._id).toBe(tables.org_roles[0]._id);
    // An Executive Assistant has its own handle; the old one stays the Head of People's.
    const assistant = await performHireAssistant(ctx, ME as any, { reach: { reach: "team", team_id: TEAM }, project_path: "/repo" });
    expect(assistant.role.handle).toBe("executive-assistant");
    expect((await liveRoleByHandle(ctx, { team_id: TEAM }, LEGACY_HEAD_OF_PEOPLE_HANDLE))?._id).toBe(tables.org_roles[0]._id);
    // No other role may take either of the Head of People's handles, and an
    // assistant never can, even where no Head of People stands.
    await expect(performCreateRole(ctx, ME as any, { name: "Ops", handle: LEGACY_HEAD_OF_PEOPLE_HANDLE, team_id: TEAM })).rejects.toThrow(/already taken/);
    await expect(performHireAssistant(ctx, ME as any, { reach: { reach: "global" }, handle: LEGACY_HEAD_OF_PEOPLE_HANDLE, project_path: "/repo" })).rejects.toThrow(/already taken/);
  });
});

describe("hiring an Executive Assistant", () => {
  test("a global assistant lives in the person's boundary, owns no work and is the personal workspace's agent", async () => {
    const { ctx, tables } = world();
    const out = await performHireAssistant(ctx, ME as any, { reach: { reach: "global" }, given_name: "Ada", project_path: "/repo" });
    expect(out.created).toBe(true);
    const role = tables.org_roles.find((r) => String(r._id) === String(out.role._id))!;
    expect(role.scope_type).toBe("user");
    expect(role.team_id).toBeUndefined();
    expect(role.assistant).toEqual({ reach: "global" });
    expect(role.given_name).toBe("Ada");
    expect(role.name).toBe("Executive Assistant");
    expect(role.handle).toBe(EXECUTIVE_ASSISTANT_HANDLE);
    expect(role.scope).toEqual({ project_ids: [], plan_ids: [] });
    expect(role.charter).toBe(executiveAssistantCharter("Me"));
    expect(out.role.given_name).toBe("Ada");
    // Its opening is the right hand's, named, reaching everything.
    const boot = await roleBootstrapOf(ctx, role);
    expect(boot.assistantOpening).toContain("You are Ada, Me's Executive Assistant for everything Me works on");
    expect(boot.assistantOpening).toContain("every workspace they are in");
    // The seat is the personal workspace's agent now.
    const seat = await findExistingAnchor(ctx, { scope_type: "user", scope_user_id: ME as any });
    expect(String(seat?.org_role_id)).toBe(String(role._id));
    expect(isWorkspaceAgentRole(role, undefined)).toBe(true);
    // Hiring again is the same seat.
    const again = await performHireAssistant(ctx, ME as any, { reach: { reach: "global" }, project_path: "/repo" });
    expect(again.already_existed).toBe(true);
    expect(String(again.role._id)).toBe(String(role._id));
  });

  test("a personal assistant for one team sits beside the global one with its own handle, and never reads as the team's agent", async () => {
    const { ctx, tables } = world();
    await performHireAssistant(ctx, ME as any, { reach: { reach: "global" }, project_path: "/repo" });
    const own = await performHireAssistant(ctx, ME as any, { reach: { reach: "team", team_id: TEAM }, personal: true, project_path: "/repo" });
    const role = tables.org_roles.find((r) => String(r._id) === String(own.role._id))!;
    expect(role.scope_type).toBe("user");
    expect(role.assistant).toEqual({ reach: "team", team_id: TEAM });
    expect(role.handle).toBe("executive-assistant-acme");
    expect(isWorkspaceAgentRole(role, TEAM)).toBe(false);
    expect(isWorkspaceAgentRole(role, undefined)).toBe(false);
    const boot = await roleBootstrapOf(ctx, role);
    expect(boot.assistantOpening).toContain("Executive Assistant for Acme");
    expect(boot.assistantOpening).toContain("--team Acme");
  });

  test("a team assistant lives in the team, is the team's agent over the Head of People, and answers @anchor", async () => {
    const { ctx, tables } = world();
    await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    const head = tables.org_roles[0];
    expect(isWorkspaceAgentRole(head, TEAM)).toBe(true);
    const out = await performHireAssistant(ctx, ME as any, { reach: { reach: "team", team_id: TEAM }, project_path: "/repo" });
    const assistant = tables.org_roles.find((r) => String(r._id) === String(out.role._id))!;
    expect(assistant.scope_type).toBe("team");
    expect(assistant.team_id).toBe(TEAM);
    const seat = await findExistingAnchor(ctx, { scope_type: "team", team_id: TEAM });
    expect(String(seat?.org_role_id)).toBe(String(assistant._id));
    const mentions = await resolveChatMentions(ctx, TEAM, "@anchor what is the plan?", ME as any);
    expect(mentions.roles.map((r: any) => String(r._id))).toEqual([String(assistant._id)]);
  });

  test("an assistant refuses a scope", async () => {
    const { ctx } = world();
    await expect(performCreateRole(ctx, ME as any, { name: "Executive Assistant", handle: "cos", assistant: { reach: "global" }, scope: { project_ids: ["p1" as any], plan_ids: [] } })).rejects.toThrow(/owns no area/);
  });

  test("default handles never collide", () => {
    const taken = new Set([EXECUTIVE_ASSISTANT_HANDLE, "executive-assistant-acme"]);
    expect(defaultAssistantHandle({ reach: "global" }, true, null, (h) => taken.has(h))).toBe("executive-assistant-2");
    expect(defaultAssistantHandle({ reach: "team", team_id: TEAM }, true, "Acme Inc", (h) => taken.has(h))).toBe("executive-assistant-acme-inc");
    expect(defaultAssistantHandle({ reach: "team", team_id: TEAM }, false, "Acme", (h) => taken.has(h))).toBe("executive-assistant-2");
  });
});

describe("migrations.renameHeadOfPeople", () => {
  async function seeded() {
    const w = world();
    await performStaff(w.ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    await performStaff(w.ctx, ME as any, { adopt_conversation_id: "jxhome1" });
    // Prod rows as they stand before the rename.
    for (const r of w.tables.org_roles) { r.handle = LEGACY_HEAD_OF_PEOPLE_HANDLE; r.name = "Chief of Staff"; r.charter = "You are the person's right hand: keep their goals in view."; }
    for (const c of w.tables.conversations) if (c.standing_role_id) { c.title = "Chief of Staff"; c.title_is_custom = true; }
    return w;
  }

  test("dry run reports every row and changes nothing", async () => {
    const { ctx, tables } = await seeded();
    const before = JSON.stringify(tables.org_roles);
    const plan = await performRenameHeadOfPeople(ctx, { personal_root: "convert" });
    expect(plan.dryRun).toBe(true);
    expect(plan.rows.map((r) => r.action).sort()).toEqual(["convert", "rename"]);
    expect(JSON.stringify(tables.org_roles)).toBe(before);
  });

  test("the team root becomes the Head of People; the personal root becomes the global assistant; reverse puts both back", async () => {
    const { ctx, tables } = await seeded();
    const team = tables.org_roles.find((r) => r.team_id === TEAM)!;
    const home = tables.org_roles.find((r) => !r.team_id)!;
    const reviewBefore = tables.agent_tasks.filter((t) => t.role_id === home._id && t.status === "scheduled").map((t) => t.title);
    expect(reviewBefore).toContain("Company review");

    const run = await performRenameHeadOfPeople(ctx, { dryRun: false, personal_root: "convert" });
    expect(run.rows.find((r) => r.role === team.short_id)!.action).toBe("rename");
    const converted = run.rows.find((r) => r.role === home.short_id)!;
    expect(converted.action).toBe("convert");
    expect(converted.needs_head_of_people).toBe(false);
    expect(converted.review_cancelled).toBeTruthy();

    expect(team.handle).toBe(HEAD_OF_PEOPLE_HANDLE);
    expect(team.name).toBe("Head of People");
    expect(team.charter).toBe(headOfPeopleCharter("Me"));
    expect(team.renamed_from.handle).toBe(LEGACY_HEAD_OF_PEOPLE_HANDLE);
    expect(tables.conversations.find((c) => c._id === "mine")!.title).toBe("Head of People");

    expect(converted.to).toEqual({ handle: "executive-assistant", name: "Executive Assistant" });
    expect(home.handle).toBe(EXECUTIVE_ASSISTANT_HANDLE);
    expect(home.name).toBe("Executive Assistant");
    expect(home.assistant).toEqual({ reach: "global" });
    expect(tables.conversations.find((c) => c._id === "home")!.title).toBe("Executive Assistant");
    expect(home.charter).toBe(executiveAssistantCharter("Me"));
    const homeTasks = tables.agent_tasks.filter((t) => t.role_id === home._id);
    expect(homeTasks.find((t) => t.title === "Company review")!.status).toBe("completed");
    expect(homeTasks.find((t) => t.title !== "Company review" && t.status === "scheduled")).toBeTruthy();
    // The old handle names the Head of People alone, never the assistant.
    expect((await liveRoleByHandle(ctx, { team_id: TEAM }, LEGACY_HEAD_OF_PEOPLE_HANDLE))?._id).toBe(team._id);
    expect(await liveRoleByHandle(ctx, { scope_user_id: ME }, LEGACY_HEAD_OF_PEOPLE_HANDLE)).toBeNull();
    // Running again changes nothing more.
    expect((await performRenameHeadOfPeople(ctx, { dryRun: false, personal_root: "convert" })).rows).toEqual([]);

    const back = await performRenameHeadOfPeople(ctx, { dryRun: false, reverse: true });
    expect(back.rows.map((r) => r.action)).toEqual(["reverse", "reverse"]);
    expect(team.handle).toBe(LEGACY_HEAD_OF_PEOPLE_HANDLE);
    expect(team.name).toBe("Chief of Staff");
    expect(team.renamed_from).toBeUndefined();
    expect(tables.conversations.find((c) => c._id === "mine")!.title).toBe("Chief of Staff");
    expect(home.assistant).toBeUndefined();
    expect(home.handle).toBe(LEGACY_HEAD_OF_PEOPLE_HANDLE);
    expect(home.name).toBe("Chief of Staff");
    expect(tables.conversations.find((c) => c._id === "home")!.title).toBe("Chief of Staff");
    expect(home.charter).toBe("You are the person's right hand: keep their goals in view.");
    expect(homeTasks.find((t) => t.title === "Company review")!.status).toBe("scheduled");
  });

  test("a personal root with other roles beside it is reported as still needing a Head of People", async () => {
    const { ctx, tables } = await seeded();
    await performCreateRole(ctx, ME as any, { name: "Writing lead", handle: "writing" });
    const home = tables.org_roles.find((r) => !r.team_id && r.handle === LEGACY_HEAD_OF_PEOPLE_HANDLE)!;
    const plan = await performRenameHeadOfPeople(ctx, { personal_root: "convert" });
    expect(plan.rows.find((r) => r.role === home.short_id)!.needs_head_of_people).toBe(true);
  });

  test("`only` and `scope` take the team roots and leave the rest for later", async () => {
    const { ctx, tables } = await seeded();
    const team = tables.org_roles.find((r) => r.team_id === TEAM)!;
    const home = tables.org_roles.find((r) => !r.team_id)!;
    const byId = await performRenameHeadOfPeople(ctx, { dryRun: false, personal_root: "convert", only: [team.short_id] });
    expect(byId.rows.map((r) => r.role)).toEqual([team.short_id]);
    expect(team.handle).toBe(HEAD_OF_PEOPLE_HANDLE);
    expect(home.handle).toBe(LEGACY_HEAD_OF_PEOPLE_HANDLE);
    expect(home.assistant).toBeUndefined();
    // A later run over personal roots alone picks up what was left.
    const later = await performRenameHeadOfPeople(ctx, { personal_root: "convert", scope: "user" });
    expect(later.rows.map((r) => [r.role, r.action])).toEqual([[home.short_id, "convert"]]);
    // Reverse honours the filter too.
    await performRenameHeadOfPeople(ctx, { dryRun: false, reverse: true, only: ["or-none"] });
    expect(team.handle).toBe(HEAD_OF_PEOPLE_HANDLE);
  });

  test("without convert the personal root is renamed like any other", async () => {
    const { ctx, tables } = await seeded();
    await performRenameHeadOfPeople(ctx, { dryRun: false });
    for (const r of tables.org_roles) { expect(r.handle).toBe(HEAD_OF_PEOPLE_HANDLE); expect(r.assistant).toBeUndefined(); }
  });
});

// A role the person already works with becomes their global Executive
// Assistant: the mark is set and nothing else on the row or its seat moves.
describe("migrations.seatExecutiveAssistant", () => {
  const CHARTER = "Keep my own work in order. Reorganizing the company is the Chief of Staff's job.";
  async function seeded() {
    const w = world();
    const role = await performCreateRole(w.ctx, ME as any, { name: "Executive Assistant", handle: "executive-assistant", reports_to: { kind: "user", user_id: ME as any }, charter: CHARTER });
    await performProvisionRole(w.ctx, ME as any, { role_id: String(role._id), adopt_conversation_id: "jxhome1" });
    const row = w.tables.org_roles.find((r) => String(r._id) === String(role._id))!;
    await ensureRoleRoutine(w.ctx, row, w.tables.conversations.find((c) => c._id === "home")!);
    return { ...w, row };
  }

  test("dry by default: names what stays and changes nothing", async () => {
    const { ctx, tables, row } = await seeded();
    const before = JSON.stringify([tables.org_roles, tables.agent_tasks, tables.conversations]);
    const plan = await performSeatExecutiveAssistant(ctx, { only: [row.short_id] });
    expect(plan.dryRun).toBe(true);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({ role: row.short_id, action: "seat", name: "Executive Assistant", handle: "executive-assistant", reports_to: "Me", seat: "jxhome1" });
    expect(plan.rows[0].triggers.length).toBeGreaterThan(0);
    expect(plan.rows[0].charter?.in).toEqual(["role", "doc"]);
    expect(JSON.stringify([tables.org_roles, tables.agent_tasks, tables.conversations])).toBe(before);
  });

  test("the real run sets the reach, brings the charter's one phrase up to date and keeps everything else; reverse puts both back", async () => {
    const { ctx, tables, row } = await seeded();
    const doc = tables.docs.find((d) => String(d._id) === String(row.charter_doc_id))!;
    const docBefore = doc.content;
    expect(docBefore).toContain(CHARTER);
    const kept = JSON.stringify([row.name, row.handle, row.anchor_id, row.brief_doc_id, row.charter_doc_id, tables.agent_tasks, tables.conversations]);
    const run = await performSeatExecutiveAssistant(ctx, { dryRun: false, only: [row.short_id] });
    expect(run.rows[0].action).toBe("seat");
    expect(run.rows[0].charter).toEqual({ in: ["role", "doc"], from: "the Chief of Staff's job", to: "the Head of People's job" });
    expect(row.assistant).toEqual({ reach: "global" });
    expect(row.charter).toBe("Keep my own work in order. Reorganizing the company is the Head of People's job.");
    expect(doc.content).toBe(docBefore.replace("the Chief of Staff's job", "the Head of People's job"));
    expect(JSON.stringify([row.name, row.handle, row.anchor_id, row.brief_doc_id, row.charter_doc_id, tables.agent_tasks, tables.conversations])).toBe(kept);
    // It is the person's global assistant to every reader: the personal
    // workspace's agent, and the seat a hire finds instead of making another.
    expect(isWorkspaceAgentRole(row, undefined)).toBe(true);
    const hire = await performHireAssistant(ctx, ME as any, { reach: { reach: "global" }, project_path: "/repo" });
    expect(hire.already_existed).toBe(true);
    expect(String(hire.role._id)).toBe(String(row._id));
    // A second run has nothing to do.
    expect((await performSeatExecutiveAssistant(ctx, { dryRun: false, only: [row.short_id] })).rows[0]).toMatchObject({ action: "skip", reason: "already an Executive Assistant" });
    const back = await performSeatExecutiveAssistant(ctx, { dryRun: false, reverse: true, only: [row.short_id] });
    expect(back.rows[0].action).toBe("reverse");
    expect(row.assistant).toBeUndefined();
    expect(row.charter).toBe(CHARTER);
    expect(doc.content).toBe(docBefore);
  });

  test("it refuses a team role, a role with an area, the Head of People and a second global assistant", async () => {
    const { ctx, tables, row } = await seeded();
    const team = await performCreateRole(ctx, ME as any, { name: "Ops", handle: "ops", team_id: TEAM, reports_to: { kind: "user", user_id: ME as any } });
    await performStaff(ctx, ME as any, { adopt_conversation_id: "jxmine1" });
    const head = tables.org_roles.find((r) => r.handle === HEAD_OF_PEOPLE_HANDLE)!;
    const other = await performCreateRole(ctx, ME as any, { name: "Second", handle: "second", reports_to: { kind: "user", user_id: ME as any } });
    await performSeatExecutiveAssistant(ctx, { dryRun: false, only: [row.short_id] });
    const run = await performSeatExecutiveAssistant(ctx, { dryRun: false, only: [team.short_id, head.short_id, other.short_id, "or-none"] });
    expect(run.rows.map((r) => r.action)).toEqual(["skip", "skip", "skip"]);
    expect(run.rows.find((r) => r.role === other.short_id)!.reason).toContain(row.short_id);
    for (const r of [team, head, other]) expect(tables.org_roles.find((x) => String(x._id) === String(r._id))!.assistant).toBeUndefined();
  });
});
