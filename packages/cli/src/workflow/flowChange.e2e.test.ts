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
import { freezeSessionChange, frozenChangeContext, refreezeSessionChange, writeFrozenChange } from "./flowChange";
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
    expect(change.shared).toEqual([{ path: "src/both.ts", also: ["jx7bbbb"] }]);
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
      look [label="Look", shape=parallelogram, script="git -C $project_path show --stat --format=%s $branch > $run_dir/seen.txt && echo $worktree >> $run_dir/seen.txt"]
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
    await expect(freezeSessionChange(root, "jx7zzzz", { branch: "codecast/x", worktree: "x" })).rejects.toThrow(/No uncommitted change/);
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
    // The fetch moved the remote-tracking ref, nothing else.
    expect(git(root, "rev-parse", "origin/main")).toBe(fresh);
    expect(shared()).toEqual(before);
  }, 30_000);

  test("upstream changed the same lines: the branch stays on HEAD and the conflict is recorded", async () => {
    const { root, upstream, shared, session } = lagging("upbb");
    const before = shared();
    const fresh = upstream("a.ts", "export const a = 3;\n");
    const change = await freezeSessionChange(root, session, { branch: "codecast/stale", worktree: "stale" });
    expect(git(root, "rev-parse", `${change.tip}^`)).toBe(before.head);
    expect(change.base).toBe(before.head);
    expect(change.behind).toEqual({ upstream: fresh, conflicts: ["a.ts"] });
    expect(git(root, "show", `${change.tip}:a.ts`)).toBe("export const a = 2;");
    expect(shared()).toEqual(before);
  }, 30_000);
});
