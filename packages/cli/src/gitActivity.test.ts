import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitActivityTailer, classifyHeadEntry, classifyRemoteEntry, parseReflogLine } from "./gitActivity.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const line = (action: string, message = "") => `${SHA_A} ${SHA_B} Tess Ter <t@t> 1788700000 -0400\t${action}${message ? `: ${message}` : ""}`;

describe("parseReflogLine and classification", () => {
  test("splits a reflog line into its parts", () => {
    expect(parseReflogLine(line("commit", "fix: the thing"))).toEqual({
      old_sha: SHA_A, new_sha: SHA_B, actor_name: "Tess Ter", actor_email: "t@t", at: 1788700000000, action: "commit", message: "fix: the thing",
    });
    expect(parseReflogLine("garbage")).toBeNull();
  });
  test("names the commands a reader cares about and drops the rest", () => {
    const kinds = (action: string, message = "") => classifyHeadEntry(parseReflogLine(line(action, message))!)?.kind ?? null;
    expect(kinds("commit", "x")).toBe("commit");
    expect(kinds("commit (initial)", "x")).toBe("commit");
    expect(kinds("commit (amend)", "x")).toBe("amend");
    expect(kinds("checkout", "moving from main to feature")).toBe("checkout");
    expect(kinds("merge origin/main", "Fast-forward")).toBe("merge");
    expect(kinds("pull", "Fast-forward")).toBe("pull");
    expect(kinds("pull --rebase origin main", "checkout something")).toBe("pull");
    expect(kinds("rebase (finish)", "returning to refs/heads/feature")).toBe("rebase");
    expect(kinds("rebase (pick)", "x")).toBeNull();
    expect(kinds("reset", "moving to HEAD~1")).toBe("reset");
    expect(kinds("cherry-pick", "x")).toBe("cherry_pick");
    expect(kinds("revert", "Revert x")).toBe("revert");
    expect(kinds("clone", "from git@github.com:a/b")).toBeNull();
  });
  test("a checkout carries both branches; a merge its source; a reset its target", () => {
    expect(classifyHeadEntry(parseReflogLine(line("checkout", "moving from main to feat/x"))!)).toMatchObject({ from_ref: "main", to_ref: "feat/x", ref: "feat/x" });
    expect(classifyHeadEntry(parseReflogLine(line("merge feat/x", "Merge made by the 'ort' strategy."))!)).toMatchObject({ kind: "merge", ref: "feat/x" });
    expect(classifyHeadEntry(parseReflogLine(line("reset", "moving to origin/main"))!)).toMatchObject({ kind: "reset", ref: "origin/main" });
  });
  test("a remote-tracking log counts pushes, not fetches", () => {
    expect(classifyRemoteEntry(parseReflogLine(line("update by push"))!, "main")).toMatchObject({ kind: "push", ref: "main" });
    expect(classifyRemoteEntry(parseReflogLine(line("fetch origin main", "fast-forward"))!, "main")).toBeNull();
  });
});

describe("GitActivityTailer", () => {
  let dir: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=Tess Ter", ...args], { encoding: "utf-8" }).trim();
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitactivity-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test("reports only what happens after it starts, with the commit described", async () => {
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "history before the tailer");

    const tailer = new GitActivityTailer(repo);
    expect(await tailer.init()).toBe(true);
    expect(await tailer.poll()).toEqual([]);

    fs.writeFileSync(path.join(repo, "a.txt"), "a\nb\n");
    git(repo, "commit", "-q", "-am", "second\n\nbody here");
    git(repo, "checkout", "-q", "-b", "feature");
    const events = await tailer.poll();
    expect(events.map((e) => e.kind)).toEqual(["commit", "checkout"]);
    expect(events[0].commit).toMatchObject({ sha: git(repo, "rev-parse", "HEAD"), message: "second\n\nbody here", author_name: "Tess Ter", files_changed: 1, insertions: 1, deletions: 0 });
    expect(events[1]).toMatchObject({ from_ref: "main", to_ref: "feature" });
    // Nothing new: nothing reported.
    expect(await tailer.poll()).toEqual([]);
  });

  test("a push shows up from the remote-tracking log", async () => {
    const remote = path.join(dir, "remote.git");
    const repo = path.join(dir, "repo");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "first");
    git(repo, "remote", "add", "origin", remote);
    const tailer = new GitActivityTailer(repo);
    await tailer.init();
    git(repo, "push", "-q", "-u", "origin", "main");
    const kinds = (await tailer.poll()).map((e) => `${e.kind}:${e.ref ?? ""}`);
    expect(kinds).toEqual(["push:main"]);
  });
});
