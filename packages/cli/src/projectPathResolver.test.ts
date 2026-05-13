import { describe, test, expect } from "bun:test";
import { resolveLocalProjectPath } from "./projectPathResolver.js";

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
