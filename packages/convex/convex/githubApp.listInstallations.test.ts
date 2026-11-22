// listInstallations feeds every window from the active team pointer. A person
// who left (or was removed from) that team still carries the pointer until it
// moves, and the query threw FORBIDDEN on each push, which reached the web as
// "[CONVEX Q(githubApp:listInstallations)] Server Error" (ct-74018). Like
// teams.getTeamMembers, a non-member is answered with nothing, not an error,
// and is never shown the team's installations.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { listInstallations } from "./githubApp";

const as = (db: any, user: string) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${user}|session` }) } });

function db() {
  return makeFakeDb({
    teams: [{ _id: "t_a", name: "Team A" }],
    team_memberships: [{ _id: "tm_a", user_id: "u_member", team_id: "t_a", role: "member", joined_at: 1 }],
    github_app_installations: [
      { _id: "gai_a", team_id: "t_a", installation_id: 1, account_login: "acme", account_type: "Organization", account_id: 9, repository_selection: "all", created_at: 1, updated_at: 1 },
    ],
  } as any);
}

describe("githubApp.listInstallations for a team the caller is not in", () => {
  test("answers with no installations instead of throwing", async () => {
    const run = (listInstallations as any)._handler(as(db(), "u_former"), { team_id: "t_a" });
    await expect(run).resolves.toEqual([]);
  });

  test("a member still sees the team's installations", async () => {
    const rows = await (listInstallations as any)._handler(as(db(), "u_member"), { team_id: "t_a" });
    expect(rows.map((r: any) => r._id)).toEqual(["gai_a"]);
  });
});
