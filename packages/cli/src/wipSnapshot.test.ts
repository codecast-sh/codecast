import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSnapshotMessage,
  createWipSnapshot,
  defaultRemote,
  parseSnapshotTrailer,
  remoteSnapshotScript,
  applySnapshotFastForward,
  isPermanentPushFailure,
  pushWipSnapshot,
  restoreWipSnapshot,
  wipRef,
} from "./wipSnapshot.js";

// Real git repos, not mocks: this module is git plumbing, and the properties that
// matter (a temp index leaves the real one alone, .gitignore excludes secrets,
// untracked files travel) are behaviors OF git. A mock would only assert that I
// can restate my own assumptions.

const tmps: string[] = [];
function tmpdir(name: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `wipsnap-${name}-`));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) {
    try { fs.rmSync(tmps.pop()!, { recursive: true, force: true }); } catch {}
  }
});

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

/** A repo with a commit, a gitignored secret, and a remote to push to. */
function repo(): { cwd: string; remote: string } {
  const cwd = tmpdir("src");
  const remote = tmpdir("remote") + "/origin.git";
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "t@t.t"]);
  git(cwd, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "v1\n");
  fs.writeFileSync(path.join(cwd, ".env"), "SECRET=leak\n");
  git(cwd, ["add", ".gitignore", "tracked.txt"]);
  git(cwd, ["commit", "-qm", "base"]);
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  return { cwd, remote: "origin" };
}

describe("createWipSnapshot", () => {
  test("is invisible to the source: branch, HEAD, index and status are untouched", async () => {
    const { cwd } = repo();
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "dirty\n");
    fs.writeFileSync(path.join(cwd, "new.txt"), "untracked\n");
    // A staged-but-uncommitted change is the sharpest case: a shared index would
    // corrupt it.
    fs.writeFileSync(path.join(cwd, "staged.txt"), "staged\n");
    git(cwd, ["add", "staged.txt"]);

    const before = {
      branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      head: git(cwd, ["rev-parse", "HEAD"]),
      status: git(cwd, ["status", "--porcelain"]),
      index: git(cwd, ["diff", "--cached", "--name-only"]),
    };

    const snap = (await createWipSnapshot(cwd))!;
    expect(snap).not.toBeNull();

    expect(git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(before.branch);
    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(git(cwd, ["status", "--porcelain"])).toBe(before.status);
    expect(git(cwd, ["diff", "--cached", "--name-only"])).toBe(before.index);
  });

  test("the snapshot's parent is the real HEAD", async () => {
    const { cwd } = repo();
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "dirty\n");
    const snap = (await createWipSnapshot(cwd))!;
    expect(snap.base).toBe(git(cwd, ["rev-parse", "HEAD"]));
    expect(git(cwd, ["rev-parse", `${snap.sha}^`])).toBe(snap.base);
  });

  test("captures uncommitted edits AND untracked files", async () => {
    const { cwd } = repo();
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "edited\n");
    fs.writeFileSync(path.join(cwd, "new.txt"), "brand new\n");
    const snap = (await createWipSnapshot(cwd))!;
    const files = git(cwd, ["ls-tree", "-r", "--name-only", snap.sha]).split("\n");
    expect(files).toContain("tracked.txt");
    expect(files).toContain("new.txt");
    expect(git(cwd, ["show", `${snap.sha}:tracked.txt`])).toBe("edited");
    expect(snap.dirty).toBe(true);
  });

  test("a gitignored secret NEVER enters the snapshot", async () => {
    const { cwd } = repo();
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "dirty\n");
    const snap = (await createWipSnapshot(cwd))!;
    const files = git(cwd, ["ls-tree", "-r", "--name-only", snap.sha]).split("\n");
    expect(files).not.toContain(".env");
    // The file is really there on disk — it's git that refuses it, not a filter.
    expect(fs.existsSync(path.join(cwd, ".env"))).toBe(true);
  });

  test("a clean tree still snapshots (the branch and unpushed commits must travel)", async () => {
    const { cwd } = repo();
    const snap = (await createWipSnapshot(cwd))!;
    expect(snap.dirty).toBe(false);
    expect(snap.base).toBe(git(cwd, ["rev-parse", "HEAD"]));
    // Same tree as HEAD: nothing to reapply, but the ref still names the branch.
    expect(snap.tree).toBe(git(cwd, ["rev-parse", "HEAD^{tree}"]));
  });

  test("records the branch it was taken on", async () => {
    const { cwd } = repo();
    git(cwd, ["checkout", "-q", "-b", "feature/x"]);
    const snap = (await createWipSnapshot(cwd))!;
    expect(snap.branch).toBe("feature/x");
    const msg = git(cwd, ["show", "-s", "--format=%B", snap.sha]);
    expect(parseSnapshotTrailer(msg, "codecast-branch")).toBe("feature/x");
  });

  test("returns null outside a repo and in a repo with no commits", async () => {
    expect(await createWipSnapshot(tmpdir("empty"))).toBeNull();
    const fresh = tmpdir("nocommits");
    git(fresh, ["init", "-q"]);
    expect(await createWipSnapshot(fresh)).toBeNull();
  });
});

