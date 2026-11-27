// A session's change carries the checkout's unpushed commits (flowChange.ts cutChange), and says so: the change names
// each one with its writer, the dry run and pull request list them, and a brief whose failures fall only in their
// files says they are another session's (ct-102477, PR #311).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { recordSessionWrites } from "../land/writeLedger";
import { freezeSessionChange, previewSessionChange } from "./flowChange";
import { carriedFailureNote, unpushedBody, unpushedCommits, unpushedLines } from "./unpushedCommits";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir";
isolateCodecastDirEachTest("cast-unpushed-");

const SESSION = "6f1c2d3e-aaaa-bbbb-cccc-000000000003";
let dir: string;
let root: string;
const run = (cwd: string, ...args: string[]) => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "unpushed-")));
  const seed = path.join(dir, "seed");
  fs.mkdirSync(seed);
  run(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "README.md"), "x\n");
  run(seed, "add", "-A");
  run(seed, "commit", "-q", "-m", "base");
  run(dir, "clone", "-q", "--bare", seed, "origin.git");
  run(dir, "clone", "-q", path.join(dir, "origin.git"), "work");
  root = path.join(dir, "work");
  // Another session's commit, never pushed: the change is built on it.
  write("editor/a.ts", "export const a = 1;\n");
  write("editor/b.ts", "export const b = 1;\n");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "Code editor", "-m", "Codecast-Session: https://codecast.sh/conversation/jx7d599abcdefghij");
  write("src/fix.test.ts", "test\n");
  recordSessionWrites(root, [path.join(root, "src/fix.test.ts")], { env: { CLAUDE_CODE_SESSION_ID: SESSION }, now: Date.now() });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the checkout's unpushed commits", () => {
  test("are read with their subject, the session their trailer names, and their files", async () => {
    const got = await unpushedCommits(root, "HEAD", "origin/main");
    expect(got.map(({ sha: _, ...c }) => c)).toEqual([{ subject: "Code editor", session: "jx7d599", files: ["editor/a.ts", "editor/b.ts"] }]);
    expect(await unpushedCommits(root, "HEAD", "HEAD")).toEqual([]);
  });

  test("the preview and the frozen change name them, and the branch carries them", async () => {
    const preview = await previewSessionChange(root, SESSION, null, { fetch: false });
    expect(preview.paths).toEqual(["src/fix.test.ts"]);
    expect(preview.unpushed.map((c) => c.subject)).toEqual(["Code editor"]);
    const change = await freezeSessionChange(root, SESSION, { branch: "codecast/change-ct-1", worktree: "change-ct-1", fetched: true });
    expect(change.unpushed?.map((c) => [c.subject, c.session, c.files.length])).toEqual([["Code editor", "jx7d599", 2]]);
    expect(run(root, "log", "--format=%s", "origin/main..codecast/change-ct-1").split("\n")).toContain("Code editor");
    const lines = unpushedLines(change.unpushed);
    expect(lines[0]).toBe("also carries 1 unpushed commit of the checkout's that upstream lacks, which ship with this change:");
    expect(lines[1]).toMatch(/^ {2}[0-9a-f]{9} Code editor \(session jx7d599, 2 files\)$/);
    expect(unpushedBody(change.unpushed)).toMatch(/^This change also carries 1 commit the checkout it was made in had not pushed\. They ship with it:\n- `[0-9a-f]{9}` Code editor \(session jx7d599, 2 files\)$/);
  });

  test("a checkout with nothing unpushed names none", async () => {
    run(root, "push", "-q", "origin", "HEAD:main");
    run(root, "fetch", "-q", "origin");
    const change = await freezeSessionChange(root, SESSION, { branch: "codecast/change-ct-2", worktree: "change-ct-2", fetched: true });
    expect(change.unpushed).toBeUndefined();
    expect(unpushedLines(change.unpushed)).toEqual([]);
    expect(unpushedBody(change.unpushed)).toBe("");
  });
});

describe("a brief's failures in carried files", () => {
  const change = { paths: ["src/fix.test.ts"], unpushed: [{ sha: "4cf50f18b0000000", subject: "Code editor", session: "jx7d599", files: ["editor/a.ts", "editor/b.ts", "src/fix.test.ts"] }] };

  test("only there: says they are not this session's edits and names the commit and session", () => {
    const note = carriedFailureNote(change, "test-cli fail\n  editor/a.ts:12:3 error: expected 1, received 2");
    expect(note).toBe("The failing files named here are not this session's edits: they are in commits the change carries from the checkout, editor/a.ts (commit 4cf50f18b, session jx7d599). Those are that session's to fix; say so in your reply rather than change them.");
  });

  test("beside the change's own: names only the carried ones", () => {
    const note = carriedFailureNote(change, "error in editor/b.ts\nerror in src/fix.test.ts");
    expect(note).toBe("Some failing files are not this session's edits but in commits the change carries from the checkout: editor/b.ts (commit 4cf50f18b, session jx7d599).");
  });

  test("none there, or nothing carried: says nothing", () => {
    expect(carriedFailureNote(change, "error in src/fix.test.ts")).toBe("");
    expect(carriedFailureNote({ paths: ["src/fix.test.ts"] }, "error in editor/a.ts")).toBe("");
  });
});
