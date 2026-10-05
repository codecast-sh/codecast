// org.where: a session reads where it sits. The ownership rule places a bound
// session (S26, most specific role wins), a folder places nothing (S35), a
// standing session is its role, and the chain runs up to a person.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { computeOrgWhere } from "./orgWhere";
import { orgContextBlock } from "@codecast/shared/contracts/orgWhere";

const ME = "u".repeat(31) + "m";
const SAM = "u".repeat(31) + "s";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const P = "projects_growth";
const PLAN = "plans_seo";
const GROWTH = "org_roles_growth";
const SEO = "org_roles_seo";
const HOP = "org_roles_hop";

const role = (over: any) => ({ team_id: TEAM, status: "active", charter: "", scope: { project_ids: [], plan_ids: [] }, created_at: 1, ...over });
const conv = (over: any) => ({ user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", created_at: 1, updated_at: 1, message_count: 1, ...over });

function db() {
  return makeFakeDb({
    users: [{ _id: ME, name: "Ashot" }, { _id: SAM, name: "Sam" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: SAM, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    projects: [{ _id: P, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", goal: "Reach 1k teams", status: "active", created_at: 1, updated_at: 1 }],
    plans: [{ _id: PLAN, team_id: TEAM, workspace: WS, project_id: P, short_id: "pl-1", title: "Search", status: "active", created_at: 1, updated_at: 1 }],
    tasks: [{ _id: "tasks_t1", team_id: TEAM, workspace: WS, plan_id: PLAN, short_id: "ct-1", title: "Fix sitemap", status: "open", created_at: 1, updated_at: 1 }],
    org_roles: [
      role({ _id: GROWTH, short_id: "or-1", handle: "growth", name: "Growth lead", reports_to: { kind: "user", user_id: ME }, scope: { project_ids: [P], plan_ids: [] } }),
      role({ _id: SEO, short_id: "or-2", handle: "seo", name: "SEO lead", reports_to: { kind: "role", role_id: GROWTH }, scope: { project_ids: [], plan_ids: [PLAN] } }),
      role({ _id: HOP, short_id: "or-3", handle: "head-of-people", name: "Head of People", reports_to: { kind: "user", user_id: SAM } }),
      role({ _id: "org_roles_gone", short_id: "or-4", handle: "gone", name: "Retired", status: "retired", reports_to: { kind: "user", user_id: ME } }),
    ],
    anchors: [],
    initiatives: [
      { _id: "initiatives_top", workspace: WS, short_id: "in-1", title: "Reach 1k teams", status: "active", project_ids: [], metrics: [] },
      { _id: "initiatives_win", workspace: WS, short_id: "in-2", title: "Win search", status: "active", project_ids: [P], parent_initiative_id: "initiatives_top", metrics: [] },
    ],
    conversations: [
      conv({ _id: "conversations_bound", short_id: "jx1", title: "Sitemap fix", active_task_id: "tasks_t1", project_path: "/repo/growth" }),
      conv({ _id: "conversations_worker", short_id: "jx2", title: "Sitemap worker", parent_conversation_id: "conversations_bound", project_path: "/repo/growth" }),
      conv({ _id: "conversations_standing", short_id: "jx3", title: "Growth lead", standing_role_id: GROWTH }),
    ],
  });
}

const read = async (id: string | null) => {
  const ctx = { db: db() };
  return computeOrgWhere(ctx, ME as any, TEAM, id ? await ctx.db.get(id as any) : null);
};

describe("org.where", () => {
  test("a bound session sits under the most specific role, with the chain to a person and the goals it serves", async () => {
    const w = (await read("conversations_bound"))!;
    expect(w.work.task?.short_id).toBe("ct-1");
    expect(w.work.plan?.short_id).toBe("pl-1");
    expect(w.work.project?.title).toBe("Growth");
    expect(w.seat).toEqual({ how: "owner", handles: ["seo"] });
    expect(w.chain).toEqual(["@growth", "Ashot"]);
    expect(w.card?.handle).toBe("seo");
    expect(w.roles.map((r) => r.handle)).toEqual(["growth", "seo", "head-of-people"]);
    expect(w.roles.find((r) => r.handle === "head-of-people")?.whole_workspace).toBe(true);
    expect(w.roles.find((r) => r.handle === "seo")?.seat).toBe(true);
    const text = orgContextBlock(w);
    expect(text).toContain("The role that answers for this work: @seo (SEO lead), reporting to @growth → Ashot.");
    expect(text).toContain("@head-of-people Head of People · reports to Sam · looks after whatever no narrower role covers");
    expect(text).toContain("Most things go sideways, not up.");
  });

  test("a spawned worker bound to nothing sits under no role, whatever its folder, and names its lead", async () => {
    const w = (await read("conversations_worker"))!;
    expect(w.seat).toEqual({ how: "none", handles: [] });
    expect(w.card).toBeNull();
    expect(w.session?.lead?.short_id).toBe("jx1");
    const text = orgContextBlock(w);
    expect(text).toContain("Spawned by: jx1 Sitemap fix. That session is your lead.");
    expect(text).toContain("it answers to Ashot");
  });

  test("a standing session is its role, and its card carries what the area serves", async () => {
    const w = (await read("conversations_standing"))!;
    expect(w.seat).toEqual({ how: "standing", handles: ["growth"] });
    expect(w.chain).toEqual(["Ashot"]);
    expect(w.card?.initiatives?.[0]).toMatchObject({ short_id: "in-2", chain: ["Reach 1k teams"] });
    expect(orgContextBlock(w)).toContain("Serves: Win search (in-2), under Reach 1k teams");
  });

  test("no session still shows the roster; a workspace with no live roles says nothing", async () => {
    const w = (await read(null))!;
    expect(w.session).toBeNull();
    expect(w.roles).toHaveLength(3);
    const empty = makeFakeDb({ users: [{ _id: ME, name: "Ashot" }], teams: [{ _id: TEAM, name: "Acme" }], team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }], org_roles: [], anchors: [] });
    expect(await computeOrgWhere({ db: empty }, ME as any, TEAM, null)).toBeNull();
  });
});
