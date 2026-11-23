// Land's check (landed.ts): the commit on origin's main that carries a branch,
// however it landed, and the line that ends Land when nothing did. Real git.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { landedCommit, landedOrWait, recordMerge, runLanded, type LandedIO } from "./landed";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
let dir = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: ENV }).trim();
const write = (cwd: string, f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true }); fs.writeFileSync(path.join(cwd, f), t); };

let remote = "", work = "", other = "";
beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-landed-")));
  remote = path.join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: ENV });
  work = path.join(dir, "work");
  execFileSync("git", ["clone", "-q", remote, work], { env: ENV, stdio: "ignore" });
  write(work, "api/a.ts", "a1\n");
  write(work, "web/w.ts", "w1\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "base");
  git(work, "push", "-q", "origin", "HEAD:main");
  other = path.join(dir, "other");
  execFileSync("git", ["clone", "-q", remote, other], { env: ENV, stdio: "ignore" });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("landedCommit", () => {
  test("not landed until main holds it; a squash lands as the commit that reads as the branch left it", async () => {
    git(work, "checkout", "-q", "-b", "change");
    write(work, "api/a.ts", "a2\n");
    git(work, "commit", "-qam", "change");
    expect(await landedCommit(work, "change", "main")).toBeNull();

    // Someone else's commit lands first, then the change is squashed onto main.
    write(other, "web/w.ts", "w2\n");
    git(other, "commit", "-qam", "other");
    git(other, "push", "-q", "origin", "HEAD:main");
    expect(await landedCommit(work, "change", "main")).toBeNull();
    git(other, "pull", "-q", "--rebase", "origin", "main");
    write(other, "api/a.ts", "a2\n");
    git(other, "commit", "-qam", "squashed change");
    git(other, "push", "-q", "origin", "HEAD:main");
    const squashed = git(other, "rev-parse", "HEAD");
    expect(await landedCommit(work, "change", "main")).toEqual({ sha: squashed, files: ["api/a.ts"] });
  });

  test("a branch main fast-forwarded to lands as its own tip, with every file since where it started", async () => {
    git(work, "fetch", "-q", "origin", "main");
    git(work, "checkout", "-q", "-b", "ff", "origin/main");
    const start = git(work, "rev-parse", "HEAD");
    write(work, "web/w.ts", "w3\n");
    git(work, "commit", "-qam", "ff change");
    write(work, "api/c.ts", "c\n");
    git(work, "add", "-A");
    git(work, "commit", "-qm", "ff change, second commit");
    git(work, "push", "-q", "origin", "HEAD:main");
    const tip = git(work, "rev-parse", "HEAD");
    // A multi-commit branch fast-forwarded by hand ships all its files, not only its last commit's.
    expect(await landedCommit(work, "ff", "main", { since: start })).toEqual({ sha: tip, files: ["api/c.ts", "web/w.ts"] });
    expect((await landedCommit(work, "ff", "main", { since: start, known: ["web/w.ts", "api/a.ts"] }))?.files).toEqual(["web/w.ts", "api/a.ts"]);
    // Without where it started, a tip main holds may be a branch with no commit of its own: never called landed.
    expect(await landedCommit(work, "ff", "main")).toBeNull();
  });

  // A branch replayed onto a main that changed the same file elsewhere (ct-61888, Nov 7) has no commit reading as
  // the branch left it.
  test("a change replayed onto a main that moved in the same file lands as the commit that holds it", async () => {
    git(other, "pull", "-q", "--rebase", "origin", "main");
    write(other, "api/b.ts", "1\n2\n3\n4\n5\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "b base");
    git(other, "push", "-q", "origin", "HEAD:main");
    git(work, "fetch", "-q", "origin", "main");
    git(work, "checkout", "-q", "-b", "replay", "origin/main");
    write(work, "api/b.ts", "ONE\n2\n3\n4\n5\n");
    git(work, "commit", "-qam", "replay change");
    write(other, "api/b.ts", "1\n2\n3\n4\nFIVE\n");
    git(other, "commit", "-qam", "main moves in the same file");
    git(other, "push", "-q", "origin", "HEAD:main");
    expect(await landedCommit(work, "replay", "main")).toBeNull();
    write(other, "api/b.ts", "ONE\n2\n3\n4\nFIVE\n");
    git(other, "commit", "-qam", "replayed change");
    git(other, "push", "-q", "origin", "HEAD:main");
    expect(await landedCommit(work, "replay", "main")).toEqual({ sha: git(other, "rev-parse", "HEAD"), files: ["api/b.ts"] });
  });
});

// A false "landed" sends a change that never merged on to Deploy, which then ends Live. Each case below is a change
// that never reached main while main moved in the same file (the Nov 21 shape: a land command that did nothing):
// every one must read as not landed. Each runs in its own repository.
describe("landedCommit never calls an unmerged change landed", () => {
  const probe = (files: Record<string, string>, branchEdit: (w: string) => void, mainEdit: (o: string) => void) => async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-landed-probe-")));
    try {
      const origin = path.join(root, "origin.git");
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: ENV });
      const w = path.join(root, "w");
      const o = path.join(root, "o");
      execFileSync("git", ["clone", "-q", origin, w], { env: ENV, stdio: "ignore" });
      for (const [f, t] of Object.entries(files)) write(w, f, t);
      git(w, "add", "-A");
      git(w, "commit", "-qm", "base");
      git(w, "push", "-q", "origin", "HEAD:main");
      execFileSync("git", ["clone", "-q", origin, o], { env: ENV, stdio: "ignore" });
      const start = git(w, "rev-parse", "HEAD");
      git(w, "checkout", "-q", "-b", "change");
      branchEdit(w);
      git(w, "add", "-A");
      git(w, "commit", "-qm", "the change, never landed");
      mainEdit(o);
      git(o, "add", "-A");
      git(o, "commit", "-qm", "main moves in the same file");
      git(o, "push", "-q", "origin", "HEAD:main");
      expect(await landedCommit(w, "change", "main", { since: start })).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  test("the change adds a line in one function; main adds the same line in another", probe(
    { "a.ts": "function a() {\n  x();\n}\nfunction b() {\n  y();\n}\n" },
    (w) => write(w, "a.ts", "function a() {\n  x();\n  return null;\n}\nfunction b() {\n  y();\n}\n"),
    (o) => write(o, "a.ts", "function a() {\n  x();\n}\nfunction b() {\n  y();\n  return null;\n}\n"),
  ));

  test("the change deletes a line; main re-indents the file", probe(
    { "a.ts": "start();\ndebug();\nend();\n" },
    (w) => write(w, "a.ts", "start();\nend();\n"),
    (o) => write(o, "a.ts", "  start();\n  debug();\n  end();\n"),
  ));

  test("the change deletes a line; main changes that line", probe(
    { "a.ts": "LIMIT = 5\nOTHER = 1\n" },
    (w) => write(w, "a.ts", "OTHER = 1\n"),
    (o) => write(o, "a.ts", "LIMIT = 50\nOTHER = 1\n"),
  ));

  test("the change replaces a line with one main's own rewrite happens to contain", probe(
    { "a.ts": "run();\nfoo();\ndone();\n" },
    (w) => write(w, "a.ts", "run();\n  });\ndone();\n"),
    (o) => write(o, "a.ts", "run();\n  foo(() => {\n    x();\n  });\ndone();\n"),
  ));

  test("the change duplicates a line and deletes another; main deletes that other for its own reason", probe(
    { "a.ts": "keep();\nold();\n" },
    (w) => write(w, "a.ts", "keep();\nkeep();\n"),
    (o) => write(o, "a.ts", "keep();\n"),
  ));

  // Absent on main is no proof a deletion landed: main may have moved the file.
  test("the change only deletes a file; main moves it", probe(
    { "old.ts": "x\n", "other.ts": "y\n" },
    (w) => fs.rmSync(path.join(w, "old.ts")),
    (o) => { fs.renameSync(path.join(o, "old.ts"), path.join(o, "new.ts")); },
  ));

  test("the change edits one part of a file; main edits another part of it", probe(
    { "a.ts": "1\n2\n3\n4\n5\n6\n7\n8\n" },
    (w) => write(w, "a.ts", "ONE\n2\n3\n4\n5\n6\n7\n8\n"),
    (o) => write(o, "a.ts", "1\n2\n3\n4\n5\n6\n7\nEIGHT\n"),
  ));
});

// A match of the change's files alone is no proof the change is on main: merging the branch into the commit must change
// nothing too. Each case matches every listed file on main while part of the branch never got there.
describe("landedCommit needs main to hold the whole branch, not only its files", () => {
  const repo = async (body: (r: { w: string; o: string; start: string; commit: (cwd: string, msg: string) => void }) => Promise<void>) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-landed-whole-")));
    try {
      const origin = path.join(root, "origin.git");
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: ENV });
      const w = path.join(root, "w");
      const o = path.join(root, "o");
      execFileSync("git", ["clone", "-q", origin, w], { env: ENV, stdio: "ignore" });
      write(w, "a.sh", "x\n");
      write(w, "keep.txt", "k\n");
      git(w, "add", "-A");
      git(w, "commit", "-qm", "base");
      git(w, "push", "-q", "origin", "HEAD:main");
      execFileSync("git", ["clone", "-q", origin, o], { env: ENV, stdio: "ignore" });
      const commit = (cwd: string, msg: string) => { git(cwd, "add", "-A"); git(cwd, "commit", "-qm", msg); };
      await body({ w, o, start: git(w, "rev-parse", "HEAD"), commit });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  test("a branch that merged another, non-main branch: main took only the branch's own file", () => repo(async ({ w, o, start, commit }) => {
    git(w, "checkout", "-q", "-b", "side");
    write(w, "side.txt", "side\n");
    commit(w, "a side branch's change");
    git(w, "checkout", "-q", "-b", "change", start);
    write(w, "a.sh", "own\n");
    commit(w, "the change");
    git(w, "merge", "-q", "--no-ff", "--no-edit", "side");
    write(o, "a.sh", "own\n");
    commit(o, "the change's own file, without the side branch");
    git(o, "push", "-q", "origin", "HEAD:main");
    expect(await landedCommit(w, "change", "main", { since: start })).toBeNull();
  }));

  test("a narrow $change_files: main took the listed file and not the rest of the branch", () => repo(async ({ w, o, start, commit }) => {
    git(w, "checkout", "-q", "-b", "change");
    write(w, "a.sh", "own\n");
    write(w, "keep.txt", "changed too\n");
    commit(w, "the change");
    write(o, "a.sh", "own\n");
    commit(o, "only the listed file");
    git(o, "push", "-q", "origin", "HEAD:main");
    expect(await landedCommit(w, "change", "main", { since: start, known: ["a.sh"] })).toBeNull();
  }));

  test("a mode-only change: main's file reads the same but was never made executable", () => repo(async ({ w, o, start, commit }) => {
    git(w, "checkout", "-q", "-b", "change");
    fs.chmodSync(path.join(w, "a.sh"), 0o755);
    commit(w, "make it executable");
    write(o, "a.sh", "y\n");
    commit(o, "main edits the file");
    write(o, "a.sh", "x\n");
    commit(o, "and puts it back");
    git(o, "push", "-q", "origin", "HEAD:main");
    expect(await landedCommit(w, "change", "main", { since: start })).toBeNull();
  }));
});

