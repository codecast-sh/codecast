import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { EXECUTIVE_ASSISTANT_HANDLE, HEAD_OF_PEOPLE_HANDLE, LEGACY_HEAD_OF_PEOPLE_HANDLE } from "@codecast/shared/contracts/orgLead";
import { executiveAssistantCharter, defaultAssistantHandle, ensureRoleRoutine, headOfPeopleCharter, performCreateRole, performHireAssistant, performProvisionRole, performStaff } from "./orgRoles";
import { liveRoleByHandle } from "./lib/orgAccess";
import { findExistingAnchor, performSetWorkspaceAgent, roleBootstrapOf, workspaceAgentRoleOf } from "./anchors";
import { resolveChatMentions } from "./lib/mentionResolve";
import { charterText } from "./roleCharter.testkit";

// The Head of People rename and the Executive Assistant as the person's right hand
// (docs/architecture/org-staffing.md S30): the old handle keeps naming the
// Head of People, an assistant owns no work and lives in its own boundary, a
// person's own workspace agent is their global assistant, a team's is the role
// its admins chose else its Head of People, and the migrations
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
    expect(await charterText(ctx.db, role)).toBe(executiveAssistantCharter("Me"));
    expect(out.role.given_name).toBe("Ada");
    // Its opening is the right hand's, named, reaching everything.
    const boot = await roleBootstrapOf(ctx, role);
    expect(boot.assistantOpening).toContain("You are Ada, Me's Executive Assistant for everything Me works on");
    expect(boot.assistantOpening).toContain("every workspace they are in");
    // The seat is the personal workspace's agent now.
    const seat = await findExistingAnchor(ctx, { scope_type: "user", scope_user_id: ME as any });
    expect(String(seat?.org_role_id)).toBe(String(role._id));
    expect(workspaceAgentRoleOf([role], {})).toBe(role);
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
    expect(workspaceAgentRoleOf([role], { team_id: TEAM })).toBeNull();
    expect(workspaceAgentRoleOf([role], {})).toBeNull();
    const boot = await roleBootstrapOf(ctx, role);
    expect(boot.assistantOpening).toContain("Executive Assistant for Acme");
    expect(boot.assistantOpening).toContain("--team Acme");
  });

  test("a team assistant lives in the team; the Head of People answers for the team until an admin chooses the assistant", async () => {
    const { ctx, tables } = world();
    await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    const head = tables.org_roles[0];
    const out = await performHireAssistant(ctx, ME as any, { reach: { reach: "team", team_id: TEAM }, project_path: "/repo" });
    const assistant = tables.org_roles.find((r) => String(r._id) === String(out.role._id))!;
    expect(assistant.scope_type).toBe("team");
    expect(assistant.team_id).toBe(TEAM);
    // Hiring moves nothing: the Head of People still answers @anchor.
    const answering = async () => String((await findExistingAnchor(ctx, { scope_type: "team", team_id: TEAM }))?.org_role_id);
    const anchorMention = async () => (await resolveChatMentions(ctx, TEAM, "@anchor what is the plan?", ME as any)).roles.map((r: any) => String(r._id));
    expect(await answering()).toBe(String(head._id));
    expect(await anchorMention()).toEqual([String(head._id)]);
    // An admin's choice moves it, and clearing it moves it back.
    await performSetWorkspaceAgent(ctx, ME as any, { team_id: TEAM, role_id: assistant._id });
    expect(await answering()).toBe(String(assistant._id));
    expect(await anchorMention()).toEqual([String(assistant._id)]);
    await performSetWorkspaceAgent(ctx, ME as any, { team_id: TEAM, role_id: null });
    expect(await answering()).toBe(String(head._id));
  });

  test("only a team admin may choose, and only one of the team's seated roles", async () => {
    const { ctx, tables } = world();
    await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    const own = await performHireAssistant(ctx, ME as any, { reach: { reach: "team", team_id: TEAM }, personal: true, project_path: "/repo" });
    await expect(performSetWorkspaceAgent(ctx, ME as any, { team_id: TEAM, role_id: own.role._id })).rejects.toThrow(/not one of this team's/);
    tables.team_memberships[0].role = "member";
    await expect(performSetWorkspaceAgent(ctx, ME as any, { team_id: TEAM, role_id: null })).rejects.toThrow(/Only a team admin/);
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

