import { describe, expect, test } from "bun:test";
import { createDataContext } from "./data";

// Regression for the work-item privacy leak (ct-38419): resolveWorkspace used
// to fall back to the caller's active_team_id when no directory mapping
// matched, so `cast task create` from a private ("Only Me" = unmapped)
// directory attached the task to the user's team — and team_id alone grants
// every team member full read access to a task (canAccessTask has no privacy
// gate). Directory mappings are now the whole rule: mapped → that team,
// unmapped → personal.

function mockDb(opts: { mappings?: any[]; isMember?: boolean } = {}) {
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
    get: async () => null,
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
    const { ctx, inserted } = mockDb({ mappings: [mapping] });
    const dc = await createDataContext(ctx, {
      userId: "u1" as any,
      project_path: "/Users/j/code/union-mobile/outreach",
    });
    expect(dc.workspace).toEqual({ type: "team", teamId: UNION as any });
    await dc.insert("tasks", { title: "team work" });
    expect(inserted[0].doc.team_id).toBe(UNION as any);
  });

  test("no project_path and no explicit workspace → unscoped, inserts stay personal", async () => {
    const { ctx, inserted } = mockDb();
    const dc = await createDataContext(ctx, { userId: "u1" as any });
    expect(dc.workspace.type).toBe("unscoped");
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

  test("an explicit team workspace from a NON-member falls through to the mapping rule", async () => {
    const { ctx } = mockDb({ mappings: [mapping], isMember: false });
    const dc = await createDataContext(ctx, {
      userId: "u1" as any,
      workspace: "team",
      team_id: "t_foreign" as any,
      project_path: "/Users/j/code/re-underwriting",
    });
    expect(dc.workspace.type).toBe("personal");
  });
});