// Deploy waits on the targets the change's files touch; a merge of main into the branch brings main's files, not the change's.
test("a branch that merged main in lands with only its own commits' files", async () => {
  git(other, "pull", "-q", "--rebase", "origin", "main");
  git(work, "fetch", "-q", "origin", "main");
  git(work, "checkout", "-q", "-b", "merged-in", "origin/main");
  const start = git(work, "rev-parse", "HEAD");
  write(work, "own/b.txt", "b\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "the change");
  write(other, "theirs/c.txt", "c\n");
  git(other, "add", "-A");
  git(other, "commit", "-qm", "main's own change");
  git(other, "push", "-q", "origin", "HEAD:main");
  git(work, "fetch", "-q", "origin", "main");
  git(work, "merge", "-q", "--no-edit", "origin/main");
  git(work, "push", "-q", "origin", "HEAD:main");
  expect(await landedCommit(work, "merged-in", "main", { since: start })).toEqual({ sha: git(work, "rev-parse", "HEAD"), files: ["own/b.txt"] });
});

describe("cast flow landed", () => {
  const capture = async (opts: Parameters<typeof runLanded>[1]) => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((l: string) => { lines.push(l); });
    try { return { code: await runLanded(work, opts), lines }; } finally { log.mockRestore(); }
  };

  test("writes the commit that carries a landed branch to merge.json and prints it last", async () => {
    const out = path.join(dir, "run", "merge.json");
    const r = await capture({ branch: "ff", base: "main", out, since: git(work, "rev-parse", "ff~2") });
    const tip = git(work, "rev-parse", "ff");
    expect(r).toEqual({ code: 0, lines: [tip] });
    expect(JSON.parse(fs.readFileSync(out, "utf-8"))).toEqual({ sha: tip, files: ["api/c.ts", "web/w.ts"] });
  });

  // Nov 21 (ct-98322): the land command applied the change to a working tree and exited 0; main never moved.
  test("fails with nothing merged when the land command exited 0 but main does not carry the branch", async () => {
    git(work, "checkout", "-q", "-b", "applied", "origin/main");
    write(work, "web/w.ts", "applied only\n");
    git(work, "commit", "-qam", "never pushed");
    const out = path.join(dir, "run2", "merge.json");
    expect(await capture({ branch: "applied", base: "main", out })).toEqual({ code: 1, lines: ["Land reported success but applied is not on main: nothing was merged"] });
    expect(fs.existsSync(out)).toBe(false);
    expect((await capture({ branch: "", base: "main" })).code).toBe(1);
  });

  // A branch with no commit of its own sits on main already: its tip is an old main commit, not a landing.
  test("a branch with nothing of its own since the run's start is never landed, though its tip is on main", async () => {
    git(work, "fetch", "-q", "origin", "main");
    git(work, "checkout", "-q", "-b", "empty", "origin/main");
    const start = git(work, "rev-parse", "HEAD");
    expect(await landedCommit(work, "empty", "main", { since: start })).toBeNull();
    expect(await landedCommit(work, "empty", "main", { since: start, known: ["web/w.ts"] })).toBeNull();
    // The same check passes a fast-forward that carried a commit of its own.
    const ffStart = git(work, "rev-parse", "ff~1");
    expect((await landedCommit(work, "ff", "main", { since: ffStart }))?.sha).toBe(git(work, "rev-parse", "ff"));
  });
});

