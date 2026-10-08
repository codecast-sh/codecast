// The read behind the task block a session gets back after compaction
// (docs/architecture/task-graph.md TG10): what it ships to whom, which
// blockers count, and which plan step it names next.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { context } from "./taskResume";
import { hashToken } from "./apiTokens";

const USER = "u_user";
const TOKEN = "task-resume-test-token";
const mine = { user_id: USER, workspace: `user:${USER}` };
const theirs = { user_id: "other", workspace: "user:other" };

const task = (shortId: string, over: any = {}) => ({
  _id: `task_${shortId}`,
  short_id: shortId,
  title: `Title ${shortId}`,
  status: "open",
  priority: "medium",
  source: "human",
  created_at: 1,
  updated_at: 1,
  ...mine,
  ...over,
});

async function read(tables: Record<string, any[]>, args: Record<string, unknown>) {
  const ctx = {
    auth: { async getUserIdentity() { return { subject: `${USER}|session` }; } },
    db: makeFakeDb({
      users: [{ _id: USER, name: "User" }, { _id: "other", name: "Other" }],
      api_tokens: [{ _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
      conversations: [],
      plans: [],
      task_comments: [],
      team_memberships: [],
      ...tables,
    }),
  } as any;
  return await (context as any)._handler(ctx, { api_token: TOKEN, ...args });
}

describe("taskResume.context", () => {
  test("a task the caller cannot read returns nothing", async () => {
    expect(await read({ tasks: [task("ct-1", theirs)] }, { short_id: "ct-1" })).toBeNull();
  });

  test("an assignee of an owner-only task sees its blocker's state but not its title", async () => {
    const out = await read({
      tasks: [task("ct-1", { ...theirs, assignee: USER, blocked_by: ["ct-2"] }), task("ct-2", { ...theirs, title: "Private blocker" })],
    }, { short_id: "ct-1" });
    expect(out.task.short_id).toBe("ct-1");
    expect(out.blockers).toEqual([{ kind: "task", ref: "ct-2", status: "open" }]);
  });

  test("only open blockers ship: a finished one and a ref that names nothing do not", async () => {
    const out = await read({
      tasks: [task("ct-1", { blocked_by: ["ct-2", "ct-3", "ct-404"] }), task("ct-2", { status: "done" }), task("ct-3", { status: "in_progress" })],
    }, { short_id: "ct-1" });
    expect(out.blockers).toEqual([{ kind: "task", ref: "ct-3", status: "in_progress", title: "Title ct-3" }]);
  });

  test("the last progress note, and the comments of other kinds posted after it", async () => {
    const tables = {
      tasks: [task("ct-1")],
      task_comments: [
        { _id: "c1", task_id: "task_ct-1", comment_type: "progress", text: "older", author: "agent", created_at: 1 },
        { _id: "c2", task_id: "task_ct-1", comment_type: "note", text: "before", author: "agent", created_at: 2 },
        { _id: "c3", task_id: "task_ct-1", comment_type: "progress", text: "newest", author: "agent", created_at: 3 },
        { _id: "c4", task_id: "task_ct-1", comment_type: "note", text: "a note", author: "agent", created_at: 4 },
        { _id: "c5", task_id: "task_ct-1", comment_type: "review", text: "changes requested", author: "Ada", created_at: 5 },
      ],
    };
    const out = await read(tables, { short_id: "ct-1" });
    expect(out.progress).toEqual({ text: "newest", author: "agent", created_at: 3 });
    expect(out.newer).toEqual({ count: 2, latest: { type: "review", author: "Ada" } });
    expect("held" in out).toBe(false);
    expect((await read({ tasks: [task("ct-1")] }, { short_id: "ct-1" })).newer).toBeNull();
  });

  describe("which task, and whether the session holds it", () => {
    const conv = (over: any = {}) => ({ _id: "conv1", session_id: "sess-1", user_id: USER, ...over });

    test("a session the server spawned for a task has no pulse: its binding names the task", async () => {
      const out = await read({ tasks: [task("ct-1")], conversations: [conv({ active_task_id: "task_ct-1" })] }, { session_id: "sess-1" });
      expect(out.task.short_id).toBe("ct-1");
      expect(out.held).toBe(true);
      expect(await read({ tasks: [task("ct-1")], conversations: [conv()] }, { session_id: "sess-1" })).toBeNull();
    });

    test("a pulse naming a task the session filed restores the one it holds and mentions the other", async () => {
      const out = await read({
        tasks: [task("ct-1"), task("ct-2", { title: "Follow-up" })],
        conversations: [conv({ active_task_id: "task_ct-1" })],
      }, { short_id: "ct-2", session_id: "sess-1" });
      expect(out.task.short_id).toBe("ct-1");
      expect(out.held).toBe(true);
      expect(out.recent).toEqual({ short_id: "ct-2", title: "Follow-up", status: "open" });
    });

    test("a task the session does not hold: closed, claimed by another session, or only filed here", async () => {
      const closed = await read({ tasks: [task("ct-1", { status: "done" })], conversations: [conv()] }, { short_id: "ct-1", session_id: "sess-1" });
      expect(closed).toMatchObject({ held: false, lost: "closed" });

      const claimed = await read({
        tasks: [task("ct-1", { conversation_ids: ["conv1", "conv2"] })],
        conversations: [conv(), { _id: "conv2", session_id: "sess-2", user_id: USER, active_task_id: "task_ct-1" }],
      }, { short_id: "ct-1", session_id: "sess-1" });
      expect(claimed).toMatchObject({ held: false, lost: "claimed" });

      const filed = await read({ tasks: [task("ct-1")], conversations: [conv()] }, { short_id: "ct-1", session_id: "sess-1" });
      expect(filed.held).toBe(false);
      expect("lost" in filed).toBe(false);
    });
  });

  test("the open subtasks the caller may read, a few of them", async () => {
    const subs = Array.from({ length: 8 }, (_, i) => task(`ct-${10 + i}`, { parent_id: "task_ct-1" }));
    subs[0].status = "done";
    Object.assign(subs[1], theirs);
    const out = await read({ tasks: [task("ct-1"), ...subs] }, { short_id: "ct-1" });
    expect(out.subtasks.items.map((s: any) => s.short_id)).toEqual(["ct-12", "ct-13", "ct-14", "ct-15", "ct-16"]);
    expect(out.subtasks.more).toBe(1);
    expect(out.subtasks.items[0]).toEqual({ short_id: "ct-12", title: "Title ct-12", status: "open" });
  });

  describe("the plan", () => {
    const plan = { _id: "plan1", short_id: "pl-1", title: "Plan", status: "active", ...mine, task_ids: ["task_ct-1", "task_ct-4", "task_ct-5", "task_ct-6", "task_ct-7", "task_ct-9"] };
    const tasks = [
      task("ct-1", { plan_id: "plan1", priority: "urgent" }),
      task("ct-4", { plan_id: "plan1", priority: "low" }),
      task("ct-5", { plan_id: "plan1", priority: "high" }),
      task("ct-6", { plan_id: "plan1", status: "dropped" }),
      task("ct-7", { plan_id: "plan1", status: "done" }),
      // A subtask carries plan_id but is not one of the plan's steps.
      task("ct-8", { plan_id: "plan1", parent_id: "task_ct-4", priority: "urgent" }),
      // Another session's checklist item: ready only for the session that filed it.
      task("ct-9", { plan_id: "plan1", priority: "urgent", ephemeral: true, created_from_conversation: "conv1" }),
    ];
    const conversations = [{ _id: "conv1", session_id: "sess-1", user_id: USER }];

    test("counts the steps without dropped ones, and names the next ready step other than the task", async () => {
      const out = await read({ tasks, plans: [plan], conversations }, { short_id: "ct-1" });
      expect(out.plan).toMatchObject({ short_id: "pl-1", done: 1, total: 5, next: { short_id: "ct-5" } });
    });

    test("the session's own ephemeral step is its next one, as `cast task ready` hands it out", async () => {
      const out = await read({ tasks, plans: [plan], conversations }, { short_id: "ct-1", session_id: "sess-1" });
      expect(out.plan.next.short_id).toBe("ct-9");
    });

    test("a task with no plan falls back to the plan the session is bound to", async () => {
      const out = await read({ tasks: [task("ct-2"), ...tasks], plans: [plan], conversations }, { short_id: "ct-2", plan_id: "pl-1" });
      expect(out.plan.short_id).toBe("pl-1");
      const bound = [{ ...conversations[0], active_plan_id: "plan1" }];
      expect((await read({ tasks: [task("ct-2"), ...tasks], plans: [plan], conversations: bound }, { short_id: "ct-2", session_id: "sess-1" })).plan.short_id).toBe("pl-1");
      expect((await read({ tasks: [task("ct-2")], plans: [plan] }, { short_id: "ct-2" })).plan).toBeNull();
    });

    test("a plan the caller cannot read, and steps they cannot read, stay out", async () => {
      expect((await read({ tasks: [task("ct-2")], plans: [{ ...plan, ...theirs }] }, { short_id: "ct-2", plan_id: "pl-1" })).plan).toBeNull();
      const hidden = tasks.map((t) => (t.short_id === "ct-5" ? { ...t, ...theirs } : t));
      const out = await read({ tasks: hidden, plans: [plan], conversations }, { short_id: "ct-1" });
      expect(out.plan).toMatchObject({ total: 4, next: { short_id: "ct-4" } });
    });
  });
});
