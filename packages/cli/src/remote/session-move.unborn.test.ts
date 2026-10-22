import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitIgnoredPatterns, isWorktree } from "./session-move.js";

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unborn-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".cache/\n.env\n*.mp4\n");
  fs.mkdirSync(path.join(dir, ".cache"));
  fs.writeFileSync(path.join(dir, ".cache", "blob"), "x");
  fs.writeFileSync(path.join(dir, ".env"), "K=1");
  fs.writeFileSync(path.join(dir, "clip [1].mp4"), "x");
  fs.writeFileSync(path.join(dir, "main.py"), "print(1)");
  return dir;
}

describe("a repository with no commit yet", () => {
  test("moves as a folder, not by git transport", () => {
    const dir = repo();
    expect(isWorktree(dir)).toBe(false);
    execFileSync("git", ["-C", dir, "add", "main.py"]);
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first"]);
    expect(isWorktree(dir)).toBe(true);
  });

  test("keeps what git ignores out of the transfer, anchored and escaped", () => {
    const patterns = gitIgnoredPatterns(repo()).sort();
    expect(patterns).toEqual(["/.cache/", "/.env", "/clip \\[1].mp4"]);
  });

  test("outside a repository nothing is excluded", () => {
    expect(gitIgnoredPatterns(fs.mkdtempSync(path.join(os.tmpdir(), "plain-")))).toEqual([]);
  });
});

describe("facts a host script reports", () => {
  test("are read by name, so a banner line or zsh's empty `echo -` cannot shift them", async () => {
    const { parseHostFacts } = await import("./session-move.js");
    const out = "Last login: today\n@cast-fact:snap=abc\n@cast-fact:branch=main\n@cast-fact:tip=\n@cast-fact:landed=\n";
    expect(parseHostFacts(out, ["snap", "branch", "tip", "landed"])).toEqual({ snap: "abc", branch: "main", tip: "", landed: "" });
  });
  test("a fact the host never printed is an error, not a guess", async () => {
    const { parseHostFacts } = await import("./session-move.js");
    expect(() => parseHostFacts("@cast-fact:snap=abc\n", ["snap", "landed"])).toThrow("did not report landed");
  });
});
