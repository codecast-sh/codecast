// The install URL is minted by the server now (githubApp.getInstallUrl), because
// its `state` is a single-use intent bound to the authenticated caller. A URL
// the client could build for itself was the authority the install callback
// trusted: any base64 JSON named the user and team an installation bound to.
//
// What is left here is the workspace the CARD reads, which must be the workspace
// the connected-state query answers for, or the install lands in one team while
// the card reports another.

import { describe, expect, test } from "bun:test";
import { parseGithubAppInstallState, newGithubAppInstallNonce } from "@codecast/shared/contracts";
import { githubAppInstallTeam } from "./githubAppInstall";

describe("githubAppInstallTeam", () => {
  test("the team being looked at outranks the home team", () => {
    expect(githubAppInstallTeam({ _id: "u1", team_id: "t_home", active_team_id: "t_active" })).toBe("t_active");
  });

  test("with no active team, the home team; with neither, none", () => {
    expect(githubAppInstallTeam({ _id: "u1", team_id: "t_home" })).toBe("t_home");
    expect(githubAppInstallTeam({ _id: "u1" })).toBeUndefined();
  });
});

describe("install state", () => {
  test("a minted nonce reads back; a forged identity state names nothing", () => {
    const nonce = newGithubAppInstallNonce();
    expect(parseGithubAppInstallState(nonce)).toBe(nonce);
    // THE regression: the old state was base64 JSON anyone could write.
    expect(parseGithubAppInstallState(btoa(JSON.stringify({ user_id: "u_victim", team_id: "t_victim" })))).toBeNull();
    expect(parseGithubAppInstallState("not-a-nonce")).toBeNull();
    expect(parseGithubAppInstallState(null)).toBeNull();
  });

  test("two nonces never collide, and each is 48 hex characters", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newGithubAppInstallNonce()));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(n).toMatch(/^[0-9a-f]{48}$/);
  });
});
