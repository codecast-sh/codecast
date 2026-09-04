import { expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { webGetTaskDetail } from "./taskMining";

function context(taskOwner: string, task: Record<string, unknown> = {}, conversation: Record<string, unknown> = {}, member = false) {
  return {
    auth: { getUserIdentity: async () => ({ subject: "viewer|session" }) },
    db: makeFakeDb({
      users: [{ _id: "viewer" }, { _id: "other" }],
      tasks: [{ _id: "task1", short_id: "ct-1", user_id: taskOwner, workspace: `user:${taskOwner}`, conversation_ids: ["conv1"], ...task }],
      conversations: [{ _id: "conv1", session_id: "session1", user_id: "other", is_private: true, title: "Synthetic private title", project_path: "/synthetic/private", status: "completed", updated_at: 1, ...conversation }],
      team_memberships: member ? [{ _id: "member1", user_id: "viewer", team_id: "team1" }] : [],
      docs: [{ _id: "doc1", user_id: "other", workspace: "user:other", conversation_id: "conv1", title: "Synthetic private document" }],
      session_insights: [{ _id: "insight1", conversation_id: "conv1", summary: "Synthetic private insight" }],
      plans: [{ _id: "plan1", user_id: "other", workspace: "user:other", title: "Synthetic private plan" }],
    }),
  } as any;
}

test("task detail denies an unrelated viewer of an owner-only task", async () => {
  expect(await (webGetTaskDetail as any)._handler(context("other"), { id: "ct-1" })).toBeNull();
});

test("a readable task does not expose an inaccessible linked session", async () => {
  const result = await (webGetTaskDetail as any)._handler(context("viewer"), { id: "ct-1" });
  expect(result.linked_conversations).toEqual([]);
});

test("an explicit task assignee can read an owner-only task", async () => {
  const result = await (webGetTaskDetail as any)._handler(context("other", { assignee: "viewer" }), { id: "ct-1" });
  expect(result._id).toBe("task1");
  expect(result.linked_conversations).toEqual([]);
});

test("team routing does not grant access to a private workspace task", async () => {
  expect(await (webGetTaskDetail as any)._handler(context("other", { team_id: "team1" }, {}, true), { id: "ct-1" })).toBeNull();
});

test("a team workspace task and shared conversation remain readable", async () => {
  const ctx = context("other", { team_id: "team1", workspace: "team:team1" }, { team_id: "team1", is_private: false }, true);
  const result = await (webGetTaskDetail as any)._handler(ctx, { id: "ct-1" });
  expect(result._id).toBe("task1");
  expect(result.linked_conversations[0]._id).toBe("conv1");
});

test("a team member who does not own a private linked conversation does not see its summary", async () => {
  // The task is in the team workspace, so the member reads it; the linked
  // conversation is private to another member and must not ride along.
  const ctx = context("other", { team_id: "team1", workspace: "team:team1" }, { team_id: "team1", is_private: true }, true);
  const result = await (webGetTaskDetail as any)._handler(ctx, { id: "ct-1" });
  expect(result._id).toBe("task1");
  expect(result.linked_conversations).toEqual([]);
});

test("active-task association cannot expose a private session", async () => {
  const result = await (webGetTaskDetail as any)._handler(context("other", { assignee: "viewer", conversation_ids: [] }, { active_task_id: "task1" }), { id: "ct-1" });
  expect(result.linked_conversations).toEqual([]);
});

test("task provenance cannot expose private documents, insights, or plans", async () => {
  const ctx = context("viewer", { created_from_conversation: "conv1", created_from_insight: "insight1", plan_id: "plan1" });
  const result = await (webGetTaskDetail as any)._handler(ctx, { id: "ct-1" });
  expect(result.related_docs).toEqual([]);
  expect(result.source_insight).toBeNull();
  expect(result.plan).toBeNull();
});

test("the owner retains readable linked-session summaries and insights", async () => {
  const ctx = context("viewer", { created_from_insight: "insight1" }, { user_id: "viewer" });
  const result = await (webGetTaskDetail as any)._handler(ctx, { id: "ct-1" });
  expect(result.linked_conversations[0].title).toBe("Synthetic private title");
  expect(result.source_insight._id).toBe("insight1");
});
