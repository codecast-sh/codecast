// Strict team-workspace boundaries for tasks, plans, and docs.
//
// The rule under test: a team view returns ONLY that team's records, and the
// personal view returns ONLY teamless records. A personal (teamless) item must
// never follow its owner into a team space — not via the old "orphan rescue"
// unions, not via assignment, not via a paginated orphan phase. For docs the
// workspace is the EFFECTIVE team (a linked private conversation makes a doc
// personal regardless of its raw team tag), and access checks follow the same
// derivation as list scoping.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  webList as webTaskList,
  webListPaginated as webTaskListPaginated,
  webCreate as webTaskCreate,
} from "./tasks";
import { webList as webPlanList } from "./plans";
import {
  webList as webDocList,
  webListPaginated as webDocListPaginated,
  webGet as webDocGet,
  webCreate as webDocCreate,
  mentionSearch,
} from "./docs";

function auth(userId: string | null) {
  return {
    async getUserIdentity() {
      return userId ? { subject: `${userId}|session` } : null;
    },
  };
}

function ctx(userId: string | null, tables: Record<string, any[]>) {
  return {
    auth: auth(userId),
    db: makeFakeDb(tables),
    scheduler: { runAfter: async () => null },
    runMutation: async () => null,
  } as any;
}

const OWNER = "u_owner";
const MEMBER = "u_member";
const STRANGER = "u_stranger";
const TEAM = "t_team";
const OTHER_TEAM = "t_other";

function baseTables(extra: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    users: [
      { _id: OWNER, name: "Owner", team_id: TEAM },
      { _id: MEMBER, name: "Member", team_id: TEAM },
      { _id: STRANGER, name: "Stranger" },
    ],
    teams: [
      { _id: TEAM, name: "Union", invite_code: "SECRET" },
      { _id: OTHER_TEAM, name: "Footage", invite_code: "OTHER" },
    ],
    team_memberships: [
      { _id: "m_owner", user_id: OWNER, team_id: TEAM, role: "admin" },
      { _id: "m_member", user_id: MEMBER, team_id: TEAM, role: "member" },
      { _id: "m_owner_other", user_id: OWNER, team_id: OTHER_TEAM, role: "member" },
    ],
    ...extra,
  };
}

const taskDefaults = { status: "open", task_type: "task", priority: "medium", source: "human", created_at: 1, updated_at: 1 };

function taskTables(extra: Record<string, any[]> = {}) {
  return baseTables({
    tasks: [
      { _id: "t_team", short_id: "ct-team", title: "Team task", user_id: MEMBER, team_id: TEAM, ...taskDefaults },
      // Personal task owned by AND assigned to the viewer — the exact shape the
      // old team-view rescue leaked into the Union board.
      { _id: "t_personal", short_id: "ct-personal", title: "Personal task", user_id: OWNER, assignee: OWNER, ...taskDefaults },
      // Teamless task someone else assigned to the viewer: personal view only.
      { _id: "t_assigned", short_id: "ct-assigned", title: "Assigned orphan", user_id: STRANGER, assignee: OWNER, ...taskDefaults },
      // Another team the viewer belongs to: never in TEAM's view.
      { _id: "t_other", short_id: "ct-other", title: "Other team task", user_id: OWNER, assignee: OWNER, team_id: OTHER_TEAM, ...taskDefaults },
    ],
    plans: [],
    ...extra,
  });
}

describe("tasks: strict workspace boundaries", () => {
  test("team view returns only this team's tasks — no personal or assigned orphans", async () => {
    const result = await (webTaskList as any)._handler(ctx(OWNER, taskTables()), {
      workspace: "team",
      team_id: TEAM,
    });
    expect(result.items.map((t: any) => t._id)).toEqual(["t_team"]);
  });

  test("personal view returns only teamless tasks (owned or assigned)", async () => {
    const result = await (webTaskList as any)._handler(ctx(OWNER, taskTables()), {
      workspace: "personal",
    });
    expect(result.items.map((t: any) => t._id).sort()).toEqual(["t_assigned", "t_personal"]);
  });

  test("paginated personal crawl excludes the user's team-tagged tasks", async () => {
    const result = await (webTaskListPaginated as any)._handler(ctx(OWNER, taskTables()), {
      workspace: "personal",
      paginationOpts: { numItems: 100, cursor: null },
    });
    expect(result.page.map((t: any) => t._id)).toEqual(["t_personal"]);
  });

  test("paginated team crawl returns only this team's tasks", async () => {
    const result = await (webTaskListPaginated as any)._handler(ctx(OWNER, taskTables()), {
      workspace: "team",
      team_id: TEAM,
      paginationOpts: { numItems: 100, cursor: null },
    });
    expect(result.page.map((t: any) => t._id)).toEqual(["t_team"]);
  });
});

