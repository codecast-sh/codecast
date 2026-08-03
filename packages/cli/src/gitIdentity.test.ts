import { afterEach, describe, expect, test } from "bun:test";
import {
  deviceKeyEnv,
  gitEnvFor,
  identityFor,
  isGitAuthError,
  isSshRemote,
  recordIdentity,
  resetGitIdentityState,
} from "./gitIdentity.js";

afterEach(() => resetGitIdentityState());

describe("isGitAuthError", () => {
  test("recognizes the ways remotes say 'you are not allowed'", () => {
    expect(isGitAuthError("git@github.com: Permission denied (publickey).")).toBe(true);
    expect(isGitAuthError("fatal: Authentication failed for 'https://github.com/x/y.git/'")).toBe(true);
    expect(isGitAuthError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe(true);
    // GitHub's phrasing for an unauthorized private repo.
    expect(isGitAuthError("ERROR: Repository not found.")).toBe(true);
    expect(isGitAuthError("remote: Permission to org/repo.git denied to user.")).toBe(true);
  });

  test("network and remote breakage is NOT an auth problem", () => {
    expect(isGitAuthError("ssh: Could not resolve hostname github.com")).toBe(false);
    expect(isGitAuthError("fatal: unable to access 'https://x/': Could not resolve host")).toBe(false);
    expect(isGitAuthError("error: RPC failed; curl 18 transfer closed")).toBe(false);
    expect(isGitAuthError("Connection timed out")).toBe(false);
  });
});

describe("isSshRemote", () => {
  test("only ssh-shaped remotes can use the device key", () => {
    expect(isSshRemote("git@github.com:org/repo.git")).toBe(true);
    expect(isSshRemote("ssh://git@host/repo.git")).toBe(true);
    expect(isSshRemote("https://github.com/org/repo.git")).toBe(false);
    expect(isSshRemote(undefined)).toBe(false);
  });
});

describe("per-repo identity memory", () => {
  test("gitEnvFor returns the device env only for repos recorded as device", () => {
    expect(gitEnvFor("/repo/a")).toBeUndefined();
    recordIdentity("/repo/a", "device");
    expect(identityFor("/repo/a")).toBe("device");
    const env = gitEnvFor("/repo/a")!;
    expect(env.GIT_SSH_COMMAND).toContain("id_ed25519");
    expect(env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
    // Unrelated repos stay on the user's own credentials.
    expect(gitEnvFor("/repo/b")).toBeUndefined();
  });

  test("deviceKeyEnv preserves the process environment", () => {
    const env = deviceKeyEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.GIT_SSH_COMMAND).toBeTruthy();
  });
});
