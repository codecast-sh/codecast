import { describe, test, expect } from "bun:test";
import {
  conventionSeed,
  resolveLocalProjectPath,
  resolveLocalRepoPath,
  resolveResumeCwd,
  isResumableCwd,
  pickProjectPath,
  claudeProjectDirName,
  chooseSessionTranscript,
  type TranscriptCandidate,
} from "./projectPathResolver.js";

const remote = "git@github.com:acme-mobile/server.git";

describe("claudeProjectDirName", () => {
  // These expectations are NOT arbitrary: each was produced by running Claude
  // 2.1.196 in the named cwd and reading the dir it created under
  // ~/.claude/projects. The slug MUST match byte-for-byte or `claude --resume`
  // can't find the JSONL we write and crashes with "No conversation found".
  test("replaces dots with dashes (the bug: dotted cwd landed in a dir Claude never reads)", () => {
    // A dot becomes "-"; combined with the leading slash's "-" it doubles up.
    expect(claudeProjectDirName("/Users/dev/.claude")).toBe("-Users-dev--claude");
  });

  test("encodes a .claude/worktrees path like Claude does (cast ws / orchestrate)", () => {
    expect(
      claudeProjectDirName("/Users/dev/src/acme-mobile/server/.claude/worktrees/agent-a5c06b4"),
    ).toBe("-Users-dev-src-acme-mobile-server--claude-worktrees-agent-a5c06b4");
  });

  test("underscores also become dashes; hyphens are preserved", () => {
    expect(claudeProjectDirName("probe_x.y-z")).toBe("probe-x-y-z");
  });

  test("a plain repo path (no dots) is unchanged except slashes", () => {
    expect(claudeProjectDirName("/Users/dev/src/codecast")).toBe("-Users-dev-src-codecast");
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
    // bot ran in /Users/ec2-user/src/acme-mobile/server/packages/x; locally
    // the user has the repo at ~/src/server
    const result = await resolveLocalProjectPath({
      projectPath: "/Users/ec2-user/src/acme-mobile/server/packages/x",
      gitRoot: "/Users/ec2-user/src/acme-mobile/server",
      gitRemoteUrl: remote,
      findCandidates: async () => ["/Users/dev/src/server"],
      exists: (p) => p === "/Users/dev/src/server" || p === "/Users/dev/src/server/packages/x",
    });
    expect(result?.remapped).toBe(true);
    expect(result?.path).toBe("/Users/dev/src/server/packages/x");
  });

  test("prefers the primary checkout over a more recently used worktree", async () => {
    // A role seat pulled from a cloud host once landed in another session's
    // worktree (912 commits behind, with its uncommitted edits) because that
    // worktree was the most recent git_root recorded for the remote.
    const worktree = "/Users/ashot/src/union-mobile-ct91614/.codecast/worktrees/union-mobile";
    const primary = "/Users/ashot/src/union-mobile";
    const result = await resolveLocalProjectPath({
      projectPath: "/home/ubuntu/work/union-mobile",
      gitRoot: "/home/ubuntu/work/union-mobile",
      gitRemoteUrl: remote,
      findCandidates: async () => [worktree, "/Users/ashot/src/um-linked", primary],
      exists: (p) => p === worktree || p === primary || p === "/Users/ashot/src/um-linked",
      isWorktree: (p) => p !== primary,
    });
    expect(result?.path).toBe(primary);
  });

  test("uses a worktree when it is the only checkout", async () => {
    const worktree = "/Users/ashot/src/repo/.codecast/worktrees/x";
    const result = await resolveLocalProjectPath({
      projectPath: "/home/ubuntu/work/repo",
      gitRoot: "/home/ubuntu/work/repo",
      gitRemoteUrl: remote,
      findCandidates: async () => [worktree],
      exists: (p) => p === worktree,
    });
    expect(result?.path).toBe(worktree);
  });

  test("falls back to repo root when the subpath is missing in the local checkout", async () => {
    const result = await resolveLocalProjectPath({
      projectPath: "/Users/ec2-user/src/server/packages/missing",
      gitRoot: "/Users/ec2-user/src/server",
      gitRemoteUrl: remote,
      findCandidates: async () => ["/Users/dev/src/server"],
      exists: (p) => p === "/Users/dev/src/server",
    });
    expect(result?.remapped).toBe(true);
    expect(result?.path).toBe("/Users/dev/src/server");
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
      projectPath: "/Users/ec2-user/src/server",
      gitRoot: "/Users/ec2-user/src/server",
      gitRemoteUrl: remote,
      findCandidates: async () => ["/Users/other/checkout"],
      exists: () => false,
    });
    expect(result).toBeNull();
  });

  test("skips candidate roots that don't exist on disk", async () => {
    const result = await resolveLocalProjectPath({
      projectPath: "/Users/ec2-user/src/server",
      gitRoot: "/Users/ec2-user/src/server",
      gitRemoteUrl: remote,
      findCandidates: async () => ["/stale", "/Users/dev/src/server"],
      exists: (p) => p === "/Users/dev/src/server",
    });
    expect(result?.path).toBe("/Users/dev/src/server");
  });

  test("picks the first usable candidate (most-recently-used wins)", async () => {
    const result = await resolveLocalProjectPath({
      projectPath: "/Users/ec2-user/src/server",
      gitRoot: "/Users/ec2-user/src/server",
      gitRemoteUrl: remote,
      findCandidates: async () => ["/Users/dev/src/server", "/Users/dev/.conductor/feat-x"],
      // Recorded ec2 path doesn't exist locally; both candidates do.
      exists: (p) => p !== "/Users/ec2-user/src/server",
    });
    expect(result?.path).toBe("/Users/dev/src/server");
  });
});

