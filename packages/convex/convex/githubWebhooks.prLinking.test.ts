import { describe, expect, test } from "bun:test";
import { conversationForCommit, matchPRToConversation } from "./githubWebhooks";
import { makeFakeDb } from "./testDb";

// A pull request links sessions by branch name, and the branch index spans
// every user. Linked sessions show on the pull request, and one is named in a
// public GitHub comment posted with its owner's token, so only a session the
// author owns or the PR's team may read can be linked (ct-55374).

const REPO = "codecast-sh/codecast";
const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

function setup(conversations: any[]) {
  const db = makeFakeDb({
    users: [
      { _id: "author", name: "Author", github_username: "author", github_access_token: "tok_author" },
      { _id: "mate", name: "Mate", github_access_token: "tok_mate" },
      { _id: "stranger", name: "Stranger", github_access_token: "tok_stranger" },
    ],
    team_memberships: [
      { _id: "m1", user_id: "author", team_id: "team_1", role: "member" },
      { _id: "m2", user_id: "mate", team_id: "team_1", role: "member" },
      { _id: "m3", user_id: "stranger", team_id: "team_2", role: "member" },
    ],
    github_app_installations: [{ _id: "install_1", team_id: "team_1", installation_id: 7, account_login: "codecast-sh", repository_selection: "all" }],
    conversations,
    github_webhook_events: [{ _id: "event_open", processed: false }],
    pull_requests: [], agent_tasks: [], tasks: [], plans: [], projects: [],
  });
  const ctx = { db, scheduler: { runAfter: async () => {} } } as any;
  const open = (head_ref: string) => call(matchPRToConversation, ctx, {
    event_id: "event_open", repository: REPO, pr_number: 12, github_pr_id: 555,
    head_ref, base_ref: "main", title: "A change", body: "",
    author_username: "author", created_at: 1, updated_at: 2,
  });
  const pr = () => db._tables.pull_requests[0];
  return { ctx, db, open, pr };
}

const remote = `git@github.com:${REPO}.git`;
const strangerPrivate = (branch: string) => ({ _id: "conv_stranger", user_id: "stranger", team_id: "team_2", title: "Acme billing secret", is_private: true, git_branch: branch, git_remote_url: remote, updated_at: 9 });
const strangerShared = (branch: string) => ({ _id: "conv_stranger_shared", user_id: "stranger", team_id: "team_2", title: "Other team work", is_private: false, git_branch: branch, git_remote_url: remote, updated_at: 8 });

describe("pull request session linking", () => {
  test("a stranger's private session on the fork's main is never linked or commented on", async () => {
    const f = setup([strangerPrivate("main")]);
    const result = await f.open("main");
    expect(result.matched_conversation_id).toBeNull();
    expect(result.github_access_token).toBeNull();
    expect(f.pr().linked_session_ids).toEqual([]);
    expect(f.pr().team_id).toBe("team_1");
  });

  test("a stranger's session on a matching feature branch is not linked; the author's own private one is", async () => {
    const f = setup([
      strangerPrivate("fix-thing"),
      { _id: "conv_author", user_id: "author", team_id: "team_1", title: "Mine", is_private: true, git_branch: "fix-thing", git_remote_url: remote, updated_at: 1 },
    ]);
    const result = await f.open("fix-thing");
    expect(f.pr().linked_session_ids).toEqual(["conv_author"]);
    expect(result.matched_conversation_id).toBe("conv_author");
    expect(result.github_access_token).toBe("tok_author");
  });

  test("a teammate's team-visible session links; their private one does not", async () => {
    const f = setup([
      { _id: "conv_mate_shared", user_id: "mate", team_id: "team_1", is_private: false, git_branch: "fix-thing", git_remote_url: remote },
      { _id: "conv_mate_private", user_id: "mate", team_id: "team_1", is_private: true, git_branch: "fix-thing", git_remote_url: remote },
    ]);
    await f.open("fix-thing");
    expect(f.pr().linked_session_ids).toEqual(["conv_mate_shared"]);
  });

  test("another team's shared session on the branch cannot take the pull request to its team", async () => {
    const f = setup([strangerShared("fix-thing")]);
    await f.open("fix-thing");
    expect(f.pr().team_id).toBe("team_1");
    expect(f.pr().linked_session_ids).toEqual([]);
  });

  test("a push links a commit by branch only to a session its pusher or team may link", async () => {
    const f = setup([strangerPrivate("fix-thing")]);
    expect(await conversationForCommit(f.ctx, "abc1234", "fix-thing", { userId: "author" as any, teamId: "team_1" as any })).toBeUndefined();
    const g = setup([{ _id: "conv_author", user_id: "author", team_id: "team_1", is_private: true, git_branch: "fix-thing" }]);
    expect(await conversationForCommit(g.ctx, "abc1234", "fix-thing", { userId: "author" as any, teamId: "team_1" as any })).toBe("conv_author");
    expect(await conversationForCommit(g.ctx, "abc1234", "fix-thing", { userId: null, teamId: "team_1" as any })).toBeUndefined();
  });
});
