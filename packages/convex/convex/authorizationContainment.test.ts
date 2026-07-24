import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getTeam } from "./teams";
import { getTeamMembers as getLegacyTeamMembers } from "./users";
import { listInstallations, deleteInstallation } from "./githubApp";
import { getDigestsByScope } from "./sessionInsights";
import { ensureDoc } from "./plans";
import { getCommentCount, addComment } from "./comments";
import {
  listPRsForTeam,
  getPRById,
  getPRsForConversation,
  getPRsForTimeline,
} from "./pull_requests";
import {
  webList as webTaskList,
  webMentionList as webTaskMentionList,
  webPromote as webTaskPromote,
  getReadyTasks,
  getDependencyChain,
  webCreate as webTaskCreate,
  webUpdate as webTaskUpdate,
  webGet as webTaskGet,
  update as updateTaskForCLI,
  addDep,
  addComment as addTaskComment,
  recalcPlanProgress,
} from "./tasks";
import { hashToken } from "./apiTokens";
import { searchForCLI, feedForCLI } from "./conversations";
import {
  webListPaginated as webDocListPaginated,
  webMentionList as webDocMentionList,
  webCreate as webDocCreate,
  webMoveDoc,
  webToggleDocLink,
  webGet as webDocGet,
  expandMentions,
} from "./docs";
import {
  webList as webPlanList,
  webMentionList as webPlanMentionList,
  webCreate as webPlanCreate,
  webUpdate as webPlanUpdate,
  webGet as webPlanGet,
  bindSession,
  associatePlan,
  unbindSession,
  get as getPlanForCLI,
  snippet as getPlanSnippet,
  getOrchestrationStatus,
  getShared as getSharedPlan,
} from "./plans";
import { createReview, getReviewsForPR, resolveComment } from "./reviews";

function auth(userId: string | null) {
  return {
    async getUserIdentity() {
      return userId ? { subject: `${userId}|session` } : null;
    },
  };
}

function ctx(userId: string | null, tables: Record<string, any[]>) {
  return {
    auth: auth(userId),
    db: makeFakeDb(tables),
    scheduler: { runAfter: async () => null },
    runMutation: async () => null,
  } as any;
}

const OWNER = "u_owner";
const MEMBER = "u_member";
const STRANGER = "u_stranger";
const TEAM = "t_team";

function baseTables(extra: Record<string, any[]> = {}): Record<string, any[]> {
  return {
    users: [
      { _id: OWNER, name: "Owner", team_id: TEAM },
      { _id: MEMBER, name: "Member", team_id: TEAM },
      { _id: STRANGER, name: "Stranger" },
    ],
    teams: [{ _id: TEAM, name: "Secret team", invite_code: "SECRET" }],
    team_memberships: [
      { _id: "m_owner", user_id: OWNER, team_id: TEAM, role: "admin" },
      { _id: "m_member", user_id: MEMBER, team_id: TEAM, role: "member" },
    ],
    ...extra,
  };
}

describe("Phase 0 team boundary", () => {
  test("the full team record is visible only to members", async () => {
    const foreign = await (getTeam as any)._handler(ctx(STRANGER, baseTables()), { team_id: TEAM });
    expect(foreign).toBeNull();

    const visible = await (getTeam as any)._handler(ctx(MEMBER, baseTables()), { team_id: TEAM });
    expect(visible?.name).toBe("Secret team");
  });

  test("the legacy member directory does not disclose a foreign team", async () => {
    const result = await (getLegacyTeamMembers as any)._handler(ctx(STRANGER, baseTables()), { team_id: TEAM });
    expect(result).toEqual([]);
  });

  test("GitHub installations cannot be listed or deleted by a non-member", async () => {
    const tables = baseTables({
      github_app_installations: [{
        _id: "install_1", team_id: TEAM, installation_id: 42, account_login: "private-org",
      }],
      github_installation_tokens: [],
    });
    await expect((listInstallations as any)._handler(ctx(STRANGER, tables), { team_id: TEAM }))
      .rejects.toThrow("Forbidden");
    await expect((deleteInstallation as any)._handler(ctx(STRANGER, tables), { installation_id: "install_1" }))
      .rejects.toThrow("Forbidden");
  });

  test("team digests reject a foreign team", async () => {
    const tables = baseTables({
      digests: [{ _id: "digest_1", team_id: TEAM, scope: "day", date: "2026-07-22", narrative: "secret", session_count: 1, generated_at: 1 }],
    });
    await expect((getDigestsByScope as any)._handler(ctx(STRANGER, tables), {
      scope: "day",
      team_id: TEAM,
    })).rejects.toThrow("Forbidden");
  });
});