describe("resolveLocalRepoPath", () => {
  const HOME = "/Users/dev";

  // THE WORKTREE BUG: an orchestrate/cast-ws worktree under <repo>/.claude/worktrees/<id>
  // was destroyed, so its recorded cwd is gone. The old walk hit the ".claude"
  // segment and resolved it to $HOME/.claude (always exists) → resume ran in the
  // wrong dir and crashed via the slug mismatch. The session belongs to the
  // PARENT repo, which is still on disk.
  test("destroyed .claude/worktrees path resolves to the parent repo, not $HOME/.claude", () => {
    const local = new Set(["/Users/dev/src/acme-mobile/server"]);
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/dev/src/acme-mobile/server/.claude/worktrees/agent-a5c06b4",
        home: HOME,
        exists: (p) => local.has(p),
      }),
    ).toBe("/Users/dev/src/acme-mobile/server");
  });

  test("destroyed .codecast/worktrees path resolves to the parent repo", () => {
    const local = new Set(["/Users/dev/src/codecast"]);
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/dev/src/codecast/.codecast/worktrees/fix-auth",
        home: HOME,
        exists: (p) => local.has(p),
      }),
    ).toBe("/Users/dev/src/codecast");
  });

  test("does NOT resolve a bare ~/.claude path to $HOME (home is never a project)", () => {
    // worktreeParent would be $HOME here; the home guard must reject it so the
    // walk (and ultimately a refusal) takes over instead.
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/dev/.claude/projects/gone",
        home: HOME,
        exists: (p) => p === "/Users/dev",
      }),
    ).toBeNull();
  });

  test("recorded path unchanged when it exists locally", () => {
    expect(
      resolveLocalRepoPath({ remotePath: "/Users/dev/src/codecast", home: HOME, exists: (p) => p === "/Users/dev/src/codecast" }),
    ).toBe("/Users/dev/src/codecast");
  });

  // THE BUG: a brand-new session seeded from another machine's SUBDIR path. The
  // leaf ("cli") names no local repo, so the old leaf-only resolver refused and
  // stamped "clone it first". Walking up finds "codecast" → ~/src/codecast and
  // re-appends packages/cli.
  test("walks up a foreign subdir path to the repo ancestor and re-appends the subpath", () => {
    const local = new Set(["/Users/dev/src/codecast", "/Users/dev/src/codecast/packages/cli"]);
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/m1/work/codecast/packages/cli",
        home: HOME,
        exists: (p) => local.has(p),
      }),
    ).toBe("/Users/dev/src/codecast/packages/cli");
  });

  test("non-leaf match without the subpath keeps walking — no generic-ancestor false positive", () => {
    // A coincidental ~/src/work exists but isn't the repo; the subpath under it
    // doesn't exist, so we must NOT return it. "codecast" resolves instead.
    const local = new Set(["/Users/dev/src/work", "/Users/dev/src/codecast"]);
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/m1/work/codecast/sub",
        home: HOME,
        exists: (p) => local.has(p),
      }),
    ).toBe("/Users/dev/src/codecast"); // subpath "sub" missing → repo root, not ~/src/work
  });

  test("leaf-only foreign path (no subdir) resolves to the local repo root", () => {
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/ec2-user/work/codecast",
        home: HOME,
        exists: (p) => p === "/Users/dev/src/codecast",
      }),
    ).toBe("/Users/dev/src/codecast");
  });

  test("explicit user mapping (full path) wins over convention", () => {
    expect(
      resolveLocalRepoPath({
        remotePath: "/Users/m1/work/codecast/packages/cli",
        home: HOME,
        userMap: { "/Users/m1/work/codecast/packages/cli": "/Users/dev/elsewhere/cli" },
        exists: (p) => p === "/Users/dev/elsewhere/cli",
      }),
    ).toBe("/Users/dev/elsewhere/cli");
  });

  test("learns the basename → repo mapping on a convention hit", () => {
    const learned: Array<[string, string]> = [];
    resolveLocalRepoPath({
      remotePath: "/Users/m1/work/codecast/packages/cli",
      home: HOME,
      exists: (p) => p === "/Users/dev/src/codecast" || p === "/Users/dev/src/codecast/packages/cli",
      onLearn: (name, local) => learned.push([name, local]),
    });
    expect(learned).toContainEqual(["codecast", "/Users/dev/src/codecast"]);
  });

  test("returns null when no ancestor maps to a local repo", () => {
    expect(
      resolveLocalRepoPath({ remotePath: "/Users/m1/work/nope/deep", home: HOME, exists: () => false }),
    ).toBeNull();
  });
});

