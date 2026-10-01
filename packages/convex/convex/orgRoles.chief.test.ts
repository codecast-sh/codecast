import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { CHIEF_OF_STAFF_HANDLE, HEAD_OF_PEOPLE_HANDLE, LEGACY_HEAD_OF_PEOPLE_HANDLE } from "@codecast/shared/contracts/orgLead";
import { chiefOfStaffCharter, defaultChiefHandle, headOfPeopleCharter, performCreateRole, performHireChief, performStaff } from "./orgRoles";
import { liveRoleByHandle } from "./lib/orgAccess";
import { findExistingAnchor, isWorkspaceAgentRole, roleBootstrapOf } from "./anchors";
import { performRenameHeadOfPeople } from "./migrations";
import { resolveChatMentions } from "./lib/mentionResolve";

// The Head of People rename and the Chief of Staff as the person's right hand
// (docs/architecture/org-staffing.md S30): the old handle keeps resolving, a
// chief owns no work and lives in its own boundary, the workspace's agent is
// the chief when one stands, and the migration converts the personal root
// when told and puts everything back on reverse.

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
  test("@chief-of-staff finds the Head of People under either handle until a chief stands", async () => {
    const { ctx, tables } = world();
    await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    expect(tables.org_roles[0].handle).toBe(HEAD_OF_PEOPLE_HANDLE);
    const byOld = await liveRoleByHandle(ctx, { team_id: TEAM }, LEGACY_HEAD_OF_PEOPLE_HANDLE);
    expect(byOld?._id).toBe(tables.org_roles[0]._id);
    // A row still carrying the old handle (prod before the migration) answers to the new one.
    tables.org_roles[0].handle = LEGACY_HEAD_OF_PEOPLE_HANDLE;
    const byNew = await liveRoleByHandle(ctx, { team_id: TEAM }, HEAD_OF_PEOPLE_HANDLE);
    expect(byNew?._id).toBe(tables.org_roles[0]._id);
    // Once a Chief of Staff stands under the handle, the handle is the chief's.
    tables.org_roles[0].handle = HEAD_OF_PEOPLE_HANDLE;
    const chief = await performHireChief(ctx, ME as any, { reach: { reach: "team", team_id: TEAM }, project_path: "/repo" });
    expect(chief.role.handle).toBe(CHIEF_OF_STAFF_HANDLE);
    const now = await liveRoleByHandle(ctx, { team_id: TEAM }, LEGACY_HEAD_OF_PEOPLE_HANDLE);
    expect(String(now._id)).toBe(String(chief.role._id));
  });
});

