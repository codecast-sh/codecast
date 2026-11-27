import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { spawnSessionCore } from "./spawn";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(60_000);

const TOKEN = "runs-in-parent-token";

async function world() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const me = await ctx.db.insert("users", { name: "Me", emailVerificationTime: 1 } as any);
    await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    const parent = await ctx.db.insert("conversations", {
      user_id: me, agent_type: "claude_code", session_id: "parent-session", project_path: "/tmp/p",
      started_at: now, updated_at: now, message_count: 0, status: "active", runs_in_parent: false,
    } as any);
    return { me, parent };
  });
  const create = async (args: Record<string, unknown>) => {
    const id = await t.mutation(api.conversations.createConversation, { user_id: ids.me, project_path: "/tmp/p", api_token: TOKEN, ...args } as any);
    return (await t.run((ctx) => ctx.db.get(id as any))) as any;
  };
  return { t, ids, create };
}

describe("createConversation writes runs_in_parent on every row", () => {
  test("an older daemon's claude subagent transcript is stamped from its agent id", async () => {
    const { ids, create } = await world();
    expect((await create({ agent_type: "claude_code", session_id: "agent-a1b2c3d4e5f6", parent_conversation_id: ids.parent })).runs_in_parent).toBe(true);
  });

  test("a top-level session and a parent-linked uuid session have their own process", async () => {
    const { ids, create } = await world();
    expect((await create({ agent_type: "claude_code", session_id: "0b6e2c1a-top" })).runs_in_parent).toBe(false);
    expect((await create({ agent_type: "claude_code", session_id: "0b6e2c1a-kid", parent_conversation_id: ids.parent, is_subagent: true })).runs_in_parent).toBe(false);
    // A fork carries its parent message: never a subagent, whatever its id.
    expect((await create({ agent_type: "claude_code", session_id: "agent-abcdef1234", parent_message_uuid: "m1" })).runs_in_parent).toBe(false);
  });

  test("the daemon's word wins over the session id", async () => {
    const { ids, create } = await world();
    expect((await create({ agent_type: "codex", session_id: "019a-codex-thread", parent_conversation_id: ids.parent, runs_in_parent: true })).runs_in_parent).toBe(true);
    expect((await create({ agent_type: "claude_code", session_id: "agent-0123456789", runs_in_parent: false })).runs_in_parent).toBe(false);
  });

  test("a resync fills a legacy row once and never overwrites the stored fact", async () => {
    const { t, create } = await world();
    const legacy = await create({ agent_type: "claude_code", session_id: "0b6e2c1a-legacy" });
    await t.run((ctx) => ctx.db.patch(legacy._id, { runs_in_parent: undefined }));
    expect((await create({ agent_type: "claude_code", session_id: "0b6e2c1a-legacy", runs_in_parent: true })).runs_in_parent).toBe(true);
    expect((await create({ agent_type: "claude_code", session_id: "0b6e2c1a-legacy", runs_in_parent: false })).runs_in_parent).toBe(true);
  });

  test("a cast spawn --subagent worker nests under its parent and runs its own process", async () => {
    const { t, ids } = await world();
    const row: any = await t.run(async (ctx) => {
      const { conversationId } = await spawnSessionCore(ctx, ids.me, {
        projectPath: "/tmp/p",
        subagentFields: { parent_conversation_id: ids.parent, is_subagent: true },
      });
      return ctx.db.get(conversationId);
    });
    expect(row.is_subagent).toBe(true);
    expect(row.runs_in_parent).toBe(false);
  });
});

describe("runsInParentBackfill", () => {
  async function legacyWorld() {
    const { t, ids } = await world();
    const rows = await t.run(async (ctx) => {
      const base = { user_id: ids.me, project_path: "/tmp/p", started_at: 1, updated_at: 1, message_count: 0, status: "active" };
      return {
        agent: await ctx.db.insert("conversations", { ...base, agent_type: "claude_code", session_id: "agent-a1b2c3d4e5", is_subagent: true, parent_conversation_id: ids.parent } as any),
        codex: await ctx.db.insert("conversations", { ...base, agent_type: "codex", session_id: "019a-thread", parent_conversation_id: ids.parent, cli_flags: "--print" } as any),
        spawned: await ctx.db.insert("conversations", { ...base, agent_type: "claude_code", session_id: "0b6e2c1a-spawned", is_subagent: true, parent_conversation_id: ids.parent } as any),
        adopted: await ctx.db.insert("conversations", { ...base, agent_type: "claude_code", session_id: "0b6e2c1a-adopted", parent_conversation_id: ids.parent, adopted_at: 5 } as any),
      };
    });
    const read = async () => Object.fromEntries(await Promise.all(Object.entries(rows).map(async ([k, id]) => [k, await t.run((ctx) => ctx.db.get(id))]))) as Record<string, any>;
    const run = (args: Record<string, unknown>) => t.mutation(internal.runsInParentBackfill.run, args as any);
    return { t, read, run };
  }

  test("a dry run counts and writes nothing", async () => {
    const { read, run } = await legacyWorld();
    expect(await run({})).toMatchObject({ dryRun: true, stampedTrue: 2, stampedFalse: 2, adoptedCleared: 1, done: true });
    const rows = await read();
    for (const r of Object.values(rows)) expect(r.runs_in_parent).toBeUndefined();
    expect(rows.adopted.adopted_at).toBe(5);
  });

  test("the real run stamps the legacy answer, clears adopted_at, and a second run writes nothing", async () => {
    const { read, run } = await legacyWorld();
    await run({ dryRun: false });
    const rows = await read();
    expect([rows.agent.runs_in_parent, rows.codex.runs_in_parent, rows.spawned.runs_in_parent, rows.adopted.runs_in_parent]).toEqual([true, true, false, false]);
    expect(rows.adopted.adopted_at).toBeUndefined();
    // The parent already held its fact.
    expect(await run({ dryRun: false })).toMatchObject({ stampedTrue: 0, stampedFalse: 0, adoptedCleared: 0 });
  });

  test("pages through the table", async () => {
    const { read, run } = await legacyWorld();
    const first = await run({ dryRun: false, numItems: 2 });
    expect(first.done).toBe(false);
    await run({ dryRun: false, cursor: first.cursor, numItems: 10 });
    for (const r of Object.values(await read())) expect(typeof r.runs_in_parent).toBe("boolean");
  });
});
