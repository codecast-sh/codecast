import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";

test("completion through the public mutation produces one actionable bell row across repeated runs", async () => {
  const t = convexTest(schema, allModules);
  const token = "notification-integration-token";
  const tokenHash = await hashToken(token);
  const { taskId, conversationId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Notification reader" });
    await ctx.db.insert("api_tokens", {
      user_id: userId, token_hash: tokenHash, name: "Test", created_at: 1, last_used_at: 1,
    });
    const conversationId = await ctx.db.insert("conversations", {
      user_id: userId, agent_type: "claude_code", session_id: "notification-test",
      started_at: 1, updated_at: 1, message_count: 0, is_private: true, status: "active",
    });
    const taskId = await ctx.db.insert("agent_tasks", {
      user_id: userId, title: "Verify deployment", prompt: "Verify it",
      schedule_type: "once", mode: "apply", status: "running",
      retry_count: 0, run_count: 1, created_at: 1,
    });
    return { taskId, conversationId };
  });
  const complete = (summary: string) => t.mutation(api.agentTasks.completeTaskRun, {
    api_token: token, task_id: taskId, conversation_id: conversationId,
    needs_attention: true, summary,
  });
  await complete("Renew the deployment credential.");
  await t.run(async (ctx) => {
    const rows = await ctx.db.query("notifications").collect();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "task_completed", conversation_id: conversationId, read: false,
      message: "Renew the deployment credential. — Verify deployment",
    });
    await ctx.db.patch(taskId, { status: "running", run_count: 2 });
  });
  await complete("The deployment credential is still expired.");
  await t.run(async (ctx) => {
    const rows = await ctx.db.query("notifications").collect();
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("The deployment credential is still expired. — Verify deployment");
  });
}, 60_000);
