import { test, expect, describe } from "bun:test";
import {
  splitDirQuery,
  matchesProjectQuery,
  resolveCustomPath,
  inferProjectBase,
  parentDir,
  commonParentDir,
  isExplicitPath,
  buildProjectPathOptions,
} from "./utils";

const HOME = "/Users/ashot";

describe("matchesProjectQuery", () => {
  const paths = [
    "/Users/ashot/src/codecast",
    "/Users/ashot/src/union-mobile",
    "/Users/ashot/src/footage-app",
  ];
  const matches = (q: string) => paths.filter((p) => matchesProjectQuery(p, q));

  test("empty query matches everything", () => {
    expect(matches("")).toEqual(paths);
    expect(matches("  ")).toEqual(paths);
  });

  test("matches project name prefix, not the shared path prefix", () => {
    // "s" appears in /Users/ashot/src/… on every path — must not match all
    expect(matches("s")).toEqual([]);
    // "a" hits footage-app via its "app" word, but not /Users/ashot on every path
    expect(matches("a")).toEqual(["/Users/ashot/src/footage-app"]);
    expect(matches("co")).toEqual(["/Users/ashot/src/codecast"]);
    expect(matches("u")).toEqual(["/Users/ashot/src/union-mobile"]);
  });

  test("anchored at name start, not mid-word", () => {
    expect(matches("decast")).toEqual([]);
  });

  test("matches word segments within the name", () => {
    expect(matches("mobile")).toEqual(["/Users/ashot/src/union-mobile"]);
    expect(matches("app")).toEqual(["/Users/ashot/src/footage-app"]);
  });

  test("query spanning a separator still matches from name start", () => {
    expect(matches("union-mo")).toEqual(["/Users/ashot/src/union-mobile"]);
  });

  test("case-insensitive", () => {
    expect(matches("CODE")).toEqual(["/Users/ashot/src/codecast"]);
  });

  test("query with slash falls back to full-path substring", () => {
    expect(matches("/Users/ashot/src/codecast")).toEqual(["/Users/ashot/src/codecast"]);
    expect(matches("ashot/src")).toEqual(paths);
  });
});

describe("resolveCustomPath", () => {
  const base = "/Users/ashot/src";

  test("home-relative and absolute paths resolve without a base", () => {
    expect(resolveCustomPath("~/experiments/foo", HOME)).toBe("/Users/ashot/experiments/foo");
    expect(resolveCustomPath("~", HOME)).toBe("/Users/ashot");
    expect(resolveCustomPath("/tmp/scratch", HOME)).toBe("/tmp/scratch");
  });

  test("a bare name resolves against the base (sibling folder)", () => {
    // The gap this fixes: "weekend-hack" used to dead-end at "no match".
    expect(resolveCustomPath("weekend-hack", HOME, base)).toBe("/Users/ashot/src/weekend-hack");
    expect(resolveCustomPath("experiments/foo", HOME, base)).toBe("/Users/ashot/src/experiments/foo");
  });

  test("a bare name without a base stays unresolved (daemon can't cd to it)", () => {
    expect(resolveCustomPath("weekend-hack", HOME)).toBeUndefined();
  });

  test("normalizes doubled and trailing slashes", () => {
    expect(resolveCustomPath("/a//b/", HOME)).toBe("/a/b");
    expect(resolveCustomPath("sub/", HOME, base)).toBe("/Users/ashot/src/sub");
  });

  test("empty input resolves to nothing", () => {
    expect(resolveCustomPath("", HOME, base)).toBeUndefined();
    expect(resolveCustomPath("   ", HOME, base)).toBeUndefined();
  });

  test("~/… needs a known home", () => {
    expect(resolveCustomPath("~/foo", undefined)).toBeUndefined();
  });
});