describe("Phase 0 relationship boundary", () => {
  test("ensureDoc cannot mutate a foreign plan", async () => {
    const tables = baseTables({
      plans: [{ _id: "plan_1", short_id: "pl-1", title: "Secret", user_id: OWNER, team_id: TEAM }],
      docs: [],
    });
    await expect((ensureDoc as any)._handler(ctx(STRANGER, tables), { plan_id: "plan_1" }))
      .rejects.toThrow("Unauthorized");
    expect(tables.docs).toHaveLength(0);
  });

  test("ensureDoc does not return a poisoned foreign document relation", async () => {
    const tables = baseTables({
      plans: [{ _id: "plan_mine", short_id: "pl-mine", title: "Mine", user_id: STRANGER, doc_id: "doc_foreign" }],
      docs: [{ _id: "doc_foreign", user_id: OWNER, team_id: TEAM, title: "Secret" }],
    });
    await expect((ensureDoc as any)._handler(ctx(STRANGER, tables), { plan_id: "plan_mine" }))
      .rejects.toThrow("Doc not found");
  });

  test("comment counts require access to the message conversation", async () => {
    const tables = baseTables({
      conversations: [{ _id: "conv_1", user_id: OWNER, team_id: TEAM, is_private: true }],
      messages: [{ _id: "msg_1", conversation_id: "conv_1" }],
      comments: [{ _id: "comment_1", message_id: "msg_1", conversation_id: "conv_1", user_id: OWNER }],
    });
    const count = await (getCommentCount as any)._handler(ctx(STRANGER, tables), { message_id: "msg_1" });
    expect(count).toBe(0);
  });

  test("a comment message must belong to the supplied conversation", async () => {
    const tables = baseTables({
      conversations: [{ _id: "conv_1", user_id: OWNER, is_private: true }],
      messages: [{ _id: "msg_other", conversation_id: "conv_other" }],
      comments: [],
    });
    await expect((addComment as any)._handler(ctx(OWNER, tables), {
      conversation_id: "conv_1",
      message_id: "msg_other",
      content: "hello",
    })).rejects.toThrow("message");
    expect(tables.comments).toHaveLength(0);
  });
});

describe("Phase 0 pull request boundary", () => {
  const pr = {
    _id: "pr_1",
    team_id: TEAM,
    repository: "private/repo",
    number: 1,
    linked_session_ids: ["conv_1"],
    updated_at: 10,
  };

  test("team and by-id reads reject non-members", async () => {
    const tables = baseTables({ pull_requests: [pr] });
    await expect((listPRsForTeam as any)._handler(ctx(STRANGER, tables), { team_id: TEAM }))
      .rejects.toThrow("Forbidden");
    expect(await (getPRById as any)._handler(ctx(STRANGER, tables), { pr_id: "pr_1" })).toBeNull();
  });

  test("conversation PR reads require conversation access", async () => {
    const tables = baseTables({
      pull_requests: [pr],
      conversations: [{ _id: "conv_1", user_id: OWNER, team_id: TEAM, is_private: true }],
    });
    expect(await (getPRsForConversation as any)._handler(ctx(STRANGER, tables), { conversation_id: "conv_1" }))
      .toEqual([]);
  });

  test("a personal conversation relation cannot disclose a foreign-team PR", async () => {
    const tables = baseTables({
      pull_requests: [pr],
      conversations: [{ _id: "conv_1", user_id: STRANGER, is_private: true }],
    });
    expect(await (getPRsForConversation as any)._handler(ctx(STRANGER, tables), { conversation_id: "conv_1" }))
      .toEqual([]);
  });

  test("timeline reads include only teams the caller belongs to", async () => {
    const tables = baseTables({
      pull_requests: [
        pr,
        { ...pr, _id: "pr_foreign", team_id: "t_foreign", repository: "other/secret", number: 2 },
      ],
    });
    const result = await (getPRsForTimeline as any)._handler(ctx(MEMBER, tables), {});
    expect(result.map((row: any) => row._id)).toEqual(["pr_1"]);
  });

  test("review reads and writes inherit the pull request boundary", async () => {
    const tables = baseTables({
      pull_requests: [pr],
      reviews: [{ _id: "review_1", pull_request_id: "pr_1", reviewer_user_id: OWNER, state: "pending" }],
      review_comments: [{ _id: "review_comment_1", pull_request_id: "pr_1", content: "secret", resolved: false }],
    });
    await expect((getReviewsForPR as any)._handler(ctx(STRANGER, tables), { pull_request_id: "pr_1" }))
      .rejects.toThrow("Pull request not found");
    await expect((createReview as any)._handler(ctx(MEMBER, tables), {
      pull_request_id: "pr_1",
      reviewer_user_id: OWNER,
      state: "approved",
    })).rejects.toThrow("reviewer");
    await expect((resolveComment as any)._handler(ctx(STRANGER, tables), { comment_id: "review_comment_1" }))
      .rejects.toThrow("Pull request not found");
  });
});