describe("snapshot message trailers", () => {
  test("round-trips the branch and session", async () => {
    const msg = buildSnapshotMessage({ branch: "feature/x", conversationId: "conv1" });
    expect(parseSnapshotTrailer(msg, "codecast-branch")).toBe("feature/x");
    expect(parseSnapshotTrailer(msg, "codecast-session")).toBe("conv1");
  });

  test("a missing trailer is undefined, not a throw", async () => {
    expect(parseSnapshotTrailer("just a commit message", "codecast-branch")).toBeUndefined();
  });
});

describe("push + restore round-trip", () => {
  test("the destination lands on the right branch with work restored as UNCOMMITTED", async () => {
    const { cwd, remote } = repo();
    // The full hard case: a feature branch, an unpushed commit, an uncommitted
    // edit, and an untracked file — none of which a plain clone would carry.
    git(cwd, ["checkout", "-q", "-b", "feature/work"]);
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "committed-but-unpushed\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-qm", "unpushed"]);
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "uncommitted\n");
    fs.writeFileSync(path.join(cwd, "new.txt"), "untracked\n");

    const snap = (await createWipSnapshot(cwd, { conversationId: "conv1" }))!;
    expect((await pushWipSnapshot(cwd, { remote, conversationId: "conv1", sha: snap.sha })).ok).toBe(true);

    // The destination: a plain clone, exactly as the daemon does it.
    const dest = tmpdir("dest") + "/clone";
    execFileSync("git", ["clone", "-q", git(cwd, ["remote", "get-url", remote]), dest]);
    // A plain clone gives the DEFAULT branch and none of the work — the bug.
    expect(fs.existsSync(path.join(dest, "new.txt"))).toBe(false);

    const res = (await restoreWipSnapshot(dest, { remote: "origin", conversationId: "conv1" }))!;
    expect(res).not.toBeNull();
    expect(res.branch).toBe("feature/work");
    expect(res.appliedWork).toBe(true);
    expect(res.applyError).toBeUndefined();

    // Right branch, right commit.
    expect(git(dest, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/work");
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(snap.base);
    // The unpushed commit travelled as an ancestor.
    expect(git(dest, ["log", "--oneline"])).toContain("unpushed");
    // Work is present AND still uncommitted — not silently committed.
    expect(fs.readFileSync(path.join(dest, "tracked.txt"), "utf-8")).toBe("uncommitted\n");
    expect(fs.readFileSync(path.join(dest, "new.txt"), "utf-8")).toBe("untracked\n");
    expect(git(dest, ["status", "--porcelain"])).toContain("tracked.txt");
    expect(git(dest, ["status", "--porcelain"])).toContain("new.txt");
    // And the secret did not cross.
    expect(fs.existsSync(path.join(dest, ".env"))).toBe(false);
  });

  test("the source's dirty state is reproduced exactly", async () => {
    const { cwd, remote } = repo();
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "x\n");
    fs.writeFileSync(path.join(cwd, "new.txt"), "y\n");
    const snap = (await createWipSnapshot(cwd, { conversationId: "c2" }))!;
    await pushWipSnapshot(cwd, { remote, conversationId: "c2", sha: snap.sha });

    const dest = tmpdir("dest2") + "/clone";
    execFileSync("git", ["clone", "-q", git(cwd, ["remote", "get-url", remote]), dest]);
    await restoreWipSnapshot(dest, { remote: "origin", conversationId: "c2" });

    const norm = (s: string) => s.split("\n").sort().join("\n");
    expect(norm(git(dest, ["status", "--porcelain"]))).toBe(norm(git(cwd, ["status", "--porcelain"])));
  });

  test("a clean source restores the branch with nothing to apply", async () => {
    const { cwd, remote } = repo();
    git(cwd, ["checkout", "-q", "-b", "clean-branch"]);
    git(cwd, ["commit", "-q", "--allow-empty", "-m", "unpushed-empty"]);
    const snap = (await createWipSnapshot(cwd, { conversationId: "c3" }))!;
    await pushWipSnapshot(cwd, { remote, conversationId: "c3", sha: snap.sha });

    const dest = tmpdir("dest3") + "/clone";
    execFileSync("git", ["clone", "-q", git(cwd, ["remote", "get-url", remote]), dest]);
    const res = (await restoreWipSnapshot(dest, { remote: "origin", conversationId: "c3" }))!;
    expect(res.branch).toBe("clean-branch");
    expect(res.appliedWork).toBe(false);
    expect(git(dest, ["status", "--porcelain"])).toBe("");
    // The unpushed commit still travelled.
    expect(git(dest, ["log", "--oneline"])).toContain("unpushed-empty");
  });

  test("binary files survive the round-trip", async () => {
    const { cwd, remote } = repo();
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42]);
    fs.writeFileSync(path.join(cwd, "blob.bin"), bin);
    const snap = (await createWipSnapshot(cwd, { conversationId: "c4" }))!;
    await pushWipSnapshot(cwd, { remote, conversationId: "c4", sha: snap.sha });

    const dest = tmpdir("dest4") + "/clone";
    execFileSync("git", ["clone", "-q", git(cwd, ["remote", "get-url", remote]), dest]);
    await restoreWipSnapshot(dest, { remote: "origin", conversationId: "c4" });
    expect(fs.readFileSync(path.join(dest, "blob.bin"))).toEqual(bin);
  });

  test("a DELETED file is reproduced as deleted, not resurrected", async () => {
    // The case a diff/apply restore silently gets wrong: the clone has the file
    // (it's in base), and only a tree-level restore removes it again.
    const { cwd, remote } = repo();
    fs.writeFileSync(path.join(cwd, "doomed.txt"), "bye\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-qm", "add doomed"]);
    git(cwd, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    fs.rmSync(path.join(cwd, "doomed.txt"));

    const snap = (await createWipSnapshot(cwd, { conversationId: "cdel" }))!;
    await pushWipSnapshot(cwd, { remote, conversationId: "cdel", sha: snap.sha });

    const dest = tmpdir("destdel") + "/clone";
    execFileSync("git", ["clone", "-q", git(cwd, ["remote", "get-url", remote]), dest]);
    expect(fs.existsSync(path.join(dest, "doomed.txt"))).toBe(true); // clone has it
    const res = (await restoreWipSnapshot(dest, { remote: "origin", conversationId: "cdel" }))!;
    expect(res.appliedWork).toBe(true);
    expect(fs.existsSync(path.join(dest, "doomed.txt"))).toBe(false); // deletion travelled
    expect(git(dest, ["status", "--porcelain"])).toContain("D doomed.txt");
  });

  test("no snapshot for the session: returns null so the caller keeps the plain clone", async () => {
    const { cwd, remote } = repo();
    const dest = tmpdir("dest5") + "/clone";
    execFileSync("git", ["clone", "-q", git(cwd, ["remote", "get-url", remote]), dest]);
    expect(await restoreWipSnapshot(dest, { remote: "origin", conversationId: "nope" })).toBeNull();
  });

  test("the wip ref is hidden from branch listings", async () => {
    const { cwd, remote } = repo();
    const snap = (await createWipSnapshot(cwd, { conversationId: "c6" }))!;
    await pushWipSnapshot(cwd, { remote, conversationId: "c6", sha: snap.sha });
    const url = git(cwd, ["remote", "get-url", remote]);
    // Present as a ref...
    expect(execFileSync("git", ["ls-remote", url, wipRef("c6")], { encoding: "utf-8" })).toContain(snap.sha);
    // ...but not as a branch, so it can't trigger CI or clutter branch lists.
    expect(execFileSync("git", ["ls-remote", "--heads", url], { encoding: "utf-8" })).not.toContain("codecast");
  });

  test("pushing the snapshot NEVER moves the real branch on the remote", async () => {
    const { cwd, remote } = repo();
    const url = git(cwd, ["remote", "get-url", remote]);
    const mainBefore = execFileSync("git", ["ls-remote", url, "refs/heads/main"], { encoding: "utf-8" });
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "local-only\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-qm", "unpushed local commit"]);
    const snap = (await createWipSnapshot(cwd, { conversationId: "c7" }))!;
    await pushWipSnapshot(cwd, { remote, conversationId: "c7", sha: snap.sha });
    // The unpushed commit is now ON the remote (as an ancestor of the wip ref),
    // but main is untouched — we never rewrite a shared branch.
    expect(execFileSync("git", ["ls-remote", url, "refs/heads/main"], { encoding: "utf-8" })).toBe(mainBefore);
  });
});

