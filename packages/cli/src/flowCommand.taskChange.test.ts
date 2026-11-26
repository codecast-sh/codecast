// `cast flow run <flow> --task ct-N` from inside a session (ct-98626): a task
// with no branch here takes the session's own edits and the run binds to that
// task, rather than refusing or binding a new task that loses the original's
// description and requester. A task an earlier run left a branch for runs on it,
// unless the calling session still holds edits here: then its edits are frozen
// onto that branch again, so the ones it made since that run go in.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { taskChange } from "./flowRunSubject";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-task-change-")));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf-8" });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(root, "a.txt"), "a\n");
git("add", "-A");
git("commit", "-qm", "base");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const none = async () => false;
const some = async () => true;

describe("taskChange", () => {
  test("a task with no branch here takes the calling session's own edits", async () => {
    expect(await taskChange(root, "change-ct-7", "ct-7", "jx7abcd", none)).toEqual({ session: "jx7abcd" });
  });

  test("with no branch and no calling session there is nothing to run on", async () => {
    expect(await taskChange(root, "change-ct-7", "ct-7", undefined, none)).toBeNull();
  });

  test("a branch an earlier run of the task left is the change when the session holds no edits here, as is a line's", async () => {
    git("branch", "codecast/change-ct-8");
    expect(await taskChange(root, "change-ct-8", "ct-8", "jx7abcd", none)).toEqual({ branch: "codecast/change-ct-8" });
    git("branch", "line-ct-9");
    expect(await taskChange(root, "change-ct-9", "ct-9", "jx7abcd", none)).toEqual({ branch: "line-ct-9" });
  });

  test("a session still holding edits here freezes them onto the branch its earlier run left; a line's branch stays the change", async () => {
    git("branch", "codecast/change-ct-10");
    expect(await taskChange(root, "change-ct-10", "ct-10", "jx7abcd", some)).toEqual({ session: "jx7abcd" });
    // Run from outside the session, the branch is the change.
    expect(await taskChange(root, "change-ct-10", "ct-10", undefined, some)).toEqual({ branch: "codecast/change-ct-10" });
    git("branch", "line-ct-11");
    expect(await taskChange(root, "change-ct-11", "ct-11", "jx7abcd", some)).toEqual({ branch: "line-ct-11" });
  });
});
