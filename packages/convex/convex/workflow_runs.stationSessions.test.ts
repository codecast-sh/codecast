// A line station's node carries its hand's short id (runner spawnHand), and
// the run report words a station by what its session reported or what
// happened to it. withAgentSessions must find that session by the short id,
// say whether it was killed, and carry its handoff from the task (ct-57659:
// Prove line was killed before it began, Build line handed off needs_context).
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { withAgentSessions } from "./workflow_runs";

const T0 = 1_790_000_000_000;
const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./workflow_runs.ts": () => import("./workflow_runs"),
};

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder" } as any);
    const workspace = `user:${owner}`;
    const conv = (extra: Record<string, any>) => ctx.db.insert("conversations", { user_id: owner, agent_type: "claude_code", status: "completed", started_at: T0, updated_at: T0, ...extra } as any);
    const prove = await conv({ session_id: "uuid-prove", short_id: "jx75tse", message_count: 0, inbox_killed_at: T0 + 5 });
    const build = await conv({ session_id: "uuid-build", short_id: "jx7ajkg", message_count: 76 });
    const task = await ctx.db.insert("tasks", { user_id: owner, workspace, short_id: "ct-1", title: "Prove dead end", status: "in_review", task_type: "task", priority: "medium", created_at: T0, updated_at: T0 } as any);
    await ctx.db.insert("task_comments", { task_id: task, author: "Founder", text: "Handoff: needs_context\n\nThe third finding needs the prove_line route, which is not on main.", comment_type: "review", conversation_id: build, created_at: T0 + 20 } as any);
    await ctx.db.insert("task_comments", { task_id: task, author: "Founder", text: "Review: changes", comment_type: "review", conversation_id: build, created_at: T0 + 10 } as any);
    return { owner, task, prove, build };
  });
  return { t, ids };
}

describe("a station's session on its run node", () => {
  test("is found by the hand's short id, with what happened to it and its handoff", async () => {
    const { t, ids } = await setup();
    const run = {
      user_id: ids.owner, task_id: ids.task, run_kind: undefined,
      node_statuses: [
        { node_id: "prove_line", status: "failed", session_id: "jx75tse" },
        { node_id: "implement_line", status: "failed", session_id: "jx7ajkg" },
      ],
    };
    const out = await t.run((ctx) => withAgentSessions(ctx, run));
    const [prove, build] = out.node_statuses;
    expect(prove.session._id).toBe(ids.prove);
    expect(prove.session.killed).toBe(true);
    expect(prove.session.message_count).toBe(0);
    expect(prove.session.handoff).toBeUndefined();
    expect(build.session._id).toBe(ids.build);
    expect(build.session.killed).toBeUndefined();
    expect(build.session.handoff).toEqual({ status: "needs_context", note: "The third finding needs the prove_line route, which is not on main.", at: T0 + 20 });
  });

  test("a session of another user is never attached", async () => {
    const { t, ids } = await setup();
    const other = await t.run((ctx) => ctx.db.insert("users", { name: "Other" } as any));
    const out = await t.run((ctx) => withAgentSessions(ctx, { user_id: other, task_id: ids.task, node_statuses: [{ node_id: "implement_line", status: "failed", session_id: "jx7ajkg" }] }));
    expect(out.node_statuses[0].session).toBeUndefined();
  });
});