describe("plans: strict workspace boundaries", () => {
  const planDefaults = { status: "active", source: "human", created_at: 1, updated_at: 1, task_ids: [] };
  const tables = () => baseTables({
    plans: [
      { _id: "p_team", short_id: "pl-team", title: "Team plan", user_id: MEMBER, team_id: TEAM, ...planDefaults },
      { _id: "p_personal", short_id: "pl-personal", title: "Personal plan", user_id: OWNER, ...planDefaults },
    ],
    managed_sessions: [],
  });

  test("team view excludes the viewer's personal plans", async () => {
    const result = await (webPlanList as any)._handler(ctx(OWNER, tables()), {
      workspace: "team",
      team_id: TEAM,
    });
    expect(result.map((p: any) => p._id)).toEqual(["p_team"]);
  });

  test("personal view excludes team plans", async () => {
    const result = await (webPlanList as any)._handler(ctx(OWNER, tables()), {
      workspace: "personal",
    });
    expect(result.map((p: any) => p._id)).toEqual(["p_personal"]);
  });
});

const docDefaults = { doc_type: "note", source: "human", content: "", created_at: 1, updated_at: 1 };

function docTables(extra: Record<string, any[]> = {}) {
  return baseTables({
    docs: [
      { _id: "d_team", title: "Team doc", user_id: MEMBER, team_id: TEAM, ...docDefaults },
      { _id: "d_personal", title: "Personal doc", user_id: OWNER, ...docDefaults },
      // No raw team tag, but born from a team-visible conversation: effectively
      // a TEAM doc — the team view must include it WITH team_id normalized.
      { _id: "d_convteam", title: "Conv team doc", user_id: OWNER, conversation_id: "conv_shared", ...docDefaults },
      // Tagged to TEAM but linked to a PRIVATE conversation: effectively
      // personal — must not appear in the team view, and a teammate must not
      // reach it by id either.
      { _id: "d_private_conv", title: "Private conv doc", user_id: OWNER, team_id: TEAM, conversation_id: "conv_private", ...docDefaults },
    ],
    conversations: [
      { _id: "conv_shared", user_id: OWNER, team_id: TEAM, is_private: false },
      { _id: "conv_private", user_id: OWNER, team_id: TEAM, is_private: true },
    ],
    plans: [],
    ...extra,
  });
}