describe("defaultRemote", () => {
  test("names the repo's remote, or null when it has none", async () => {
    const { cwd } = repo();
    expect(await defaultRemote(cwd)).toBe("origin");
    const bare = tmpdir("noremote");
    git(bare, ["init", "-q"]);
    expect(await defaultRemote(bare)).toBeNull();
  });
});

// A session's repo is whatever the agent was working in — often one the user can
// read but not push. Retrying that every pass, forever, is pure noise; a genuine
// network blip must keep retrying.
describe("isPermanentPushFailure", () => {
  test("access problems are permanent — waiting never fixes them", () => {
    for (const err of [
      "remote: Permission to octocat/Hello-World.git denied to ashot.",
      "remote: Repository not found.",
      "fatal: 'origin' does not appear to be a git repository",
      "remote: Write access to repository not granted. fatal: Authentication failed",
      "ERROR: Permission denied (publickey).",
      "remote: error: GH006: Forbidden",
    ]) {
      expect(isPermanentPushFailure(err)).toBe(true);
    }
  });

  test("transient failures keep retrying — the snapshot must exist before the lid closes", () => {
    for (const err of [
      "fatal: unable to access 'https://github.com/x.git': Could not resolve host: github.com",
      "ssh: connect to host github.com port 22: Operation timed out",
      "fatal: the remote end hung up unexpectedly",
      "error: RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly",
    ]) {
      expect(isPermanentPushFailure(err)).toBe(false);
    }
  });

  test("a real unpushable remote reports permanent", async () => {
    const cwd = tmpdir("nopush");
    execFileSync("git", ["init", "-q", cwd]);
    git(cwd, ["config", "user.email", "t@t.t"]);
    git(cwd, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(cwd, "f.txt"), "x\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-qm", "c"]);
    git(cwd, ["remote", "add", "origin", "/nonexistent/definitely-not-a-repo.git"]);
    const snap = (await createWipSnapshot(cwd, { conversationId: "c" }))!;
    const res = await pushWipSnapshot(cwd, { remote: "origin", conversationId: "c", sha: snap.sha });
    expect(res.ok).toBe(false);
    expect(res.permanent).toBe(true);
  });
});

