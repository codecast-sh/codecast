// End to end (flows.md FL4): a session's change in a shared checkout, made
// partly with the Edit tool and partly through Bash (sed -i, a python
// heredoc, a cat redirect), beside another session's work, frozen into a
// commit of its own and run through a flow. Real git, fake transcripts in an
// isolated CODECAST_DIR and HOME. The worst failure here is a run that
// silently leaves out some of the session's edits.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { freezeCheckoutChange, freezeSessionChange, frozenChangeContext, NoSessionChange, previewCheckoutChange, previewSessionChange, refreezeSessionChange, snapshotRunTree, writeFrozenChange } from "./flowChange";
import { behindWords, heldDir, heldWords, readFrozenChange } from "./flowChangeFile";
import { parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow } from "./runner";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let sandbox = "";

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-flow-e2e-")));
  for (const [k, v] of Object.entries({ ...ENV, HOME: sandbox, CODECAST_DIR: path.join(sandbox, ".codecast") })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// The base commit is an hour old, so the transcripts' writes (seconds ago) come after it.
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: HOUR_AGO, GIT_COMMITTER_DATE: HOUR_AGO } }).replace(/\n$/, "");
const write = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };

// Each test its own state dir: the sync ledger store is cached per path.
let worlds = 0;
const freshState = () => { process.env.CODECAST_DIR = path.join(sandbox, `.codecast-${++worlds}`); };

function transcript(sessionId: string, conversationId: string, lines: object[]) {
  const dir = path.join(sandbox, ".claude", "projects", "-sandbox");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const ledgerFile = path.join(process.env.CODECAST_DIR!, "sync-ledger.json");
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf-8")) : {};
  ledger[file] = { lastSyncedAt: Date.now(), lastSyncedPosition: 0, messageCount: lines.length, conversationId, sourceGeneration: { client: "claude", sessionId, dev: 0, ino: 0, birthtimeMs: 0, unit: "bytes", watermark: 0, prefixProven: true } };
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
}
const at = (ms: number) => new Date(Date.now() - ms).toISOString();
const tool = (cwd: string, name: string, input: object, ms: number) => ({ type: "assistant", timestamp: at(ms), cwd, message: { role: "assistant", content: [{ type: "tool_use", id: `t${Math.random()}`, name, input }] } });

