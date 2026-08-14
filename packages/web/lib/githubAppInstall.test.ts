// The install URL's `state` is what the install webhook binds the installation
// with (convex/http.ts github callback: team_id + user_id out of atob(state)).
// What earns tests: the WORKSPACE the state carries — it must be the team the
// connected-state query answers for (active team, else home team), or the
// install lands in one workspace while the Apps card reports another.

import { describe, expect, test } from "bun:test";
import { githubAppInstallTeam, githubAppInstallUrl } from "./githubAppInstall";

const decodeState = (url: string) =>
  JSON.parse(atob(new URL(url).searchParams.get("state")!));

describe("githubAppInstallUrl", () => {
  test("no team anywhere: null — nothing to bind an installation to", () => {
    expect(githubAppInstallUrl({ _id: "u1" })).toBe(null);
  });

  test("home team only: state carries it, with the caller's user id", () => {
    const url = githubAppInstallUrl({ _id: "u1", team_id: "t_home" })!;
    expect(url).toStartWith("https://github.com/apps/");
    expect(url).toContain("/installations/new?state=");
    expect(decodeState(url)).toEqual({ team_id: "t_home", user_id: "u1" });
  });

  test("the team being looked at outranks the home team — the same resolution listConnections uses", () => {
    const user = { _id: "u1", team_id: "t_home", active_team_id: "t_active" };
    expect(githubAppInstallTeam(user)).toBe("t_active");
    expect(decodeState(githubAppInstallUrl(user)!).team_id).toBe("t_active");
  });
});
