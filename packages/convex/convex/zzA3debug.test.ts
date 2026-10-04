import { test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole } from "./orgRoles";
import { resolveScope, sessionsInScope } from "./org";
const ME = "u".repeat(31) + "m"; const TEAM = "teams_acme" as any; const WS = `team:${TEAM}`; const NOW = Date.now();
test("debug", async () => {
  const db = makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    projects: [{ _id: "projects_p", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW }],
    conversations: [{ _id: "conversations_c", short_id: "jx70001", user_id: ME, team_id: TEAM, is_private: false, status: "active", agent_type: "claude_code", title: "Session", project_path: "/repo/growth", message_count: 3, updated_at: NOW, created_at: 1 }],
    counters: [],
  });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: ME }) } };
  const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: ["projects_p" as any], plan_ids: [] } });
  const resolved = await resolveScope(ctx as any, ME as any, { role_id: String(role._id) });
  console.log("resolved", !!resolved, resolved?.projects.length);
  try { const s = await sessionsInScope(ctx as any, resolved as any, Date.now()); console.log("sessions", s.length, JSON.stringify(s).slice(0, 300)); } catch (e) { console.log("threw", e); }
});
