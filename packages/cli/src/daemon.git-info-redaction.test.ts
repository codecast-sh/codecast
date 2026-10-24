import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGitInfo } from "./daemon.js";
import { setKnownValuesForTest } from "./knownValueRedaction.js";

// getGitInfo's diff and status go to the server as conversation_git_diffs,
// which team viewers read. A Vault value written into a tracked file
// (`cast vault get x > config.json`) was uploaded there in plain text while
// the same value in a tool result came out redacted.

const VALUE = "zz-vault-value-9f3k2m8q7w";
const dirs: string[] = [];

afterEach(() => {
  setKnownValuesForTest(null);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zz-git-info-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=zz", "-c", "user.email=zz@example.com", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  for (const name of Object.keys(files)) fs.writeFileSync(path.join(dir, name), "placeholder\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

describe("getGitInfo redacts what it uploads", () => {
  test("a known Vault value in a modified tracked file is a marker in the diff and the staged diff", async () => {
    setKnownValuesForTest([{ value: VALUE, name: "x", vault: true }]);
    const dir = repoWith({ "config.json": `{"token":"${VALUE}"}\n`, "staged.txt": `${VALUE}\n` });
    execFileSync("git", ["add", "staged.txt"], { cwd: dir });
    const info = await getGitInfo(dir);
    expect(info?.diff).toContain("[redacted:known:x]");
    expect(info?.diffStaged).toContain("[redacted:known:x]");
    expect(JSON.stringify(info)).not.toContain(VALUE);
  });

  test("a value straddling the diff cap is replaced whole, not cut to a readable prefix", async () => {
    setKnownValuesForTest([{ value: VALUE, name: "x", vault: true }]);
    const dir = repoWith({ "a.txt": "" });
    const write = (pad: number) => fs.writeFileSync(path.join(dir, "a.txt"), `${"p".repeat(pad)}${VALUE}\n`);
    // Find where the value lands in the raw diff, then pad so it starts 5 characters before the 100,000 cut.
    write(99_000);
    const at = execFileSync("git", ["diff"], { cwd: dir, encoding: "utf-8", maxBuffer: 1 << 24 }).indexOf(VALUE);
    write(99_000 + (100_000 - 5 - at));
    const info = await getGitInfo(dir);
    expect(info?.diff?.length).toBeLessThanOrEqual(100_000);
    expect(info?.diff).not.toContain(VALUE.slice(0, 5));
  });
});