describe("resolveResumeCwd", () => {
  const noRepo = () => null;

  // jx74yqy (2026-10-23): a role's standing session recorded in /Users/dev
  // was moved to a Linux box whose home is /home/cam. No repo, no remote, so
  // every rule refused and the resume died in silence. A bare home directory
  // has an equivalent everywhere: this machine's home.
  test("a foreign bare home directory resolves to this machine's home", async () => {
    for (const recorded of ["/Users/dev", "/home/ubuntu", "/root"]) {
      const cwd = await resolveResumeCwd({
        recordedCwd: recorded,
        home: "/home/cam",
        resolveLocalRepo: noRepo,
        remapViaRemote: async () => null,
        exists: (p) => p === "/home/cam",
      });
      expect(cwd).toBe("/home/cam");
    }
  });

  test("a foreign folder inside a home is still refused, never placed in $HOME", async () => {
    const cwd = await resolveResumeCwd({
      recordedCwd: "/Users/dev/notes",
      home: "/home/cam",
      resolveLocalRepo: noRepo,
      remapViaRemote: async () => null,
      exists: (p) => p === "/home/cam",
    });
    expect(cwd).toBeNull();
  });

  test("an existing override wins (remote-move worktree path)", async () => {
    const cwd = await resolveResumeCwd({
      cwdOverride: "/Users/m1/work/server",
      recordedCwd: "/Users/dev/src/acme-mobile/server",
      resolveLocalRepo: noRepo,
      exists: (p) => p === "/Users/m1/work/server",
    });
    expect(cwd).toBe("/Users/m1/work/server");
  });

  test("uses the recorded cwd when it exists locally (the common local resume)", async () => {
    const cwd = await resolveResumeCwd({
      recordedCwd: "/Users/dev/src/acme-mobile/server",
      resolveLocalRepo: noRepo,
      exists: (p) => p === "/Users/dev/src/acme-mobile/server",
    });
    expect(cwd).toBe("/Users/dev/src/acme-mobile/server");
  });

  test("falls back to the local-repo map when the recorded cwd is foreign", async () => {
    const cwd = await resolveResumeCwd({
      recordedCwd: "/Users/ec2-user/src/server",
      resolveLocalRepo: (p) => (p === "/Users/ec2-user/src/server" ? "/Users/dev/src/server" : null),
      exists: (p) => p === "/Users/dev/src/server",
    });
    expect(cwd).toBe("/Users/dev/src/server");
  });

  test("falls back to a git-remote remap when nothing else resolves", async () => {
    const cwd = await resolveResumeCwd({
      recordedCwd: "/Users/ec2-user/src/server",
      resolveLocalRepo: noRepo,
      remapViaRemote: async () => "/Users/dev/src/server",
      exists: (p) => p === "/Users/dev/src/server",
    });
    expect(cwd).toBe("/Users/dev/src/server");
  });

  // The regression: the remote Mac receives a resume for a session recorded at a
  // path it has no checkout of. Old code fell back to $HOME (/Users/m1), ran the
  // agent there, and the project got mislabeled "m1". It must REFUSE instead.
  test("returns null (refuse) when no local checkout exists — never $HOME", async () => {
    const home = "/Users/m1";
    const cwd = await resolveResumeCwd({
      recordedCwd: "/Users/dev/src/acme-mobile/server",
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
      recordedCwd: "/Users/dev/src/server",
      resolveLocalRepo: noRepo,
      exists: (p) => p === "/Users/dev/src/server",
    });
    expect(cwd).toBe("/Users/dev/src/server");
  });

  // The recorded git root seeds the convention resolver (conventionSeed), so the
  // repo is looked up by ITS name rather than by whatever leaf the cwd ends in,
  // and the in-repo subpath is put back afterwards — the start_session placement.
  describe("recordedRoot seed", () => {
    const root = "/Users/dev/src/codecast";
    const local = "/home/ubuntu/work/codecast";
    const byRoot = (p: string) => (p === root ? local : null);

    test("resolves the root by convention and keeps the subpath when it exists locally", async () => {
      const cwd = await resolveResumeCwd({
        recordedCwd: `${root}/packages/cli`,
        recordedRoot: root,
        resolveLocalRepo: byRoot,
        exists: (p) => p === local || p === `${local}/packages/cli`,
      });
      expect(cwd).toBe(`${local}/packages/cli`);
    });

    test("falls back to the local root when the subpath is absent there", async () => {
      const cwd = await resolveResumeCwd({
        recordedCwd: `${root}/packages/gone`,
        recordedRoot: root,
        resolveLocalRepo: byRoot,
        exists: (p) => p === local,
      });
      expect(cwd).toBe(local);
    });

    test("a root the cwd does not live under is ignored (a root stamped off another conversation)", async () => {
      const seen: string[] = [];
      const cwd = await resolveResumeCwd({
        recordedCwd: "/Users/ec2-user/src/server",
        recordedRoot: root,
        resolveLocalRepo: (p) => { seen.push(p); return null; },
        remapViaRemote: async () => null,
        exists: () => false,
      });
      expect(cwd).toBeNull();
      expect(seen).toEqual(["/Users/ec2-user/src/server"]);
    });
  });
});