describe("Phase 0 task boundary", () => {
  test("team list and mention endpoints reject an explicit foreign team", async () => {
    const tables = baseTables({ tasks: [] });
    await expect((webTaskList as any)._handler(ctx(STRANGER, tables), {
      workspace: "team",
      team_id: TEAM,
    })).rejects.toThrow("Forbidden");
    await expect((webTaskMentionList as any)._handler(ctx(STRANGER, tables), {
      workspace: "team",
      team_id: TEAM,
    })).rejects.toThrow("Forbidden");
  });

  test("a foreign task cannot be promoted by short id", async () => {
    const tables = baseTables({
      tasks: [{ _id: "task_1", short_id: "ct-1", user_id: OWNER, team_id: TEAM }],
    });
    const testCtx = ctx(STRANGER, tables);
    await expect((webTaskPromote as any)._handler(testCtx, { short_id: "ct-1" }))
      .rejects.toThrow("Task not found");
    expect((testCtx.db as any)._patched).toHaveLength(0);
  });

  test("ready-plan and dependency queries reject foreign roots", async () => {
    const token = "test-token";
    const tables = baseTables({
      api_tokens: [{ _id: "token_1", user_id: STRANGER, token_hash: await hashToken(token) }],
      plans: [{ _id: "plan_1", short_id: "pl-1", user_id: OWNER, team_id: TEAM, task_ids: ["task_1"] }],
      tasks: [{ _id: "task_1", short_id: "ct-1", user_id: OWNER, team_id: TEAM, status: "open" }],
    });
    await expect((getReadyTasks as any)._handler(ctx(null, tables), {
      api_token: token,
      plan_id: "pl-1",
    })).rejects.toThrow("Plan not found");
    await expect((getDependencyChain as any)._handler(ctx(null, tables), {
      api_token: token,
      short_id: "ct-1",
    })).rejects.toThrow("Task not found");
  });

  test("task creation and updates reject foreign project relationships", async () => {
    const tables = baseTables({
      projects: [{ _id: "project_1", user_id: OWNER, team_id: TEAM, title: "Secret" }],
      tasks: [{ _id: "task_1", short_id: "ct-1", user_id: STRANGER, status: "open" }],
      counters: [],
      task_history: [],
      plans: [],
    });
    await expect((webTaskCreate as any)._handler(ctx(STRANGER, tables), {
      title: "Poison relation",
      project_id: "project_1",
    })).rejects.toThrow("Project not found");
    await expect((webTaskUpdate as any)._handler(ctx(STRANGER, tables), {
      short_id: "ct-1",
      project_id: "project_1",
    })).rejects.toThrow("Project not found");
  });

  test("CLI updates cannot move a task into a foreign team", async () => {
    const token = "update-token";
    const tables = baseTables({
      api_tokens: [{ _id: "token_update", user_id: STRANGER, token_hash: await hashToken(token) }],
      tasks: [{ _id: "task_1", short_id: "ct-1", user_id: STRANGER, status: "open" }],
      task_history: [],
    });
    await expect((updateTaskForCLI as any)._handler(ctx(null, tables), {
      api_token: token,
      short_id: "ct-1",
      team_id: TEAM,
    })).rejects.toThrow("Forbidden");
  });

  test("task projections filter a poisoned plan relationship", async () => {
    const tables = baseTables({
      tasks: [{ _id: "task_mine", short_id: "ct-mine", user_id: STRANGER, status: "open", plan_id: "plan_foreign" }],
      plans: [{ _id: "plan_foreign", short_id: "pl-secret", user_id: OWNER, team_id: TEAM, title: "SECRET PLAN" }],
      task_comments: [],
    });
    const result = await (webTaskGet as any)._handler(ctx(STRANGER, tables), { short_id: "ct-mine" });
    expect(result.plan).toBeNull();
  });

  test("dependency and comment relationships cannot cross workspaces", async () => {
    const token = "task-relation-token";
    const tables = baseTables({
      api_tokens: [{ _id: "token_task_relation", user_id: MEMBER, token_hash: await hashToken(token) }],
      tasks: [
        { _id: "task_personal", short_id: "ct-personal", user_id: MEMBER, status: "open", blocks: [] },
        { _id: "task_team", short_id: "ct-team", user_id: OWNER, team_id: TEAM, status: "open", blocked_by: [] },
      ],
      conversations: [{ _id: "conv_team", session_id: "team-session", user_id: OWNER, team_id: TEAM, is_private: false }],
      task_comments: [],
    });
    const testCtx = ctx(null, tables);
    await expect((addDep as any)._handler(testCtx, {
      api_token: token,
      short_id: "ct-personal",
      blocks: "ct-team",
    })).rejects.toThrow("Forbidden");
    await expect((addTaskComment as any)._handler(testCtx, {
      api_token: token,
      short_id: "ct-personal",
      text: "poison",
      conversation_id: "team-session",
    })).rejects.toThrow("Forbidden");
    expect((testCtx.db as any)._patched).toHaveLength(0);
    expect(tables.task_comments).toHaveLength(0);
  });

  test("plan progress ignores a one-way poisoned task relation", async () => {
    const tables = baseTables({
      plans: [{
        _id: "plan_foreign",
        user_id: OWNER,
        team_id: TEAM,
        status: "active",
        task_ids: ["task_legit"],
      }],
      tasks: [
        { _id: "task_legit", user_id: OWNER, team_id: TEAM, status: "open" },
        { _id: "task_personal", user_id: STRANGER, status: "open", plan_id: "plan_foreign" },
      ],
    });
    const testCtx = ctx(STRANGER, tables);
    await recalcPlanProgress(testCtx, "plan_foreign" as any, "task_personal" as any, "done");
    expect((testCtx.db as any)._patched).toHaveLength(0);
  });
});

