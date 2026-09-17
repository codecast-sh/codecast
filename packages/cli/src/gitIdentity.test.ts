import { afterEach, describe, expect, test } from "bun:test";
import {
  DEVICE_GIT_KEY_REL,
  deviceGitKeyPath,
  deviceKeyComment,
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
    // GitHub's refusal of a push over a deploy key added without write access.
    expect(isGitAuthError("ERROR: The key you are authenticating with has been marked as read only.\nfatal: Could not read from remote repository.")).toBe(true);
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

describe("device key path and comment", () => {
  test("the key lives at the same HOME-relative path on every machine", () => {
    expect(DEVICE_GIT_KEY_REL).toBe(".codecast/git/id_ed25519");
    expect(deviceGitKeyPath().endsWith(`/${DEVICE_GIT_KEY_REL}`)).toBe(true);
  });

  test("deviceKeyComment sanitizes to [A-Za-z0-9._-] and caps at 60 chars, exactly as ensureDeviceGitKey did", () => {
    expect(deviceKeyComment("MacBook Pro (work)")).toBe("codecast-MacBook-Pro-work-");
    expect(deviceKeyComment("i-084309c56a91e15ff")).toBe("codecast-i-084309c56a91e15ff");
    expect(deviceKeyComment("x".repeat(80))).toBe(`codecast-${"x".repeat(60)}`);
    expect(deviceKeyComment("a  b\tc")).toBe("codecast-a-b-c");
  });
});
