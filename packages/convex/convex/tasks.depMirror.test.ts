// blocked_by/blocks are a stored mirror: every accepted edge write must land
// on both sides. addDep/removeDep always did; these tests pin the paths that
// used to bypass the mirror — create (raw blocked_by, referenced tasks
// untouched) and update (raw overwrite of either array).
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { create, update } from "./tasks";
import { hashToken } from "./apiTokens";

const USER = "u_user";
const TOKEN = "dep-mirror-test-token";

async function makeCtx(tasks: any[]) {
  const tables: Record<string, any[]> = {
    users: [{ _id: USER, name: "User" }],
    api_tokens: [{ _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
    tasks,
  };
  return {
    ctx: {
      auth: { async getUserIdentity() { return null; } },
      db: makeFakeDb(tables),
      scheduler: { runAfter: async () => null },
      runMutation: async () => null,
    } as any,
    tables,
  };
}

const bare = (shortId: string, over: any = {}) => ({
  _id: `task_${shortId}`,
  short_id: shortId,
  user_id: USER,
  status: "open",
  ...over,
});

const byShortId = (tables: Record<string, any[]>, shortId: string) =>
  tables.tasks.find((t) => t.short_id === shortId);

describe("create dependency mirror", () => {
  test("blocked_by populates each referenced task's blocks", async () => {
    const { ctx, tables } = await makeCtx([bare("ct-12"), bare("ct-13")]);
    const { short_id } = await (create as any)._handler(ctx, {
      api_token: TOKEN,
      title: "New task",
      blocked_by: ["ct-12", "ct-13"],
    });
    expect(byShortId(tables, short_id).blocked_by).toEqual(["ct-12", "ct-13"]);
    expect(byShortId(tables, "ct-12").blocks).toEqual([short_id]);
    expect(byShortId(tables, "ct-13").blocks).toEqual([short_id]);
  });

  test("an unresolvable reference is skipped, not a failure", async () => {
    const { ctx, tables } = await makeCtx([bare("ct-12")]);
    const { short_id } = await (create as any)._handler(ctx, {
      api_token: TOKEN,
      title: "New task",
      blocked_by: ["ct-99", "ct-12"],
    });
    expect(byShortId(tables, "ct-12").blocks).toEqual([short_id]);
  });
});

describe("update dependency mirror", () => {
  test("adding and removing a blocked_by entry patches both referenced tasks", async () => {
    const { ctx, tables } = await makeCtx([
      bare("ct-11", { blocked_by: ["ct-12"] }),
      bare("ct-12", { blocks: ["ct-11"] }),
      bare("ct-13"),
    ]);
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-11", blocked_by: ["ct-13"] });
    expect(byShortId(tables, "ct-11").blocked_by).toEqual(["ct-13"]);
    expect(byShortId(tables, "ct-12").blocks).toEqual([]);
    expect(byShortId(tables, "ct-13").blocks).toEqual(["ct-11"]);
  });

  test("overwriting blocks patches referenced tasks' blocked_by symmetrically", async () => {
    const { ctx, tables } = await makeCtx([
      bare("ct-11", { blocked_by: ["ct-12"] }),
      bare("ct-12", { blocks: ["ct-11"] }),
      bare("ct-14"),
    ]);
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-12", blocks: ["ct-14"] });
    expect(byShortId(tables, "ct-12").blocks).toEqual(["ct-14"]);
    expect(byShortId(tables, "ct-11").blocked_by).toEqual([]);
    expect(byShortId(tables, "ct-14").blocked_by).toEqual(["ct-12"]);
  });

  test("an unchanged entry is left alone", async () => {
    const { ctx, tables } = await makeCtx([
      bare("ct-11", { blocked_by: ["ct-12"] }),
      bare("ct-12", { blocks: ["ct-11"] }),
      bare("ct-13"),
    ]);
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-11", blocked_by: ["ct-12", "ct-13"] });
    expect(byShortId(tables, "ct-12").blocks).toEqual(["ct-11"]);
    expect(byShortId(tables, "ct-13").blocks).toEqual(["ct-11"]);
  });

  // An older plan row names its blocker by `_id`; a write naming it by short
  // id is the same edge, so the blocker's mirror stays.
  test("swapping a blocker's _id for its short id keeps the mirror", async () => {
    const { ctx, tables } = await makeCtx([
      bare("ct-11", { blocked_by: ["task_ct-12"] }),
      bare("ct-12", { blocks: ["ct-11"] }),
    ]);
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-11", blocked_by: ["ct-12"] });
    expect(byShortId(tables, "ct-11").blocked_by).toEqual(["ct-12"]);
    expect(byShortId(tables, "ct-12").blocks).toEqual(["ct-11"]);
  });

  // Readiness never reads across workspaces, so the edge could never clear.
  test("a reference into another workspace is refused and nothing is written", async () => {
    const { ctx, tables } = await makeCtx([
      bare("ct-11"),
      bare("ct-24", { user_id: "u_other", blocks: [] }),
    ]);
    await expect((update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-11", blocked_by: ["ct-24"] }))
      .rejects.toThrow("dependency task belongs to another workspace");
    expect(byShortId(tables, "ct-11").blocked_by).toBeUndefined();
    expect(byShortId(tables, "ct-24").blocks).toEqual([]);
  });
});