describe("landedOrWait: Land on a pull request Ship's session merges", () => {
  const io = (over: Partial<LandedIO> & { mergedAt?: number } = {}) => {
    let now = 0;
    const lines: string[] = [];
    const base: LandedIO = {
      landed: async () => (over.mergedAt !== undefined && now >= over.mergedAt ? { sha: "abc1234", files: ["a.ts"] } : null),
      pr: () => ({ url: "https://github.com/o/r/pull/7", state: "OPEN" }),
      now: () => now,
      sleep: async (ms) => { now += ms; },
      progress: (l) => lines.push(l),
    };
    return { io: { ...base, ...over }, lines };
  };

  test("waits for the merge, naming the pull request, then reports the commit", async () => {
    const f = io({ mergedAt: 90_000 });
    expect(await landedOrWait({ branch: "b", base: "main", wait: "3600", interval: "30" }, f.io)).toEqual({ code: 0, line: "abc1234", sha: "abc1234", files: ["a.ts"], pr_url: "https://github.com/o/r/pull/7" });
    expect(f.lines[0]).toBe("Waiting for pull request https://github.com/o/r/pull/7 to merge (0m of 60m)");
  });

  test("a pull request still open at the end of the wait is no false 'nothing was merged'", async () => {
    const r = await landedOrWait({ branch: "b", base: "main", wait: "600", interval: "60" }, io().io);
    expect(r).toEqual({ code: 2, line: "The ship session's pull request https://github.com/o/r/pull/7 has not merged after 10m, so this run will not deploy the change" });
  });

  test("a pull request closed unmerged ends it at once; without a wait nothing on main is nothing merged", async () => {
    expect((await landedOrWait({ branch: "b", base: "main", wait: "600" }, io({ pr: () => ({ url: "u", state: "CLOSED" }) }).io)).code).toBe(1);
    expect(await landedOrWait({ branch: "b", base: "main" }, io().io)).toEqual({ code: 1, line: "Land reported success but b is not on main: nothing was merged" });
  });
});

