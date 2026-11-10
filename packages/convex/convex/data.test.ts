import { describe, expect, test } from "bun:test";
import { createDataContext, pathIsWithin, scopeByProject } from "./data";

// Regression for the work-item privacy leak (ct-38419): resolveWorkspace used
// to fall back to the caller's active_team_id when no directory mapping
// matched, so `cast task create` from a private ("Only Me" = unmapped)
// directory attached the task to the user's team — and team_id alone grants
// every team member full read access to a task (canAccessTask has no privacy
// gate). Directory mappings are now the whole rule: mapped → that team,
// unmapped → personal.

function mockDb(opts: { mappings?: any[]; isMember?: boolean; deletedTeams?: string[] } = {}) {
  const inserted: Array<{ table: string; doc: any }> = [];
  const db = {
    query: (table: string) => ({
      withIndex: (_name: string, _fn: any) => ({
        collect: async () => (table === "directory_team_mappings" ? opts.mappings || [] : []),
        first: async () =>
          table === "team_memberships" && opts.isMember ? { _id: "m1" } : null,
        order: (_d: string) => ({ take: async () => [] }),
      }),
    }),
    insert: async (table: string, doc: any) => {
      inserted.push({ table, doc });
      return "id_1" as any;
    },
    // Team rows exist unless the test deleted them; everything else is unknown.
    get: async (id: any) =>
      typeof id === "string" && id.startsWith("t") && !opts.deletedTeams?.includes(id) ? { _id: id } : null,
    patch: async () => {},
  };
  return { ctx: { db } as any, inserted };
}

const UNION = "t_union";
const mapping = { team_id: UNION, path_prefix: "/Users/j/code/union-mobile", auto_share: true };

describe("createDataContext — work items follow directory→team privacy", () => {
  test("THE BUG (ct-38419): an unmapped ('Only Me') directory resolves personal, never the active team", async () => {
    const { ctx, inserted } = mockDb({ mappings: [mapping] });
    const dc = await createDataContext(ctx, {
      userId: "u1" as any,
      project_path: "/Users/j/code/re-underwriting",
    });
    expect(dc.workspace.type).toBe("personal");
    await dc.insert("tasks", { title: "private work" });
    expect(inserted[0].doc.team_id).toBeUndefined();
  });

  test("a mapped directory resolves to its team and stamps it on inserts", async () => {
    const { ctx, inserted } = mockDb({ mappings: [mapping], isMember: true });
    const dc = await createDataContext(ctx, {
      userId: "u1" as any,
      project_path: "/Users/j/code/union-mobile/outreach",
    });
    expect(dc.workspace).toEqual({ type: "team", teamId: UNION as any });
    await dc.insert("tasks", { title: "team work" });
    expect(inserted[0].doc.team_id).toBe(UNION as any);
  });

  // Regression (2026-08-30): the codecast checkout was mapped to a team deleted in
  // April. The mapping survived, isTeamMember failed, and every task/plan/doc
  // command from the repo was Forbidden with no way to self-heal. A mapping to a
  // team that no longer exists is dangling data, not an access decision.
  test("a mapping to a DELETED team resolves personal instead of bricking the directory", async () => {
    const { ctx, inserted } = mockDb({ mappings: [mapping], isMember: false, deletedTeams: [UNION] });
    const dc = await createDataContext(ctx, {
      userId: "u1" as any,
      project_path: "/Users/j/code/union-mobile/outreach",
    });
    expect(dc.workspace).toEqual({ type: "personal", userId: "u1" as any });
    await dc.insert("tasks", { title: "still works" });
    expect(inserted[0].doc.team_id).toBeUndefined();
  });

  // The explicit-team branch has the same trap: tasks/plans/docs create hand
  // the session's stamped team in as `workspace: "team"`, and a conversation
  // stamped before its team was deleted used to fail "team membership
  // required" on every write from that session.
  test("an explicit DELETED team falls through to the directory rule", async () => {
    const { ctx, inserted } = mockDb({ mappings: [], isMember: false, deletedTeams: [UNION] });
    const dc = await createDataContext(ctx, {
      userId: "u1" as any,
      workspace: "team",
      team_id: UNION as any,
      project_path: "/Users/j/code/re-underwriting",
    });
    expect(dc.workspace).toEqual({ type: "personal", userId: "u1" as any });
    await dc.insert("tasks", { title: "still works" });
    expect(inserted[0].doc.team_id).toBeUndefined();
  });

  test("an explicit LIVE team without membership still fails closed", async () => {
    const { ctx } = mockDb({ mappings: [], isMember: false });
    await expect(createDataContext(ctx, {
      userId: "u1" as any,
      workspace: "team",
      team_id: UNION as any,
    })).rejects.toThrow(/team membership required/);
  });

  test("a mapping to a LIVE team the user left still fails closed", async () => {
    const { ctx } = mockDb({ mappings: [mapping], isMember: false });
    await expect(createDataContext(ctx, {
      userId: "u1" as any,
      project_path: "/Users/j/code/union-mobile/outreach",
    })).rejects.toThrow("Forbidden");
  });

  test("no project_path and no explicit workspace defaults to personal, never raw", async () => {
    const { ctx, inserted } = mockDb();
    const dc = await createDataContext(ctx, { userId: "u1" as any });
    expect(dc.workspace).toEqual({ type: "personal", userId: "u1" as any });
    expect("raw" in dc).toBe(false);
    expect("unscoped" in dc).toBe(false);
    await dc.insert("tasks", { title: "orphan" });
    expect(inserted[0].doc.team_id).toBeUndefined();
  });

  test("an explicit team workspace is honored for a member", async () => {
    const { ctx } = mockDb({ isMember: true });
    const dc = await createDataContext(ctx, {
      userId: "u1" as any,
      workspace: "team",
      team_id: UNION as any,
    });
    expect(dc.workspace).toEqual({ type: "team", teamId: UNION as any });
  });

  test("an explicit team workspace from a NON-member is forbidden, never downgraded", async () => {
    const { ctx } = mockDb({ mappings: [mapping], isMember: false });
    await expect(createDataContext(ctx, {
        userId: "u1" as any,
        workspace: "team",
        team_id: "t_foreign" as any,
        project_path: "/Users/j/code/re-underwriting",
      }))
      .rejects.toThrow("Forbidden");
  });

  test("a team workspace without a team id is rejected", async () => {
    const { ctx } = mockDb();
    await expect(createDataContext(ctx, {
      userId: "u1" as any,
      workspace: "team",
    })).rejects.toThrow("team_id");
  });

  test("pagination applies the same personal and project filters as collect", async () => {
    const rows = [
      { _id: "mine", user_id: "u1", project_path: "/repo/app" },
      { _id: "team", user_id: "u1", team_id: "t1", project_path: "/repo/app" },
      { _id: "other-project", user_id: "u1", project_path: "/elsewhere" },
    ];
    const builder: any = {
      withIndex: () => builder,
      filter: () => builder,
      order: () => builder,
      paginate: async () => ({ page: rows, isDone: true, continueCursor: "" }),
      collect: async () => rows,
    };
    const dc = await createDataContext({ db: { query: () => builder } } as any, {
      userId: "u1" as any,
      workspace: "personal",
      project_path: "/repo",
    });

    const result = await dc.query("tasks").paginate({ numItems: 10, cursor: null });
    expect(result.page.map((row: any) => row._id)).toEqual(["mine"]);
  });
});

