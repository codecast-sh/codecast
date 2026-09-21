// LOCAL-03. `copyGitignoredFiles` is the older remote push/move path's transfer
// of the files git will not carry: the workspace manifest's setup.copy list.
// That list lives in the repository, so a repo collaborator writes it. It used
// to be joined straight into both the local worktree and the remote one, so
// `../../.aws/credentials` copied a file outside the repository to a directory
// outside the remote worktree.
//
// Driven through the real exported function with real filesystem, real path
// and real manifest resolution; only the process boundary is replaced, so no
// SSH runs and nothing leaves the machine.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { copyGitignoredFiles, type RemoteHost } from "./session-move.js";

// TEST-NET-3, and nothing in this file runs ssh or rsync anyway.
const HOST: RemoteHost = { user: "cast", address: "198.51.100.7", keyPath: "/dev/null", remoteBaseDir: "/home/cast" } as RemoteHost;
const REMOTE = "/home/cast/work/repo";

let dir = "";
let repo = "";
let savedEnv: NodeJS.ProcessEnv;
let scheduled: string[][] = [];
let remoteDirs: string[] = [];
let warnings: string[] = [];

function write(root: string, rel: string, body: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function copy(): string[] {
  return copyGitignoredFiles(HOST, repo, REMOTE, {
    onWarn: (m) => warnings.push(m),
    rsync: (args) => scheduled.push(args),
    mkdirRemote: (d) => remoteDirs.push(d),
  });
}

/** Everything the transfer would have touched: rsync sources and destinations. */
function transferred(): string[] {
  return scheduled.map((args) => `${args[args.length - 2]} -> ${args[args.length - 1]}`);
}

beforeEach(() => {
  savedEnv = { ...process.env };
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "legacy-copy-")));
  repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  // A scratch HOME, or the resolver reads this machine's real git config and
  // walks the real checkout it is running inside.
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.GIT_CONFIG_GLOBAL = path.join(home, ".gitconfig");
  // The manifest resolver enumerates the project through git, so the fixture
  // has to be a real repository for a declared copy list to resolve at all.
  spawnSync("git", ["init", "-q"], { cwd: repo });
  scheduled = [];
  remoteDirs = [];
  warnings = [];
});

afterEach(() => {
  process.env = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("legitimate setup files still transfer", () => {
  test("the .env family copies when the manifest declares nothing", () => {
    write(repo, ".env", "SECRET\n");
    write(repo, ".env.local", "LOCAL\n");
    expect(copy().sort()).toEqual([".env", ".env.local"]);
    expect(transferred()).toContain(`${path.join(repo, ".env")} -> cast@198.51.100.7:${REMOTE}/`);
  });

  test("nested files and whole directories the manifest declares copy", () => {
    write(repo, ".codecast/workspace.toml", '[setup]\ncopy = ["config/local.json", "secrets"]\ninstall = ["true"]\n');
    write(repo, "config/local.json", "{}\n");
    write(repo, "secrets/key", "k\n");
    write(repo, "secrets/deeper/other", "o\n");
    write(repo, "not-listed", "stays\n");
    expect(copy().sort()).toEqual(["config/local.json", "secrets/deeper/other", "secrets/key"]);
    expect(transferred().join("\n")).not.toContain("not-listed");
    // Each lands under its own parent inside the remote worktree.
    expect(transferred()).toContain(`${path.join(repo, "secrets/deeper/other")} -> cast@198.51.100.7:${REMOTE}/secrets/deeper/`);
  });

  test("a declared file that does not exist here is skipped, not an error", () => {
    write(repo, ".codecast/workspace.toml", '[setup]\ncopy = [".env.production"]\n');
    expect(copy()).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("a repository cannot widen the transfer", () => {
  test.each([
    "../outside",
    "/etc/passwd",
    "secrets/../../outside",
    ".git/config",
    "C:\\outside",
    "secrets\\outside",
    "./.env",
  ])("refuses %s and schedules nothing", (rel) => {
    write(dir, "outside", "NOT YOURS\n");
    write(repo, ".codecast/workspace.toml", `[setup]\ncopy = [${JSON.stringify(rel)}]\n`);
    expect(copy()).toEqual([]);
    expect(scheduled).toEqual([]);
    expect(warnings.join("\n")).toContain("unsafe workspace copy path");
  });

  test.each(["file", "parent", "nested"])("refuses a %s symlink escape before any transfer", (kind) => {
    write(dir, "outside/key", "NOT YOURS\n");
    write(repo, ".codecast/workspace.toml", '[setup]\ncopy = ["secrets"]\n');
    if (kind === "nested") {
      fs.mkdirSync(path.join(repo, "secrets"));
      fs.symlinkSync(path.join(dir, "outside/key"), path.join(repo, "secrets/key"));
    } else {
      fs.symlinkSync(path.join(dir, kind === "file" ? "outside/key" : "outside"), path.join(repo, "secrets"));
    }
    expect(copy()).toEqual([]);
    expect(scheduled).toEqual([]);
    expect(warnings.join("\n")).toContain("refuses symlink");
  });

  test("an invalid manifest fails instead of falling back to the .env list", () => {
    write(repo, ".codecast/workspace.toml", '[setup]\ncopy = ["SECRET_VALUE"\n');
    write(repo, ".env", "SECRET_VALUE\n");
    expect(copy()).toEqual([]);
    expect(scheduled).toEqual([]);
    expect(warnings.join("\n")).toContain("invalid workspace manifest");
    // And the manifest's own contents never reach the warning.
    expect(warnings.join("\n")).not.toContain("SECRET_VALUE");
  });

  test("no scheduled source or destination ever leaves its worktree", () => {
    write(dir, "outside", "NOT YOURS\n");
    write(repo, ".codecast/workspace.toml", '[setup]\ncopy = ["a/b/c.env"]\n');
    write(repo, "a/b/c.env", "ok\n");
    copy();
    expect(remoteDirs.every((d) => d.startsWith(`${REMOTE}/`))).toBe(true);
    for (const args of scheduled) {
      expect(args[args.length - 2]!.startsWith(`${fs.realpathSync(repo)}/`)).toBe(true);
      expect(args[args.length - 1]!).toContain(`:${REMOTE}/`);
      expect(args[args.length - 1]!).not.toContain("..");
    }
  });
});
