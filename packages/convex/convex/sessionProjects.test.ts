// A session's project (docs/architecture/session-projects.md): a person puts a
// session in a project, its workers follow without a copy, a bound task names
// one, and neither side the caller cannot see can be joined.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { effectiveSessionProjectId } from "./sessionProjects";

const TOKEN = "p".repeat(64);
const OTHER = "o".repeat(64);
const api = anyApi as any;

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    const other = await ctx.db.insert("users", { name: "Ben" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: 0, last_used_at: 0 } as any);
    await ctx.db.insert("api_tokens", { user_id: other, token_hash: await hashToken(OTHER), name: "cli", created_at: 0, last_used_at: 0 } as any);
    const project = (owner: any, title: string) =>
      ctx.db.insert("projects", { user_id: owner, workspace: `user:${owner}`, title, status: "active", created_at: 0, updated_at: 0 } as any);
    const mobile = await project(user, "Mobile");
    const web = await project(user, "Web");
    const bens = await project(other, "Ben's");
    const conv = (session_id: string, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("conversations", { user_id: user, agent_type: "claude_code", session_id, started_at: 0, updated_at: 0, message_count: 0, status: "active", is_private: true, ...extra } as any);
    const lead = await conv("lead");
    const worker = await conv("worker", { parent_conversation_id: lead, is_subagent: true });
    const spawned = await conv("spawned", { spawned_by_conversation_id: worker });
    const task = await ctx.db.insert("tasks", { user_id: user, workspace: `user:${user}`, title: "Ship it", status: "open", project_id: web, created_at: 0, updated_at: 0 } as any);
    const bound = await conv("bound", { parent_conversation_id: lead, active_task_id: task });
    return { mobile, web, bens, lead, worker, spawned, bound };
  });
  const effective = (id: any) => t.run(async (ctx) => effectiveSessionProjectId(ctx as any, (await ctx.db.get(id))!));
  const set = (conversation_id: any, project_id: any, api_token = TOKEN) =>
    t.mutation(api.sessionProjects.setSessionProject, { session: String(conversation_id), project_id, api_token });
  return { t, ids, effective, set };
}

describe("session projects", () => {
  test("putting a lead in a project puts its workers and their spawns there too", async () => {
    const { ids, effective, set } = await setup();
    expect(await effective(ids.spawned)).toBeNull();
    await set(ids.lead, ids.mobile);
    expect(await effective(ids.lead)).toBe(ids.mobile);
    expect(await effective(ids.worker)).toBe(ids.mobile);
    expect(await effective(ids.spawned)).toBe(ids.mobile);
  });

  test("moving the lead moves its workers, and nothing was copied onto them", async () => {
    const { t, ids, effective, set } = await setup();
    await set(ids.lead, ids.mobile);
    await set(ids.lead, ids.web);
    expect(await effective(ids.spawned)).toBe(ids.web);
    const worker = await t.run((ctx) => ctx.db.get(ids.worker));
    expect(worker?.project_id).toBeUndefined();
  });

  test("a worker bound to a task in another project works in that task's project", async () => {
    const { ids, effective, set } = await setup();
    await set(ids.lead, ids.mobile);
    expect(await effective(ids.bound)).toBe(ids.web);
  });

  test("a short id or the agent's session uuid names the session", async () => {
    const { t, ids, effective } = await setup();
    await t.mutation(api.sessionProjects.setSessionProject, { session: "worker", project_id: ids.mobile, api_token: TOKEN });
    expect(await effective(ids.worker)).toBe(ids.mobile);
  });

  test("null takes a session out", async () => {
    const { ids, effective, set } = await setup();
    await set(ids.lead, ids.mobile);
    await set(ids.lead, null);
    expect(await effective(ids.worker)).toBeNull();
  });

  test("a project the caller cannot read is refused", async () => {
    const { ids, set } = await setup();
    await expect(set(ids.lead, ids.bens)).rejects.toThrow("Project not found");
  });

  test("a session the caller cannot open is refused", async () => {
    const { ids, set } = await setup();
    await expect(set(ids.lead, ids.bens, OTHER)).rejects.toThrow("Session not found");
  });
});

// A project's default session (SP4): the first session its own composer starts
// becomes the canonical one, and a lead hired for the project adopts it.
import { makeFakeDb } from "./testDb";
import { dispatch } from "./dispatch";
import { setTitleAndSubtitle } from "./titleGeneration";
import { performCreateRole, performProvisionRole } from "./orgRoles";
import { projectDefaultSessionId } from "./sessionProjects";