// run.merge.sha is the one landed truth the web reads, however the change landed.
describe("recordMerge: the landed commit goes on the run as its merge", () => {
  const merge = { run_id: "run1", sha: "abc1234def", branch: "codecast/change-ct-1", into: "main" };
  const server = (runMerge: { sha?: string } | null, fail?: string) => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const post = async (p: string, body: Record<string, unknown>) => {
      posts.push({ path: p, body: structuredClone(body) });
      if (fail && p === fail) throw new Error("server said no");
      return p === "/cli/workflow-runs/get" ? { run: { merge: runMerge } } : { used: 0 };
    };
    return { posts, post };
  };

  test("records it the way cast line merge does", async () => {
    const s = server(null);
    expect(await recordMerge(s.post, { ...merge, pr_url: "https://github.com/o/r/pull/7" }, () => {})).toBe("recorded");
    // An observed landing: no allowance was checked for it, so it spends none.
    expect(s.posts[1]).toEqual({ path: "/cli/line/merge/record", body: { ...merge, pr_url: "https://github.com/o/r/pull/7", observed: true } });
  });

  test("leaves a merge the Merge station already recorded, so a role's merge is not counted twice", async () => {
    const s = server({ sha: merge.sha });
    expect(await recordMerge(s.post, merge, () => {})).toBe("already");
    expect(s.posts.map((p) => p.path)).toEqual(["/cli/workflow-runs/get"]);
  });

  test("a record that fails is logged and Land goes on", async () => {
    const logged: string[] = [];
    expect(await recordMerge(server(null, "/cli/line/merge/record").post, merge, (l) => logged.push(l))).toBe("failed");
    expect(logged).toEqual(["Could not record the merge of abc1234def on the run: server said no"]);
  });

  // The Merge station (cast line merge) records main's landed sha; Land finding the same commit records nothing more.
  test("a run whose merge already names main's landed commit is not recorded twice", async () => {
    const s = server({ sha: git(work, "rev-parse", "ff") });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runLanded(work, { branch: "ff", base: "main", run: "run1", since: git(work, "rev-parse", "ff~2") }, s.post)).toBe(0);
    } finally { log.mockRestore(); }
    expect(s.posts.map((p) => p.path)).toEqual(["/cli/workflow-runs/get"]);
  });

  test("cast flow landed records the merge when it finds the change, and still exits 0 when the record fails", async () => {
    const s = server(null, "/cli/line/merge/record");
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((l: string) => { lines.push(l); });
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runLanded(work, { branch: "ff", base: "main", run: "run1", since: git(work, "rev-parse", "ff~2") }, s.post)).toBe(0);
    } finally { log.mockRestore(); err.mockRestore(); }
    expect(s.posts.map((p) => p.path)).toEqual(["/cli/workflow-runs/get", "/cli/line/merge/record"]);
    expect(s.posts[1].body).toMatchObject({ run_id: "run1", sha: git(work, "rev-parse", "ff"), branch: "ff", into: "main" });
  });
});

