// A GitHub App install on a person's own GitHub account covers everything they
// keep there, side projects and private repositories included. Installing it
// for a team must not hand all of that to every teammate: a repository reaches
// the team only once its owner shares it there (the Sync repository rule).
import { describe, expect, test } from "bun:test";
import { canBrowse, listRepositories } from "./repos";
import { resolveTeamForRepository } from "./githubWebhooks";
import { withdrawUnroutedRepositoryRows } from "./githubApp";
import { makeFakeDb } from "./testDb";

function context(viewer: string, overrides: Record<string, any[]> = {}) {
  return {
    auth: { getUserIdentity: async () => ({ subject: `${viewer}|sess`, tokenIdentifier: "test" }) },
    db: makeFakeDb({
      users: [{ _id: "owner", active_team_id: "team" }, { _id: "teammate", active_team_id: "team" }],
      team_memberships: [
        { _id: "m1", user_id: "owner", team_id: "team" },
        { _id: "m2", user_id: "teammate", team_id: "team" },
      ],
      github_app_installations: [{
        _id: "install", installation_id: 7, account_login: "ownergh", account_type: "User",
        team_id: "team", installed_by_user_id: "owner", repository_selection: "selected",
        repositories: [{ full_name: "ownergh/side-project" }, { full_name: "ownergh/shared" }],
      }],
      directory_team_mappings: [{
        _id: "rule", user_id: "owner", team_id: "team", auto_share: true,
        path_prefix: "/Users/owner/code/shared", repository: "ownergh/shared",
      }],
      repo_sources: [],
      pull_requests: [],
      commits: [],
      ...overrides,
    }),
  };
}

const browse = (viewer: string, repository: string, overrides?: Record<string, any[]>) =>
  (canBrowse as any)._handler(context(viewer, overrides), { repository });

describe("a person's GitHub account installed for a team", () => {
  test("a teammate cannot browse a repository its owner never shared", async () => {
    expect(await browse("teammate", "ownergh/side-project")).toBe(false);
  });

  test("a teammate browses the repository its owner shares with the team", async () => {
    expect(await browse("teammate", "ownergh/shared")).toBe(true);
  });

  test("the owner still browses their own unshared repository", async () => {
    expect(await browse("owner", "ownergh/side-project")).toBe(true);
  });

  test("a lock on the shared checkout withdraws it", async () => {
    const locked = [{ _id: "rule", user_id: "owner", auto_share: false, private: true,
      path_prefix: "/Users/owner/code/shared", repository: "ownergh/shared" }];
    expect(await browse("teammate", "ownergh/shared", { directory_team_mappings: locked })).toBe(false);
  });

  test("the repository list shows a teammate only the shared repository", async () => {
    const ctx = context("teammate");
    const rows = await (listRepositories as any)._handler(ctx, {});
    expect(rows.map((r: any) => r.repository)).toEqual(["ownergh/shared"]);
  });

  test("webhook activity routes only for the shared repository", async () => {
    const ctx = context("owner");
    expect(await resolveTeamForRepository(ctx, "ownergh/side-project")).toBeNull();
    expect(await resolveTeamForRepository(ctx, "ownergh/shared")).toBe("team" as any);
  });

  test("an organization's team install is unchanged", async () => {
    const org = [{ _id: "org", installation_id: 8, account_login: "acme", account_type: "Organization",
      team_id: "team", installed_by_user_id: "owner", repository_selection: "all" }];
    expect(await browse("teammate", "acme/anything", { github_app_installations: org })).toBe(true);
  });

  test("withdrawing removes rows routed before the rule, keeps shared ones, and unteams session commits", async () => {
    const ctx = context("owner", {
      pull_requests: [
        { _id: "pr-side", repository: "ownergh/side-project", team_id: "team" },
        { _id: "pr-shared", repository: "ownergh/shared", team_id: "team" },
      ],
      reviews: [{ _id: "review", pull_request_id: "pr-side" }],
      pull_request_sessions: [],
      review_comments: [],
      commits: [
        { _id: "c-hook", repository: "ownergh/side-project", team_id: "team", timestamp: 1 },
        { _id: "c-session", repository: "ownergh/side-project", team_id: "team", conversation_id: "conv", timestamp: 2 },
      ],
    });
    const run = (table: string) =>
      (withdrawUnroutedRepositoryRows as any)._handler(ctx, { installation_id: 7, table });
    expect((await run("pull_requests")).withdrawn).toEqual({ "ownergh/side-project": 1 });
    expect((await run("commits")).withdrawn).toEqual({ "ownergh/side-project": 2 });
    const t = (ctx.db as any)._tables;
    expect(t.pull_requests.map((r: any) => r._id)).toEqual(["pr-shared"]);
    expect(t.reviews).toEqual([]);
    expect(t.commits.map((r: any) => [r._id, r.team_id])).toEqual([["c-session", undefined]]);
    const listed = await (listRepositories as any)._handler({ ...ctx, auth: context("teammate").auth }, {});
    expect(listed.map((r: any) => r.repository)).toEqual(["ownergh/shared"]);
  });
});

describe("the repository list across the viewer's teams", () => {
  test("each team lists its own repositories, and one both reach lists under each", async () => {
    const ctx = context("owner", {
      team_memberships: [
        { _id: "m1", user_id: "owner", team_id: "team" },
        { _id: "m3", user_id: "owner", team_id: "other" },
      ],
      github_app_installations: [],
      commits: [
        { _id: "c1", repository: "acme/union-only", team_id: "team", timestamp: 1 },
        { _id: "c2", repository: "footage/app", team_id: "other", timestamp: 2 },
        { _id: "c3", repository: "acme/both", team_id: "team", timestamp: 3 },
        { _id: "c4", repository: "Acme/Both", team_id: "other", timestamp: 4 },
      ],
    });
    const rows = await (listRepositories as any)._handler(ctx, {});
    expect(rows.map((r: any) => `${r.team_id}:${r.repository.toLowerCase()}`).sort()).toEqual([
      "other:acme/both", "other:footage/app", "team:acme/both", "team:acme/union-only",
    ]);
  });
});