describe("hiring a Chief of Staff", () => {
  test("a global chief lives in the person's boundary, owns no work and is the personal workspace's agent", async () => {
    const { ctx, tables } = world();
    const out = await performHireChief(ctx, ME as any, { reach: { reach: "global" }, given_name: "Ada", project_path: "/repo" });
    expect(out.created).toBe(true);
    const role = tables.org_roles.find((r) => String(r._id) === String(out.role._id))!;
    expect(role.scope_type).toBe("user");
    expect(role.team_id).toBeUndefined();
    expect(role.chief).toEqual({ reach: "global" });
    expect(role.given_name).toBe("Ada");
    expect(role.name).toBe("Chief of Staff");
    expect(role.handle).toBe(CHIEF_OF_STAFF_HANDLE);
    expect(role.scope).toEqual({ project_ids: [], plan_ids: [] });
    expect(role.charter).toBe(chiefOfStaffCharter("Me"));
    expect(out.role.given_name).toBe("Ada");
    // Its opening is the right hand's, named, reaching everything.
    const boot = await roleBootstrapOf(ctx, role);
    expect(boot.chiefOpening).toContain("You are Ada, Me's Chief of Staff for everything Me works on");
    expect(boot.chiefOpening).toContain("every workspace they are in");
    // The seat is the personal workspace's agent now.
    const seat = await findExistingAnchor(ctx, { scope_type: "user", scope_user_id: ME as any });
    expect(String(seat?.org_role_id)).toBe(String(role._id));
    expect(isWorkspaceAgentRole(role, undefined)).toBe(true);
    // Hiring again is the same seat.
    const again = await performHireChief(ctx, ME as any, { reach: { reach: "global" }, project_path: "/repo" });
    expect(again.already_existed).toBe(true);
    expect(String(again.role._id)).toBe(String(role._id));
  });

  test("a personal chief for one team sits beside the global one with its own handle, and never reads as the team's agent", async () => {
    const { ctx, tables } = world();
    await performHireChief(ctx, ME as any, { reach: { reach: "global" }, project_path: "/repo" });
    const own = await performHireChief(ctx, ME as any, { reach: { reach: "team", team_id: TEAM }, personal: true, project_path: "/repo" });
    const role = tables.org_roles.find((r) => String(r._id) === String(own.role._id))!;
    expect(role.scope_type).toBe("user");
    expect(role.chief).toEqual({ reach: "team", team_id: TEAM });
    expect(role.handle).toBe("chief-of-staff-acme");
    expect(isWorkspaceAgentRole(role, TEAM)).toBe(false);
    expect(isWorkspaceAgentRole(role, undefined)).toBe(false);
    const boot = await roleBootstrapOf(ctx, role);
    expect(boot.chiefOpening).toContain("Chief of Staff for Acme");
    expect(boot.chiefOpening).toContain("--team Acme");
  });

  test("a team chief lives in the team, is the team's agent over the Head of People, and answers @anchor", async () => {
    const { ctx, tables } = world();
    await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    const head = tables.org_roles[0];
    expect(isWorkspaceAgentRole(head, TEAM)).toBe(true);
    const out = await performHireChief(ctx, ME as any, { reach: { reach: "team", team_id: TEAM }, project_path: "/repo" });
    const chief = tables.org_roles.find((r) => String(r._id) === String(out.role._id))!;
    expect(chief.scope_type).toBe("team");
    expect(chief.team_id).toBe(TEAM);
    const seat = await findExistingAnchor(ctx, { scope_type: "team", team_id: TEAM });
    expect(String(seat?.org_role_id)).toBe(String(chief._id));
    const mentions = await resolveChatMentions(ctx, TEAM, "@anchor what is the plan?", ME as any);
    expect(mentions.roles.map((r: any) => String(r._id))).toEqual([String(chief._id)]);
  });

  test("a chief refuses a scope", async () => {
    const { ctx } = world();
    await expect(performCreateRole(ctx, ME as any, { name: "Chief of Staff", handle: "cos", chief: { reach: "global" }, scope: { project_ids: ["p1" as any], plan_ids: [] } })).rejects.toThrow(/owns no area/);
  });

  test("default handles never collide", () => {
    const taken = new Set([CHIEF_OF_STAFF_HANDLE, "chief-of-staff-acme"]);
    expect(defaultChiefHandle({ reach: "global" }, true, null, (h) => taken.has(h))).toBe("chief-of-staff-2");
    expect(defaultChiefHandle({ reach: "team", team_id: TEAM }, true, "Acme Inc", (h) => taken.has(h))).toBe("chief-of-staff-acme-inc");
    expect(defaultChiefHandle({ reach: "team", team_id: TEAM }, false, "Acme", (h) => taken.has(h))).toBe("chief-of-staff-2");
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

  test("the team root becomes the Head of People; the personal root becomes the global chief; reverse puts both back", async () => {
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

    expect(home.handle).toBe(CHIEF_OF_STAFF_HANDLE);
    expect(home.chief).toEqual({ reach: "global" });
    expect(home.charter).toBe(chiefOfStaffCharter("Me"));
    const homeTasks = tables.agent_tasks.filter((t) => t.role_id === home._id);
    expect(homeTasks.find((t) => t.title === "Company review")!.status).toBe("completed");
    expect(homeTasks.find((t) => t.title !== "Company review" && t.status === "scheduled")).toBeTruthy();
    // Both still answer to the old handle in their own boundary.
    expect((await liveRoleByHandle(ctx, { team_id: TEAM }, LEGACY_HEAD_OF_PEOPLE_HANDLE))?._id).toBe(team._id);
    expect((await liveRoleByHandle(ctx, { scope_user_id: ME }, LEGACY_HEAD_OF_PEOPLE_HANDLE))?._id).toBe(home._id);
    // Running again changes nothing more.
    expect((await performRenameHeadOfPeople(ctx, { dryRun: false, personal_root: "convert" })).rows).toEqual([]);

    const back = await performRenameHeadOfPeople(ctx, { dryRun: false, reverse: true });
    expect(back.rows.map((r) => r.action)).toEqual(["reverse", "reverse"]);
    expect(team.handle).toBe(LEGACY_HEAD_OF_PEOPLE_HANDLE);
    expect(team.name).toBe("Chief of Staff");
    expect(team.renamed_from).toBeUndefined();
    expect(tables.conversations.find((c) => c._id === "mine")!.title).toBe("Chief of Staff");
    expect(home.chief).toBeUndefined();
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

  test("without convert the personal root is renamed like any other", async () => {
    const { ctx, tables } = await seeded();
    await performRenameHeadOfPeople(ctx, { dryRun: false });
    for (const r of tables.org_roles) { expect(r.handle).toBe(HEAD_OF_PEOPLE_HANDLE); expect(r.chief).toBeUndefined(); }
  });
});