describe("a session's change runs through a flow", () => {
  test("every file the session wrote, by Edit or by Bash, is in the frozen commit; others' files and credentials stay out", async () => {
    freshState();
    const root = path.join(sandbox, "shared");
    fs.mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    for (const [f, t] of Object.entries({ "src/api.ts": "export const api = 1;\n", "src/util.ts": "export const u = 1;\n", "src/page.tsx": "export const page = 1;\n", "src/both.ts": "export const both = 1;\n", "docs/notes.md": "# notes\n" })) write(root, f, t);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");

    // Session A: one Edit, then Bash for the rest.
    write(root, "src/api.ts", "export const api = 2;\n");
    write(root, "src/util.ts", "export const u = 2;\n");
    write(root, "src/new-helper.ts", "export const helper = 1;\n");
    write(root, "docs/notes.md", "# notes\n\nA line written by a heredoc.\n");
    write(root, "src/both.ts", "export const both = 2; // A\nexport const alsoB = 1; // B\n");
    write(root, ".env.local", "SECRET=sk-ant-REDACTEDREDACTEDREDACTEDREDACTED\n");
    // Session B: its own page, and a later line in the file A also changed.
    write(root, "src/page.tsx", "export const page = 2;\n");
    transcript("sess-a", "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [
      tool(root, "Edit", { file_path: path.join(root, "src/api.ts"), old_string: "1", new_string: "2" }, 90_000),
      tool(root, "Bash", { command: `cd ${root}/src && sed -i '' 's/u = 1/u = 2/' util.ts` }, 80_000),
      tool(root, "Bash", { command: `cat > src/new-helper.ts <<'EOF'\nexport const helper = 1;\nEOF` }, 70_000),
      tool(root, "Bash", { command: `cd ${root} && python3 - <<'EOF'\np='docs/notes.md'\nopen(p,'a').write('A line written by a heredoc.')\nEOF` }, 60_000),
      tool(root, "Edit", { file_path: path.join(root, "src/both.ts"), old_string: "1", new_string: "2" }, 50_000),
      tool(root, "Bash", { command: `printf 'SECRET=x' > .env.local` }, 45_000),
    ]);
    transcript("sess-b", "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [
      tool(root, "Edit", { file_path: path.join(root, "src/page.tsx"), old_string: "1", new_string: "2" }, 40_000),
      tool(root, "Edit", { file_path: path.join(root, "src/both.ts"), old_string: "", new_string: "export const alsoB = 1;" }, 30_000),
    ]);
    const statusBefore = git(root, "status", "--porcelain");
    const headBefore = git(root, "rev-parse", "HEAD");

    const change = await freezeSessionChange(root, "jx7aaaa", { branch: "codecast/change-ct-1", worktree: "change-ct-1", title: "Speed up the api" });

    // All five of A's files, though B wrote both.ts last; B's page and the credential stay out.
    expect(change.paths).toEqual(["docs/notes.md", "src/api.ts", "src/both.ts", "src/new-helper.ts", "src/util.ts"]);
    expect(change.shared).toEqual([{ path: "src/both.ts", also: ["jx7bbbb"], why: "jx7bbbb's edits do not replay: an edit without a string to replace" }]);
    expect(change.paths).not.toContain(".env.local");
    expect(change.session).toBe("jx7aaaa");

    // The commit holds exactly that content, on its own branch, on top of HEAD (no remote, so nothing to replay onto).
    expect(git(root, "rev-parse", "codecast/change-ct-1")).toBe(change.tip);
    expect(git(root, "rev-parse", `${change.tip}^`)).toBe(headBefore);
    expect(change.base).toBe(headBefore);
    expect(change.behind).toBeUndefined();
    expect(git(root, "diff", "--name-only", headBefore, change.tip).split("\n").sort()).toEqual(change.paths);
    expect(git(root, "show", `${change.tip}:src/util.ts`)).toBe("export const u = 2;");
    expect(git(root, "show", `${change.tip}:docs/notes.md`)).toContain("A line written by a heredoc.");
    expect(git(root, "show", `${change.tip}:src/new-helper.ts`)).toBe("export const helper = 1;");
    expect(git(root, "show", `${change.tip}:src/page.tsx`)).toBe("export const page = 1;");
    expect(() => git(root, "cat-file", "-e", `${change.tip}:.env.local`)).toThrow();
    expect(git(root, "log", "-1", "--format=%s", change.tip)).toBe("feat(src): speed up the api");

    // Nothing in the shared tree moved.
    expect(git(root, "status", "--porcelain")).toBe(statusBefore);
    expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);

    // The run starts on the change: its stations read $branch and $worktree from the run's files.
    const flow = parseWorkflowSource(`digraph change {
      start [shape=Mdiamond]
      look [label="Look", shape=parallelogram, script="git -C $project_path show --stat --format=%s $branch > $run_dir/seen.txt && echo diff_base=$diff_base >> $run_dir/seen.txt && echo $worktree >> $run_dir/seen.txt"]
      done [shape=Msquare]
      start -> look -> done
    }`);
    const runDir = lineRunDir(root, runSlug(flow, { task_id: "ct-1" }, "run"));
    writeFrozenChange(runDir, change);
    expect(frozenChangeContext(runDir)).toMatchObject({ branch: "codecast/change-ct-1", worktree: "change-ct-1", change_session: "jx7aaaa" });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      expect(await runWorkflow(flow, { cwd: root, taskId: "ct-1" })).toBe("completed");
    } finally {
      console.log = orig;
    }
    const seen = fs.readFileSync(path.join(runDir, "seen.txt"), "utf-8");
    expect(seen).toContain("feat(src): speed up the api");
    for (const p of change.paths) expect(seen).toContain(p);
    // A reviewer's diff starts where the change was cut: HEAD here, with no upstream.
    expect(seen).toContain(`diff_base=${headBefore}`);
    expect(seen.trim().endsWith("change-ct-1")).toBe(true);
  }, 60_000);

  test("an Edit recorded through a symlinked path still counts (/tmp is /private/tmp on macOS)", async () => {
    freshState();
    const real = path.join(sandbox, "real");
    fs.mkdirSync(path.join(real, "repo"), { recursive: true });
    fs.symlinkSync(real, path.join(sandbox, "link"));
    const root = path.join(real, "repo");
    const typed = path.join(sandbox, "link", "repo");
    git(root, "init", "-q", "-b", "main");
    write(root, "a.ts", "export const a = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    write(root, "a.ts", "export const a = 2;\n");
    transcript("sess-d", "jx7ddddddddddddddddddddddddddddd", [tool(typed, "Edit", { file_path: path.join(typed, "a.ts"), old_string: "1", new_string: "2" }, 10_000)]);
    const change = await freezeSessionChange(root, "jx7dddd", { branch: "codecast/link", worktree: "link" });
    expect(change.paths).toEqual(["a.ts"]);
  });

  test("a session with nothing changed here says so", async () => {
    freshState();
    const root = path.join(sandbox, "quiet");
    fs.mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    write(root, "a.txt", "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    write(root, "a.txt", "b\n");
    transcript("sess-c", "jx7ccccccccccccccccccccccccccccc", [tool(root, "Edit", { file_path: path.join(root, "a.txt"), old_string: "a", new_string: "b" }, 10_000)]);
    const refused = freezeSessionChange(root, "jx7zzzz", { branch: "codecast/x", worktree: "x" });
    await expect(refused).rejects.toThrow(/No uncommitted change/);
    await expect(refused).rejects.toBeInstanceOf(NoSessionChange);
  });
});

