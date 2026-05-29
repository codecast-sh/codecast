import { describe, test, expect } from "bun:test";
import { resolveLocalProjectPath, resolveResumeCwd } from "./projectPathResolver.js";

const remote = "git@github.com:union-mobile/outreach.git";

describe("resolveLocalProjectPath", () => {
  test("returns the recorded path unchanged when it exists locally", async () => {
    const result = await resolveLocalProjectPath({
      projectPath: "/repo/foo",
      gitRoot: "/repo",
      gitRemoteUrl: remote,
      findCandidates: async () => [],
      exists: (p) => p === "/repo/foo",
    });
    expect(result).toEqual({ path: "/repo/foo", remapped: false, reason: "recorded path exists locally" });
  });

  test("remaps a foreign path to a local checkout, preserving the subpath", async () => {
    // bot ran in /Users/ec2-user/src/union-mobile/outreach/packages/x; locally
    // the user has the repo at ~/src/outreach
    const result = await resolveLocalProjectPath({
      projectPath: "/Users/ec2-user/src/union-mobile/outreach/packages/x",
      gitRoot: "/Users/ec2-user/src/union-mobile/outreach",
      gitRemoteUrl: remote,
      findCandidates: async () => ["/Users/ashot/src/outreach"],
      exists: (p) => p === "/Users/ashot/src/outreach" || p === "/Users/ashot/src/outreach/packages/x",
    });
    expect(result?.remapped).toBe(true);
    expect(result?.path).toBe("/Users/ashot/src/outreach/packages/x");
  });

  test("falls back to repo root when the subpath is missing in the local checkout", async () => {
    const result = await resolveLocalProjectPath({
      projectPath: "/Users/ec2-user/src/outreach/packages/missing",
      gitRoot: "/Users/ec2-user/src/outreach",
      gitRemoteUrl: remote,
      findCandidates: async () => ["/Users/ashot/src/outreach"],
      exists: (p) => p === "/Users/ashot/src/outreach",
    });
    expect(result?.remapped).toBe(true);
    expect(result?.path).toBe("/Users/ashot/src/outreach");
  });

  test("returns null when no remote URL is provided and recorded path is missing", async () => {
    const result = await resolveLocalProjectPath({
      projectPath: "/nope",
      gitRoot: "/nope",
      gitRemoteUrl: null,
      findCandidates: async () => [],
      exists: () => false,
    });
    expect(result).toBeNull();
  });

  test("returns null when no candidate checkouts exist locally", async () => {
    const result = await resolveLocalProjectPath({
      projectPath: "/Users/ec2-user/src/outreach",
      gitRoot: "/Users/ec2-user/src/outreach",
      gitRemoteUrl: remote,
      findCandidates: async () => ["/Users/other/checkout"],
      exists: () => false,
    });
    expect(result).toBeNull();
  });

  test("skips candidate roots that don't exist on disk", async () => {
    const result = await resolveLocalProjectPath({
      projectPath: "/Users/ec2-user/src/outreach",
      gitRoot: "/Users/ec2-user/src/outreach",
      gitRemoteUrl: remote,
      findCandidates: async () => ["/stale", "/Users/ashot/src/outreach"],
      exists: (p) => p === "/Users/ashot/src/outreach",
    });
    expect(result?.path).toBe("/Users/ashot/src/outreach");
  });

  test("picks the first usable candidate (most-recently-used wins)", async () => {
    const result = await resolveLocalProjectPath({
      projectPath: "/Users/ec2-user/src/outreach",
      gitRoot: "/Users/ec2-user/src/outreach",
      gitRemoteUrl: remote,
      findCandidates: async () => ["/Users/ashot/src/outreach", "/Users/ashot/.conductor/feat-x"],
      // Recorded ec2 path doesn't exist locally; both candidates do.
      exists: (p) => p !== "/Users/ec2-user/src/outreach",
    });
    expect(result?.path).toBe("/Users/ashot/src/outreach");
  });
});

describe("resolveResumeCwd", () => {
  const noRepo = () => null;

  test("an existing override wins (remote-move worktree path)", async () => {
    const cwd = await resolveResumeCwd({
      cwdOverride: "/Users/m1/work/outreach",
      recordedCwd: "/Users/ashot/src/union-mobile/outreach",
      resolveLocalRepo: noRepo,
      exists: (p) => p === "/Users/m1/work/outreach",
    });
    expect(cwd).toBe("/Users/m1/work/outreach");
  });

  test("uses the recorded cwd when it exists locally (the common local resume)", async () => {
    const cwd = await resolveResumeCwd({
      recordedCwd: "/Users/ashot/src/union-mobile/outreach",
      resolveLocalRepo: noRepo,
      exists: (p) => p === "/Users/ashot/src/union-mobile/outreach",
    });
    expect(cwd).toBe("/Users/ashot/src/union-mobile/outreach");
  });

  test("falls back to the local-repo map when the recorded cwd is foreign", async () => {
    const cwd = await resolveResumeCwd({
      recordedCwd: "/Users/ec2-user/src/outreach",
      resolveLocalRepo: (p) => (p === "/Users/ec2-user/src/outreach" ? "/Users/ashot/src/outreach" : null),
      exists: (p) => p === "/Users/ashot/src/outreach",
    });
    expect(cwd).toBe("/Users/ashot/src/outreach");
  });

  test("falls back to a git-remote remap when nothing else resolves", async () => {
    const cwd = await resolveResumeCwd({
      recordedCwd: "/Users/ec2-user/src/outreach",
      resolveLocalRepo: noRepo,
      remapViaRemote: async () => "/Users/ashot/src/outreach",
      exists: (p) => p === "/Users/ashot/src/outreach",
    });
    expect(cwd).toBe("/Users/ashot/src/outreach");
  });

  // The regression: the remote Mac receives a resume for a session recorded at a
  // path it has no checkout of. Old code fell back to $HOME (/Users/m1), ran the
  // agent there, and the project got mislabeled "m1". It must REFUSE instead.
  test("returns null (refuse) when no local checkout exists — never $HOME", async () => {
    const home = "/Users/m1";
    const cwd = await resolveResumeCwd({
      recordedCwd: "/Users/ashot/src/union-mobile/outreach",
      resolveLocalRepo: noRepo,
      remapViaRemote: async () => null,
      // Only the home dir exists here (as on the bare remote Mac).
      exists: (p) => p === home,
    });
    expect(cwd).toBeNull();
  });

  test("ignores a non-existent override and uses the recorded cwd instead", async () => {
    const cwd = await resolveResumeCwd({
      cwdOverride: "/Users/m1/work/stale",
      recordedCwd: "/Users/ashot/src/outreach",
      resolveLocalRepo: noRepo,
      exists: (p) => p === "/Users/ashot/src/outreach",
    });
    expect(cwd).toBe("/Users/ashot/src/outreach");
  });
});