describe("Phase 0 CLI team boundary", () => {
  test("search and feed reject an explicit foreign team before reading its members", async () => {
    const token = "cli-token";
    const tables = baseTables({
      api_tokens: [{ _id: "token_cli", user_id: STRANGER, token_hash: await hashToken(token) }],
      conversations: [],
    });
    expect(await (searchForCLI as any)._handler(ctx(null, tables), {
      api_token: token,
      query: "secret",
      team_id: TEAM,
    })).toEqual({ error: "Unauthorized team" });
    expect(await (feedForCLI as any)._handler(ctx(null, tables), {
      api_token: token,
      team_id: TEAM,
    })).toEqual({ error: "Unauthorized team" });
  });
});

describe("Phase 0 doc boundary", () => {
  test("paginated and mention reads reject an explicit foreign team", async () => {
    const tables = baseTables({ docs: [] });
    await expect((webDocListPaginated as any)._handler(ctx(STRANGER, tables), {
      workspace: "team",
      team_id: TEAM,
      paginationOpts: { numItems: 10, cursor: null },
    })).rejects.toThrow("Forbidden");
    await expect((webDocMentionList as any)._handler(ctx(STRANGER, tables), {
      workspace: "team",
      team_id: TEAM,
    })).rejects.toThrow("Forbidden");
  });

  test("parent and link relationships cannot cross workspaces", async () => {
    const tables = baseTables({
      docs: [
        { _id: "doc_personal", user_id: STRANGER, title: "Mine", created_at: 1, updated_at: 1 },
        { _id: "doc_foreign", user_id: OWNER, team_id: TEAM, title: "Foreign", created_at: 1, updated_at: 1 },
      ],
    });
    await expect((webDocCreate as any)._handler(ctx(STRANGER, tables), {
      title: "Child",
      parent_id: "doc_foreign",
    })).rejects.toThrow("Doc not found");
    await expect((webMoveDoc as any)._handler(ctx(STRANGER, tables), {
      id: "doc_personal",
      parent_id: "doc_foreign",
    })).rejects.toThrow("Doc not found");
    await expect((webToggleDocLink as any)._handler(ctx(STRANGER, tables), {
      doc_id: "doc_personal",
      linked_doc_id: "doc_foreign",
      action: "add",
    })).rejects.toThrow("Doc not found");
  });

  test("doc detail filters poisoned conversation relationships", async () => {
    const tables = baseTables({
      docs: [{
        _id: "doc_personal",
        user_id: STRANGER,
        title: "Mine",
        content: "body",
        doc_type: "note",
        source: "human",
        related_conversation_ids: ["conv_foreign"],
        created_at: 1,
        updated_at: 1,
      }],
      conversations: [{ _id: "conv_foreign", user_id: OWNER, team_id: TEAM, is_private: true, session_id: "secret-session" }],
    });
    const result = await (webDocGet as any)._handler(ctx(STRANGER, tables), { id: "doc_personal" });
    expect(result.related_conversations ?? []).toEqual([]);
  });

  test("mention expansion filters poisoned plan children", async () => {
    const tables = baseTables({
      plans: [{
        _id: "plan_personal",
        short_id: "pl-mine",
        user_id: STRANGER,
        title: "Mine",
        task_ids: ["task_foreign"],
        doc_id: "doc_foreign",
      }],
      tasks: [{
        _id: "task_foreign",
        short_id: "ct-secret",
        user_id: OWNER,
        team_id: TEAM,
        title: "SECRET TASK TITLE",
        body: "SECRET TASK BODY",
        status: "open",
      }],
      docs: [{
        _id: "doc_foreign",
        user_id: OWNER,
        team_id: TEAM,
        title: "Secret doc",
        content: "SECRET DOC CONTENT",
      }],
    });
    const result = await (expandMentions as any)._handler(ctx(STRANGER, tables), {
      mentions: [{ type: "plan", shortId: "pl-mine" }],
    });
    expect(result).toHaveLength(1);
    expect(result[0].markdown).not.toContain("SECRET TASK");
    expect(result[0].markdown).not.toContain("SECRET DOC");
  });
});