describe("a named branch's fix comes back to the run", () => {
  // A run started over ssh on another machine (ct-98831): the session fixes the branch there and pushes it.
  test("a fix pushed from another machine moves the run's change; one committed here does too", async () => {
    const origin = path.join(sandbox, "origin.git");
    const here = path.join(sandbox, "here");
    const there = path.join(sandbox, "there");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "--quiet", origin, here], { env: { ...process.env, ...ENV } });
    write(here, "a.txt", "a\n");
    git(here, "add", "a.txt");
    git(here, "commit", "--quiet", "-m", "base");
    git(here, "push", "--quiet", "origin", "HEAD:main", "HEAD:refs/heads/feat");
    git(here, "fetch", "--quiet", "origin");
    git(here, "branch", "feat", "origin/feat");
    const worktree = path.join(sandbox, "run-wt");
    git(here, "worktree", "add", "--quiet", worktree, "feat");
    const base = git(here, "rev-parse", "feat");
    const runDir = path.join(sandbox, "run-dir");
    fs.mkdirSync(runDir, { recursive: true });
    writeFrozenChange(runDir, { source: "branch", session: "jx7aaaa", base, tip: base, remote_tip: base, branch: "feat", worktree: "run-wt", paths: [], shared: [], held: [] } as any);

    execFileSync("git", ["clone", "--quiet", "--branch", "feat", origin, there], { env: { ...process.env, ...ENV } });
    write(there, "a.txt", "fixed there\n");
    git(there, "commit", "--quiet", "-am", "fix there");
    git(there, "push", "--quiet", "origin", "feat");
    const pushed = git(there, "rev-parse", "HEAD");

    const away = await refreezeSessionChange(here, runDir, worktree);
    expect(away.moved).toBe(true);
    expect(away.change.tip).toBe(pushed);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(pushed);

    write(worktree, "a.txt", "fixed here\n");
    git(worktree, "commit", "--quiet", "-am", "fix here");
    const local = git(worktree, "rev-parse", "HEAD");
    const home = await refreezeSessionChange(here, runDir, worktree);
    expect(home.change.tip).toBe(local);

    // Origin still holds the earlier fix, behind what the run froze: nothing moved.
    const still = await refreezeSessionChange(here, runDir, worktree);
    expect(still.moved).toBe(false);
    expect(still.change.tip).toBe(local);

    // The conflict fix: rebuilt there on an older base and force-pushed, so it descends from nothing the run holds.
    git(there, "fetch", "--quiet", "origin");
    git(there, "reset", "--quiet", "--hard", base);
    write(there, "a.txt", "rebased there\n");
    git(there, "commit", "--quiet", "-am", "fix rebased there");
    git(there, "push", "--quiet", "--force", "origin", "feat");
    const rebased = git(there, "rev-parse", "HEAD");
    const forced = await refreezeSessionChange(here, runDir, worktree);
    expect(forced.moved).toBe(true);
    expect(forced.change.tip).toBe(rebased);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(rebased);
  });

  // Rebased here before the run, while origin still holds the push from before it: that older copy is not a fix.
  test("a branch rebased here keeps its tip when origin holds the copy from before the rebase and nothing was fixed", async () => {
    const origin = path.join(sandbox, "origin-stale.git");
    const here = path.join(sandbox, "here-stale");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "--quiet", origin, here], { env: { ...process.env, ...ENV } });
    write(here, "a.txt", "v1\n");
    git(here, "add", "a.txt");
    git(here, "commit", "--quiet", "-m", "v1");
    git(here, "push", "--quiet", "origin", "HEAD:main", "HEAD:refs/heads/feat");
    const pushed = git(here, "rev-parse", "HEAD");
    write(here, "a.txt", "v2\n");
    git(here, "commit", "--quiet", "--amend", "-am", "v2");
    const amended = git(here, "rev-parse", "HEAD");
    git(here, "branch", "feat", amended);
    git(here, "fetch", "--quiet", "origin");
    const worktree = path.join(sandbox, "run-wt-stale");
    git(here, "worktree", "add", "--quiet", worktree, "feat");
    const runDir = path.join(sandbox, "run-dir-stale");
    fs.mkdirSync(runDir, { recursive: true });
    writeFrozenChange(runDir, { source: "branch", session: "jx7aaaa", base: amended, tip: amended, remote_tip: pushed, branch: "feat", worktree: "run-wt-stale", paths: [], shared: [], held: [] } as any);

    const again = await refreezeSessionChange(here, runDir, worktree);
    expect(again.moved).toBe(false);
    expect(again.change.tip).toBe(amended);
    expect(fs.readFileSync(path.join(worktree, "a.txt"), "utf-8")).toBe("v2\n");
  });

  /** Origin with main and `branch` at one base commit, this checkout's run worktree on `branch`, and another clone on it. */
  function originWorld(name: string, branch = "feat") {
    const origin = path.join(sandbox, `origin-${name}.git`);
    const here = path.join(sandbox, `here-${name}`);
    const there = path.join(sandbox, `there-${name}`);
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "--quiet", origin, here], { env: { ...process.env, ...ENV } });
    write(here, "a.txt", "a\n");
    write(here, "package.json", "{}\n");
    write(here, "bun.lock", "lock 1\n");
    git(here, "add", "-A");
    git(here, "commit", "--quiet", "-m", "base");
    git(here, "push", "--quiet", "origin", "HEAD:refs/heads/main", `HEAD:refs/heads/${branch}`);
    git(here, "fetch", "--quiet", "origin");
    git(here, "branch", branch, `origin/${branch}`);
    const worktree = path.join(sandbox, `run-wt-${name}`);
    git(here, "worktree", "add", "--quiet", worktree, branch);
    execFileSync("git", ["clone", "--quiet", "--branch", branch, origin, there], { env: { ...process.env, ...ENV } });
    const runDir = path.join(sandbox, `run-dir-${name}`);
    // The run starts on the branch as it stands: its recorded base is its head then, and origin's tip is that too.
    const start = () => {
      const tip = git(here, "rev-parse", branch);
      writeFrozenChange(runDir, { source: "task", session: "jx7aaaa", base: tip, tip, remote_tip: git(origin, "rev-parse", branch), branch, worktree: `run-wt-${name}`, paths: [], shared: [], held: [] } as any);
      return tip;
    };
    const push = (file: string, text: string, msg: string) => {
      write(there, file, text);
      git(there, "add", file);
      git(there, "commit", "--quiet", "-m", msg);
      git(there, "push", "--quiet", "origin", branch);
      return git(there, "rev-parse", "HEAD");
    };
    return { origin, here, there, worktree, runDir, start, push };
  }

  test("an edit left uncommitted in the run's worktree goes on a tip pushed from elsewhere, here only, and stays through the next fix pushed there; a conflict refuses (ct-99118)", async () => {
    const { origin, here, worktree, runDir, start, push } = originWorld("carry");
    start();
    await snapshotRunTree(worktree, runDir);
    write(worktree, "b.txt", "left here\n");
    const pushed = push("a.txt", "pushed there\n", "fix there");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "rev-parse", `${change.tip}^`)).toBe(pushed);
    expect([git(here, "show", `${change.tip}:a.txt`), git(here, "show", `${change.tip}:b.txt`)]).toEqual(["pushed there", "left here"]);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(change.tip);
    // The refreeze pushes nothing: the run's PR station pushes the branch.
    expect(git(origin, "rev-parse", "feat")).toBe(pushed);

    // The next fix is pushed from elsewhere on origin's tip, which lacks the carry: the carry goes on top of it again.
    const again = push("a.txt", "fixed again there\n", "fix again there");
    await snapshotRunTree(worktree, runDir);
    const second = (await refreezeSessionChange(here, runDir, worktree)).change;
    expect(git(here, "rev-parse", `${second.tip}^`)).toBe(again);
    expect([git(here, "show", `${second.tip}:a.txt`), git(here, "show", `${second.tip}:b.txt`)]).toEqual(["fixed again there", "left here"]);
    expect(fs.readFileSync(path.join(worktree, "b.txt"), "utf-8")).toBe("left here\n");

    // Elsewhere b.txt is written otherwise and pushed, while another edit to it waits here: nothing moves.
    await snapshotRunTree(worktree, runDir);
    write(worktree, "b.txt", "left here again\n");
    const theirs = push("b.txt", "pushed b\n", "b there");
    await expect(refreezeSessionChange(here, runDir, worktree)).rejects.toThrow(/conflict with origin's feat/);
    expect(git(here, "rev-parse", "feat")).toBe(second.tip);
    expect(git(origin, "rev-parse", "feat")).toBe(theirs);
    expect(readFrozenChange(runDir)?.tip).toBe(second.tip);
    expect(fs.readFileSync(path.join(worktree, "b.txt"), "utf-8")).toBe("left here again\n");
  }, 180_000);

  test("another clone's push between rounds goes under the session's commit and carry (ct-99118)", async () => {
    const { origin, here, worktree, runDir, start, push } = originWorld("under");
    start();
    const theirs = push("y.txt", "another clone\n", "y there");
    await snapshotRunTree(worktree, runDir);
    // The session commits one fix in the worktree and leaves another uncommitted.
    write(worktree, "x.txt", "committed here\n");
    git(worktree, "add", "x.txt");
    git(worktree, "commit", "--quiet", "-m", "x here");
    write(worktree, "z.txt", "left here\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "merge-base", "--is-ancestor", theirs, change.tip)).toBe("");
    expect(["x.txt", "y.txt", "z.txt"].map((f) => git(here, "show", `${change.tip}:${f}`))).toEqual(["committed here", "another clone", "left here"]);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(change.tip);
    expect(git(origin, "rev-parse", "feat")).toBe(theirs);
  }, 180_000);

  test("a commit a force-push took off origin is not brought back by the replay (ct-99118)", async () => {
    const { origin, here, there, worktree, runDir, start } = originWorld("force");
    // The branch held x.txt, here and on origin, when the run last froze it.
    write(worktree, "x.txt", "taken off later\n");
    git(worktree, "add", "x.txt");
    git(worktree, "commit", "--quiet", "-m", "x");
    git(worktree, "push", "--quiet", "origin", "feat");
    start();
    // Elsewhere the branch is rebuilt without it and force-pushed.
    git(there, "fetch", "--quiet", "origin");
    git(there, "reset", "--quiet", "--hard", "origin/main");
    write(there, "y.txt", "rebuilt\n");
    git(there, "add", "y.txt");
    git(there, "commit", "--quiet", "-m", "y");
    git(there, "push", "--quiet", "--force", "origin", "feat");
    const rebuilt = git(origin, "rev-parse", "feat");
    // Here the session commits one fix in the worktree and leaves another uncommitted.
    await snapshotRunTree(worktree, runDir);
    write(worktree, "w.txt", "committed here\n");
    git(worktree, "add", "w.txt");
    git(worktree, "commit", "--quiet", "-m", "w here");
    write(worktree, "z.txt", "left here\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect(git(here, "merge-base", "--is-ancestor", rebuilt, change.tip)).toBe("");
    expect(git(here, "ls-tree", "--name-only", change.tip, "--", "x.txt")).toBe("");
    expect([git(here, "show", `${change.tip}:w.txt`), git(here, "show", `${change.tip}:z.txt`)]).toEqual(["committed here", "left here"]);
    expect(git(origin, "rev-parse", "feat")).toBe(rebuilt);
  }, 180_000);

  test("a file the session committed on a branch is its own push: the refreeze takes it with the carry, credential name or not (ct-99118)", async () => {
    const { here, worktree, runDir, start } = originWorld("own");
    start();
    await snapshotRunTree(worktree, runDir);
    write(worktree, ".env.local", "KEY=1\n");
    git(worktree, "add", ".env.local");
    git(worktree, "commit", "--quiet", "-m", "local env");
    write(worktree, "b.txt", "left here\n");
    const { change } = await refreezeSessionChange(here, runDir, worktree);
    expect([git(here, "show", `${change.tip}:.env.local`), git(here, "show", `${change.tip}:b.txt`)]).toEqual(["KEY=1", "left here"]);
  }, 180_000);

  test("a lockfile regenerated for the branch's own manifest edit, made before the run, is carried (ct-99118)", async () => {
    const { here, worktree, runDir, start } = originWorld("lock");
    write(worktree, "package.json", "{\"dependencies\":{\"y\":\"1\"}}\n");
    git(worktree, "commit", "--quiet", "-am", "add y");
    git(worktree, "push", "--quiet", "origin", "feat");
    start();
    await snapshotRunTree(worktree, runDir);
    write(worktree, "bun.lock", "lock 2\n");
    const { change, held } = await refreezeSessionChange(here, runDir, worktree);
    expect(held).toEqual([]);
    expect(git(here, "show", `${change.tip}:bun.lock`)).toBe("lock 2");
  }, 180_000);

  test("a run worktree taken off the change's branch refuses and is left as it is (ct-99118)", async () => {
    const { here, worktree, runDir, start } = originWorld("off");
    const tip = start();
    git(worktree, "checkout", "--quiet", "-b", "elsewhere");
    await expect(refreezeSessionChange(here, runDir, worktree)).rejects.toThrow(/not the change's branch feat/);
    expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("elsewhere");
    expect(git(here, "rev-parse", "feat")).toBe(tip);
  }, 180_000);
});

// A shared checkout whose HEAD lags its upstream: the change is cut on HEAD,
// then replayed onto the freshly fetched upstream, so Check and Review test it
// on what it would land on. Only the branch ref moves.
describe("a session's change is cut on fresh upstream", () => {
  function lagging(name: string) {
    freshState();
    const dir = path.join(sandbox, name);
    const origin = path.join(dir, "origin.git");
    const seed = path.join(dir, "seed");
    const root = path.join(dir, "shared");
    fs.mkdirSync(seed, { recursive: true });
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(seed, "init", "-q", "-b", "main");
    write(seed, "a.ts", "export const a = 1;\n");
    write(seed, "b.ts", "export const b = 1;\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "base");
    git(seed, "push", "-q", origin, "main");
    git(dir, "clone", "-q", origin, root);
    // Upstream moves on without the shared checkout fetching it.
    const upstream = (file: string, text: string) => {
      write(seed, file, text);
      git(seed, "commit", "-qam", `upstream ${file}`);
      git(seed, "push", "-q", origin, "main");
      return git(origin, "rev-parse", "main");
    };
    // The session edits a.ts in the shared checkout.
    write(root, "a.ts", "export const a = 2;\n");
    transcript(`sess-${name}`, `jx7${name}`.padEnd(32, "0"), [tool(root, "Edit", { file_path: path.join(root, "a.ts"), old_string: "1", new_string: "2" }, 10_000)]);
    const shared = () => ({ head: git(root, "rev-parse", "HEAD"), status: git(root, "status", "--porcelain"), index: git(root, "ls-files", "-s"), a: fs.readFileSync(path.join(root, "a.ts"), "utf-8") });
    return { root, upstream, shared, session: `jx7${name}`.slice(0, 7) };
  }

  test("upstream changed another file: the branch sits on fresh upstream and holds both", async () => {
    const { root, upstream, shared, session } = lagging("upaa");
    const before = shared();

    // HEAD already holds upstream: the change sits on HEAD.
    const first = await freezeSessionChange(root, session, { branch: "codecast/fresh", worktree: "fresh" });
    expect(git(root, "rev-parse", `${first.tip}^`)).toBe(before.head);

    const fresh = upstream("b.ts", "export const b = 2;\n");
    const change = await freezeSessionChange(root, session, { branch: "codecast/fresh", worktree: "fresh" });
    expect(change.paths).toEqual(["a.ts"]);
    expect(git(root, "rev-parse", "codecast/fresh")).toBe(change.tip);
    expect(git(root, "rev-parse", `${change.tip}^`)).toBe(fresh);
    expect(change.base).toBe(fresh);
    expect(change.behind).toBeUndefined();
    expect(git(root, "show", `${change.tip}:a.ts`)).toBe("export const a = 2;");
    expect(git(root, "show", `${change.tip}:b.ts`)).toBe("export const b = 2;");
    expect(git(root, "diff", "--name-only", fresh, change.tip)).toBe("a.ts");
    // The local main lags, so a reviewer diffs from where the change was cut: from main it would show upstream's b.ts too.
    const runDir = path.join(root, ".git", "run-fresh");
    writeFrozenChange(runDir, change);
    expect(frozenChangeContext(runDir).diff_base).toBe(fresh);
    expect(git(root, "diff", "--name-only", `${frozenChangeContext(runDir).diff_base}...codecast/fresh`)).toBe("a.ts");
    expect(git(root, "diff", "--name-only", "main...codecast/fresh").split("\n").sort()).toEqual(["a.ts", "b.ts"]);
    // The fetch moved the remote-tracking ref, nothing else.
    expect(git(root, "rev-parse", "origin/main")).toBe(fresh);
    expect(shared()).toEqual(before);
  }, 180_000);

  test("a run with no frozen change diffs from the default branch", async () => {
    freshState();
    const root = path.join(sandbox, "plain");
    fs.mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    write(root, "a.txt", "a\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    const flow = parseWorkflowSource(`digraph plain {
      start [shape=Mdiamond]
      look [label="Look", shape=parallelogram, script="mkdir -p $run_dir && echo $diff_base > $run_dir/base.txt"]
      done [shape=Msquare]
      start -> look -> done
    }`);
    const runDir = lineRunDir(root, runSlug(flow, { task_id: "ct-2" }, "run"));
    const orig = console.log;
    console.log = () => {};
    try {
      expect(await runWorkflow(flow, { cwd: root, taskId: "ct-2" })).toBe("completed");
    } finally {
      console.log = orig;
    }
    expect(fs.readFileSync(path.join(runDir, "base.txt"), "utf-8").trim()).toBe("main");
  }, 180_000);

  test("upstream changed the same lines: the branch stays on HEAD and the conflict is recorded", async () => {
    const { root, upstream, shared, session } = lagging("upbb");
    const before = shared();
    const fresh = upstream("a.ts", "export const a = 3;\n");
    const change = await freezeSessionChange(root, session, { branch: "codecast/stale", worktree: "stale" });
    expect(git(root, "rev-parse", `${change.tip}^`)).toBe(before.head);
    expect(change.base).toBe(before.head);
    expect(change.behind).toMatchObject({ upstream: fresh, why: "conflict", conflicts: ["a.ts"] });
    expect(change.behind!.reason).toContain("a.ts");
    expect(behindWords(change)).toMatch(/conflicts with upstream \w+ in a\.ts/);
    expect(git(root, "show", `${change.tip}:a.ts`)).toBe("export const a = 2;");
    expect(shared()).toEqual(before);

    // The checkout's change is cut the same way.
    const pass = await freezeCheckoutChange(root, { branch: "codecast/stale-pass", worktree: "stale-pass" });
    expect(pass.base).toBe(before.head);
    expect(pass.behind).toMatchObject({ upstream: fresh, why: "conflict", conflicts: ["a.ts"] });
    expect(shared()).toEqual(before);
  }, 180_000);

  test("a merge commit in the checkout's own history cannot be replayed: the change stays on HEAD and says why", async () => {
    const { root, upstream, shared, session } = lagging("upcc");
    git(root, "checkout", "-qb", "side");
    write(root, "c.ts", "export const c = 1;\n");
    git(root, "add", "c.ts");
    git(root, "commit", "-qm", "side");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const before = shared();
    const fresh = upstream("b.ts", "export const b = 2;\n");
    const change = await freezeSessionChange(root, session, { branch: "codecast/merged", worktree: "merged" });
    expect(git(root, "rev-parse", `${change.tip}^`)).toBe(before.head);
    expect(change.behind).toMatchObject({ upstream: fresh, why: "unreplayable", conflicts: [] });
    expect(change.behind!.reason).toContain("merge commit");
    expect(behindWords(change)).toMatch(/could not be replayed onto upstream \w+ \(.*merge commit/);
    expect(shared()).toEqual(before);
  }, 180_000);

  test("a freeze told its preview just fetched does not fetch again", async () => {
    const { root, upstream, shared, session } = lagging("updd");
    const before = shared();
    const stale = git(root, "rev-parse", "origin/main");
    const fresh = upstream("b.ts", "export const b = 2;\n");
    const unfetched = await freezeSessionChange(root, session, { branch: "codecast/once", worktree: "once", fetched: true });
    expect(git(root, "rev-parse", "origin/main")).toBe(stale);
    expect(unfetched.base).toBe(before.head);
    const pass = await freezeCheckoutChange(root, { branch: "codecast/once-pass", worktree: "once-pass", fetched: true });
    expect(git(root, "rev-parse", "origin/main")).toBe(stale);
    expect(pass.base).toBe(before.head);
    // Left to itself, it fetches.
    const fetched = await freezeSessionChange(root, session, { branch: "codecast/once", worktree: "once" });
    expect(fetched.base).toBe(fresh);
  }, 180_000);

  test("a change upstream already holds is reported as landed, by the preview and by a refreeze", async () => {
    const { root, upstream, session } = lagging("upee");
    const change = await freezeSessionChange(root, session, { branch: "codecast/landed", worktree: "landed" });
    expect(change.landed).toBeUndefined();
    const runDir = path.join(root, ".git", "run-landed");
    writeFrozenChange(runDir, change);

    // Someone lands the same edit upstream.
    const fresh = upstream("a.ts", "export const a = 2;\n");
    expect((await previewSessionChange(root, session)).landed).toBe(fresh);
    expect((await previewCheckoutChange(root)).landed).toBe(fresh);
    const pass = await freezeCheckoutChange(root, { branch: "codecast/landed-pass", worktree: "landed-pass" });
    expect(pass.landed).toBe(fresh);
    expect(pass.tip).toBe(fresh);

    const { change: again } = await refreezeSessionChange(root, runDir, null);
    expect(again.landed).toBe(fresh);
    expect(again.tip).toBe(fresh);
    expect(readFrozenChange(runDir)?.landed).toBe(fresh);

    // The level sweep then pulls it in: the session has nothing uncommitted left, and the refreeze still reads landed.
    writeFrozenChange(runDir, change);
    git(root, "fetch", "-q", "origin");
    git(root, "reset", "-q", "--hard", "origin/main");
    await expect(previewSessionChange(root, session)).rejects.toBeInstanceOf(NoSessionChange);
    const { change: levelled, moved } = await refreezeSessionChange(root, runDir, null);
    expect(levelled.landed).toBe(fresh);
    expect(levelled.tip).toBe(change.tip);
    expect(moved).toBe(false);
  }, 180_000);

  test("a landed refreeze with nothing new in the run's worktree keeps the change as it was; landed only once upstream holds what the worktree carried (ct-99118)", async () => {
    const { root, upstream, session } = lagging("upff");
    const runDir = path.join(root, ".git", "run-landed-carry");
    writeFrozenChange(runDir, await freezeSessionChange(root, session, { branch: "codecast/landed-carry", worktree: "landed-carry" }));
    const tree = path.join(sandbox, "upff-wt");
    git(root, "worktree", "add", "--quiet", tree, "codecast/landed-carry");
    await snapshotRunTree(tree, runDir);
    write(tree, "b.ts", "export const b = 'from the worktree';\n");
    const carried = (await refreezeSessionChange(root, runDir, tree)).change;
    expect(carried.carried).toEqual(["b.ts"]);
    const level = () => { git(root, "fetch", "-q", "origin"); git(root, "reset", "-q", "--hard", "origin/main"); };

    // Upstream lands the session's a.ts and the checkout levels with it, but upstream lacks the worktree's b.ts.
    upstream("a.ts", "export const a = 2;\n");
    level();
    await snapshotRunTree(tree, runDir);
    const kept = await refreezeSessionChange(root, runDir, tree);
    expect(kept.change.landed).toBeUndefined();
    expect(kept.change.tip).toBe(carried.tip);
    expect(kept.moved).toBe(false);

    // Once upstream holds b.ts too, the change has landed, as it was.
    const all = upstream("b.ts", "export const b = 'from the worktree';\n");
    level();
    await snapshotRunTree(tree, runDir);
    const landed = await refreezeSessionChange(root, runDir, tree);
    expect(landed.change.landed).toBe(all);
    expect(landed.change.tip).toBe(carried.tip);
    expect(landed.change.carried).toEqual(["b.ts"]);
  }, 180_000);
});

// Two sessions in one file (ct-98915): the Quick run on a fix carried another session's unfinished lines in
// tasks.ts and workflow_runs.ts, and its reviewer sent it back for them.
describe("a file two sessions changed", () => {
  const BASE = "one\ntwo\nthree\nfour\n";
  const failed = (id: string, ms: number) => ({ type: "user", timestamp: at(ms), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "String to replace not found" }] } });
  function world(): string {
    freshState();
    const root = path.join(sandbox, `two-${worlds}`);
    fs.mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    write(root, "src/shared.ts", BASE);
    write(root, "src/other.ts", "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    return root;
  }

  test("each session's change holds only its own lines, and a failed edit is no part of it", async () => {
    const root = world();
    write(root, "src/shared.ts", "ONE\ntwo\nthree\nFOUR\n");
    const missed = { ...tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "nope", new_string: "x" }, 95_000), message: { role: "assistant", content: [{ type: "tool_use", id: "miss-1", name: "Edit", input: { file_path: path.join(root, "src/shared.ts"), old_string: "nope", new_string: "x" } }] } };
    transcript("sess-a", "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [missed, failed("miss-1", 94_000), tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "one", new_string: "ONE" }, 90_000)]);
    transcript("sess-b", "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [tool(root, "MultiEdit", { file_path: path.join(root, "src/shared.ts"), edits: [{ old_string: "four", new_string: "FOUR" }] }, 50_000)]);
    const statusBefore = git(root, "status", "--porcelain");

    const a = await freezeSessionChange(root, "jx7aaaa", { branch: "codecast/a", worktree: "a", title: "Shout one" });
    expect(a.paths).toEqual(["src/shared.ts"]);
    expect(a.shared).toEqual([]);
    expect(git(root, "show", `${a.tip}:src/shared.ts`)).toBe("ONE\ntwo\nthree\nfour");

    const b = await freezeSessionChange(root, "jx7bbbb", { branch: "codecast/b", worktree: "b", title: "Shout four" });
    expect(b.shared).toEqual([]);
    expect(git(root, "show", `${b.tip}:src/shared.ts`)).toBe("one\ntwo\nthree\nFOUR");

    expect(git(root, "status", "--porcelain")).toBe(statusBefore);
    expect(fs.readFileSync(path.join(root, "src/shared.ts"), "utf-8")).toBe("ONE\ntwo\nthree\nFOUR\n");
  });

  test("a file the session also wrote through the shell goes in whole, named as shared", async () => {
    const root = world();
    write(root, "src/shared.ts", "ONE\nTWO\nthree\nFOUR\n");
    transcript("sess-a", "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [
      tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "one", new_string: "ONE" }, 90_000),
      tool(root, "Bash", { command: `sed -i 's/two/TWO/' src/shared.ts` }, 80_000),
    ]);
    transcript("sess-b", "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "four", new_string: "FOUR" }, 50_000)]);
    const a = await freezeSessionChange(root, "jx7aaaa", { branch: "codecast/a", worktree: "a", title: "Shout" });
    expect(a.shared).toEqual([{ path: "src/shared.ts", also: ["jx7bbbb"], why: "jx7aaaa's edits do not replay: a shell command wrote it" }]);
    expect(git(root, "show", `${a.tip}:src/shared.ts`)).toBe("ONE\nTWO\nthree\nFOUR");
  });

  test("lines the other session changed again on top of this session's go in whole", async () => {
    const root = world();
    write(root, "src/shared.ts", "ONE!\ntwo\nthree\nfour\n");
    transcript("sess-a", "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "one", new_string: "ONE" }, 90_000)]);
    transcript("sess-b", "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "ONE", new_string: "ONE!" }, 50_000)]);
    const a = await freezeSessionChange(root, "jx7aaaa", { branch: "codecast/a", worktree: "a", title: "Shout" });
    expect(a.shared).toEqual([{ path: "src/shared.ts", also: ["jx7bbbb"], why: "jx7bbbb's edits do not replay: an edit no longer lands on one place in the committed file" }]);
    expect(git(root, "show", `${a.tip}:src/shared.ts`)).toBe("ONE!\ntwo\nthree\nfour");
  });

  // The reviewer's case: a commit after the session's first edit changed another line of the file, so the replay
  // from that commit leaves the first edit out, while the file on disk still holds it.
  test("a line of the session's own that the file's last commit left out keeps the file whole", async () => {
    const root = world();
    const lines = (...up: number[]) => Array.from({ length: 14 }, (_, i) => (up.includes(i + 1) ? `LINE${i + 1}` : `line${i + 1}`)).join("\n") + "\n";
    write(root, "src/shared.ts", lines());
    git(root, "commit", "-qam", "fourteen lines");
    write(root, "src/shared.ts", lines(14));
    const halfHour = new Date(Date.now() - 1_800_000).toISOString();
    execFileSync("git", ["-C", root, "commit", "-qam", "line 14 only"], { env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: halfHour, GIT_COMMITTER_DATE: halfHour } });
    write(root, "src/shared.ts", lines(1, 5, 10, 14));
    const edit = (from: string, to: string, ms: number) => tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: from, new_string: to }, ms);
    transcript("sess-a", "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [edit("line1\n", "LINE1\n", 2_400_000), edit("line5\n", "LINE5\n", 600_000)]);
    transcript("sess-b", "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [edit("line10\n", "LINE10\n", 1_200_000)]);
    const a = await freezeSessionChange(root, "jx7aaaa", { branch: "codecast/a", worktree: "a", title: "Shout" });
    expect(a.shared).toEqual([{ path: "src/shared.ts", also: ["jx7bbbb"], why: "it holds lines no session's edits since its last commit account for" }]);
    expect(git(root, "show", `${a.tip}:src/shared.ts`)).toContain("LINE1\n");
  });

  test("a line no session's edits explain (a formatter's) keeps the file whole", async () => {
    const root = world();
    write(root, "src/shared.ts", "ONE\ntwo\nthree\nFOUR\n// formatted\n");
    transcript("sess-a", "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "one", new_string: "ONE" }, 90_000)]);
    transcript("sess-b", "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "four", new_string: "FOUR" }, 50_000)]);
    const a = await freezeSessionChange(root, "jx7aaaa", { branch: "codecast/a", worktree: "a", title: "Shout" });
    expect(a.shared.map((x) => x.path)).toEqual(["src/shared.ts"]);
    expect(git(root, "show", `${a.tip}:src/shared.ts`)).toContain("// formatted");
  });

  test("a session's own failed last edit does not keep the file whole", async () => {
    const root = world();
    write(root, "src/shared.ts", "ONE\ntwo\nthree\nFOUR\n");
    const miss = { type: "assistant", timestamp: at(60_000), cwd: root, message: { role: "assistant", content: [{ type: "tool_use", id: "miss-2", name: "Edit", input: { file_path: path.join(root, "src/shared.ts"), old_string: "nope", new_string: "x" } }] } };
    transcript("sess-a", "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "one", new_string: "ONE" }, 90_000), miss, failed("miss-2", 59_000)]);
    transcript("sess-b", "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "four", new_string: "FOUR" }, 50_000)]);
    const a = await freezeSessionChange(root, "jx7aaaa", { branch: "codecast/a", worktree: "a", title: "Shout" });
    expect(a.shared).toEqual([]);
    expect(git(root, "show", `${a.tip}:src/shared.ts`)).toBe("ONE\ntwo\nthree\nfour");
  });

  test("a file that is not UTF-8 goes in whole, its bytes as they are", async () => {
    const root = world();
    fs.writeFileSync(path.join(root, "src/shared.ts"), Buffer.concat([Buffer.from("one\ncaf"), Buffer.from([0xe9]), Buffer.from("\nthree\nfour\n")]));
    git(root, "commit", "-qam", "latin-1");
    const edited = Buffer.concat([Buffer.from("ONE\ncaf"), Buffer.from([0xe9]), Buffer.from("\nthree\nFOUR\n")]);
    fs.writeFileSync(path.join(root, "src/shared.ts"), edited);
    transcript("sess-a", "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "one", new_string: "ONE" }, 90_000)]);
    transcript("sess-b", "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "four", new_string: "FOUR" }, 50_000)]);
    const a = await freezeSessionChange(root, "jx7aaaa", { branch: "codecast/a", worktree: "a", title: "Shout" });
    expect(a.shared).toEqual([{ path: "src/shared.ts", also: ["jx7bbbb"], why: "it is not UTF-8 text" }]);
    expect(execFileSync("git", ["-C", root, "show", `${a.tip}:src/shared.ts`])).toEqual(edited);
  });

  test("a subject whose cut file landed has no other work, though the checkout still holds the other session's lines", async () => {
    const root = world();
    write(root, "src/shared.ts", "ONE\ntwo\nthree\nFOUR\n");
    transcript("sess-a", "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "one", new_string: "ONE" }, 90_000)]);
    transcript("sess-b", "jx7bbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [tool(root, "Edit", { file_path: path.join(root, "src/shared.ts"), old_string: "four", new_string: "FOUR" }, 50_000)]);
    const a = await freezeSessionChange(root, "jx7aaaa", { branch: "codecast/a", worktree: "a", title: "Shout" });
    const { subjectOtherWork } = await import("./subjectPark");
    expect(await subjectOtherWork(root, { conversationId: "jx7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa", shortId: "jx7aaaa" }, a.tip, "HEAD")).toBeNull();
  });
});

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
    await expect(refreezeSessionChange(root, runDir, tree)).rejects.toThrow(/does not hold the change as last frozen/);
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
});