describe("a project's default session", () => {
  const ME = "u".repeat(31) + "m";
  const TEAM = "teams_acme" as any;
  const PROJ = "projects_app";

  function world() {
    const db = makeFakeDb({
      users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
      team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
      teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
      projects: [{ _id: PROJ, user_id: ME, team_id: TEAM, workspace: `team:${TEAM}`, short_id: "pr-1", title: "App", status: "active", created_at: 1, updated_at: 1 }],
      rate_limits: [], directory_team_mappings: [], conversations: [], devices: [], daemon_commands: [], change_log: [],
      local_view_heads: [], docs: [], plans: [], tasks: [], counters: [], org_roles: [], org_role_history: [], org_changes: [],
      org_proposals: [], org_proposal_changes: [], anchors: [], anchor_channels: [], session_commands: [], agent_tasks: [],
      pending_messages: [], managed_sessions: [], session_owners: [], messages: [], user_presence: [], session_decisions: [],
      decision_inbox: [], decision_grants: [],
    });
    const ctx: any = { db, auth: { getUserIdentity: async () => ({ subject: `${ME}|session` }) }, scheduler: { runAfter: async () => {} } };
    const create = (session_id: string, extra: Record<string, unknown>) =>
      (dispatch as any)._handler(ctx, { action: "createSession", args: [{ agent_type: "claude_code", project_path: "/repo", session_id, ...extra }] });
    const conv = (session_id: string) => db._tables.conversations.find((c: any) => c.session_id === session_id);
    const project = () => db._tables.projects.find((p: any) => p._id === PROJ);
    return { ctx, db, create, conv, project };
  }

  test("the first session the project's composer starts is born in it and becomes its default", async () => {
    const w = world();
    await w.create("first", { project_id: PROJ, project_default: true });
    await w.create("second", { project_id: PROJ, project_default: true });
    expect(String(w.conv("first").project_id)).toBe(PROJ);
    expect(String(w.conv("second").project_id)).toBe(PROJ);
    expect(String(w.project().default_session_id)).toBe(String(w.conv("first")._id));
    expect(String(await projectDefaultSessionId(w.ctx, w.project()))).toBe(String(w.conv("first")._id));
  });

  test("a session started elsewhere in the project does not become its default", async () => {
    const w = world();
    await w.create("plain", { project_id: PROJ });
    expect(String(w.conv("plain").project_id)).toBe(PROJ);
    expect(w.project().default_session_id).toBeUndefined();
  });

  test("a project the creator cannot read is dropped, not trusted", async () => {
    const w = world();
    w.db._tables.projects.push({ _id: "projects_other", user_id: "users_x", workspace: "user:users_x", title: "Other", status: "active", created_at: 1, updated_at: 1 });
    await w.create("s", { project_id: "projects_other", project_default: true });
    expect(w.conv("s").project_id).toBeUndefined();
  });

  test("a session started as a new project makes the project, once, in the composer's team, as its default", async () => {
    const w = world();
    const np = { title: "Billing rework", client_key: "pjstub-s", team_id: TEAM, description: "Billing rework: move invoices to the new ledger." };
    await w.create("s", { new_project: np });
    await w.create("s", { new_project: np });
    const made = w.db._tables.projects.filter((p: any) => p.client_key === "pjstub-s");
    expect(made.length).toBe(1);
    expect(made[0].title).toBe("Billing rework");
    expect(made[0].description).toBe("Billing rework: move invoices to the new ledger.");
    expect(String(made[0].team_id)).toBe(String(TEAM));
    expect(made[0].short_id).toBeTruthy();
    expect(String(w.conv("s").project_id)).toBe(String(made[0]._id));
    expect(String(made[0].default_session_id)).toBe(String(w.conv("s")._id));
  });

  test("a project started from a session takes the session's generated title until renamed", async () => {
    const w = world();
    await w.create("s", { new_project: { title: "Release notes draft: read the doc and write", client_key: "pjstub-t", team_id: TEAM } });
    const made = () => w.db._tables.projects.find((p: any) => p.client_key === "pjstub-t");
    expect(made().title_from_session).toBe(true);
    await (setTitleAndSubtitle as any)._handler(w.ctx, { conversation_id: w.conv("s")._id, title: "Projects release notes" });
    expect(made().title).toBe("Projects release notes");
    // A rename ends it: the next generated title leaves the project alone.
    made().title = "Mine"; delete made().title_from_session;
    await (setTitleAndSubtitle as any)._handler(w.ctx, { conversation_id: w.conv("s")._id, title: "Something else" });
    expect(made().title).toBe("Mine");
  });

  test("a new project in a team the creator is not in is made personal", async () => {
    const w = world();
    await w.create("s", { new_project: { title: "Mine", client_key: "pjstub-m", team_id: "teams_other" } });
    const made = w.db._tables.projects.find((p: any) => p.client_key === "pjstub-m");
    expect(made.team_id).toBeUndefined();
    expect(String(made.user_id)).toBe(ME);
  });

  test("a lead hired for the project takes over its canonical session as the seat", async () => {
    const w = world();
    await w.create("first", { project_id: PROJ, project_default: true });
    const canonical = w.conv("first");
    const role = await performCreateRole(w.ctx, ME as any, { name: "App lead", handle: "app", team_id: TEAM, scope: { project_ids: [PROJ as any], plan_ids: [] } });
    w.project().owner_role_id = role._id;
    await performProvisionRole(w.ctx, ME as any, { role_id: String(role._id) });
    const seated = w.db._tables.conversations.find((c: any) => String(c._id) === String(canonical._id));
    expect(String(seated.standing_role_id)).toBe(String(role._id));
    expect(String(await projectDefaultSessionId(w.ctx, w.project()))).toBe(String(canonical._id));
  });
});