describe("docs: strict workspace boundaries on the effective team", () => {
  test("team view: only effective-team docs, with team_id normalized", async () => {
    const { docs } = await (webDocList as any)._handler(ctx(OWNER, docTables()), {
      workspace: "team",
      team_id: TEAM,
    });
    expect(docs.map((d: any) => d._id).sort()).toEqual(["d_convteam", "d_team"]);
    const convTeamDoc = docs.find((d: any) => d._id === "d_convteam");
    expect(convTeamDoc.team_id).toBe(TEAM);
  });

  test("personal view: teamless docs plus effectively-personal team-tagged docs", async () => {
    const { docs } = await (webDocList as any)._handler(ctx(OWNER, docTables()), {
      workspace: "personal",
    });
    expect(docs.map((d: any) => d._id).sort()).toEqual(["d_personal", "d_private_conv"]);
    // The private-conversation doc ships as personal (normalized team_id).
    const privateConvDoc = docs.find((d: any) => d._id === "d_private_conv");
    expect(privateConvDoc.team_id).toBeUndefined();
  });

  test("paginated team crawl yields exactly the effective-team docs across phases", async () => {
    // Walk the crawl like the client does: primary (by_team_id) phase, then the
    // conversation-derived phase. The union must be exactly the docs the team
    // view shows — no personal docs, no private-conversation docs — or the
    // client's absent-prune would eat rows the list view renders.
    const tables = docTables();
    const all: any[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const result: any = await (webDocListPaginated as any)._handler(ctx(OWNER, tables), {
        workspace: "team",
        team_id: TEAM,
        paginationOpts: { numItems: 100, cursor },
      });
      all.push(...result.page);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    expect(all.map((d: any) => d._id).sort()).toEqual(["d_convteam", "d_team"]);
    // The conversation-derived doc ships with its effective team normalized.
    expect(all.find((d: any) => d._id === "d_convteam").team_id).toBe(TEAM);
  });

  test("the legacy orphan-phase cursor no longer ships personal docs", async () => {
    const result = await (webDocListPaginated as any)._handler(ctx(OWNER, docTables()), {
      workspace: "team",
      team_id: TEAM,
      paginationOpts: {
        numItems: 100,
        cursor: JSON.stringify({ phase: "orphans", inner: null }),
      },
    });
    // Only the viewer's conversation-derived TEAM docs — never d_personal or
    // d_private_conv, which the old orphan phase used to leak into team view.
    expect(result.page.map((d: any) => d._id)).toEqual(["d_convteam"]);
    expect(result.isDone).toBe(true);
  });

  test("id access follows the effective team: teammate denied on a private-conversation doc", async () => {
    const denied = await (webDocGet as any)._handler(ctx(MEMBER, docTables()), { id: "d_private_conv" });
    expect(denied).toBeNull();

    const owned = await (webDocGet as any)._handler(ctx(OWNER, docTables()), { id: "d_private_conv" });
    expect(owned?._id).toBe("d_private_conv");

    // A genuinely team-visible doc stays reachable for teammates.
    const teamDoc = await (webDocGet as any)._handler(ctx(MEMBER, docTables()), { id: "d_convteam" });
    expect(teamDoc?._id).toBe("d_convteam");
  });
});

describe("mentionSearch: workspace-scoped and membership-enforced", () => {
  const mentionTables = () => baseTables({
    tasks: [
      { _id: "t_team", short_id: "ct-team", title: "Team task", user_id: MEMBER, team_id: TEAM, ...taskDefaults },
      { _id: "t_personal", short_id: "ct-personal", title: "Personal task", user_id: OWNER, ...taskDefaults },
    ],
    docs: [
      { _id: "d_team", title: "Team doc", user_id: MEMBER, team_id: TEAM, ...docDefaults },
      { _id: "d_personal", title: "Personal doc", user_id: OWNER, ...docDefaults },
    ],
    plans: [
      { _id: "p_team", short_id: "pl-team", title: "Team plan", user_id: MEMBER, team_id: TEAM, status: "active", source: "human", created_at: 1, updated_at: 1, task_ids: [] },
      { _id: "p_personal", short_id: "pl-personal", title: "Personal plan", user_id: OWNER, status: "active", source: "human", created_at: 1, updated_at: 1, task_ids: [] },
    ],
    conversations: [
      // Team-visible session vs a private one ROUTED to the team (routing is
      // not visibility): personal scope must return only the private one.
      { _id: "c_team", user_id: OWNER, team_id: TEAM, is_private: false, title: "Team session", updated_at: 2 },
      { _id: "c_private", user_id: OWNER, team_id: TEAM, is_private: true, title: "Private session", updated_at: 1 },
    ],
    directory_team_mappings: [],
  });

  test("a foreign team id is rejected, not searched", async () => {
    await expect((mentionSearch as any)._handler(ctx(STRANGER, mentionTables()), {
      query: "",
      teamId: TEAM,
      workspace: "team",
    })).rejects.toThrow("Forbidden");
  });

  test("personal scope returns only effectively-personal items despite an active team", async () => {
    const results = await (mentionSearch as any)._handler(ctx(OWNER, mentionTables()), {
      query: "",
      workspace: "personal",
    });
    const ids = results.map((r: any) => r.id).sort();
    // The user's active_team_id is TEAM (baseTables), but personal scope must
    // not fall back to it: no team task/doc/plan, no team-visible session.
    expect(ids).toEqual(["c_private", "d_personal", "p_personal", "t_personal"]);
  });

  test("team scope returns only that team's items", async () => {
    const results = await (mentionSearch as any)._handler(ctx(OWNER, mentionTables()), {
      query: "",
      teamId: TEAM,
      workspace: "team",
      types: ["task", "doc", "plan", "session"],
    });
    const ids = results.map((r: any) => r.id).sort();
    expect(ids).toEqual(["c_team", "d_team", "p_team", "t_team"]);
  });
});

describe("creates: workspace is stamped and membership-enforced", () => {
  test("task creation into a foreign team is rejected", async () => {
    const tables = baseTables({ tasks: [], plans: [], counters: [], task_history: [] });
    await expect((webTaskCreate as any)._handler(ctx(STRANGER, tables), {
      title: "Poison",
      workspace: "team",
      team_id: TEAM,
    })).rejects.toThrow("Forbidden");
    expect(tables.tasks).toHaveLength(0);
  });

  test("a task created onto a plan inherits the plan's team workspace", async () => {
    const tables = baseTables({
      tasks: [],
      counters: [],
      task_history: [],
      plans: [{ _id: "p_team", short_id: "pl-team", title: "Team plan", user_id: OWNER, team_id: TEAM, status: "active", task_ids: [], created_at: 1, updated_at: 1 }],
    });
    await (webTaskCreate as any)._handler(ctx(MEMBER, tables), {
      title: "Child of team plan",
      plan_id: "pl-team",
    });
    expect(tables.tasks).toHaveLength(1);
    expect(tables.tasks[0].team_id).toBe(TEAM);
  });

  test("doc creation stamps the requested workspace, membership enforced", async () => {
    const tables = baseTables({ docs: [] });
    await (webDocCreate as any)._handler(ctx(MEMBER, tables), {
      title: "Team doc",
      workspace: "team",
      team_id: TEAM,
    });
    expect(tables.docs).toHaveLength(1);
    expect(tables.docs[0].team_id).toBe(TEAM);

    await expect((webDocCreate as any)._handler(ctx(STRANGER, tables), {
      title: "Poison doc",
      workspace: "team",
      team_id: TEAM,
    })).rejects.toThrow("Forbidden");
    expect(tables.docs).toHaveLength(1);

    // No workspace named → personal, never the active team.
    await (webDocCreate as any)._handler(ctx(MEMBER, tables), { title: "Quiet doc" });
    const quiet = tables.docs.find((d: any) => d.title === "Quiet doc");
    expect(quiet.team_id).toBeUndefined();
  });
});
