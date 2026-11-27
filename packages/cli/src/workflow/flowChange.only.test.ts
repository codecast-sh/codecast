// `--only` names the files of a session's change. A literal route path such as app/task/[id].tsx, read only as a
// glob, is a character class that matches nothing, and the file fell out of the change with no word (ct-102457).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { recordSessionWrites } from "../land/writeLedger";
import { previewSessionChange } from "./flowChange";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir";
isolateCodecastDirEachTest("cast-flow-only-");

const SESSION = "6f1c2d3e-aaaa-bbbb-cccc-000000000002";
const FILES = ["app/task/[id].tsx", "app/pr/[owner]/[repo]/[number]/page.tsx", "lib/other.ts"];

let root: string;
const git = (...args: string[]) => {
  // Commits are an hour old, so every write the test makes comes after them.
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const r = spawnSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-only-")));
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "export {};\n");
  }
  recordSessionWrites(root, FILES.map((f) => path.join(root, f)), { env: { CLAUDE_CODE_SESSION_ID: SESSION }, now: Date.now() });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("--only", () => {
  test("a path with brackets names that file, not a character class", async () => {
    const change = await previewSessionChange(root, SESSION, ["app/task/[id].tsx", "app/pr/[owner]/[repo]/[number]/page.tsx"], { fetch: false });
    expect(change.paths).toEqual(["app/pr/[owner]/[repo]/[number]/page.tsx", "app/task/[id].tsx"]);
    expect(change.unmatched).toEqual([]);
  });

  test("a glob still matches, and an entry that names none of the session's files is said", async () => {
    const change = await previewSessionChange(root, SESSION, ["lib/*.ts", "app/nowhere.tsx"], { fetch: false });
    expect(change.paths).toEqual(["lib/other.ts"]);
    expect(change.unmatched).toEqual(["app/nowhere.tsx"]);
  });
});
