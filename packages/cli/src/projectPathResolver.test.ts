import { describe, test, expect } from "bun:test";
import {
  resolveLocalProjectPath,
  resolveResumeCwd,
  pickProjectPath,
  chooseSessionTranscript,
  type TranscriptCandidate,
} from "./projectPathResolver.js";

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

describe("chooseSessionTranscript", () => {
  // The live duplicate observed in pl-79: one session UUID, two .jsonl copies.
  const live: TranscriptCandidate = {
    filePath: "/Users/ashot/.claude/projects/-Users-ashot-src-union-mobile/f0d46305.jsonl",
    projectPath: "/Users/ashot/src/union-mobile",
    projectExists: true, // real local checkout
  };
  const stale: TranscriptCandidate = {
    filePath: "/Users/ashot/.claude/projects/-Users-m1/f0d46305.jsonl",
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
      filePath: "/Users/ashot/.claude/projects/-Users-ashot-src-other/f0d46305.jsonl",
      projectPath: "/Users/ashot/src/other",
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
