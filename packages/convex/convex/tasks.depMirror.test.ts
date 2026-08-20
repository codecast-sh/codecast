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
    const { ctx, tables } = await makeCtx([bare("ct-b"), bare("ct-c")]);
    const { short_id } = await (create as any)._handler(ctx, {
      api_token: TOKEN,
      title: "New task",
      blocked_by: ["ct-b", "ct-c"],
    });
    expect(byShortId(tables, short_id).blocked_by).toEqual(["ct-b", "ct-c"]);
    expect(byShortId(tables, "ct-b").blocks).toEqual([short_id]);
    expect(byShortId(tables, "ct-c").blocks).toEqual([short_id]);
  });

  test("an unresolvable reference is skipped, not a failure", async () => {
    const { ctx, tables } = await makeCtx([bare("ct-b")]);
    const { short_id } = await (create as any)._handler(ctx, {
      api_token: TOKEN,
      title: "New task",
      blocked_by: ["ct-nope", "ct-b"],
    });
    expect(byShortId(tables, "ct-b").blocks).toEqual([short_id]);
  });
});

describe("update dependency mirror", () => {
  test("adding and removing a blocked_by entry patches both referenced tasks", async () => {
    const { ctx, tables } = await makeCtx([
      bare("ct-a", { blocked_by: ["ct-b"] }),
      bare("ct-b", { blocks: ["ct-a"] }),
      bare("ct-c"),
    ]);
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-a", blocked_by: ["ct-c"] });
    expect(byShortId(tables, "ct-a").blocked_by).toEqual(["ct-c"]);
    expect(byShortId(tables, "ct-b").blocks).toEqual([]);
    expect(byShortId(tables, "ct-c").blocks).toEqual(["ct-a"]);
  });

  test("overwriting blocks patches referenced tasks' blocked_by symmetrically", async () => {
    const { ctx, tables } = await makeCtx([
      bare("ct-a", { blocked_by: ["ct-b"] }),
      bare("ct-b", { blocks: ["ct-a"] }),
      bare("ct-d"),
    ]);
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-b", blocks: ["ct-d"] });
    expect(byShortId(tables, "ct-b").blocks).toEqual(["ct-d"]);
    expect(byShortId(tables, "ct-a").blocked_by).toEqual([]);
    expect(byShortId(tables, "ct-d").blocked_by).toEqual(["ct-b"]);
  });

  test("an unchanged entry is left alone", async () => {
    const { ctx, tables } = await makeCtx([
      bare("ct-a", { blocked_by: ["ct-b"] }),
      bare("ct-b", { blocks: ["ct-a"] }),
      bare("ct-c"),
    ]);
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-a", blocked_by: ["ct-b", "ct-c"] });
    expect(byShortId(tables, "ct-b").blocks).toEqual(["ct-a"]);
    expect(byShortId(tables, "ct-c").blocks).toEqual(["ct-a"]);
  });

  test("a reference the caller cannot access is skipped silently", async () => {
    const { ctx, tables } = await makeCtx([
      bare("ct-a"),
      bare("ct-x", { user_id: "u_other", blocks: [] }),
    ]);
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-a", blocked_by: ["ct-x"] });
    expect(byShortId(tables, "ct-a").blocked_by).toEqual(["ct-x"]);
    expect(byShortId(tables, "ct-x").blocks).toEqual([]);
  });
});
