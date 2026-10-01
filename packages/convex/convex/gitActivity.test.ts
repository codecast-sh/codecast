import { describe, expect, test } from "bun:test";
import { linkLocalCommitToConversation, localEventTitle, recordLocal } from "./gitActivity";
import { makeFakeDb } from "./testDb";

// Reflog lines become team activity the same way webhook pushes do: same
// table, same commit dedupe key, same session link, gated by the checkout
// path's team mapping.

const SHA = "1".repeat(40);
const OLD = "0".repeat(39) + "a";

function context(user: string = "owner", overrides: Record<string, any[]> = {}) {
  return {
    auth: { getUserIdentity: async () => ({ subject: `${user}|sess`, tokenIdentifier: "test" }) },
    db: makeFakeDb({
      users: [{ _id: "owner", github_username: "ashot", github_avatar_url: "https://a/v.png" }],
      team_memberships: [{ _id: "m", user_id: "owner", team_id: "team" }],
      conversations: [{ _id: "conv", user_id: "owner", team_id: "team", git_branch: "feat/x" }],
      directory_team_mappings: [{ _id: "map", user_id: "owner", path_prefix: "/src", team_id: "team", auto_share: true, created_at: 1 }],
      commits: [],
      external_events: [],
      file_changes: [],
      tasks: [],
      ...overrides,
    }),
  };
}

const commit = { sha: SHA, message: "feat: the thing\n\nbody", author_name: "A", author_email: "a@x", timestamp: 1_700_000_000_000, files_changed: 2, insertions: 5, deletions: 1 };
const record = (ctx: any, events: any[], extra: any = {}) => (recordLocal as any)._handler(ctx, { root: "/src/demo", repository: "Acme/Demo", branch: "feat/x", events, ...extra });