describe("inferProjectBase", () => {
  test("prefers the parent of the current project (siblings)", () => {
    expect(inferProjectBase("/Users/ashot/src/codecast", ["/Users/ashot/family"], HOME)).toBe("/Users/ashot/src");
  });

  test("with no current project, uses the common parent of recents", () => {
    expect(
      inferProjectBase(undefined, ["/Users/ashot/src/codecast", "/Users/ashot/src/union-mobile"], HOME),
    ).toBe("/Users/ashot/src");
  });

  test("falls back to home when recents don't cluster", () => {
    expect(inferProjectBase(undefined, ["/Users/ashot/a", "/Users/ashot/b"], HOME)).toBe("/Users/ashot");
    expect(inferProjectBase(undefined, [], HOME)).toBe(HOME);
  });
});

describe("parentDir / commonParentDir / isExplicitPath", () => {
  test("parentDir", () => {
    expect(parentDir("/a/b/c")).toBe("/a/b");
    expect(parentDir("/a/b/c/")).toBe("/a/b");
    expect(parentDir("/a")).toBe("/");
  });

  test("commonParentDir returns undefined when only root is shared", () => {
    expect(commonParentDir(["/Users/ashot/src/x", "/opt/y"])).toBeUndefined();
    expect(commonParentDir(["/Users/ashot/src/x", "/Users/ashot/src/y"])).toBe("/Users/ashot/src");
  });

  test("isExplicitPath distinguishes typed paths from bare names", () => {
    expect(isExplicitPath("/abs")).toBe(true);
    expect(isExplicitPath("~/rel")).toBe(true);
    expect(isExplicitPath("weekend-hack")).toBe(false);
    expect(isExplicitPath("a/b")).toBe(false);
  });
});

describe("buildProjectPathOptions", () => {
  const recents = [
    "/Users/ashot/src/codecast",
    "/Users/ashot/src/union-mobile",
    "/Users/ashot/src/footage-app",
  ];
  const base = "/Users/ashot/src";
  const build = (query: string, extra?: { currentPath?: string; defaultLimit?: number }) =>
    buildProjectPathOptions({ query, recentPaths: recents, home: HOME, base, ...extra });

  test("no query lists the first N recents, no custom row", () => {
    expect(build("")).toEqual(recents.map((path) => ({ path })));
    expect(build("", { defaultLimit: 2 })).toEqual(recents.slice(0, 2).map((path) => ({ path })));
  });

  test("a bare name filters recents by project name", () => {
    expect(build("co")).toEqual([{ path: "/Users/ashot/src/codecast" }]);
  });

  test("a bare name with no matches offers it resolved against the base", () => {
    expect(build("weekend-hack")).toEqual([
      { path: "/Users/ashot/src/weekend-hack", custom: true },
    ]);
  });

  test("a bare name that matches recents does NOT offer a custom row", () => {
    // Plain filtering stays clean: "co" means codecast, not ~/src/co.
    expect(build("co").some((o) => o.custom)).toBe(false);
  });

  test("an explicit path always offers its folder alongside matching recents", () => {
    expect(build("~/src/code")).toEqual([
      { path: "/Users/ashot/src/codecast" },
      { path: "/Users/ashot/src/code", custom: true },
    ]);
  });

  test("an explicit path that IS a recent doesn't duplicate it as custom", () => {
    expect(build("~/src/codecast")).toEqual([{ path: "/Users/ashot/src/codecast" }]);
  });

  test("the current path is never offered as a custom row", () => {
    expect(build("~/elsewhere", { currentPath: "/Users/ashot/elsewhere" })).toEqual([]);
  });

  test("an unresolvable query (no home for ~/…) just filters", () => {
    expect(
      buildProjectPathOptions({ query: "~/nope", recentPaths: recents, home: undefined, base: undefined }),
    ).toEqual([]);
  });
});

