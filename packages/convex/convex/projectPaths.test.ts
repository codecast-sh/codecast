import { describe, expect, test } from "bun:test";
import { conversationProjectRoot, foldCheckoutsByRepository, normalizeProjectPath, pathWithinLocalRoots, pickInheritedGitMeta, projectContainingPath } from "./projectPaths";

describe("normalizeProjectPath", () => {
  // Regression: a session whose cwd fell back to $HOME (e.g. a remote/resume
  // path that couldn't resolve the real project) records git_root="/Users/m1".
  // That phantom must never become a "recent project" chip.
  test("drops bare home directories and shallower paths", () => {
    expect(normalizeProjectPath("/Users/m1")).toBeNull();
    expect(normalizeProjectPath("/Users/ashot")).toBeNull();
    expect(normalizeProjectPath("/home/ubuntu")).toBeNull();
    expect(normalizeProjectPath("/Users")).toBeNull();
    expect(normalizeProjectPath("/home")).toBeNull();
    expect(normalizeProjectPath("/root")).toBeNull();
    expect(normalizeProjectPath("/")).toBeNull();
  });

  test("keeps real project roots", () => {
    expect(normalizeProjectPath("/Users/ashot/src/codecast")).toBe("/Users/ashot/src/codecast");
    expect(normalizeProjectPath("/home/ubuntu/repos/api")).toBe("/home/ubuntu/repos/api");
    expect(normalizeProjectPath("/Users/ashot/Desktop/scratch")).toBe("/Users/ashot/Desktop/scratch");
  });

  test("trims to the repo dir below a recognized code parent", () => {
    expect(normalizeProjectPath("/Users/ashot/src/codecast/packages/web")).toBe("/Users/ashot/src/codecast");
    expect(normalizeProjectPath("/Users/ashot/projects/foo/bar")).toBe("/Users/ashot/projects/foo");
  });

  test("strips worktree suffixes", () => {
    expect(normalizeProjectPath("/Users/ashot/src/codecast/.conductor/feat-x")).toBe("/Users/ashot/src/codecast");
    expect(normalizeProjectPath("/Users/ashot/src/codecast/.codecast/worktrees/wt1")).toBe("/Users/ashot/src/codecast");
  });

  test("drops temp dirs (incl. macOS /private/var/folders)", () => {
    expect(normalizeProjectPath("/tmp/whatever")).toBeNull();
    expect(normalizeProjectPath("/private/tmp/x")).toBeNull();
    expect(normalizeProjectPath("/var/folders/sr/t5/T/cc-inject-clear-1")).toBeNull();
    expect(normalizeProjectPath("/private/var/folders/sr/t5/T/cc-inject-clear-1")).toBeNull();
  });
});

describe("conversationProjectRoot", () => {
  // Regression: repos moved to ~/code/work.noindex/GitHub/<repo>, and trimming
  // to one level below "code" turned every one of them into a single chip for
  // ~/code/work.noindex, which is not a checkout.
  test("a git_root is the checkout, however deep below a code parent", () => {
    const root = "/Users/a/code/work.noindex/GitHub/littlebird";
    expect(conversationProjectRoot({ git_root: root })).toBe(root);
    expect(conversationProjectRoot({ git_root: root, project_path: `${root}/apps/web` })).toBe(root);
    expect(conversationProjectRoot({ git_root: `${root}/` })).toBe(root);
  });

  test("a bare cwd is still trimmed, since it may be anywhere inside a repo", () => {
    expect(conversationProjectRoot({ project_path: "/Users/a/src/app/packages/web" })).toBe("/Users/a/src/app");
    expect(conversationProjectRoot({ git_root: "", project_path: "/Users/a/src/app/packages/web" })).toBe("/Users/a/src/app");
  });

  test("a managed worktree's git_root is its repository's checkout", () => {
    const root = "/Users/a/code/work/GitHub/app";
    expect(conversationProjectRoot({ git_root: `${root}/.codecast/worktrees/wt1` })).toBe(root);
    expect(conversationProjectRoot({ git_root: `${root}/.claude/worktrees/wt1` })).toBe(root);
    expect(conversationProjectRoot({ git_root: `${root}/.conductor/wt1` })).toBe(root);
  });

  test("phantoms stay out, and a phantom git_root does not fall back to the cwd", () => {
    expect(conversationProjectRoot({ git_root: "/Users/a", project_path: "/Users/a/src/app" })).toBeNull();
    expect(conversationProjectRoot({ git_root: "/private/tmp/x" })).toBeNull();
    expect(conversationProjectRoot({ git_root: "/Users/a/.claude/worktrees/wt1" })).toBeNull();
    expect(conversationProjectRoot({})).toBeNull();
  });
});