describe("project scoping stops at a path boundary", () => {
  test("a sibling directory sharing the prefix is another project", () => {
    expect(pathIsWithin("/repo/codecast-web", "/repo/codecast")).toBe(false);
    expect(pathIsWithin("/repo/codecast", "/repo/codecast")).toBe(true);
    expect(pathIsWithin("/repo/codecast/packages/web", "/repo/codecast")).toBe(true);
    // A worktree lives under its repository, and a trailing slash names the same directory.
    expect(pathIsWithin("/repo/codecast/.codecast/worktrees/fix", "/repo/codecast/")).toBe(true);
    expect(pathIsWithin("/repo/codecast-web", "/repo/codecast/")).toBe(false);
    expect(pathIsWithin("/anything", "/")).toBe(true);
  });

  test("scopeByProject keeps the project, its subdirectories and unplaced rows only", () => {
    const rows = [
      { _id: "same", project_path: "/repo/codecast" },
      { _id: "child", project_path: "/repo/codecast/packages/cli" },
      { _id: "sibling", project_path: "/repo/codecast-web" },
      { _id: "by-root", project_path: "/elsewhere", git_root: "/repo/codecast" },
      { _id: "sibling-root", project_path: "/elsewhere", git_root: "/repo/codecast-web" },
      { _id: "unplaced" },
    ];
    expect(scopeByProject(rows, "/repo/codecast").map((r) => r._id)).toEqual(["same", "child", "by-root", "unplaced"]);
  });

  test("a scoped query applies the same boundary", async () => {
    const rows = [
      { _id: "mine", user_id: "u1", project_path: "/repo/app" },
      { _id: "sibling", user_id: "u1", project_path: "/repo/app-old" },
    ];
    const builder: any = {
      withIndex: () => builder,
      filter: () => builder,
      order: () => builder,
      paginate: async () => ({ page: rows, isDone: true, continueCursor: "" }),
      collect: async () => rows,
    };
    const dc = await createDataContext({ db: { query: () => builder } } as any, {
      userId: "u1" as any,
      workspace: "personal",
      project_path: "/repo/app",
    });
    const result = await dc.query("tasks").paginate({ numItems: 10, cursor: null });
    expect(result.page.map((row: any) => row._id)).toEqual(["mine"]);
  });
});
