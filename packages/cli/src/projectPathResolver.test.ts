import { describe, test, expect } from "bun:test";
import { resolveLocalProjectPath, resolveLocalRepoPath, resolveResumeCwd, pickProjectPath, claudeProjectDirName } from "./projectPathResolver.js";

const remote = "git@github.com:union-mobile/outreach.git";

describe("claudeProjectDirName", () => {
  // These expectations are NOT arbitrary: each was produced by running Claude
  // 2.1.196 in the named cwd and reading the dir it created under
  // ~/.claude/projects. The slug MUST match byte-for-byte or `claude --resume`
  // can't find the JSONL we write and crashes with "No conversation found".
  test("replaces dots with dashes (the bug: dotted cwd landed in a dir Claude never reads)", () => {
    // A dot becomes "-"; combined with the leading slash's "-" it doubles up.
    expect(claudeProjectDirName("/Users/ashot/.claude")).toBe("-Users-ashot--claude");
  });

  test("encodes a .claude/worktrees path like Claude does (cast ws / orchestrate)", () => {
    expect(
      claudeProjectDirName("/Users/ashot/src/union-mobile/outreach/.claude/worktrees/agent-a5c06b4"),
    ).toBe("-Users-ashot-src-union-mobile-outreach--claude-worktrees-agent-a5c06b4");
  });

  test("underscores also become dashes; hyphens are preserved", () => {
    expect(claudeProjectDirName("probe_x.y-z")).toBe("probe-x-y-z");
  });

  test("a plain repo path (no dots) is unchanged except slashes", () => {
    expect(claudeProjectDirName("/Users/ashot/src/codecast")).toBe("-Users-ashot-src-codecast");
  });
});

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