// ct-39054: `cast remote move` used to call session-move's own wipSnapshot(),
// which ran `git add -A && git commit` on your REAL branch and left the junk
// commit behind forever — moving a session silently rewrote the history you were
// working on. gitPushWorktree now pushes createWipSnapshot's dangling commit
// instead. This pins the property that made the swap worth doing.
describe("the SSH move no longer pollutes the source branch (ct-39054)", () => {
  test("taking the snapshot leaves the branch, its history and its dirt untouched", async () => {
    const { cwd } = repo();
    git(cwd, ["checkout", "-q", "-b", "feature/move"]);
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "uncommitted\n");
    fs.writeFileSync(path.join(cwd, "untracked.txt"), "new\n");

    const before = {
      head: git(cwd, ["rev-parse", "HEAD"]),
      log: git(cwd, ["log", "--oneline"]),
      status: git(cwd, ["status", "--porcelain"]),
    };

    const snap = (await createWipSnapshot(cwd))!;

    // The old behavior: HEAD advances onto a "wip snapshot" commit, permanently.
    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(git(cwd, ["log", "--oneline"])).toBe(before.log);
    expect(git(cwd, ["log", "--oneline"])).not.toContain("wip snapshot");
    expect(git(cwd, ["status", "--porcelain"])).toBe(before.status);

    // ...while the remote still receives the exact same tree it did before:
    // the uncommitted edit and the untracked file, parented on the branch tip.
    expect(git(cwd, ["show", `${snap.sha}:tracked.txt`])).toBe("uncommitted");
    expect(git(cwd, ["ls-tree", "-r", "--name-only", snap.sha])).toContain("untracked.txt");
    expect(git(cwd, ["rev-parse", `${snap.sha}^`])).toBe(before.head);
  });
});

