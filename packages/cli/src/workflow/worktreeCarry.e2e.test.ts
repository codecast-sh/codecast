// End to end (flows.md FL4, ct-99118): what a session leaves uncommitted in the run's worktree is carried into a
// change frozen from its checkout through every refreeze, with credentials and unexplained lockfiles held out.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { freezeSessionChange, frozenChangeContext, refreezeSessionChange, snapshotRunTree, writeFrozenChange } from "./flowChange";
import { heldDir, heldWords, readFrozenChange } from "./flowChangeFile";
import { freshState, git, sandbox, tool, transcript, useSandbox, write } from "./carry.testkit";

useSandbox();

// A stage's finding names the run's worktree, so a subject may fix the change there and leave it uncommitted (ct-99118).
describe("edits left in the run's worktree", () => {
  /** A session's change to a.txt frozen onto codecast/<name>, the run's worktree on that branch, and its run directory. */
  async function carryWorld(name: string, opts: { grow?: boolean; also?: string } = {}) {
    freshState();
    const root = path.join(sandbox, name);
    fs.mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    for (const f of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "package.json", "bun.lock", ".env.production"]) write(root, f, "base\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    if (opts.grow) {
      write(root, "b.txt", "v2\n");
      git(root, "commit", "-qam", "grow b");
    }
    const conversation = `jx7${name}`.padEnd(32, "0");
    // The session's change: a.txt, and `also` beside it.
    const files = ["a.txt", ...(opts.also ? [opts.also] : [])];
    for (const f of files) write(root, f, `${f} 1\n`);
    transcript(`sess-${name}`, conversation, files.map((f) => tool(root, "Edit", { file_path: path.join(root, f), old_string: "base", new_string: "1" }, 10_000)));
    const runDir = path.join(sandbox, `run-dir-${name}`);
    writeFrozenChange(runDir, { ...(await freezeSessionChange(root, conversation.slice(0, 7), { branch: `codecast/${name}`, worktree: name })), conversation });
    const tree = path.join(sandbox, `${name}-wt`);
    git(root, "worktree", "add", "--quiet", tree, `codecast/${name}`);
    const show = (rev: string, f: string) => git(root, "show", `${rev}:${f}`);
    return { root, runDir, tree, show, conversation, branch: `codecast/${name}` };
  }

  test("are carried onto every refreeze of a session's change, through a runner restart; what a station did there before the brief is not", async () => {
    const { root, runDir, tree, show } = await carryWorld("cara");
    // A station changed c.txt and deleted d.txt before the brief went out.
    write(tree, "c.txt", "station\n");
    fs.rmSync(path.join(tree, "d.txt"));
    await snapshotRunTree(tree, runDir);
    // The session fixes b.txt there, adds a test and deletes e.txt; the runner restarts and sends the brief again.
    write(tree, "b.txt", "fixed in the worktree\n");
    write(tree, "b.test.txt", "new\n");
    fs.rmSync(path.join(tree, "e.txt"));
    await snapshotRunTree(tree, runDir);
    const first = await refreezeSessionChange(root, runDir, tree);
    expect(first.moved).toBe(true);
    const at = (rev: string, f: string) => (git(root, "ls-tree", "--name-only", rev, "--", f) ? show(rev, f) : null);
    expect(["a.txt", "b.txt", "b.test.txt", "c.txt", "d.txt", "e.txt"].map((f) => at(first.change.tip, f))).toEqual(["a.txt 1", "fixed in the worktree", "new", "base", "base", null]);
    // The checkout's own files stay its own; what the worktree added is named apart.
    expect(first.change.paths).toEqual(["a.txt"]);
    expect(first.change.carried).toEqual(["b.test.txt", "b.txt", "e.txt"]);
    expect(frozenChangeContext(runDir).change_files).toBe("a.txt b.test.txt b.txt e.txt");
    expect(git(tree, "rev-parse", "HEAD")).toBe(first.change.tip);
    expect(git(tree, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(runDir, "brief-tree"))).toBe(false);

    // The next round's fix is in the checkout: the worktree's fix stays in the change, on top of the new freeze.
    await snapshotRunTree(tree, runDir);
    write(root, "a.txt", "a2\n");
    const second = await refreezeSessionChange(root, runDir, tree);
    expect(["a.txt", "b.txt", "b.test.txt"].map((f) => show(second.change.tip, f))).toEqual(["a2", "fixed in the worktree", "new"]);
    expect(readFrozenChange(runDir)?.tip).toBe(second.change.tip);
    expect(git(root, "rev-parse", "codecast/cara")).toBe(second.change.tip);
    // The shared checkout is the subject's own: nothing of the worktree's reaches it.
    expect(git(root, "status", "--porcelain", "--untracked-files=no")).toBe(" M a.txt");
  }, 180_000);

  test("a credential and a lockfile nothing explains are held out and moved into the run's directory; a file put back as it was is the session's own", async () => {
    const { root, runDir, tree, show } = await carryWorld("carb", { grow: true });
    await snapshotRunTree(tree, runDir);
    const token = ["sk", "ant", "api03", "Qz7Lm2Vx9Rt4Kp8Wn3Hj6Bd1Fs5Gy0Ce"].join("-");
    write(tree, ".env", "KEY=1\n");
    write(tree, "config.txt", `key = ${token}\n`);
    write(tree, "bun.lock", "rewritten by an install\n");
    // b.txt put back as it was before a later commit changed it: a revert the session chose.
    write(tree, "b.txt", "base\n");
    write(tree, "c.txt", "fixed\n");
    const { change, held } = await refreezeSessionChange(root, runDir, tree);
    expect([show(change.tip, "b.txt"), show(change.tip, "c.txt")]).toEqual(["base", "fixed"]);
    expect(git(root, "diff", "--name-only", change.frozen_tip!, change.tip)).toBe("b.txt\nc.txt");
    expect(held.map((h) => h.path).sort()).toEqual([".env", "bun.lock", "config.txt"]);
    expect(change.held.map((h) => h.path).sort()).toEqual([".env", "bun.lock", "config.txt"]);
    expect(held.find((h) => h.path === "config.txt")?.why).toBe("holds an API token");
    // The next stage checks the change alone: the held files wait in the run's directory, not the worktree.
    expect(fs.existsSync(path.join(tree, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(tree, "config.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(tree, "bun.lock"), "utf-8")).toBe("base\n");
    expect(git(tree, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(heldDir(runDir), ".env"), "utf-8")).toBe("KEY=1\n");
    expect(fs.readFileSync(path.join(heldDir(runDir), "bun.lock"), "utf-8")).toBe("rewritten by an install\n");
    expect(heldWords(runDir, held)).toContain(".env (named like a credential file)");
  }, 180_000);

  test("a lockfile the change's own manifest edit explains is carried", async () => {
    const { root, runDir, tree, show } = await carryWorld("carg", { also: "package.json" });
    await snapshotRunTree(tree, runDir);
    write(tree, "bun.lock", "regenerated for package.json\n");
    const { change, held } = await refreezeSessionChange(root, runDir, tree);
    expect(held).toEqual([]);
    expect(show(change.tip, "bun.lock")).toBe("regenerated for package.json");
  }, 180_000);

  test("a run that writes its change afresh drops a brief's record left by a stopped attempt, so that attempt's station output is not carried", async () => {
    const { root, runDir, tree, show } = await carryWorld("carh");
    // An earlier attempt recorded the worktree at its brief and stopped; a station then wrote c.txt.
    await snapshotRunTree(tree, runDir);
    write(tree, "c.txt", "station output\n");
    // The next run in the same directory writes its change, and its own brief records the tree as it finds it.
    writeFrozenChange(runDir, readFrozenChange(runDir)!);
    expect(fs.existsSync(path.join(runDir, "brief-tree"))).toBe(false);
    await snapshotRunTree(tree, runDir);
    write(tree, "b.txt", "fixed\n");
    const { change } = await refreezeSessionChange(root, runDir, tree);
    expect([show(change.tip, "b.txt"), show(change.tip, "c.txt")]).toEqual(["fixed", "base"]);
  }, 180_000);

  test("the carry names its session", async () => {
    const { root, runDir, tree, conversation } = await carryWorld("carc");
    fs.writeFileSync(path.join(process.env.CODECAST_DIR!, "session-links.json"), JSON.stringify({ "sess-carc": { conversation_id: conversation, team_visible: true, checked_at: Date.now() } }));
    await snapshotRunTree(tree, runDir);
    write(tree, "b.txt", "fixed\n");
    const { change } = await refreezeSessionChange(root, runDir, tree);
    expect(git(root, "log", "-1", "--format=%B", change.tip)).toContain(`Codecast-Session: `);
    expect(git(root, "log", "-1", "--format=%B", change.tip)).toContain(conversation);
  }, 180_000);

  test("a carry that conflicts with the new freeze moves nothing: the branch, the change and the worktree's edits stay", async () => {
    const { root, runDir, tree } = await carryWorld("card");
    await snapshotRunTree(tree, runDir);
    write(tree, "a.txt", "from the worktree\n");
    const first = await refreezeSessionChange(root, runDir, tree);
    // The checkout then changes a.txt otherwise, and the session leaves another edit in the worktree.
    await snapshotRunTree(tree, runDir);
    write(root, "a.txt", "from the checkout\n");
    write(tree, "b.txt", "left here\n");
    await expect(refreezeSessionChange(root, runDir, tree)).rejects.toThrow(/conflict with the change frozen again from the checkout/);
    expect(git(root, "rev-parse", "codecast/card")).toBe(first.change.tip);
    expect(readFrozenChange(runDir)?.tip).toBe(first.change.tip);
    expect(git(tree, "status", "--porcelain")).toBe(" M b.txt");
    expect(fs.existsSync(path.join(runDir, "brief-tree"))).toBe(true);
  }, 180_000);

  test("a merge commit in the worktree refuses with why, and moves nothing", async () => {
    const { root, runDir, tree, branch } = await carryWorld("care");
    const before = git(root, "rev-parse", branch);
    await snapshotRunTree(tree, runDir);
    git(tree, "checkout", "-q", "-b", "side");
    write(tree, "b.txt", "side\n");
    git(tree, "commit", "-qam", "side");
    git(tree, "checkout", "-q", branch);
    git(tree, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merged = git(tree, "rev-parse", "HEAD");
    await expect(refreezeSessionChange(root, runDir, tree)).rejects.toThrow(/history the run cannot carry.*merge commit/);
    expect(git(root, "rev-parse", branch)).toBe(merged);
    expect(readFrozenChange(runDir)?.tip).toBe(before);
  }, 180_000);

  test("a worktree reset off the change refuses, and is left as it is", async () => {
    const { root, runDir, tree, branch } = await carryWorld("carf");
    const before = git(root, "rev-parse", branch);
    await snapshotRunTree(tree, runDir);
    git(tree, "reset", "-q", "--hard", "main");
    write(tree, "b.txt", "fixed on the wrong base\n");
    await expect(refreezeSessionChange(root, runDir, tree)).rejects.toThrow(/^Something reset or rebased the run's worktree to [0-9a-f]{10}, off the change as last frozen \([0-9a-f]{10}\), so the run left it as it is$/);
    expect(readFrozenChange(runDir)?.tip).toBe(before);
    expect(fs.readFileSync(path.join(tree, "b.txt"), "utf-8")).toBe("fixed on the wrong base\n");
  }, 180_000);
  test("a credential the session committed in the worktree refuses the refreeze, naming it, and moves nothing (ct-99118)", async () => {
    const { root, runDir, tree, branch } = await carryWorld("cari");
    const before = git(root, "rev-parse", branch);
    await snapshotRunTree(tree, runDir);
    write(tree, ".env", "KEY=1\n");
    write(tree, "b.txt", "fixed\n");
    git(tree, "add", ".env", "b.txt");
    git(tree, "commit", "--quiet", "-m", "fix with a secret");
    const committed = git(tree, "rev-parse", "HEAD");
    await expect(refreezeSessionChange(root, runDir, tree)).rejects.toThrow(/committed \.env \(named like a credential file\)/);
    expect(git(root, "rev-parse", branch)).toBe(committed);
    expect(readFrozenChange(runDir)?.tip).toBe(before);
  }, 180_000);

  test("deleting a tracked file named like a credential is carried, not held", async () => {
    const { root, runDir, tree } = await carryWorld("carj");
    await snapshotRunTree(tree, runDir);
    fs.rmSync(path.join(tree, ".env.production"));
    const { change, held } = await refreezeSessionChange(root, runDir, tree);
    expect(held).toEqual([]);
    expect(git(root, "ls-tree", "--name-only", change.tip, "--", ".env.production")).toBe("");
    expect(fs.existsSync(path.join(tree, ".env.production"))).toBe(false);
  }, 180_000);

  test("a credential file's template is carried", async () => {
    const { root, runDir, tree, show } = await carryWorld("cark");
    await snapshotRunTree(tree, runDir);
    write(tree, "backend/.env.example", "KEY=\n");
    const { change, held } = await refreezeSessionChange(root, runDir, tree);
    expect(held).toEqual([]);
    expect(show(change.tip, "backend/.env.example")).toBe("KEY=");
  }, 180_000);

  test("a template is a credential by its content, not its name: one holding a live token is held, and refuses when committed", async () => {
    const token = ["sk", "ant", "api03", "Qz7Lm2Vx9Rt4Kp8Wn3Hj6Bd1Fs5Gy0Ce"].join("-");
    const { root, runDir, tree } = await carryWorld("carl");
    await snapshotRunTree(tree, runDir);
    write(tree, "backend/.env.example", `KEY=${token}\n`);
    const { held } = await refreezeSessionChange(root, runDir, tree);
    expect(held).toEqual([{ path: "backend/.env.example", why: "holds an API token" }]);

    await snapshotRunTree(tree, runDir);
    write(tree, "config.sample", `KEY=${token}\n`);
    git(tree, "add", "config.sample");
    git(tree, "commit", "--quiet", "-m", "sample with a live key");
    await expect(refreezeSessionChange(root, runDir, tree)).rejects.toThrow(/committed config\.sample \(holds an API token\)/);
  }, 180_000);

  test("deleting a lockfile nothing explains is carried, not held and put back", async () => {
    const { root, runDir, tree } = await carryWorld("carm");
    await snapshotRunTree(tree, runDir);
    fs.rmSync(path.join(tree, "bun.lock"));
    const { change, held } = await refreezeSessionChange(root, runDir, tree);
    expect(held).toEqual([]);
    expect(git(root, "ls-tree", "--name-only", change.tip, "--", "bun.lock")).toBe("");
    expect(fs.existsSync(path.join(tree, "bun.lock"))).toBe(false);
  }, 180_000);

  /** A reference-transaction hook that writes `file` into the run's worktree when the change's branch moves: a write made while the refreeze runs. */
  const writeWhileFreezing = (root: string, tree: string, branch: string, file: string, once: boolean) => {
    const hook = path.join(root, ".git", "hooks", "reference-transaction");
    const marker = path.join(root, ".git", "wrote-once");
    fs.writeFileSync(hook, `#!/bin/sh
[ "$1" = committed ] || exit 0
grep -q "refs/heads/${branch}$" || exit 0
${once ? `[ -e "${marker}" ] && exit 0
touch "${marker}"` : ""}
echo "written while freezing $$" > "${path.join(tree, file)}"
`, { mode: 0o755 });
    return () => fs.rmSync(hook, { force: true });
  };

  test("a write made while the refreeze runs is read again and carried, not lost to the reset", async () => {
    const { root, runDir, tree, branch, show } = await carryWorld("carn");
    await snapshotRunTree(tree, runDir);
    write(tree, "b.txt", "fixed\n");
    const unhook = writeWhileFreezing(root, tree, branch, "late.txt", true);
    const { change } = await refreezeSessionChange(root, runDir, tree);
    unhook();
    expect(show(change.tip, "b.txt")).toBe("fixed");
    expect(show(change.tip, "late.txt")).toMatch(/^written while freezing/);
    expect(git(tree, "status", "--porcelain")).toBe("");
  }, 180_000);

  test("a worktree still changing on the second read refuses and is left as it is", async () => {
    const { root, runDir, tree, branch } = await carryWorld("caro");
    const before = git(root, "rev-parse", branch);
    await snapshotRunTree(tree, runDir);
    write(tree, "b.txt", "fixed\n");
    const unhook = writeWhileFreezing(root, tree, branch, "late.txt", false);
    await expect(refreezeSessionChange(root, runDir, tree)).rejects.toThrow(/kept changing/);
    unhook();
    expect(readFrozenChange(runDir)?.tip).toBe(before);
    expect(git(root, "rev-parse", branch)).toBe(before);
    expect(fs.readFileSync(path.join(tree, "b.txt"), "utf-8")).toBe("fixed\n");
    expect(fs.existsSync(path.join(tree, "late.txt"))).toBe(true);
  }, 180_000);

  test("a reset that fails leaves the run as it was: the branch, change.json and the worktree's files, held ones included", async () => {
    const { root, runDir, tree, branch } = await carryWorld("carp");
    const before = git(root, "rev-parse", branch);
    await snapshotRunTree(tree, runDir);
    write(tree, "b.txt", "fixed\n");
    write(tree, ".env", "KEY=1\n");
    const lock = git(tree, "rev-parse", "--path-format=absolute", "--git-path", "index.lock");
    fs.writeFileSync(lock, "");
    await expect(refreezeSessionChange(root, runDir, tree)).rejects.toThrow(/Could not reset the run's worktree/);
    fs.rmSync(lock);
    expect(git(root, "rev-parse", branch)).toBe(before);
    expect(readFrozenChange(runDir)?.tip).toBe(before);
    expect(fs.readFileSync(path.join(tree, "b.txt"), "utf-8")).toBe("fixed\n");
    expect(fs.readFileSync(path.join(tree, ".env"), "utf-8")).toBe("KEY=1\n");
    expect(fs.existsSync(path.join(heldDir(runDir), ".env"))).toBe(false);
    // With the lock gone, the next refreeze carries it all.
    const { change } = await refreezeSessionChange(root, runDir, tree);
    expect(git(root, "show", `${change.tip}:b.txt`)).toBe("fixed");
  }, 180_000);
});
