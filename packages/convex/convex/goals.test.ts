// goals.brief (the-line-end-to-end.md LE5): the active initiatives of the
// caller's workspace with their metrics, and the charter of every live project
// that has one or that an active initiative carries. Other workspaces, closed
// initiatives and charterless side projects stay out.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { brief } from "./goals";
import { hashToken } from "./apiTokens";

const OWNER = "users_owner";
const TOKEN = "goals-token";
const WS = `user:${OWNER}`;

async function makeCtx() {
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner" }, { _id: "users_other", name: "Other" }],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    org_roles: [{ _id: "org_roles_1", handle: "growth" }],
    projects: [
      { _id: "projects_a", short_id: "pj-a", user_id: OWNER, workspace: WS, title: "Onboarding", status: "active", goal: "Day one agent run", priority: "p1", owner_role_id: "org_roles_1" },
      { _id: "projects_b", short_id: "pj-b", user_id: OWNER, workspace: WS, title: "Carried", status: "planning" },
      { _id: "projects_c", short_id: "pj-c", user_id: OWNER, workspace: WS, title: "Side", status: "active" },
      { _id: "projects_d", short_id: "pj-d", user_id: OWNER, workspace: WS, title: "Shipped", status: "done", goal: "Old" },
      { _id: "projects_x", short_id: "pj-x", user_id: "users_other", workspace: "user:users_other", title: "Theirs", status: "active", goal: "Hidden" },
    ],
    initiatives: [
      { _id: "initiatives_1", short_id: "in-1", user_id: OWNER, workspace: WS, title: "Retention", status: "active", health: "at_risk", priority: "p0",
        owner: { kind: "role", role_id: "org_roles_1" }, project_ids: ["projects_a", "projects_b"],
        metrics: [{ key: "w4", name: "Week 4", target: "40%" }], scoreboard: { w4: { value: "31%", observed_at: 1, source: "posthog" } } },
      { _id: "initiatives_2", short_id: "in-2", user_id: OWNER, workspace: WS, title: "Done", status: "completed", health: "none", project_ids: [] },
      { _id: "initiatives_3", short_id: "in-3", user_id: "users_other", workspace: "user:users_other", title: "Theirs", status: "active", health: "none", project_ids: [] },
    ],
  };
  return { auth: { async getUserIdentity() { return null; } }, db: makeFakeDb(tables) } as any;
}

describe("goals.brief", () => {
  test("the caller's workspace: active initiatives and live charters", async () => {
    const out = await (brief as any)._handler(await makeCtx(), { api_token: TOKEN, workspace: "personal" });
    expect(out.workspace).toBe(WS);
    expect(out.initiatives).toEqual([{
      short_id: "in-1", title: "Retention", priority: "p0", owner: "@growth", target_date: undefined, health: "at_risk", description: undefined,
      metrics: [{ key: "w4", name: "Week 4", target: "40%" }], scoreboard: { w4: { value: "31%", observed_at: 1, source: "posthog" } },
      project_short_ids: ["pj-a", "pj-b"],
    }]);
    expect(out.projects.map((p: any) => p.short_id).sort()).toEqual(["pj-a", "pj-b"]);
    expect(out.projects.find((p: any) => p.short_id === "pj-a")).toMatchObject({ goal: "Day one agent run", priority: "p1", owner_role: "@growth" });
  });

  test("one project (LP1): its charter and the initiatives that carry it, nothing else", async () => {
    const out = await (brief as any)._handler(await makeCtx(), { api_token: TOKEN, workspace: "personal", project: "Carried" });
    expect(out.project_title).toBe("Carried");
    expect(out.projects.map((p: any) => p.short_id)).toEqual(["pj-b"]);
    expect(out.initiatives.map((i: any) => i.short_id)).toEqual(["in-1"]);
    const side = await (brief as any)._handler(await makeCtx(), { api_token: TOKEN, workspace: "personal", project: "pj-c" });
    expect(side.projects.map((p: any) => p.short_id)).toEqual(["pj-c"]);
    expect(side.initiatives).toEqual([]);
    await expect((brief as any)._handler(await makeCtx(), { api_token: TOKEN, workspace: "personal", project: "Theirs" })).rejects.toThrow(/No project matching/);
  });
});