describe("pickProjectPath", () => {
  const HOME = "/Users/m1";

  test("normal session: real non-$HOME slug dir wins", () => {
    // The everyday case — slug decodes to the same dir the session ran in.
    expect(pickProjectPath({
      decodedSlugPath: "/Users/dev/src/server",
      recordedCwd: "/Users/dev/src/server",
      home: HOME,
      exists: (p) => p === "/Users/dev/src/server",
    })).toBe("/Users/dev/src/server");
  });

  test("cross-machine fork: real local slug dir wins over a foreign recorded cwd", () => {
    // Fork lives under a real local project dir; its transcript still carries the
    // original author's (foreign, non-local) cwd. The local dir must win.
    expect(pickProjectPath({
      decodedSlugPath: "/Users/dev/src/server",
      recordedCwd: "/Users/ec2-user/src/server",
      home: HOME,
      exists: (p) => p === "/Users/dev/src/server",
    })).toBe("/Users/dev/src/server");
  });

  test("THE BUG: a transcript parked in the bare $HOME dir is relabeled to its real cwd", () => {
    // Remote-offloaded session: an old resume fell back to $HOME, so the JSONL sits
    // under ~/.claude/projects/-Users-m1/ → slug decodes to /Users/m1 (which exists,
    // it's the home dir). Without the fix this returns "/Users/m1" → label "m1".
    expect(pickProjectPath({
      decodedSlugPath: HOME,
      recordedCwd: "/Users/dev/src/acme-mobile/server",
      home: HOME,
      exists: (p) => p === HOME, // home dir exists; the real project does not (foreign machine)
    })).toBe("/Users/dev/src/acme-mobile/server");
  });

  test("foreign slug that doesn't exist locally falls back to the recorded cwd", () => {
    expect(pickProjectPath({
      decodedSlugPath: "/Users/dev/src/acme-mobile/server",
      recordedCwd: "/Users/dev/src/acme-mobile/server",
      home: HOME,
      exists: () => false, // nothing exists on this (remote) machine
    })).toBe("/Users/dev/src/acme-mobile/server");
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

describe("chooseSessionTranscript", () => {
  // The live duplicate observed in pl-79: one session UUID, two .jsonl copies.
  const live: TranscriptCandidate = {
    filePath: "/Users/dev/.claude/projects/-Users-dev-src-acme-mobile/f0d46305.jsonl",
    projectPath: "/Users/dev/src/acme-mobile",
    projectExists: true, // real local checkout
  };
  const stale: TranscriptCandidate = {
    filePath: "/Users/dev/.claude/projects/-Users-m1/f0d46305.jsonl",
    projectPath: "/Users/m1",
    projectExists: false, // resume artifact: /Users/m1 doesn't exist locally
  };

  test("first transcript for a UUID always syncs", () => {
    const choice = chooseSessionTranscript(live, undefined);
    expect(choice.action).toBe("sync");
  });

  test("the same file re-firing is not treated as a duplicate", () => {
    const choice = chooseSessionTranscript(live, live);
    expect(choice.action).toBe("sync");
  });

  test("skips the stale resume artifact when a real-checkout copy is canonical", () => {
    // live registered first (newer mtime); stale m1 copy arrives second.
    const choice = chooseSessionTranscript(stale, live);
    expect(choice.action).toBe("skip");
    if (choice.action === "skip") {
      expect(choice.canonicalFilePath).toBe(live.filePath);
    }
  });

  test("promotes the real-checkout copy over an artifact registered first", () => {
    // Ordering flip: the m1 artifact changed first and registered as canonical;
    // the live copy then arrives and must win, superseding the artifact's sync.
    const choice = chooseSessionTranscript(live, stale);
    expect(choice.action).toBe("sync");
    if (choice.action === "sync") {
      expect(choice.supersededFilePath).toBe(stale.filePath);
    }
  });

  test("keeps both when both copies live in real checkouts (no clear artifact)", () => {
    const other: TranscriptCandidate = {
      filePath: "/Users/dev/.claude/projects/-Users-dev-src-other/f0d46305.jsonl",
      projectPath: "/Users/dev/src/other",
      projectExists: true,
    };
    const choice = chooseSessionTranscript(other, live);
    expect(choice.action).toBe("sync");
    if (choice.action === "sync") {
      expect(choice.supersededFilePath).toBeUndefined();
    }
  });

  test("keeps both when neither copy resolves to a real dir (never drop blindly)", () => {
    const stale2: TranscriptCandidate = { ...stale, filePath: "/x/-Users-other/f0d46305.jsonl", projectPath: "/Users/other" };
    const choice = chooseSessionTranscript(stale2, stale);
    expect(choice.action).toBe("sync");
    if (choice.action === "sync") {
      expect(choice.supersededFilePath).toBeUndefined();
    }
  });
});

// THE WRONG-REPO LAUNCH BUG: a task-comment session carried the task's foreign
// project_path plus a git_root stamped from the viewer's UNRELATED open
// conversation (~/src/conv). The start_session fallback seeded the convention
// resolver with git_root, which existed locally, so it won verbatim and the
// session launched in ~/src/conv instead of the task's repo.
describe("conventionSeed", () => {
  const RAW = "/Users/ec2-user/src/acme-mobile/server";

  test("ignores a recorded root the requested path does not live under", () => {
    expect(conventionSeed(RAW, "/Users/dev/src/conv")).toBe(RAW);
  });

  test("uses the recorded root when the path lives under it", () => {
    expect(conventionSeed(RAW, "/Users/ec2-user/src/acme-mobile")).toBe("/Users/ec2-user/src/acme-mobile");
    expect(conventionSeed(RAW, RAW)).toBe(RAW);
  });

  test("prefix match is per path segment, not per character", () => {
    expect(conventionSeed("/Users/dev/src/conv-other", "/Users/dev/src/conv")).toBe("/Users/dev/src/conv-other");
  });

  test("no recorded root falls through to the requested path", () => {
    expect(conventionSeed(RAW, null)).toBe(RAW);
    expect(conventionSeed(RAW, undefined)).toBe(RAW);
  });

  test("end-to-end: mismatched root no longer hijacks resolution; the real path resolves by learned map", () => {
    const local = new Set(["/Users/dev/src/conv", "/Users/dev/src/acme-mobile", "/Users/dev/src/acme-mobile/server"]);
    const resolve = (seed: string) =>
      resolveLocalRepoPath({
        remotePath: seed,
        home: "/Users/dev",
        learnedMap: { server: "/Users/dev/src/acme-mobile/server" },
        exists: (p) => local.has(p),
      });
    // Old behavior: seeding with the unrelated-but-existing git_root returned it verbatim.
    expect(resolve("/Users/dev/src/conv")).toBe("/Users/dev/src/conv");
    // Guarded behavior: the foreign task path seeds the walk and lands in the task's repo.
    expect(resolve(conventionSeed(RAW, "/Users/dev/src/conv"))).toBe("/Users/dev/src/acme-mobile/server");
  });
});

describe("isResumableCwd / root is never a resume cwd", () => {
  test("the filesystem root is refused even though it exists everywhere", () => {
    expect(isResumableCwd("/")).toBe(false);
    expect(isResumableCwd(" / ")).toBe(false);
    expect(isResumableCwd("")).toBe(false);
    expect(isResumableCwd(undefined)).toBe(false);
    expect(isResumableCwd("/Users/dev/src/codecast")).toBe(true);
  });

  test("a rollout regenerated under the daemon (cwd `/`) does not resume in `/`", async () => {
    // 2026-09-05: repair wrote session_meta.cwd="/" and the resume took it
    // because `/` exists, landing every delivery in Codex's directory picker.
    const cwd = await resolveResumeCwd({
      recordedCwd: "/",
      resolveLocalRepo: () => null,
      remapViaRemote: async () => "/Users/dev/src/codecast",
      exists: () => true,
    });
    expect(cwd).toBe("/Users/dev/src/codecast");
  });

  test("a root override is ignored the same way", async () => {
    const cwd = await resolveResumeCwd({
      cwdOverride: "/",
      recordedCwd: "/Users/dev/src/codecast",
      resolveLocalRepo: () => null,
      exists: () => true,
    });
    expect(cwd).toBe("/Users/dev/src/codecast");
  });
});
