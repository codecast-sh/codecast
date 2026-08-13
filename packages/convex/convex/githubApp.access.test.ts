// Workspace scoping for GitHub App installation lookup.
//
// An installation is a credential: resolving one yields a token that can read
// and write the repositories it covers. Lookup therefore has to answer "which
// installations may THIS principal reach", not "which installation matches this
// owner name". The lookup used to answer the second question — it tried the
// named team first and then scanned by account_login across every team — so a
// member of team A resolved team B's installation for any repo under an owner
// name they could guess.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getInstallationForRepo, getInstallationForRepoInTeam } from "./githubApp";

const TEAM_A = "t_a";
const TEAM_B = "t_b";
const USER_A = "u_a";
const USER_B = "u_b";

function tables(installations: any[]) {
  return {
    teams: [
      { _id: TEAM_A, name: "Team A" },
      { _id: TEAM_B, name: "Team B" },
    ],
    team_memberships: [
      { _id: "tm_a", user_id: USER_A, team_id: TEAM_A, role: "member", joined_at: 1 },
      { _id: "tm_b", user_id: USER_B, team_id: TEAM_B, role: "member", joined_at: 1 },
    ],
    github_app_installations: installations,
  };
}

// Team B owns the only installation for the `acme` account.
function teamBInstallation(extra: Record<string, any> = {}) {
  return {
    _id: "gai_b",
    team_id: TEAM_B,
    installation_id: 555,
    account_login: "acme",
    account_type: "Organization",
    account_id: 900,
    repository_selection: "all",
    created_at: 1,
    updated_at: 1,
    ...extra,
  };
}

function ctx(installations: any[]) {
  return { db: makeFakeDb(tables(installations)) } as any;
}

function lookup(installations: any[], args: Record<string, any>) {
  return (getInstallationForRepo as any)._handler(ctx(installations), {
    repository: "acme/widgets",
    ...args,
  });
}

describe("getInstallationForRepo workspace scoping", () => {
  test("a member of the owning team resolves the installation", async () => {
    const found = await lookup([teamBInstallation()], { user_id: USER_B, team_id: TEAM_B });
    expect(found?.installation_id).toBe(555);
  });

  test("resolves without a named team from the caller's own memberships", async () => {
    const found = await lookup([teamBInstallation()], { user_id: USER_B });
    expect(found?.installation_id).toBe(555);
  });

  // The hole: an outsider used to reach team B's credential through the
  // account_login fallback.
  test("an outsider gets nothing when they name no team", async () => {
    expect(await lookup([teamBInstallation()], { user_id: USER_A })).toBeNull();
  });

  test("an outsider gets nothing when they name their own team", async () => {
    expect(await lookup([teamBInstallation()], { user_id: USER_A, team_id: TEAM_A })).toBeNull();
  });

  test("naming a team you do not belong to is refused, not answered", async () => {
    await expect(lookup([teamBInstallation()], { user_id: USER_A, team_id: TEAM_B }))
      .rejects.toThrow(/team membership required/i);
  });

  // Repository coverage still decides within a team the caller does belong to:
  // a `selected` installation only answers for the repos it lists.
  test("a selected installation answers only for its listed repositories", async () => {
    const selected = teamBInstallation({
      repository_selection: "selected",
      repositories: [{ id: 1, name: "gadgets", full_name: "acme/gadgets" }],
    });
    expect(await lookup([selected], { user_id: USER_B, team_id: TEAM_B })).toBeNull();

    const covering = teamBInstallation({
      repository_selection: "selected",
      repositories: [{ id: 2, name: "widgets", full_name: "acme/widgets" }],
    });
    expect((await lookup([covering], { user_id: USER_B, team_id: TEAM_B }))?.installation_id).toBe(555);
  });

  test("a different account login never matches", async () => {
    const other = teamBInstallation({ account_login: "other-org" });
    expect(await lookup([other], { user_id: USER_B, team_id: TEAM_B })).toBeNull();
  });
});

// The team-scoped entry point serves callers with no user to check — webhook
// processing knows only which team the repository work belongs to.
describe("getInstallationForRepoInTeam", () => {
  function lookupInTeam(installations: any[], team_id: string) {
    return (getInstallationForRepoInTeam as any)._handler(ctx(installations), {
      repository: "acme/widgets",
      team_id,
    });
  }

  test("returns the installation the named team owns", async () => {
    expect((await lookupInTeam([teamBInstallation()], TEAM_B))?.installation_id).toBe(555);
  });

  test("another team's installation is never substituted", async () => {
    expect(await lookupInTeam([teamBInstallation()], TEAM_A)).toBeNull();
  });
});
