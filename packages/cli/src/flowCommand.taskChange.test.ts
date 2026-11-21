// `cast flow run <flow> --task ct-N` from inside a session (ct-98626): a task
// with no branch here takes the session's own edits and the run binds to that
// task, rather than refusing or binding a new task that loses the original's
// description and requester. A task an earlier run left a branch for runs on it.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { taskChange } from "./flowCommand";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-task-change-")));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf-8" });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(root, "a.txt"), "a\n");
git("add", "-A");
git("commit", "-qm", "base");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("taskChange", () => {
  test("a task with no branch here takes the calling session's own edits", () => {
    expect(taskChange(root, "change-ct-7", "ct-7", "jx7abcd")).toEqual({ session: "jx7abcd" });
  });

  test("with no branch and no calling session there is nothing to run on", () => {
    expect(taskChange(root, "change-ct-7", "ct-7", undefined)).toBeNull();
  });

  test("a branch an earlier run of the task left wins over the session's edits, as does a line's", () => {
    git("branch", "codecast/change-ct-8");
    expect(taskChange(root, "change-ct-8", "ct-8", "jx7abcd")).toEqual({ branch: "codecast/change-ct-8" });
    git("branch", "line-ct-9");
    expect(taskChange(root, "change-ct-9", "ct-9", "jx7abcd")).toEqual({ branch: "line-ct-9" });
  });
});
