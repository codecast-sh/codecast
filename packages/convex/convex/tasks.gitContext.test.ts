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

// THE WRONG-TEAM LAUNCH BUG (ct-52745): a Union task that pins no path was
// opened while the viewer had a codecast session on screen. The client sent the
// viewer's repo as the seed, the seed won, and three sessions ran in
// ~/src/codecast and were routed to the Codecast team. A seed from outside the
// task's team is only a last resort.
describe("resolveTaskGitContext: a seed from another team never beats the task's team", () => {
  const USER = "users_1";
  const UNION = "teams_union";
  const CODECAST = "teams_codecast";
  const mappings = [
    { team_id: CODECAST, path_prefix: "/Users/ashot/src/codecast", auto_share: true },
    { team_id: UNION, path_prefix: "/Users/ashot/src/union-mobile", auto_share: true },
  ];
  const ctx = (tables: Record<string, any[]> = {}) => ({ db: makeFakeDb({ conversations: [], projects: [], ...tables }) });
  const task = (over: any = {}) => ({ _id: "tasks_1", user_id: USER, team_id: UNION, conversation_ids: [], ...over });
  const viewer = { project_path: "/Users/ashot/src/codecast", git_root: "/Users/ashot/src/codecast" };

  test("a task that pins nothing launches in its team's mapped directory, not the viewer's repo", async () => {
    const r = await resolveTaskGitContext(ctx(), USER as any, task(), mappings, viewer);
    expect(r.project_path).toBe("/Users/ashot/src/union-mobile");
    // The viewer's root describes another repo, and the daemon prefers git_root.
    expect(r.git_root).toBeUndefined();
  });

  test("a seed inside the task's team is kept: it is the more specific choice", async () => {
    const seed = { project_path: "/Users/ashot/src/union-mobile/outreach", git_root: "/Users/ashot/src/union-mobile" };
    const r = await resolveTaskGitContext(ctx(), USER as any, task(), mappings, seed);
    expect(r.project_path).toBe("/Users/ashot/src/union-mobile/outreach");
    expect(r.git_root).toBe("/Users/ashot/src/union-mobile");
  });

  test("the task's project path beats both the seed and the team mapping", async () => {
    const projects = [{ _id: "projects_1", project_path: "/Users/ashot/src/outreach" }];
    const r = await resolveTaskGitContext(ctx({ projects }), USER as any, task({ project_id: "projects_1" }), mappings, viewer);
    expect(r.project_path).toBe("/Users/ashot/src/outreach");
  });

  test("with no mapping for the task's team the seed still routes the session", async () => {
    const r = await resolveTaskGitContext(ctx(), USER as any, task(), [mappings[0]], viewer);
    expect(r.project_path).toBe("/Users/ashot/src/codecast");
  });

  test("a personal task keeps the seed", async () => {
    const r = await resolveTaskGitContext(ctx(), USER as any, task({ team_id: undefined }), mappings, viewer);
    expect(r.project_path).toBe("/Users/ashot/src/codecast");
  });
});