describe("gitActivity.recordLocal", () => {
  test("a commit becomes a commits row and one event under the webhook's key, linked to the claimed session", async () => {
    const ctx = context();
    const result = await record(ctx, [{ kind: "commit", old_sha: OLD, new_sha: SHA, at: 1_700_000_000_000, actor_name: "A", actor_email: "a@x", message: "feat: the thing", commit, conversation_id: "conv" }]);
    expect(result).toEqual({ published: true, recorded: 1 });
    expect(ctx.db._tables.commits[0]).toMatchObject({ sha: SHA, repository: "acme/demo", team_id: "team", conversation_id: "conv", branch: "feat/x" });
    const evt = ctx.db._tables.external_events[0];
    expect(evt).toMatchObject({ source: "git", kind: "commit", team_id: "team", repository: "acme/demo", title: "feat: the thing", sha: SHA, branch: "feat/x", conversation_id: "conv", actor_login: "ashot", actor_user_id: "owner", dedupe_key: `commit:${SHA}`, created_at: 1_700_000_000_000 });
    expect(evt.commit_id).toBe(ctx.db._tables.commits[0]._id);
    // The same commit reported again (or by a webhook later) is still one row and one event.
    await record(ctx, [{ kind: "commit", old_sha: OLD, new_sha: SHA, at: 1_700_000_000_000, actor_name: "A", actor_email: "a@x", message: "feat: the thing", commit }]);
    expect(ctx.db._tables.commits).toHaveLength(1);
    expect(ctx.db._tables.external_events).toHaveLength(1);
  });

  test("a commit with no claimed session finds the transcript that printed its sha", async () => {
    const ctx = context("owner", { file_changes: [{ _id: "fc", conversation_id: "conv", change_type: "commit", commit_hash: SHA.slice(0, 7) }] });
    await record(ctx, [{ kind: "commit", old_sha: OLD, new_sha: SHA, at: 1, actor_name: "A", actor_email: "a@x", message: "x", commit }]);
    expect(ctx.db._tables.commits[0].conversation_id).toBe("conv");
    expect(ctx.db._tables.external_events[0].conversation_id).toBe("conv");
  });

  test("a Codecast-Session trailer names the session over the daemon's claim, even on a row already linked", async () => {
    const TRAILED = "t".repeat(32);
    const trailedCommit = { ...commit, message: `feat: the thing\n\nCodecast-Session: https://codecast.sh/conversation/${TRAILED}` };
    const ctx = context("owner", {
      conversations: [
        { _id: "conv", user_id: "owner", team_id: "team", git_branch: "feat/x" },
        { _id: TRAILED, user_id: "owner", team_id: "team" },
      ],
      commits: [{ _id: "c", sha: SHA, repository: "acme/demo", team_id: "team", message: "x", author_name: "A", author_email: "a", timestamp: 1, files_changed: 0, insertions: 0, deletions: 0, conversation_id: "conv" }],
    });
    await record(ctx, [{ kind: "commit", old_sha: OLD, new_sha: SHA, at: 1, actor_name: "A", actor_email: "a@x", message: "feat: the thing", commit: trailedCommit, conversation_id: "conv" }]);
    expect(ctx.db._tables.commits[0].conversation_id).toBe(TRAILED);
    expect(ctx.db._tables.external_events[0].conversation_id).toBe(TRAILED);
  });

  test("a harness's scratch commit links no session until it is seen on a real branch", async () => {
    const trailedCommit = { ...commit, message: "base\n\nCodecast-Session: https://codecast.sh/conversation/conv" };
    const ctx = context("owner", { file_changes: [{ _id: "fc", conversation_id: "conv", change_type: "commit", commit_hash: SHA.slice(0, 7) }] });
    const event = { kind: "commit", old_sha: OLD, new_sha: SHA, at: 1, actor_name: "A", actor_email: "a@x", message: "base", commit: trailedCommit, conversation_id: "conv" };
    for (const branch of ["worktree-wf_83ab08aa-905-104", "worktree-agent-a1b2c3d4"]) {
      await record(ctx, [event], { branch });
      expect(ctx.db._tables.commits[0].conversation_id).toBeUndefined();
      expect(ctx.db._tables.external_events[0].conversation_id).toBeUndefined();
    }
    await linkLocalCommitToConversation(ctx as any, "conv" as any, SHA.slice(0, 7));
    expect(ctx.db._tables.commits[0].conversation_id).toBeUndefined();

    await record(ctx, [event], { branch: "main" });
    expect(ctx.db._tables.commits[0]).toMatchObject({ conversation_id: "conv", branch: "main" });
  });

  test("a harness worktree's commit links no session even on a branch the agent named itself", async () => {
    const trailedCommit = { ...commit, message: "base\n\nCodecast-Session: https://codecast.sh/conversation/conv" };
    const ctx = context();
    const event = { kind: "commit", old_sha: OLD, new_sha: SHA, at: 1, actor_name: "A", actor_email: "a@x", message: "base", commit: trailedCommit, conversation_id: "conv" };
    await record(ctx, [event], { root: "/src/demo/.claude/worktrees/wf_83ab08aa-905-32", branch: "review-l3db" });
    expect(ctx.db._tables.commits[0].conversation_id).toBeUndefined();
    expect(ctx.db._tables.external_events[0].conversation_id).toBeUndefined();
  });

  test("a trailer from a checkout links no teammate's private session and takes no teammate's commit", async () => {
    const MATE_PRIVATE = "p".repeat(32);
    const MINE = "t".repeat(32);
    const trailedBy = (id: string) => ({ ...commit, message: `feat: the thing\n\nCodecast-Session: https://codecast.sh/conversation/${id}` });
    const seed = (conversation_id?: string) => context("owner", {
      conversations: [
        { _id: "mate_conv", user_id: "mate", team_id: "team", is_private: false },
        { _id: MATE_PRIVATE, user_id: "mate", team_id: "team", is_private: true },
        { _id: MINE, user_id: "owner", team_id: "team", is_private: true },
      ],
      commits: [{ _id: "c", sha: SHA, repository: "acme/demo", team_id: "team", message: "x", author_name: "A", author_email: "a", timestamp: 1, files_changed: 0, insertions: 0, deletions: 0, conversation_id }],
    });
    const run = async (id: string, linked?: string) => {
      const ctx = seed(linked);
      await record(ctx, [{ kind: "commit", old_sha: OLD, new_sha: SHA, at: 1, actor_name: "A", actor_email: "a@x", message: "feat: the thing", commit: trailedBy(id) }]);
      return ctx.db._tables.commits[0].conversation_id;
    };
    expect(await run(MATE_PRIVATE)).toBeUndefined();
    expect(await run(MINE)).toBe(MINE);
    expect(await run(MINE, "mate_conv")).toBe("mate_conv");
  });

  test("checkouts and pushes are events with readable titles and no commit row", async () => {
    const ctx = context();
    await record(ctx, [
      { kind: "checkout", old_sha: OLD, new_sha: SHA, at: 2, actor_name: "A", actor_email: "a@x", message: "moving from main to feat/x", from_ref: "main", to_ref: "feat/x", ref: "feat/x" },
      { kind: "push", old_sha: OLD, new_sha: SHA, at: 3, actor_name: "A", actor_email: "a@x", message: "", ref: "feat/x", commits_count: 3 },
    ]);
    expect(ctx.db._tables.commits).toHaveLength(0);
    expect(ctx.db._tables.external_events.map((e: any) => [e.kind, e.title])).toEqual([
      ["checkout", "switched to feat/x from main"],
      ["push", "pushed feat/x (3 commits)"],
    ]);
  });

  test("a checkout outside every shared directory publishes nothing", async () => {
    const ctx = context();
    expect(await record(ctx, [{ kind: "commit", old_sha: OLD, new_sha: SHA, at: 1, actor_name: "A", actor_email: "a@x", message: "x", commit }], { root: "/private/demo" })).toEqual({ published: false, reason: "private" });
    expect(ctx.db._tables.external_events).toHaveLength(0);
  });
});

describe("linkLocalCommitToConversation", () => {
  test("a commit and its event that arrived before the transcript line learn the session", async () => {
    const ctx = context("owner", {
      commits: [{ _id: "c", sha: SHA, repository: "acme/demo", team_id: "team", message: "x", author_name: "A", author_email: "a", timestamp: 1, files_changed: 0, insertions: 0, deletions: 0 }],
      external_events: [{ _id: "e", team_id: "team", source: "git", kind: "commit", title: "x", dedupe_key: `commit:${SHA}`, created_at: 1 }],
    });
    await linkLocalCommitToConversation(ctx, "conv" as any, SHA.slice(0, 7));
    expect(ctx.db._tables.commits[0].conversation_id).toBe("conv");
    expect(ctx.db._tables.external_events[0].conversation_id).toBe("conv");
  });
});

test("localEventTitle reads like a shell prompt would", () => {
  expect(localEventTitle({ kind: "reset", message: "moving to origin/main", ref: "origin/main", new_sha: SHA, branch: "main" })).toBe("reset main to origin/main");
  expect(localEventTitle({ kind: "merge", message: "Fast-forward", ref: "feat/x", new_sha: SHA, branch: "main" })).toBe("merged feat/x into main");
  expect(localEventTitle({ kind: "amend", message: "fix: typo", new_sha: SHA })).toBe("amended 1111111: fix: typo");
});
