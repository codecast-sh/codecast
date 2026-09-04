import { expect, test } from "bun:test";
import { webGetTaskDetail } from "./taskMining";
import { webGet } from "./plans";
import { makeFakeDb } from "./testDb";

const remote = "git@github.com:codecast-sh/codecast.git";
function context(owner = "viewer", activeTask = false) {
  return {
    auth: { getUserIdentity: async () => ({ subject: "viewer|session" }) },
    db: makeFakeDb({
      users: [{ _id: "viewer" }],
      tasks: [{ _id: "task1", short_id: "ct-1", user_id: "viewer", workspace: "user:viewer", conversation_ids: activeTask ? [] : ["conv1"] }],
      plans: [{ _id: "plan1", short_id: "pl-1", user_id: "viewer", workspace: "user:viewer", session_ids: ["conv1"] }],
      conversations: [{ _id: "conv1", session_id: "session1", user_id: owner, is_private: true, git_remote_url: remote, status: "completed", updated_at: 1, ...(activeTask ? { active_task_id: "task1" } : {}) }],
    }),
  } as any;
}

test("task repository navigation survives a cold inbox and a completed session", async () => {
  const result = await (webGetTaskDetail as any)._handler(context(), { id: "ct-1" });
  expect(result.linked_conversations[0].git_remote_url).toBe(remote);
});

test("active-task association carries the same repository origin", async () => {
  const result = await (webGetTaskDetail as any)._handler(context("viewer", true), { id: "ct-1" });
  expect(result.linked_conversations[0].git_remote_url).toBe(remote);
});

test("a task link does not disclose another user's private repository origin", async () => {
  const result = await (webGetTaskDetail as any)._handler(context("other"), { id: "ct-1" });
  expect(result.linked_conversations[0]?.git_remote_url).toBeUndefined();
});

test("plan session summaries carry the origin without opening the session", async () => {
  const result = await (webGet as any)._handler(context(), { short_id: "pl-1" });
  expect(result.sessions[0].git_remote_url).toBe(remote);
});

test("plan repository navigation excludes inaccessible sessions", async () => {
  const result = await (webGet as any)._handler(context("other"), { short_id: "pl-1" });
  expect(result.sessions).toEqual([]);
});