describe("foldCheckoutsByRepository", () => {
  const tally = (path: string, count: number, repository?: string, lastActive = 100) => ({ path, count, lastActive, repository });
  const GH = "/Users/a/code/work/GitHub";

  test("worktrees of one repo become one entry with all their sessions", () => {
    const folded = foldCheckoutsByRepository([
      tally(`${GH}/lb-feature`, 40, "acme/littlebird", 500),
      tally(`${GH}/littlebird`, 2, "acme/littlebird", 100),
      tally("/Users/a/code/work/lb2/wt-1", 8, "acme/littlebird", 300),
    ]);
    expect(folded).toEqual([tally(`${GH}/littlebird`, 50, "acme/littlebird", 500)]);
  });

  test("with no checkout named after the repo, the most used one stands for it", () => {
    expect(foldCheckoutsByRepository([
      tally(`${GH}/app-a`, 2, "acme/app"),
      tally(`${GH}/app-b`, 9, "acme/app"),
    ])).toEqual([tally(`${GH}/app-b`, 11, "acme/app")]);
  });

  test("the repo name matches whatever the case", () => {
    expect(foldCheckoutsByRepository([
      tally(`${GH}/wt`, 9, "acme/littlebird"),
      tally(`${GH}/LittleBird`, 1, "acme/littlebird"),
    ])[0].path).toBe(`${GH}/LittleBird`);
  });

  test("a worktree under a dot folder never stands for the repo by borrowing its name", () => {
    expect(foldCheckoutsByRepository([
      tally("/Users/a/.codex/worktrees/abc/app", 50, "acme/app"),
      tally(`${GH}/app-main`, 1, "acme/app"),
    ])[0].path).toBe("/Users/a/.codex/worktrees/abc/app");
    expect(foldCheckoutsByRepository([
      tally("/Users/a/.codex/worktrees/abc/app", 50, "acme/app"),
      tally(`${GH}/app`, 1, "acme/app"),
    ])[0].path).toBe(`${GH}/app`);
  });

  test("plain folders and other repositories stay separate", () => {
    const rows = [tally("/Users/a/notes", 3), tally("/Users/a/draft", 1), tally(`${GH}/one`, 2, "acme/one"), tally(`${GH}/two`, 2, "acme/two")];
    expect(foldCheckoutsByRepository(rows)).toEqual(rows);
  });

  test("the same repo in two home directories keeps a path for each machine", () => {
    expect(foldCheckoutsByRepository([
      tally("/Users/a/src/app", 3, "acme/app"),
      tally("/Users/m1/work/app", 2, "acme/app"),
    ]).map((p) => p.path)).toEqual(["/Users/a/src/app", "/Users/m1/work/app"]);
  });
});

describe("pathWithinLocalRoots", () => {
  test("accepts a project nested below a reported project parent", () => {
    expect(pathWithinLocalRoots(
      "/Users/samvit/dev/union/union-mobile",
      ["/Users/samvit/dev/union"],
    )).toBe(true);
  });

  test("does not confuse sibling path prefixes", () => {
    expect(pathWithinLocalRoots(
      "/Users/samvit/dev/union-mobile-old",
      ["/Users/samvit/dev/union-mobile"],
    )).toBe(false);
  });
});

describe("pickInheritedGitMeta", () => {
  // Regression: a "New Session" off a task whose path was last recorded on
  // another machine (/Users/ec2-user/...) used to inherit the path with NO
  // git_remote_url, so the local daemon couldn't remap it to the local checkout
  // and flashed "clone it first". The remote must be recovered from the task's
  // source conversations, where a daemon stamped it.
  test("recovers the remote + repo root from a foreign source conversation", () => {
    expect(
      pickInheritedGitMeta([
        {
          git_remote_url: "git@github.com:ashot/union-mobile.git",
          git_root: "/Users/ec2-user/src/union-mobile",
          updated_at: 1000,
        },
      ]),
    ).toEqual({
      git_remote_url: "git@github.com:ashot/union-mobile.git",
      git_root: "/Users/ec2-user/src/union-mobile",
    });
  });

  test("picks the most-recently-active source that has a remote", () => {
    expect(
      pickInheritedGitMeta([
        { git_remote_url: "git@github.com:ashot/old.git", git_root: "/a", updated_at: 10 },
        { git_remote_url: "git@github.com:ashot/new.git", git_root: "/b", updated_at: 99 },
        { git_remote_url: "git@github.com:ashot/mid.git", git_root: "/c", updated_at: 50 },
      ]),
    ).toEqual({ git_remote_url: "git@github.com:ashot/new.git", git_root: "/b" });
  });

  test("skips sources with no remote and falls back to started_at", () => {
    expect(
      pickInheritedGitMeta([
        { git_root: "/no-remote", updated_at: 999 },
        { git_remote_url: "git@github.com:ashot/real.git", git_root: "/real", started_at: 5 },
      ]),
    ).toEqual({ git_remote_url: "git@github.com:ashot/real.git", git_root: "/real" });
  });

  test("returns nulls when no source carries a remote", () => {
    expect(pickInheritedGitMeta([])).toEqual({ git_remote_url: null, git_root: null });
    expect(
      pickInheritedGitMeta([{ git_root: "/x", updated_at: 1 }, { git_remote_url: null, git_root: "/y" }]),
    ).toEqual({ git_remote_url: null, git_root: null });
  });
});

describe("projectContainingPath", () => {
  const p = (title: string, project_path?: string, isDefault?: boolean) => ({ title, project_path, ...(isDefault ? { line_profile: { default: true } } : {}) });

  test("the deepest path holding the directory wins; a sibling prefix does not hold it", () => {
    const rows = [p("Repo", "/src/repo"), p("Web", "/src/repo/packages/web/"), p("Other", "/src/repo-two"), p("None")];
    expect(projectContainingPath(rows, "/src/repo/packages/web/app")?.title).toBe("Web");
    expect(projectContainingPath(rows, "/src/repo")?.title).toBe("Repo");
    expect(projectContainingPath(rows, "/src/repo-twofold")).toBeNull();
    expect(projectContainingPath(rows, undefined)).toBeNull();
  });

  test("projects sharing the path are told apart by the profile default, else none", () => {
    expect(projectContainingPath([p("Product", "/src/cc", true), p("Sync", "/src/cc")], "/src/cc/x")?.title).toBe("Product");
    expect(projectContainingPath([p("Product", "/src/cc"), p("Sync", "/src/cc")], "/src/cc/x")).toBeNull();
  });
});