// ct-39063: `cast remote back` used to have the Mac `git add -A && git commit` its
// work, then fast-forward that commit onto YOUR branch — so bringing a session
// home left a junk commit behind and turned the agent's uncommitted work into a
// commit you never made. The Mac now builds a dangling snapshot (remoteSnapshotScript,
// the same recipe in shell) and we replay it here as uncommitted work.
describe("applySnapshotFastForward (cast remote back)", () => {
  /** Stand in for the Mac: a clone with its own commits + uncommitted work. */
  async function remoteWithWork(): Promise<{ local: string; remoteRepo: string; ref: string }> {
    const { cwd: local } = repo();
    const remoteRepo = tmpdir("mac") + "/checkout";
    execFileSync("git", ["clone", "-q", local, remoteRepo]);
    git(remoteRepo, ["config", "user.email", "m@m.m"]);
    git(remoteRepo, ["config", "user.name", "mac"]);
    return { local, remoteRepo, ref: "refs/codecast/back/main" };
  }

  /** Run the real shell recipe, as gitPullWorktree does over ssh. */
  const runRemoteScript = (cwd: string, ref: string) =>
    execFileSync("sh", ["-c", remoteSnapshotScript({ cwd, ref })], { encoding: "utf-8" }).trim();

  test("the remote's shell recipe produces the same shape as createWipSnapshot", async () => {
    const { remoteRepo, ref } = await remoteWithWork();
    fs.writeFileSync(path.join(remoteRepo, "tracked.txt"), "mac edit\n");
    fs.writeFileSync(path.join(remoteRepo, "mac-new.txt"), "made on the mac\n");
    const sha = runRemoteScript(remoteRepo, ref);

    expect(git(remoteRepo, ["rev-parse", ref])).toBe(sha);
    // Non-destructive there too: the Mac's own branch is untouched.
    expect(git(remoteRepo, ["log", "--oneline"])).not.toContain("wip snapshot");
    expect(git(remoteRepo, ["status", "--porcelain"])).toContain("mac-new.txt");
    // Same message contract the TS twin writes, so parsing works either way.
    const msg = git(remoteRepo, ["show", "-s", "--format=%B", sha]);
    expect(parseSnapshotTrailer(msg, "codecast-branch")).toBe("main");
    // ...and .gitignore is still respected by the shell path.
    expect(git(remoteRepo, ["ls-tree", "-r", "--name-only", sha])).not.toContain(".env");
  });

  test("the Mac's uncommitted work lands here as UNCOMMITTED, with no junk commit", async () => {
    const { local, remoteRepo, ref } = await remoteWithWork();
    // The Mac commits something AND leaves work uncommitted.
    fs.writeFileSync(path.join(remoteRepo, "tracked.txt"), "committed on mac\n");
    git(remoteRepo, ["add", "-A"]);
    git(remoteRepo, ["commit", "-qm", "real work on the mac"]);
    fs.writeFileSync(path.join(remoteRepo, "tracked.txt"), "still editing\n");
    fs.writeFileSync(path.join(remoteRepo, "mac-new.txt"), "untracked on mac\n");
    runRemoteScript(remoteRepo, ref);

    // Fetch it home exactly as gitPullWorktree does.
    git(local, ["fetch", "--force", remoteRepo, `${ref}:${ref}`]);
    const res = await applySnapshotFastForward(local, ref);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The Mac's real commit fast-forwarded in...
    expect(git(local, ["log", "--oneline"])).toContain("real work on the mac");
    // ...with NO junk commit (the old bug).
    expect(git(local, ["log", "--oneline"])).not.toContain("wip snapshot");
    // ...and its uncommitted work is uncommitted here.
    expect(fs.readFileSync(path.join(local, "tracked.txt"), "utf-8")).toBe("still editing\n");
    expect(fs.readFileSync(path.join(local, "mac-new.txt"), "utf-8")).toBe("untracked on mac\n");
    expect(git(local, ["status", "--porcelain"])).toContain("tracked.txt");
    expect(res.appliedWork).toBe(true);
  });

  test("local commits the Mac never saw: refuses and changes nothing", async () => {
    const { local, remoteRepo, ref } = await remoteWithWork();
    fs.writeFileSync(path.join(remoteRepo, "tracked.txt"), "mac\n");
    runRemoteScript(remoteRepo, ref);
    git(local, ["fetch", "--force", remoteRepo, `${ref}:${ref}`]);
    // Diverge: a local commit that isn't in the Mac's history.
    fs.writeFileSync(path.join(local, "local-only.txt"), "mine\n");
    git(local, ["add", "-A"]);
    git(local, ["commit", "-qm", "local only commit"]);
    const before = { head: git(local, ["rev-parse", "HEAD"]), log: git(local, ["log", "--oneline"]) };

    const res = await applySnapshotFastForward(local, ref);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("diverged");
    // Nothing touched — the local commit is safe.
    expect(git(local, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(git(local, ["log", "--oneline"])).toBe(before.log);
    expect(fs.existsSync(path.join(local, "local-only.txt"))).toBe(true);
  });

  test("a dirty local tree is backed up to a ref before being overwritten", async () => {
    const { local, remoteRepo, ref } = await remoteWithWork();
    fs.writeFileSync(path.join(remoteRepo, "tracked.txt"), "from the mac\n");
    runRemoteScript(remoteRepo, ref);
    git(local, ["fetch", "--force", remoteRepo, `${ref}:${ref}`]);
    // Local has its own uncommitted edit — after a move this is the NORMAL state,
    // since the move no longer commits the source's work away.
    fs.writeFileSync(path.join(local, "tracked.txt"), "precious local edit\n");

    const res = await applySnapshotFastForward(local, ref, { now: 12345 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.backupRef).toBe("refs/codecast/backup/12345");
    // The Mac's version won...
    expect(fs.readFileSync(path.join(local, "tracked.txt"), "utf-8")).toBe("from the mac\n");
    // ...but nothing was lost: the clobbered edit is recoverable from the ref.
    expect(git(local, ["show", `${res.backupRef}:tracked.txt`])).toBe("precious local edit");
  });

  test("a clean local tree needs no backup", async () => {
    const { local, remoteRepo, ref } = await remoteWithWork();
    fs.writeFileSync(path.join(remoteRepo, "tracked.txt"), "mac\n");
    runRemoteScript(remoteRepo, ref);
    git(local, ["fetch", "--force", remoteRepo, `${ref}:${ref}`]);
    const res = await applySnapshotFastForward(local, ref);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.backupRef).toBeUndefined();
  });

  test("a missing/garbage ref reports rather than throws", async () => {
    const { cwd } = repo();
    const res = await applySnapshotFastForward(cwd, "refs/codecast/back/nope");
    expect(res.ok).toBe(false);
  });
});
