import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { isOutsideGitRepo } from "./gitRepoProbe";

describe("isOutsideGitRepo", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "repo-probe-"));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: base };

  test("a plain folder is outside, a repo (even with no commits) and a missing folder are not", async () => {
    const plain = path.join(base, "plain");
    const repo = path.join(base, "repo");
    fs.mkdirSync(plain);
    fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo, env });
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = base;
    try {
      expect(await isOutsideGitRepo(plain)).toBe(true);
      expect(await isOutsideGitRepo(repo)).toBe(false);
      expect(await isOutsideGitRepo(path.join(repo, "sub"))).toBe(false);
      expect(await isOutsideGitRepo(path.join(base, "missing"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = saved;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
