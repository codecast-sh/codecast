// The fallback GitHub token for a team's pull request comes from someone who
// is in the team today (team_memberships), never from the home-team pointer.
import { expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { teamMemberGithubToken } from "./githubWebhooks";

const tok = (name: string) => "gh" + "o_" + name;

test("a member whose home team is elsewhere still serves; a person who left, or another team's, does not", async () => {
  const db = makeFakeDb({
    users: [
      { _id: "left", team_id: "team_a", github_access_token: tok("left") },
      { _id: "other", team_id: "team_b", github_access_token: tok("other") },
      { _id: "member", team_id: "team_b", github_access_token: tok("member") },
    ],
    team_memberships: [
      { _id: "m1", user_id: "member", team_id: "team_a" },
      { _id: "m2", user_id: "other", team_id: "team_b" },
      { _id: "m3", user_id: "member", team_id: "team_b" },
    ],
  });
  expect(await teamMemberGithubToken({ db }, "team_a" as any)).toBe(tok("member"));
  expect(await teamMemberGithubToken({ db }, "team_c" as any)).toBeNull();
  expect(await teamMemberGithubToken({ db }, undefined)).toBeNull();
});
