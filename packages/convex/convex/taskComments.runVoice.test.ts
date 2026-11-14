// A comment a workflow run posts on its task reads as the run (ct-85594): the
// author and every notification name the flow, never the person whose account
// and machine run it; a run's note for its owner reaches the owner alone.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(30_000);
const TOKEN = "r".repeat(64);

async function setup() {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const jason = await ctx.db.insert("users", { name: "Jason Benn" } as any);
    const ashot = await ctx.db.insert("users", { name: "Ashot Petrosian" } as any);
    await ctx.db.insert("api_tokens", { user_id: jason, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    const taskId = await ctx.db.insert("tasks", {
      user_id: jason, workspace: `user:${jason}`, short_id: "ct-85594", title: "Cam's changes ship on his word",
      task_type: "task", status: "in_progress", priority: "high", blocks: [], source: "human",
      attempt_count: 0, retry_count: 0, max_retries: 3, created_at: now, updated_at: now,
    } as any);
    // Ashot follows the task: he commented on it by hand.
    await ctx.db.insert("entity_subscriptions", { user_id: ashot, entity_type: "task", entity_id: String(taskId), reason: "commenter", via: "human", muted: false, created_at: now } as any);
    const workflowId = await ctx.db.insert("workflows", { user_id: jason, name: "change", label: "Change", nodes: [], edges: [], created_at: now, updated_at: now } as any);
    const runId = await ctx.db.insert("workflow_runs", { user_id: jason, workflow_id: workflowId, workflow_name: "change", task_id: taskId, status: "running", node_statuses: [], created_at: now, updated_at: now } as any);
    const conv = (fields: Record<string, unknown>) => ctx.db.insert("conversations", {
      user_id: jason, agent_type: "claude_code", started_at: now, updated_at: now, message_count: 1, is_private: true, status: "active", ...fields,
    } as any);
    const runSession = await conv({ session_id: `wf-${runId}`, title: "change", workflow_run_id: runId, is_workflow_primary: true });
    await ctx.db.patch(runId, { primary_conversation_id: runSession } as any);
    const session = await conv({ session_id: "sess-jason", short_id: "jx756fb", title: "Cam request rules" });
    return { jason, ashot, taskId, runSession, session };
  });
  const comment = (args: Record<string, unknown>) => t.mutation(api.tasks.addComment, { api_token: TOKEN, short_id: "ct-85594", ...args } as any);
  const read = () => t.run(async (ctx) => ({
    comments: await ctx.db.query("task_comments").collect(),
    notifications: await ctx.db.query("notifications").collect(),
  }));
  return { ...ids, comment, read };
}

describe("a run's comment on its task", () => {
  test("a blocker from the run's own session is signed by the run, and its notification names the run, not Jason", async () => {
    const { comment, read, runSession, ashot, jason } = await setup();
    await comment({ text: "The run stopped: Check failed. The problem is open again.", comment_type: "blocker", conversation_id: String(runSession) });
    const { comments, notifications } = await read();
    expect(comments[0]).toMatchObject({ author: "Change run", comment_type: "blocker" });
    expect(comments[0].author_user_id).toBeUndefined();
    const toAshot = notifications.find((n: any) => String(n.recipient_user_id) === String(ashot));
    expect(toAshot).toMatchObject({ type: "task_commented", actor_name: "Change run" });
    expect(toAshot!.actor_user_id).toBeUndefined();
    expect(toAshot!.conversation_id).toBeUndefined();
    // Jason runs the machine, not the comment: he hears his run's blocker too.
    expect(notifications.some((n: any) => String(n.recipient_user_id) === String(jason))).toBe(true);
  });

  test("a note for the run's owner reaches Jason alone", async () => {
    const { comment, read, runSession, jason } = await setup();
    await comment({ text: "This machine could not run the project's check.", comment_type: "note", conversation_id: String(runSession), to_owner: true });
    const { notifications } = await read();
    expect(notifications.map((n: any) => String(n.recipient_user_id))).toEqual([String(jason)]);
    expect(notifications[0]).toMatchObject({ actor_name: "Change run" });
  });

  test("only a run's own session may ask for its owner alone", async () => {
    const { comment, session } = await setup();
    await expect(comment({ text: "x", conversation_id: String(session), to_owner: true })).rejects.toThrow(/run's own comments/);
  });

  test("a person commenting by hand is still the person", async () => {
    const { comment, read, ashot, jason } = await setup();
    await comment({ text: "Looks good", comment_type: "note" });
    const { comments, notifications } = await read();
    expect(comments[0]).toMatchObject({ author: "Jason Benn" });
    expect(String(comments[0].author_user_id)).toBe(String(jason));
    expect(notifications.find((n: any) => String(n.recipient_user_id) === String(ashot))).toMatchObject({ actor_user_id: jason });
  });
});
