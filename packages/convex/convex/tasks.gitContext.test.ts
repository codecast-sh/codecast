import { describe, expect, test } from "bun:test";
import { resolveTaskGitContext } from "./tasks";
import { makeFakeDb } from "./testDb";

// THE WRONG-REPO LAUNCH BUG: the task page's ContextChatInput sent the task's
// project_path together with a git_root taken from the viewer's currently-open
// conversation — an unrelated repo. The daemon prefers git_root when resolving
// a cwd, so the session launched in the viewer's repo (~/src/conv) instead of
// the task's (union-mobile). A git_root that isn't an ancestor of the resolved
// project_path must be dropped.
describe("resolveTaskGitContext git_root consistency", () => {
  const USER = "users_1";
  const TASK_PATH = "/Users/ec2-user/src/union-mobile/outreach";

  function ctx(conversations: any[] = []) {
    return { db: makeFakeDb({ conversations }) };
  }
  const task = (over: any = {}) => ({
    _id: "tasks_1",
    user_id: USER,
    project_path: TASK_PATH,
    conversation_ids: [],
    ...over,
  });

  test("drops a seed git_root from an unrelated repo when the seed carries the task's path", async () => {
    const r = await resolveTaskGitContext(ctx(), USER as any, task(), [], {
      project_path: TASK_PATH,
      git_root: "/Users/ashot/src/conv",
    });
    expect(r.project_path).toBe(TASK_PATH);
    expect(r.git_root).toBeUndefined();
  });

  test("drops an unrelated seed git_root when the path comes from the task itself", async () => {
    const r = await resolveTaskGitContext(ctx(), USER as any, task(), [], {
      git_root: "/Users/ashot/src/conv",
    });
    expect(r.project_path).toBe(TASK_PATH);
    expect(r.git_root).toBeUndefined();
  });

  test("keeps a git_root that is an ancestor of the project_path", async () => {
    const r = await resolveTaskGitContext(ctx(), USER as any, task(), [], {
      project_path: TASK_PATH,
      git_root: "/Users/ec2-user/src/union-mobile",
    });
    expect(r.git_root).toBe("/Users/ec2-user/src/union-mobile");
  });

  test("keeps a git_root equal to the project_path", async () => {
    const r = await resolveTaskGitContext(ctx(), USER as any, task(), [], {
      project_path: TASK_PATH,
      git_root: TASK_PATH,
    });
    expect(r.git_root).toBe(TASK_PATH);
  });

  test("ancestor check is per path segment, not per character", async () => {
    const r = await resolveTaskGitContext(
      ctx(),
      USER as any,
      task({ project_path: "/Users/ashot/src/conv-other" }),
      [],
      { project_path: "/Users/ashot/src/conv-other", git_root: "/Users/ashot/src/conv" },
    );
    expect(r.git_root).toBeUndefined();
  });

  test("no seed: task path resolves and doubles as git_root (unchanged behavior)", async () => {
    const r = await resolveTaskGitContext(ctx(), USER as any, task(), []);
    expect(r.project_path).toBe(TASK_PATH);
    expect(r.git_root).toBe(TASK_PATH);
  });

  test("recovers git_remote_url from a user-owned source conversation and refines git_root", async () => {
    const conv = {
      _id: "conversations_1",
      user_id: USER,
      git_remote_url: "git@github.com:ashot/union-mobile.git",
      git_root: "/Users/ec2-user/src/union-mobile",
      updated_at: 2,
      started_at: 1,
    };
    const r = await resolveTaskGitContext(
      ctx([conv]),
      USER as any,
      task({ conversation_ids: ["conversations_1"] }),
      [],
    );
    expect(r.git_remote_url).toBe("git@github.com:ashot/union-mobile.git");
    expect(r.git_root).toBe("/Users/ec2-user/src/union-mobile");
  });
});
