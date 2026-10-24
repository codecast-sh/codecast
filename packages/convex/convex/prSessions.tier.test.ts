import { describe, expect, test } from "bun:test";
import { chooseShepherdConversation, matchPRToConversation } from "./githubWebhooks";
import { updatePRCommits } from "./pull_requests";
import { linkPullRequestSessions } from "./lib/prSessions";
import { makeFakeDb } from "./testDb";

// pull_request_sessions tiers: a branch match is "observed", a session's own
// commit on the pull request is "committed"; the stronger link wins and stays.

const USER = "user_1";
const TEAM = "team_1";
const ON_BRANCH = "conv_branch";
const COMMITTER = "conv_commit";
const REPO = "codecast-sh/codecast";
const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const discovery = {
  event_id: "event_open", repository: REPO, pr_number: 12, github_pr_id: 555,
  head_ref: "fix-test", base_ref: "main", head_sha: "def4567890", title: "Fix test", body: "",
  author_username: "ashot", created_at: 1, updated_at: 2,
};

function fixture() {
  const db = makeFakeDb({
    users: [{ _id: USER, name: "Ashot", github_username: "ashot" }],
    team_memberships: [{ _id: "membership_1", user_id: USER, team_id: TEAM, role: "member" }],
    github_app_installations: [{ _id: "install_1", team_id: TEAM, installation_id: 7, account_login: "codecast-sh", repository_selection: "all" }],
    conversations: [
      { _id: ON_BRANCH, user_id: USER, title: "Looked at it", is_private: true, git_branch: "fix-test", git_remote_url: `git@github.com:${REPO}.git`, updated_at: 20 },
      { _id: COMMITTER, user_id: USER, title: "Wrote it", is_private: true, git_branch: "other", updated_at: 10 },
    ],
    file_changes: [{ _id: "fc_1", conversation_id: COMMITTER, commit_hash: "def4567" }],
    commits: [],
    github_webhook_events: [{ _id: "event_open", processed: false }],
    pull_requests: [], pull_request_sessions: [], agent_tasks: [], reviews: [], review_comments: [], tasks: [],
  });
  const ctx = { db, scheduler: { runAfter: async () => {} } } as any;
  const pr = () => db._tables.pull_requests[0];
  const tiers = () =>
    Object.fromEntries(db._tables.pull_request_sessions.map((row: any) => [row.conversation_id, row.tier ?? "observed"]));
  return { db, ctx, pr, tiers };
}

describe("pull request link tiers", () => {
  test("a branch match is observed; a session's own commit upgrades it to committed", async () => {
    const f = fixture();
    await call(matchPRToConversation, f.ctx, discovery);
    expect(f.tiers()).toEqual({ [ON_BRANCH]: "observed" });

    await call(updatePRCommits, f.ctx, { pr_id: f.pr()._id, commits: [{ sha: "def4567890", message: "fix" }] });
    expect(f.pr().linked_session_ids).toEqual([ON_BRANCH, COMMITTER]);
    expect(f.tiers()).toEqual({ [ON_BRANCH]: "observed", [COMMITTER]: "committed" });
  });

  test("rediscovery keeps the committed link and a weaker link never lowers it", async () => {
    const f = fixture();
    await call(matchPRToConversation, f.ctx, discovery);
    await call(updatePRCommits, f.ctx, { pr_id: f.pr()._id, commits: [{ sha: "def4567890", message: "fix" }] });

    await call(matchPRToConversation, f.ctx, discovery);
    expect(f.pr().linked_session_ids).toContain(COMMITTER);
    await linkPullRequestSessions(f.ctx, f.pr()._id, [COMMITTER as any], "observed");
    expect(f.tiers()).toEqual({ [ON_BRANCH]: "observed", [COMMITTER]: "committed" });
    expect(f.db._tables.pull_request_sessions).toHaveLength(2);
  });

  test("the shepherd is a committed session when one exists", async () => {
    const f = fixture();
    await call(matchPRToConversation, f.ctx, discovery);
    expect(f.pr().shepherd_conversation_id).toBe(ON_BRANCH);
    await call(updatePRCommits, f.ctx, { pr_id: f.pr()._id, commits: [{ sha: "def4567890", message: "fix" }] });
    await f.db.patch(f.pr()._id, { shepherd_conversation_id: undefined });
    await call(matchPRToConversation, f.ctx, discovery);
    expect(f.pr().shepherd_conversation_id).toBe(COMMITTER);
  });

  test("chooseShepherdConversation prefers committed over a newer branch match in the repo", () => {
    const onBranch = { _id: "a", updated_at: 99, git_remote_url: `git@github.com:${REPO}.git` } as any;
    const committed = { _id: "b", updated_at: 1 } as any;
    expect(chooseShepherdConversation([onBranch], REPO, "fix-test")?._id).toBe("a");
    expect(chooseShepherdConversation([onBranch], REPO, "fix-test", [committed])?._id).toBe("b");
  });
});