describe("splitDirQuery", () => {
  const base = "/Users/ashot/src";
  test("a bare name lists the base and matches the name", () => {
    expect(splitDirQuery("co", HOME, base)).toEqual({ dir: base, prefix: "co", hidden: false });
  });
  test("an explicit path lists its parent", () => {
    expect(splitDirQuery("~/src/co", HOME, base)).toEqual({ dir: "/Users/ashot/src", prefix: "co", hidden: false });
    expect(splitDirQuery("/tmp/x", HOME, base)).toEqual({ dir: "/tmp", prefix: "x", hidden: false });
  });
  test("a trailing slash browses INTO the directory", () => {
    expect(splitDirQuery("~/src/", HOME, base)).toEqual({ dir: "/Users/ashot/src", prefix: "", hidden: false });
    expect(splitDirQuery("~/", HOME, base)).toEqual({ dir: HOME, prefix: "", hidden: false });
  });
  test("dot prefixes ask for hidden folders", () => {
    expect(splitDirQuery("~/.con", HOME, base)?.hidden).toBe(true);
  });
  test("with no home yet, a ~ directory is passed through for the daemon to expand", () => {
    expect(splitDirQuery("~/src/co", undefined, undefined)).toEqual({ dir: "~/src", prefix: "co", hidden: false });
    expect(splitDirQuery("~/src/", undefined, undefined)).toEqual({ dir: "~/src", prefix: "", hidden: false });
    expect(splitDirQuery("~/x", undefined, undefined)).toEqual({ dir: "~", prefix: "x", hidden: false });
  });
  test("nothing listable → undefined", () => {
    expect(splitDirQuery("", HOME, base)).toBeUndefined();
    expect(splitDirQuery("bare", HOME, undefined)).toBeUndefined();
  });
});

describe("buildProjectPathOptions with a disk listing", () => {
  const recents = ["/Users/ashot/src/codecast"];
  const base = "/Users/ashot/src";
  const listing = {
    home: HOME,
    path: base,
    exists: true,
    dirs: [
      { name: "codecast", path: "/Users/ashot/src/codecast", repo: true },
      { name: "notes", path: "/Users/ashot/src/notes", repo: false },
      { name: "cobalt", path: "/Users/ashot/src/cobalt", repo: true },
      { name: "claude-code", path: "/Users/ashot/src/claude-code", repo: true },
    ],
  };
  const build = (query: string, extra?: Partial<Parameters<typeof buildProjectPathOptions>[0]>) =>
    buildProjectPathOptions({ query, recentPaths: recents, home: HOME, base, listing, ...extra });

  test("disk folders follow matching recents: prefix matches, then repos, no duplicates", () => {
    expect(build("co")).toEqual([
      { path: "/Users/ashot/src/codecast" },
      { path: "/Users/ashot/src/cobalt", disk: true, repo: true },
      { path: "/Users/ashot/src/claude-code", disk: true, repo: true },
    ]);
    expect(build("~/src/")).toEqual([
      { path: "/Users/ashot/src/codecast" },
      { path: "/Users/ashot/src/claude-code", disk: true, repo: true },
      { path: "/Users/ashot/src/cobalt", disk: true, repo: true },
      { path: "/Users/ashot/src/notes", disk: true, repo: false },
      { path: "/Users/ashot/src", custom: true },
    ]);
  });

  test("a folder the listing proves absent is offered as create", () => {
    expect(build("weekend-hack")).toEqual([{ path: "/Users/ashot/src/weekend-hack", custom: true, create: true }]);
    expect(build("~/src/weekend-hack")).toEqual([{ path: "/Users/ashot/src/weekend-hack", custom: true, create: true }]);
  });

  test("an explicit path that exists on disk is the disk row, not a custom row", () => {
    expect(build("~/src/notes")).toEqual([{ path: "/Users/ashot/src/notes", disk: true, repo: false }]);
  });

  test("a listing for another directory is ignored (stale keystroke)", () => {
    expect(build("/tmp/x")).toEqual([{ path: "/tmp/x", custom: true }]);
  });

  test("under a directory that doesn't exist, the row is create", () => {
    const missing = { home: HOME, path: "/Users/ashot/new", exists: false, dirs: [] };
    expect(build("~/new/thing", { listing: missing })).toEqual([{ path: "/Users/ashot/new/thing", custom: true, create: true }]);
  });

  test("the current folder is never re-offered from disk", () => {
    expect(build("~/src/", { currentPath: "/Users/ashot/src/notes" }).some((o) => o.path.endsWith("/notes"))).toBe(false);
  });
});
