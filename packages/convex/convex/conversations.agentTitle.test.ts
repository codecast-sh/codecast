// A local agent's own title (Claude Code's ai-title) stands in until a title
// pass names the session, and never overrides a generated or custom title.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

const TOKEN = "t".repeat(64);

async function setup(conversation: Record<string, unknown>) {
  const t = convexTest(schema, allModules);
  const id = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: 0, last_used_at: 0 } as any);
    return ctx.db.insert("conversations", { user_id: user, workspace: `user:${user}`, agent_type: "claude_code", session_id: "s1", started_at: 0, updated_at: 0, message_count: 3, status: "active", ...conversation } as any);
  });
  const guess = (title: string) => t.mutation(api.conversations.updateTitle, { conversation_id: id, title, api_token: TOKEN, agent_guess: true });
  const title = async () => (await t.run((ctx) => ctx.db.get(id)))?.title;
  return { guess, title };
}

describe("updateTitle agent_guess", () => {
  test("replaces the opening-prompt placeholder while no title pass has run", async () => {
    const s = await setup({ title: "can we not show untitled but pull better" });
    await s.guess("Session title fallback");
    expect(await s.title()).toBe("Session title fallback");
    await s.guess("Agent session titles");
    expect(await s.title()).toBe("Agent session titles");
  });

  test("fills an untitled session", async () => {
    const s = await setup({});
    await s.guess("Session title fallback");
    expect(await s.title()).toBe("Session title fallback");
  });

  test("leaves a generated title alone", async () => {
    const s = await setup({ title: "Use agent titles when LLM fails", subtitle: "- parser reads ai-title" });
    await s.guess("Session title fallback");
    expect(await s.title()).toBe("Use agent titles when LLM fails");
  });

  test("leaves a custom title alone", async () => {
    const s = await setup({ title: "Mine", title_is_custom: true });
    await s.guess("Session title fallback");
    expect(await s.title()).toBe("Mine");
  });
});
