import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { lineRunsRoot } from "./runDirs";

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rundirs-")));
  execFileSync("git", ["init", "-q", dir]);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("lineRunsRoot", () => {
  test("a checkout's root and any folder in it keep their runs under the repository's own .git", () => {
    const sub = path.join(dir, "outreach");
    fs.mkdirSync(sub);
    expect(lineRunsRoot(dir)).toBe(path.join(dir, ".git", "cast-line"));
    expect(lineRunsRoot(sub)).toBe(path.join(dir, ".git", "cast-line"));
  });

  test("a bare .git a Claude Code session left in a subfolder is not the repository's", () => {
    const sub = path.join(dir, "outreach");
    fs.mkdirSync(path.join(sub, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(sub, ".git", "info", "exclude"), "# claude-code-runtime\n");
    expect(lineRunsRoot(sub)).toBe(path.join(dir, ".git", "cast-line"));
  });
});
