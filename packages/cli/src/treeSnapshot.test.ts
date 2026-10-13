import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHAIN_DEPTH_CAP, STALE_INDEX_LOCK_MS, chainHead, createTurnSnapshot, diffSnapshots, listChain, snapshotStateDir } from "./treeSnapshot.js";
import { restoreWipSnapshot, pushWipSnapshot } from "./wipSnapshot.js";

const tmps: string[] = [];
function tmpdir(name: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `turnsnap-${name}-`));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) {
    try { fs.rmSync(tmps.pop()!, { recursive: true, force: true }); } catch {}
  }
});
const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
const status = (cwd: string) => execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf-8" }).split("\n").filter(Boolean).sort();

function repo(): { cwd: string; remote: string } {
  const cwd = tmpdir("src");
  const remote = tmpdir("remote") + "/origin.git";
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.email", "t@t.t"]);
  git(cwd, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "v1\n");
  fs.writeFileSync(path.join(cwd, "doomed.txt"), "v1\n");
  fs.writeFileSync(path.join(cwd, ".env"), "SECRET=leak\n");
  git(cwd, ["add", ".gitignore", "tracked.txt", "doomed.txt"]);
  git(cwd, ["commit", "-qm", "base"]);
  git(cwd, ["remote", "add", "origin", remote]);
  git(cwd, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  return { cwd, remote: "origin" };
}

describe("createTurnSnapshot", () => {
  test("a lock left on the private index by a killed git is cleared once stale; a fresh one is respected", async () => {
    const { cwd } = repo();
    expect(await createTurnSnapshot(cwd)).not.toBeNull();
    const lock = path.join((await snapshotStateDir(cwd))!, "wip.index.lock");
    fs.writeFileSync(lock, "");
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "after the crash\n");
    await expect(createTurnSnapshot(cwd)).rejects.toThrow(/index\.lock/);
    const old = (Date.now() - STALE_INDEX_LOCK_MS - 60_000) / 1000;
    fs.utimesSync(lock, old, old);
    const snap = await createTurnSnapshot(cwd);
    expect(snap?.changedPaths).toContain("tracked.txt");
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("a same-size edit in the same second as the real index is still seen (racy-git survives the index copy)", async () => {
    // git trusts an entry's stat only when its mtime is older than the index
    // file. The persistent index is seeded by copying the real one; stamped
    // now, the copy vouched for an edit made in the index's own second.
    for (let attempt = 0; attempt < 5; attempt++) {
      const { cwd } = repo();
      git(cwd, ["update-index", "-q", "--refresh"]);
      const indexSecond = Math.floor(fs.statSync(path.join(cwd, ".git", "index")).mtimeMs / 1000);
      fs.writeFileSync(path.join(cwd, "tracked.txt"), "v2\n");
      if (Math.floor(fs.statSync(path.join(cwd, "tracked.txt")).mtimeMs / 1000) !== indexSecond) continue;
      await new Promise((r) => setTimeout(r, 1100));
      const snap = await createTurnSnapshot(cwd);
      expect(snap?.changedPaths).toContain("tracked.txt");
      return;
    }
  });

  test("first snapshot: parent is HEAD, tree carries the dirty edit and the untracked file, never the ignored secret", async () => {
    const { cwd } = repo();
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "dirty\n");
    fs.writeFileSync(path.join(cwd, "new.txt"), "untracked\n");
    const snap = await createTurnSnapshot(cwd);
    expect(snap).not.toBeNull();
    expect(snap!.depth).toBe(1);
    expect(snap!.prev).toBeUndefined();
    expect(snap!.dirty).toBe(true);
    expect(snap!.unchanged).toBe(false);
    expect(git(cwd, ["rev-parse", `${snap!.sha}^`])).toBe(git(cwd, ["rev-parse", "HEAD"]));
    const files = git(cwd, ["ls-tree", "-r", "--name-only", snap!.sha]).split("\n");
    expect(files).toContain("new.txt");
    expect(files).not.toContain(".env");
    expect(git(cwd, ["show", `${snap!.sha}:tracked.txt`])).toBe("dirty");
    expect(snap!.changedPaths.sort()).toEqual(["new.txt", "tracked.txt"]);
    expect(snap!.changedCount).toBe(2);
    // The real index, HEAD and status are untouched.
    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(snap!.base);
    expect(status(cwd)).toEqual([" M tracked.txt", "?? new.txt"]);
    expect(git(cwd, ["diff", "--cached", "--name-only"])).toBe("");
  });

  test("second snapshot chains: first parent HEAD, second parent the previous snapshot, changed paths relative to it", async () => {
    const { cwd } = repo();
    fs.writeFileSync(path.join(cwd, "a.txt"), "1\n");
    const one = (await createTurnSnapshot(cwd))!;
    fs.writeFileSync(path.join(cwd, "b.txt"), "2\n");
    const two = (await createTurnSnapshot(cwd))!;
    expect(two.depth).toBe(2);
    expect(two.prev).toBe(one.sha);
    expect(git(cwd, ["rev-parse", `${two.sha}^1`])).toBe(git(cwd, ["rev-parse", "HEAD"]));
    expect(git(cwd, ["rev-parse", `${two.sha}^2`])).toBe(one.sha);
    expect(two.changedPaths).toEqual(["b.txt"]);
    const chain = await listChain(cwd, two.sha);
    expect(chain.map((c) => c.sha)).toEqual([two.sha, one.sha]);
    expect(chain[0].takenAt).toBeGreaterThan(0);
    expect(await chainHead(cwd)).toEqual({ sha: two.sha, tree: two.tree, depth: 2 });
    expect(await diffSnapshots(cwd, one.sha, two.sha, { stat: true })).toContain("b.txt");
  });

  test("an unchanged tree writes nothing new and names the existing snapshot", async () => {
    const { cwd } = repo();
    fs.writeFileSync(path.join(cwd, "a.txt"), "1\n");
    const one = (await createTurnSnapshot(cwd))!;
    const again = (await createTurnSnapshot(cwd))!;
    expect(again.unchanged).toBe(true);
    expect(again.sha).toBe(one.sha);
    expect(again.depth).toBe(1);
    expect(again.changedCount).toBe(0);
  });

  test("a deletion and an edit made outside any tool are recorded", async () => {
    const { cwd } = repo();
    const one = (await createTurnSnapshot(cwd))!;
    expect(one.dirty).toBe(false);
    execFileSync("sh", ["-c", "echo shelled > tracked.txt && rm doomed.txt"], { cwd });
    const two = (await createTurnSnapshot(cwd))!;
    expect(two.changedPaths.sort()).toEqual(["doomed.txt", "tracked.txt"]);
    expect(git(cwd, ["ls-tree", "-r", "--name-only", two.sha]).split("\n")).not.toContain("doomed.txt");
    expect(git(cwd, ["show", `${two.sha}:tracked.txt`])).toBe("shelled");
  });

  test("paths: only the named paths are re-read, a change elsewhere waits for the next full pass", async () => {
    const { cwd } = repo();
    await createTurnSnapshot(cwd);
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "named\n");
    fs.writeFileSync(path.join(cwd, "other.txt"), "unnamed\n");
    fs.rmSync(path.join(cwd, "doomed.txt"));
    const partial = (await createTurnSnapshot(cwd, { paths: ["tracked.txt", "missing.txt", ".env", "doomed.txt", path.join(cwd, "tracked.txt")] }))!;
    expect(partial.changedPaths.sort()).toEqual(["doomed.txt", "tracked.txt"]);
    expect(git(cwd, ["ls-tree", "-r", "--name-only", partial.sha]).split("\n")).not.toContain(".env");
    const full = (await createTurnSnapshot(cwd))!;
    expect(full.changedPaths).toEqual(["other.txt"]);
    expect(full.prev).toBe(partial.sha);
  });

  test("the chain restarts at the depth cap so an old tail can be collected", async () => {
    const { cwd } = repo();
    const dir = (await snapshotStateDir(cwd))!;
    fs.writeFileSync(path.join(cwd, "a.txt"), "1\n");
    const one = (await createTurnSnapshot(cwd))!;
    // Pretend the chain is already at the cap.
    fs.writeFileSync(path.join(dir, "wip.head"), `${one.sha} ${one.tree} ${CHAIN_DEPTH_CAP}\n`);
    fs.writeFileSync(path.join(cwd, "a.txt"), "2\n");
    const next = (await createTurnSnapshot(cwd))!;
    expect(next.depth).toBe(1);
    expect(next.prev).toBeUndefined();
    expect(git(cwd, ["rev-list", "--parents", "-n", "1", next.sha]).split(" ").length).toBe(2);
  });

  test("a stale head file (object gone) is ignored, not trusted", async () => {
    const { cwd } = repo();
    const dir = (await snapshotStateDir(cwd))!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "wip.head"), `${"0".repeat(40)} ${"1".repeat(40)} 7\n`);
    fs.writeFileSync(path.join(cwd, "a.txt"), "1\n");
    const snap = (await createTurnSnapshot(cwd))!;
    expect(snap.depth).toBe(1);
    expect(await chainHead(cwd)).toEqual({ sha: snap.sha, tree: snap.tree, depth: 1 });
  });

  test("a chained snapshot still restores through the existing wip path", async () => {
    const { cwd, remote } = repo();
    fs.writeFileSync(path.join(cwd, "a.txt"), "1\n");
    await createTurnSnapshot(cwd);
    fs.writeFileSync(path.join(cwd, "a.txt"), "2\n");
    const two = (await createTurnSnapshot(cwd))!;
    const conv = "conv_turnsnap";
    const push = await pushWipSnapshot(cwd, { remote, conversationIds: [conv], sha: two.sha });
    expect(push.ok).toBe(true);
    const dest = tmpdir("dest");
    execFileSync("git", ["clone", "-q", git(cwd, ["remote", "get-url", "origin"]), dest]);
    const restored = await restoreWipSnapshot(dest, { remote: "origin", conversationId: conv });
    expect(restored).not.toBeNull();
    expect(fs.readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("2\n");
    // The whole chain travelled with the tip.
    expect((await listChain(dest, two.sha)).length).toBe(2);
  });

  test("concurrent calls on one checkout serialize and both see a consistent chain", async () => {
    const { cwd } = repo();
    fs.writeFileSync(path.join(cwd, "a.txt"), "1\n");
    const [x, y] = await Promise.all([createTurnSnapshot(cwd), createTurnSnapshot(cwd)]);
    expect(x!.sha).toBe(y!.sha);
    expect((await chainHead(cwd))!.depth).toBe(1);
  });

  test("outside a repository: null", async () => {
    expect(await createTurnSnapshot(tmpdir("plain"))).toBeNull();
  });
});
