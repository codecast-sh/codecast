// A session's project as it reads it (session-projects.md SP6): instructions,
// memory (pinned docs) and main session, through the session's derived
// project, never past what the caller may read.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

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
    const project = await ctx.db.insert("projects", { user_id: user, workspace: `user:${user}`, short_id: "pj-t1", title: "Mine", status: "active", created_at: 0, updated_at: 0 } as any);
    const conv = (session_id: string, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("conversations", { user_id: user, agent_type: "claude_code", session_id, short_id: session_id.slice(0, 7), started_at: 0, updated_at: 0, message_count: 0, status: "active", is_private: true, ...extra } as any);
    const lead = await conv("leadsession", { project_id: project });
    const worker = await conv("workersess", { parent_conversation_id: lead, is_subagent: true });
    const loose = await conv("loosesess");
    await ctx.db.patch(project, { default_session_id: lead } as any);
    return { user, other, project, lead, worker, loose };
  });
  return { t, ids };
}

const remember = (t: any, project: any, title: string, content: string, api_token = TOKEN) =>
  t.mutation(api.docs.create, { api_token, title, content, project_id: String(project), pinned: true, workspace: "personal" });

describe("projectContext.forSession", () => {
  test("a worker reads its lead's project: instructions, memory and the main session", async () => {
    const { t, ids } = await setup();
    await t.mutation(api.projects.update, { api_token: TOKEN, id: ids.project, instructions: "  Use bun.  " });
    await remember(t, ids.project, "Fact A", "Alpha holds.");
    const b = await remember(t, ids.project, "Fact B", "Beta holds.");
    await t.mutation(api.docs.create, { api_token: TOKEN, title: "Not memory", content: "x", project_id: String(ids.project), workspace: "personal" });
    const ctx = await t.query(api.projectContext.forSession, { api_token: TOKEN, session: String(ids.worker) });
    expect(ctx.short_id).toBe("pj-t1");
    expect(ctx.instructions).toBe("Use bun.");
    expect(ctx.memory.map((m: any) => m.title).sort()).toEqual(["Fact A", "Fact B"]);
    expect(ctx.memory.find((m: any) => m.title === "Fact A").gist).toBe("Alpha holds.");
    expect(ctx.main_session.short_id).toBe("leadses");
    expect(ctx.is_main).toBe(false);
    expect((await t.query(api.projectContext.forSession, { api_token: TOKEN, session: String(ids.lead) })).is_main).toBe(true);

    await t.mutation(api.docs.update, { api_token: TOKEN, id: b.id, pinned: false });
    const after = await t.query(api.projectContext.forSession, { api_token: TOKEN, session: String(ids.worker) });
    expect(after.memory.map((m: any) => m.title)).toEqual(["Fact A"]);
  });

  test("a session in no project, another person's project, or another person's session reads nothing", async () => {
    const { t, ids } = await setup();
    expect(await t.query(api.projectContext.forSession, { api_token: TOKEN, session: String(ids.loose) })).toBeNull();
    expect(await t.query(api.projectContext.forSession, { api_token: OTHER, project_id: String(ids.project) })).toBeNull();
    expect(await t.query(api.projectContext.forSession, { api_token: OTHER, session: String(ids.worker) })).toBeNull();
  });

  test("instructions are capped and an empty string clears them", async () => {
    const { t, ids } = await setup();
    await expect(t.mutation(api.projects.update, { api_token: TOKEN, id: ids.project, instructions: "x".repeat(16_001) })).rejects.toThrow(/at most 16000/);
    await t.mutation(api.projects.update, { api_token: TOKEN, id: ids.project, instructions: "keep" });
    await t.mutation(api.projects.update, { api_token: TOKEN, id: ids.project, instructions: "" });
    const row: any = await t.run((ctx) => ctx.db.get(ids.project));
    expect(row.instructions).toBeUndefined();
  });
});
