// The install URL's `state` is what the install webhook binds the installation
// with (convex/http.ts github callback: team_id + user_id out of atob(state)).
// What earns tests: the WORKSPACE the state carries — it must be the team the
// connected-state query answers for (active team, else home team), or the
// install lands in one workspace while the Apps card reports another.

import { describe, expect, test } from "bun:test";
import { parseGithubAppInstallState } from "@codecast/shared/contracts";
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
    expect(decodeState(url)).toEqual({ user_id: "u1", scope: "team", team_id: "t_home" });
  });

  test("a personal install needs no team and names none", () => {
    const url = githubAppInstallUrl({ _id: "u1" }, "personal")!;
    expect(url).toContain("/installations/new?state=");
    expect(decodeState(url)).toEqual({ user_id: "u1", scope: "personal" });
    // Even with a team in view, a personal install binds to the person.
    expect(decodeState(githubAppInstallUrl({ _id: "u1", active_team_id: "t_active" }, "personal")!)).toEqual({
      user_id: "u1",
      scope: "personal",
    });
  });

  test("the callback reads back exactly what the button minted, old states included", () => {
    const team = githubAppInstallUrl({ _id: "u1", team_id: "t_home" })!;
    expect(parseGithubAppInstallState(new URL(team).searchParams.get("state"))).toEqual({
      user_id: "u1",
      scope: "team",
      team_id: "t_home",
    });
    const personal = githubAppInstallUrl({ _id: "u1" }, "personal")!;
    expect(parseGithubAppInstallState(new URL(personal).searchParams.get("state"))).toEqual({ user_id: "u1", scope: "personal" });
    // Installs minted before scopes existed carried only team_id + user_id.
    expect(parseGithubAppInstallState(btoa(JSON.stringify({ team_id: "t_old", user_id: "u1" })))).toEqual({
      user_id: "u1",
      scope: "team",
      team_id: "t_old",
    });
    // A state that names nobody binds to nothing.
    expect(parseGithubAppInstallState(btoa(JSON.stringify({ team_id: "t_old" })))).toBeNull();
    expect(parseGithubAppInstallState("not-base64-json")).toBeNull();
  });

  test("the team being looked at outranks the home team — the same resolution listConnections uses", () => {
    const user = { _id: "u1", team_id: "t_home", active_team_id: "t_active" };
    expect(githubAppInstallTeam(user)).toBe("t_active");
    expect(decodeState(githubAppInstallUrl(user)!).team_id).toBe("t_active");
  });
});
