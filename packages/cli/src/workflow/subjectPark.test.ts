import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { notLiveYet } from "./subjectPark";

// Whether a landed change is live, as a parked subject asks it: a target the change's files touch only through what
// its `unless` exempts (tests) is not waited on. The server's row says what each target exempts, the checkout's
// deploy.toml when the row holds nothing (an older server). Synthetic repository and server only.
describe("notLiveYet reads what each target exempts", () => {
  test("a change of only a target's tests is live without it; a shipped file waits on it", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "subject-park-"));
    const git = (...args: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf-8" }).stdout.trim();
    try {
      git("init", "-q", "-b", "main");
      git("remote", "add", "origin", "https://github.com/acme/app.git");
      fs.mkdirSync(path.join(repo, ".codecast"));
      fs.writeFileSync(path.join(repo, ".codecast/deploy.toml"), '[[target]]\nname = "cli"\nwhen = ["cli/**"]\nunless = ["**/*.test.ts"]\nrun = "cut.sh"\npolicy = "release"\n');
      fs.writeFileSync(path.join(repo, "README.md"), "app\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const sha = git("rev-parse", "HEAD");
      // The server's row holds no `unless` (an older publish): the checkout's file supplies it.
      const call = async () => ({ targets: [{ name: "cli", paths: ["cli/**"], live: null }] });
      expect(await notLiveYet(repo, { sha, files: ["cli/src/a.test.ts"] }, call)).toBeNull();
      expect(await notLiveYet(repo, { sha, files: ["cli/src/a.test.ts", "cli/src/a.ts"] }, call)).toBe("its change is not live yet on cli");
      // A row that holds `unless` speaks for itself, as the server's reach reads it.
      const published = async () => ({ targets: [{ name: "cli", paths: ["cli/**"], unless: ["**/*.spec.ts"], live: null }] });
      expect(await notLiveYet(repo, { sha, files: ["cli/src/a.spec.ts"] }, published)).toBeNull();
      expect(await notLiveYet(repo, { sha, files: ["cli/src/a.test.ts"] }, published)).toBe("its change is not live yet on cli");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
