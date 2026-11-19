// A message shared into chat by reference previews the agent's answer under a
// person's message, and names the person who typed it.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";

test("webGet with_reply returns the person's name and the first reply with text in the same turn", async () => {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ada" });
    const conversation_id = await ctx.db.insert("conversations", {
      user_id: owner, is_private: true, agent_type: "claude_code", session_id: "s", started_at: 0, updated_at: 0,
      message_count: 5, status: "active", title: "Prompt blocks rebuild",
    } as any);
    const msg = (role: string, timestamp: number, extra: any) =>
      ctx.db.insert("messages", { conversation_id, role, timestamp, ...extra } as any);
    const asked = await msg("user", 1, { content: "Can we measure it?" });
    await msg("assistant", 2, { tool_calls: [{ id: "t", name: "Read", input: "{}" }] });
    await msg("user", 3, { tool_results: [{ tool_use_id: "t", content: "ok" }] });
    await msg("assistant", 4, { content: "Yes: run an ablation." });
    const lastAsk = await msg("user", 5, { content: "Thanks" });
    return { owner, asked, lastAsk };
  });
  const as = t.withIdentity({ subject: ids.owner });

  const got: any = await as.query(api.messages.webGet, { id: ids.asked, with_reply: true });
  expect(got.author.name).toBe("Ada");
  expect(got.reply.content).toBe("Yes: run an ablation.");

  // Without the flag nothing extra is read; a message with no answer yet has none.
  expect(((await as.query(api.messages.webGet, { id: ids.asked })) as any).reply).toBeNull();
  expect(((await as.query(api.messages.webGet, { id: ids.lastAsk, with_reply: true })) as any).reply).toBeNull();
});