describe("Phase 0 plan boundary", () => {
  test("project lists and team mentions reject foreign scopes", async () => {
    const tables = baseTables({
      projects: [{ _id: "project_1", user_id: OWNER, team_id: TEAM }],
      plans: [{ _id: "plan_1", short_id: "pl-1", project_id: "project_1", user_id: OWNER, team_id: TEAM }],
    });
    await expect((webPlanList as any)._handler(ctx(STRANGER, tables), { project_id: "project_1" }))
      .rejects.toThrow("Project not found");
    await expect((webPlanMentionList as any)._handler(ctx(STRANGER, tables), {
      workspace: "team",
      team_id: TEAM,
    })).rejects.toThrow("Forbidden");
  });

  test("plan creation rejects a foreign project", async () => {
    const tables = baseTables({
      projects: [{ _id: "project_1", user_id: OWNER, team_id: TEAM }],
      counters: [],
      plans: [],
      docs: [],
    });
    await expect((webPlanCreate as any)._handler(ctx(STRANGER, tables), {
      title: "Poison plan",
      project_id: "project_1",
    })).rejects.toThrow("Project not found");
  });

  test("plan updates cannot attach foreign tasks", async () => {
    const tables = baseTables({
      plans: [{ _id: "plan_personal", short_id: "pl-mine", user_id: STRANGER, title: "Mine", task_ids: [] }],
      tasks: [{ _id: "task_foreign", short_id: "ct-secret", user_id: OWNER, team_id: TEAM, status: "open" }],
    });
    await expect((webPlanUpdate as any)._handler(ctx(STRANGER, tables), {
      short_id: "pl-mine",
      task_ids: ["task_foreign"],
    })).rejects.toThrow("Task not found");
  });

  test("plan detail filters poisoned child resources", async () => {
    const tables = baseTables({
      plans: [{
        _id: "plan_personal",
        short_id: "pl-mine",
        user_id: STRANGER,
        title: "Mine",
        task_ids: ["task_foreign"],
        session_ids: ["conv_foreign"],
        doc_id: "doc_foreign",
      }],
      tasks: [{ _id: "task_foreign", user_id: OWNER, team_id: TEAM, short_id: "ct-secret", status: "open" }],
      docs: [{ _id: "doc_foreign", user_id: OWNER, team_id: TEAM, content: "secret" }],
      conversations: [{ _id: "conv_foreign", user_id: OWNER, team_id: TEAM, is_private: true, session_id: "secret" }],
      managed_sessions: [],
    });
    const result = await (webPlanGet as any)._handler(ctx(STRANGER, tables), { id: "plan_personal" });
    expect(result.tasks).toEqual([]);
    expect(result.sessions).toEqual([]);
    expect(result.doc_content).toBeUndefined();
  });

  test("CLI and shared plan projections filter poisoned child resources", async () => {
    const token = "plan-read-token";
    const tables = baseTables({
      api_tokens: [{ _id: "token_plan_read", user_id: STRANGER, token_hash: await hashToken(token) }],
      plans: [{
        _id: "plan_personal",
        short_id: "pl-mine",
        share_token: "shared-plan",
        user_id: STRANGER,
        title: "Mine",
        status: "active",
        task_ids: ["task_foreign"],
        doc_id: "doc_foreign",
      }],
      tasks: [{
        _id: "task_foreign",
        short_id: "ct-secret",
        user_id: OWNER,
        team_id: TEAM,
        title: "SECRET TASK",
        status: "open",
      }],
      docs: [{
        _id: "doc_foreign",
        user_id: OWNER,
        team_id: TEAM,
        title: "Secret doc",
        content: "SECRET DOC",
      }],
      managed_sessions: [],
    });

    const detail = await (getPlanForCLI as any)._handler(ctx(null, tables), {
      api_token: token,
      short_id: "pl-mine",
    });
    expect(detail.tasks).toEqual([]);
    expect(detail.doc_content).toBeUndefined();

    const snippet = await (getPlanSnippet as any)._handler(ctx(null, tables), {
      api_token: token,
      plan_short_id: "pl-mine",
    });
    expect(snippet.task_count).toBe(0);
    expect(snippet.snippet).not.toContain("SECRET");

    const status = await (getOrchestrationStatus as any)._handler(ctx(null, tables), {
      api_token: token,
      short_id: "pl-mine",
    });
    expect(status.wave_progress).toEqual({});

    const shared = await (getSharedPlan as any)._handler(ctx(null, tables), {
      share_token: "shared-plan",
    });
    expect(shared.tasks).toEqual([]);
    expect(shared.doc_content).toBeUndefined();
  });

  test("CLI plan/session relationships require access and the same workspace", async () => {
    const token = "plan-relation-token";
    const tables = baseTables({
      api_tokens: [{ _id: "token_plan_relation", user_id: STRANGER, token_hash: await hashToken(token) }],
      plans: [{
        _id: "plan_personal",
        short_id: "pl-mine",
        user_id: STRANGER,
        title: "Mine",
        session_ids: [],
        current_session_id: "conv_foreign",
      }],
      conversations: [{
        _id: "conv_foreign",
        session_id: "foreign-session",
        user_id: OWNER,
        team_id: TEAM,
        is_private: true,
      }],
    });

    await expect((bindSession as any)._handler(ctx(null, tables), {
      api_token: token,
      short_id: "pl-mine",
      conversation_id: "foreign-session",
    })).rejects.toThrow("Conversation not found");
    await expect((associatePlan as any)._handler(ctx(null, tables), {
      api_token: token,
      plan_id: "pl-mine",
      conversation_id: "foreign-session",
    })).rejects.toThrow("Conversation not found");
    await expect((unbindSession as any)._handler(ctx(null, tables), {
      api_token: token,
      short_id: "pl-mine",
    })).rejects.toThrow("Conversation not found");
  });
});
