// A claimed GitHub login is not a verified one.
//
// `github_username` is read as identity, not decoration: issueSync maps an
// issue's assignee_login to a codecast user, tasks resolves an @handle to an
// assignee, and pull_requests attributes a review to a team member. A public
// mutation (`users.linkGitHub`) used to take the id, the login AND an access
// token as arguments, so any signed-in account could claim any GitHub login
// nobody had claimed yet, and then receive whatever that login is assigned.
// Nothing in the product ever called it.
//
// So the identity has exactly one writer: the auth provider's profile, which
// only GitHub itself can produce.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as users from "./users";

const here = import.meta.dir;

/** Every convex module, comments stripped, so prose never counts as code. */
function modules(): Array<{ file: string; src: string }> {
  return readdirSync(here)
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .map((file) => ({
      file,
      src: readFileSync(join(here, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""),
    }));
}

describe("who may write a GitHub identity", () => {
  // teams.createUserFromGithub also writes the pair from its arguments, and is
  // allowed to: it is internal, and syncGithubOrg fills those arguments from
  // GitHub's own org member list after authenticating a team admin. The
  // identity still comes from GitHub, never from the person it names.
  test("no function claims one from its arguments", () => {
    const claimants = modules()
      .filter(({ src }) => /(?<![_\w])github_(id|username)\s*:\s*args\./.test(src))
      .map(({ file }) => file);
    expect(claimants).toEqual(["teams.ts"]);
  });

  test("the one argument-fed writer stays internal", () => {
    const teams = modules().find((m) => m.file === "teams.ts")!;
    expect(teams.src).toMatch(/export const createUserFromGithub = internalMutation\(/);
  });

  test("the auth provider's profile is the writer that remains", () => {
    const auth = modules().find((m) => m.file === "auth.ts")!;
    expect(auth.src).toMatch(/github_id:\s*String\(profile\.id\)/);
    expect(auth.src).toMatch(/github_username:\s*profile\.login/);
  });

  test("users exposes no way to link a GitHub account, and still unlinks", () => {
    expect((users as any).linkGitHub).toBeUndefined();
    expect((users as any).unlinkGitHub).toBeDefined();
  });
});
