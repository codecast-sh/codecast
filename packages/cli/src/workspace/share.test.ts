import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectProject } from "./detect.js";
import {
  linkSharedDirectories,
  resolveSharedDirectories,
  safeShareName,
  unlinkSharedDirectories,
} from "./share.js";

let primary: string;
let worktree: string;
let codecastDir: string | undefined;

beforeEach(() => {
  primary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-share-main-")));
  worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-share-wt-")));
  codecastDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = path.join(primary, "host-state");
  execSync("git init -q -b main", { cwd: primary });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: primary });
  fs.writeFileSync(path.join(primary, ".gitignore"), "node_modules/\n.venv\n");
  execSync("git add . && git commit -q -m init", { cwd: primary });
});

afterEach(() => {
  fs.rmSync(primary, { recursive: true, force: true });
  fs.rmSync(worktree, { recursive: true, force: true });
  if (codecastDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = codecastDir;
});

function mkdirIn(root: string, rel: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

describe("resolveSharedDirectories", () => {
  test("keeps gitignored directories that exist and drops everything else", () => {
    mkdirIn(primary, "node_modules");
    mkdirIn(primary, "vendor"); // exists, but not gitignored
    fs.writeFileSync(path.join(primary, ".venv"), "a file, not a directory");

    expect(
      resolveSharedDirectories(primary, ["node_modules", ".venv", "vendor", "missing"]),
    ).toEqual(["node_modules"]);
  });

  test("a repo git cannot read shares nothing", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ws-share-nogit-"));
    try {
      mkdirIn(bare, "node_modules");
      expect(resolveSharedDirectories(bare, ["node_modules"])).toEqual([]);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  test("refuses a path that leaves the checkout", () => {
    expect(safeShareName("../secrets")).toBeNull();
    expect(safeShareName("/etc")).toBeNull();
    expect(safeShareName("C:node_modules")).toBeNull();
    expect(safeShareName("node_modules")).toBe("node_modules");
  });

  test("refuses a directory holding workspace links back into the repo", () => {
    // The shape a package manager writes for a monorepo: a link out of
    // node_modules into the checkout's own source.
    mkdirIn(primary, "packages/shared");
    mkdirIn(primary, "node_modules/@scope");
    fs.symlinkSync("../../packages/shared", path.join(primary, "node_modules/@scope/shared"));

    expect(resolveSharedDirectories(primary, ["node_modules"])).toEqual([]);
  });

  test("tolerates links that stay inside the shared directory", () => {
    // `.bin` entries point at siblings; sharing them is harmless.
    mkdirIn(primary, "node_modules/.bin");
    mkdirIn(primary, "node_modules/pkg");
    fs.symlinkSync("../pkg/cli.js", path.join(primary, "node_modules/.bin/pkg"));

    expect(resolveSharedDirectories(primary, ["node_modules"])).toEqual(["node_modules"]);
  });
});

describe("detectProject share list", () => {
  test("offers a gitignored node_modules and nothing tracked", () => {
    mkdirIn(primary, "node_modules");
    mkdirIn(primary, "vendor");
    fs.writeFileSync(path.join(primary, "package.json"), "{}");

    expect(detectProject(primary).setup.share).toEqual(["node_modules"]);
  });

  test("offers nothing when the workspace-link trap is present", () => {
    mkdirIn(primary, "packages/web");
    mkdirIn(primary, "node_modules/@scope");
    fs.symlinkSync("../../packages/web", path.join(primary, "node_modules/@scope/web"));

    expect(detectProject(primary).setup.share).toEqual([]);
  });
});

describe("linkSharedDirectories", () => {
  test("links the primary's directory into the worktree", () => {
    mkdirIn(primary, "node_modules/pkg");
    fs.writeFileSync(path.join(primary, "node_modules/pkg/index.js"), "module.exports = 1;\n");

    expect(linkSharedDirectories(primary, worktree, ["node_modules"])).toEqual(["node_modules"]);
    const link = path.join(worktree, "node_modules");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(path.join(primary, "node_modules"));
    expect(fs.readFileSync(path.join(link, "pkg/index.js"), "utf-8")).toContain("module.exports");
  });

  test("leaves a directory the worktree already has alone", () => {
    mkdirIn(primary, "node_modules");
    const own = mkdirIn(worktree, "node_modules");
    fs.writeFileSync(path.join(own, "marker"), "mine");

    expect(linkSharedDirectories(primary, worktree, ["node_modules"])).toEqual([]);
    expect(fs.lstatSync(own).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(own, "marker"), "utf-8")).toBe("mine");
  });
});

describe("unlinkSharedDirectories", () => {
  test("removes the link and leaves what it pointed at", () => {
    mkdirIn(primary, "node_modules/pkg");
    linkSharedDirectories(primary, worktree, ["node_modules"]);

    expect(unlinkSharedDirectories(worktree, ["node_modules"])).toEqual(["node_modules"]);
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(primary, "node_modules/pkg"))).toBe(true);
  });

  test("a manifest written before setup.share existed is not an error", () => {
    const legacy = undefined as unknown as string[];
    expect(resolveSharedDirectories(primary, legacy)).toEqual([]);
    expect(linkSharedDirectories(primary, worktree, legacy)).toEqual([]);
    expect(unlinkSharedDirectories(worktree, legacy)).toEqual([]);
  });

  test("never removes a real directory that shares the name", () => {
    const own = mkdirIn(worktree, "node_modules");
    expect(unlinkSharedDirectories(worktree, ["node_modules", "../escape"])).toEqual([]);
    expect(fs.existsSync(own)).toBe(true);
  });

  test("takes the configured list, which is what git still reports as untracked", () => {
    // The primary's `node_modules/` rule matches its real directory but not the
    // worktree's symlink, so git calls the link untracked — and `git worktree
    // remove` refuses a worktree with untracked files.
    execSync(`git worktree add -q ${JSON.stringify(worktree)} -b shared-branch`, { cwd: primary });
    mkdirIn(primary, "node_modules");
    linkSharedDirectories(primary, worktree, ["node_modules"]);
    const dirty = execSync("git status --porcelain", { cwd: worktree, encoding: "utf-8" });
    expect(dirty).toContain("node_modules");

    unlinkSharedDirectories(worktree, ["node_modules"]);
    expect(execSync("git status --porcelain", { cwd: worktree, encoding: "utf-8" }).trim()).toBe("");
    execSync(`git worktree remove ${JSON.stringify(worktree)}`, { cwd: primary });
    expect(fs.existsSync(worktree)).toBe(false);
    fs.mkdirSync(worktree, { recursive: true });
  });
});

describe("a shared node_modules keeps bun test inside the worktree", () => {
  test("discovers the worktree's own tests and resolves through the link", () => {
    // The trap this guards: a shared node_modules that reaches back into the
    // primary checkout makes a worktree run against two trees at once.
    const pkg = mkdirIn(primary, "node_modules/dep");
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "dep", main: "index.js" }));
    fs.writeFileSync(path.join(pkg, "index.js"), "module.exports = 'from-shared-install';\n");
    // A test file inside the dependency: discovery must not descend into it.
    fs.writeFileSync(
      path.join(pkg, "vendored.test.js"),
      "import { test } from 'bun:test';\ntest('vendored', () => { throw new Error('discovered a dependency test'); });\n",
    );

    linkSharedDirectories(primary, worktree, ["node_modules"]);
    fs.writeFileSync(
      path.join(worktree, "own.test.js"),
      "import { test, expect } from 'bun:test';\n" +
        "import dep from 'dep';\n" +
        "test('own', () => { expect(dep).toBe('from-shared-install'); });\n",
    );

    const run = Bun.spawnSync(["bun", "test"], { cwd: worktree, env: process.env });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    // One file, one test: the runner stayed in the worktree and never walked
    // the link into the shared install.
    expect(output).toContain("Ran 1 test across 1 file");
    expect(output).not.toContain("vendored");
    expect(run.exitCode).toBe(0);
  });
});