describe("resolveLocalRepoPath", () => {
  const HOME = "/Users/ashot";

  // THE WORKTREE BUG: an orchestrate/cast-ws worktree under <repo>/.claude/worktrees/<id>
  // was destroyed, so its recorded cwd is gone. The old walk hit the ".claude"
  // segment and resolved it to $HOME/.claude (always exists) → resume ran in the
  // wrong dir and crashed via the slug mismatch. The session belongs to the
  // PARENT repo, which is still on disk.
  test("destroyed .claude/worktrees path resolves to the parent repo, not $HOME/.claude", () => {
    const local = new Set(["/Users/ashot/src/union-mobile/outreach"]);
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/ashot/src/union-mobile/outreach/.claude/worktrees/agent-a5c06b4",
        home: HOME,
        exists: (p) => local.has(p),
      }),
    ).toBe("/Users/ashot/src/union-mobile/outreach");
  });

  test("destroyed .codecast/worktrees path resolves to the parent repo", () => {
    const local = new Set(["/Users/ashot/src/codecast"]);
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/ashot/src/codecast/.codecast/worktrees/fix-auth",
        home: HOME,
        exists: (p) => local.has(p),
      }),
    ).toBe("/Users/ashot/src/codecast");
  });

  test("does NOT resolve a bare ~/.claude path to $HOME (home is never a project)", () => {
    // worktreeParent would be $HOME here; the home guard must reject it so the
    // walk (and ultimately a refusal) takes over instead.
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/ashot/.claude/projects/gone",
        home: HOME,
        exists: (p) => p === "/Users/ashot",
      }),
    ).toBeNull();
  });

  test("recorded path unchanged when it exists locally", () => {
    expect(
      resolveLocalRepoPath({ remotePath: "/Users/ashot/src/codecast", home: HOME, exists: (p) => p === "/Users/ashot/src/codecast" }),
    ).toBe("/Users/ashot/src/codecast");
  });

  // THE BUG: a brand-new session seeded from another machine's SUBDIR path. The
  // leaf ("cli") names no local repo, so the old leaf-only resolver refused and
  // stamped "clone it first". Walking up finds "codecast" → ~/src/codecast and
  // re-appends packages/cli.
  test("walks up a foreign subdir path to the repo ancestor and re-appends the subpath", () => {
    const local = new Set(["/Users/ashot/src/codecast", "/Users/ashot/src/codecast/packages/cli"]);
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/m1/work/codecast/packages/cli",
        home: HOME,
        exists: (p) => local.has(p),
      }),
    ).toBe("/Users/ashot/src/codecast/packages/cli");
  });

  test("non-leaf match without the subpath keeps walking — no generic-ancestor false positive", () => {
    // A coincidental ~/src/work exists but isn't the repo; the subpath under it
    // doesn't exist, so we must NOT return it. "codecast" resolves instead.
    const local = new Set(["/Users/ashot/src/work", "/Users/ashot/src/codecast"]);
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/m1/work/codecast/sub",
        home: HOME,
        exists: (p) => local.has(p),
      }),
    ).toBe("/Users/ashot/src/codecast"); // subpath "sub" missing → repo root, not ~/src/work
  });

  test("leaf-only foreign path (no subdir) resolves to the local repo root", () => {
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/ec2-user/work/codecast",
        home: HOME,
        exists: (p) => p === "/Users/ashot/src/codecast",
      }),
    ).toBe("/Users/ashot/src/codecast");
  });

  test("explicit user mapping (full path) wins over convention", () => {
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/m1/work/codecast/packages/cli",
        home: HOME,
        userMap: { "/Users/m1/work/codecast/packages/cli": "/Users/ashot/elsewhere/cli" },
        exists: (p) => p === "/Users/ashot/elsewhere/cli",
      }),
    ).toBe("/Users/ashot/elsewhere/cli");
  });

  test("learns the basename → repo mapping on a convention hit", () => {
    const learned: Array<[string, string]> = [];
    resolveLocalRepoPath({
      remotePath: "/Users/m1/work/codecast/packages/cli",
      home: HOME,
      exists: (p) => p === "/Users/ashot/src/codecast" || p === "/Users/ashot/src/codecast/packages/cli",
      onLearn: (name, local) => learned.push([name, local]),
    });
    expect(learned).toContainEqual(["codecast", "/Users/ashot/src/codecast"]);
  });

  test("returns null when no ancestor maps to a local repo", () => {
    expect(
      resolveLocalRepoPath({ remotePath: "/Users/m1/work/nope/deep", home: HOME, exists: () => false }),
    ).toBeNull();
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

describe("pickProjectPath", () => {
  const HOME = "/Users/m1";

  test("normal session: real non-$HOME slug dir wins", () => {
    // The everyday case — slug decodes to the same dir the session ran in.
    expect(pickProjectPath({
      decodedSlugPath: "/Users/ashot/src/outreach",
      recordedCwd: "/Users/ashot/src/outreach",
      home: HOME,
      exists: (p) => p === "/Users/ashot/src/outreach",
    })).toBe("/Users/ashot/src/outreach");
  });

  test("cross-machine fork: real local slug dir wins over a foreign recorded cwd", () => {
    // Fork lives under a real local project dir; its transcript still carries the
    // original author's (foreign, non-local) cwd. The local dir must win.
    expect(pickProjectPath({
      decodedSlugPath: "/Users/ashot/src/outreach",
      recordedCwd: "/Users/ec2-user/src/outreach",
      home: HOME,
      exists: (p) => p === "/Users/ashot/src/outreach",
    })).toBe("/Users/ashot/src/outreach");
  });

  test("THE BUG: a transcript parked in the bare $HOME dir is relabeled to its real cwd", () => {
    // Remote-offloaded session: an old resume fell back to $HOME, so the JSONL sits
    // under ~/.claude/projects/-Users-m1/ → slug decodes to /Users/m1 (which exists,
    // it's the home dir). Without the fix this returns "/Users/m1" → label "m1".
    expect(pickProjectPath({
      decodedSlugPath: HOME,
      recordedCwd: "/Users/ashot/src/union-mobile/outreach",
      home: HOME,
      exists: (p) => p === HOME, // home dir exists; the real project does not (foreign machine)
    })).toBe("/Users/ashot/src/union-mobile/outreach");
  });

  test("foreign slug that doesn't exist locally falls back to the recorded cwd", () => {
    expect(pickProjectPath({
      decodedSlugPath: "/Users/ashot/src/union-mobile/outreach",
      recordedCwd: "/Users/ashot/src/union-mobile/outreach",
      home: HOME,
      exists: () => false, // nothing exists on this (remote) machine
    })).toBe("/Users/ashot/src/union-mobile/outreach");
  });

  test("$HOME slug with no recorded cwd falls back to the decoded slug (last resort)", () => {
    // A genuinely home-dir-run session (rare) or a cwd-less transcript: don't drop it.
    expect(pickProjectPath({
      decodedSlugPath: HOME,
      recordedCwd: null,
      home: HOME,
      exists: (p) => p === HOME,
    })).toBe(HOME);
  });
});
