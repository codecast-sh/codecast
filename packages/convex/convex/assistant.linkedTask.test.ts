// A hosted session started for a task (a compose link, /inbox?task=ct-N, on
// the Codecast assistant) is linked to the task the way a machine session is,
// and only when the task's workspace lets the caller open it.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./assistant/entry.ts": () => import("./assistant/entry"),
  "./agentTasks.ts": () => import("./agentTasks"),
  "./managedSessions.ts": () => import("./managedSessions"),
  "./messages.ts": () => import("./messages"),
  "./sessionDecisions.ts": () => import("./sessionDecisions"),
  "./conversations.ts": () => import("./conversations"),
  "./dispatch.ts": () => import("./dispatch"),
  "./pendingMessages.ts": () => import("./pendingMessages"),
};

async function setup() {
  const t = convexTest(schema, modules);
  // A proven address: the Free plan serves only one (assistant/freeGate.ts).
  const user = await t.run((ctx) => ctx.db.insert("users", { emailVerificationTime: 1 }));
  return { t, user, authed: t.withIdentity({ subject: user }) };
}

describe("a hosted session started for a task", () => {
  test("is linked to the task, as a machine session is", async () => {
    const { t, user, authed } = await setup();
    const taskId = await t.run((ctx) => ctx.db.insert("tasks", {
      user_id: user, short_id: "ct-77", title: "Link me", status: "open", task_type: "task", priority: "medium",
      created_at: Date.now(), updated_at: Date.now(), workspace: `user:${user}`,
    } as any));
    const args = [{ agent_type: "codecast", session_id: "stub-task", first_message: "Let's do this task ct-77", first_message_client_id: "client-t", linked_object: { type: "task", id: taskId } }];
    await authed.mutation(api.dispatch.dispatch, { action: "createSession", args });
    const { conv, task } = await t.run(async (ctx) => ({
      conv: await ctx.db.query("conversations").withIndex("by_session_id", (q) => q.eq("session_id", "stub-task")).first(),
      task: await ctx.db.get(taskId),
    }));
    expect((task as any).conversation_ids?.map(String)).toContain(String(conv!._id));
  });

  test("leaves a task private to its owner inside a team alone when a teammate names it", async () => {
    // Access is the task's workspace (user:<owner>), never its team: the
    // teammate's session starts and the task is not linked or taken.
    const { t, user: owner } = await setup();
    const { mate, taskId } = await t.run(async (ctx) => {
      const mate = await ctx.db.insert("users", { emailVerificationTime: 1 });
      const team = await ctx.db.insert("teams", { name: "T", created_at: Date.now() } as any);
      for (const u of [owner, mate]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: Date.now() } as any);
      const taskId = await ctx.db.insert("tasks", {
        user_id: owner, team_id: team, short_id: "ct-78", title: "Mine", status: "open", task_type: "task", priority: "medium",
        created_at: Date.now(), updated_at: Date.now(), workspace: `user:${owner}`,
      } as any);
      return { mate, taskId };
    });
    const args = [{ agent_type: "codecast", session_id: "stub-mate", linked_object: { type: "task", id: taskId } }];
    await t.withIdentity({ subject: mate }).mutation(api.dispatch.dispatch, { action: "createSession", args });
    const { conv, task } = await t.run(async (ctx) => ({
      conv: await ctx.db.query("conversations").withIndex("by_session_id", (q) => q.eq("session_id", "stub-mate")).first(),
      task: await ctx.db.get(taskId),
    }));
    expect(conv).not.toBeNull();
    expect((task as any).conversation_ids ?? []).toEqual([]);
  });
});
