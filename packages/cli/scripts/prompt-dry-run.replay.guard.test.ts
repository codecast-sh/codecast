// The prompt dry run harness, run as a subprocess with a fake `claude` and a
// fake real `cast` (prompt-dry-run.guard-helpers.ts): a replayed checkout in
// the closed world: git through worktrees and shared clones, the evals home,
// and a line replay end to end.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { replayCwd } from "../src/lineReplay.ts";
import { harnessWorld, PG, world, write } from "./prompt-dry-run.guard-helpers.ts";

// Every test spawns bash and a fake CLI; on a loaded machine one spawn can take a second.
setDefaultTimeout(30_000);

describe("prompt-dry-run.ts: replayed checkouts", () => {
  test.if(process.platform === "darwin")("a replayed checkout works: git through a worktree or a shared clone, linked dependencies, the run's own env file", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const repos = path.join(h.dir, "repos");
    const main = path.join(repos, "main");
    fs.mkdirSync(main, { recursive: true });
    const git = (cwd: string, ...args: string[]) => { const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
    git(main, "init", "-q", "-b", "main");
    write(path.join(main, "a.txt"), "a\n");
    git(main, "add", "a.txt");
    git(main, "commit", "-q", "-m", "first-commit");
    git(main, "worktree", "add", "-q", path.join(repos, "wt"));
    const deps = path.join(repos, "deps", "node_modules");
    write(path.join(deps, "dep", "package.json"), '{"name":"dep"}\n');
    fs.mkdirSync(h.runDir, { recursive: true });
    const tree = path.join(h.runDir, "tree");
    git(h.runDir, "clone", "-q", "--shared", main, tree);
    fs.symlinkSync(deps, path.join(tree, "node_modules"));
    write(path.join(tree, ".env.replay"), "DATABASE_URL=postgres://reader@127.0.0.1:1/db\n");
    const t = (name: string, cmd: string) => `( ${cmd} ) >/dev/null 2>&1; echo "${name} $?"`;
    const clone = [t("clone-log", "git log -1 --format=%s"), t("clone-deps", "cat node_modules/dep/package.json"), t("clone-env", "cat .env.replay")].join("; ");
    const r = h.runWith({ FAKE_CLAUDE_BASH: clone }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--cwd", tree, "--read", deps);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    for (const name of ["clone-log", "clone-deps", "clone-env"]) expect(h.recorded("bash")).toContain(`${name} 0`);
    // A Try station in a worktree of the real checkout: its .git is a file pointing into the main checkout's .git,
    // which also holds another session's stash and tools' data (round-4 review): git works, those stay closed.
    write(path.join(main, "a.txt"), "someone else's uncommitted work\n");
    git(main, "stash", "-q");
    write(path.join(main, ".git", "codecast-tool", "state.json"), '{"tool":"data"}\n');
    const common = fs.realpathSync(path.join(main, ".git"));
    const h2 = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const wtBash = [
      `echo "worktree-msg $(git log -1 --format=%s 2>&1)"`,
      t("read-stash-ref", `cat '${common}/refs/stash'`),
      t("git-stash-list", "git stash list | grep -q ."),
      t("list-common", `ls '${common}'`),
      t("read-tool-data", `cat '${common}/codecast-tool/state.json'`),
    ].join("; ");
    const r2 = h2.runWith({ FAKE_CLAUDE_BASH: wtBash }, "--run", h2.runDir, "--prompt", h2.prompt, "--model", "m", "--account", "fake", "--cwd", path.join(repos, "wt"));
    expect(r2.err).toBe("");
    const wtSaid = h2.recorded("bash")!;
    expect(wtSaid).toContain("worktree-msg first-commit");
    for (const name of ["read-stash-ref", "git-stash-list", "list-common", "read-tool-data"]) expect({ name, ok: wtSaid.includes(`${name} 0`) }).toEqual({ name, ok: false });
  }, 60_000);

  // An evals run's dir and its baked guard sit inside the evals home, a closed data home: a path through it must still
  // resolve (round 5 found /usr/bin/env spinning on the guard's #!/usr/bin/env shebang there), and git must not climb
  // out of the run into whatever repository holds the evals home.

  test.if(process.platform === "darwin")("a run inside the evals home runs its guard, cast and git, and still lists nothing of the home", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const home = h.dir;
    Bun.spawnSync(["git", "init", "-q", home]);
    const run = path.join(home, ".local", "share", "codecast", "evals", "runs", "r1", "agent");
    fs.mkdirSync(path.join(run, ".rec"), { recursive: true });
    write(path.join(run, ".rec", "stream.jsonl"), JSON.stringify({ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }) + "\n");
    const bash = [
      `/usr/bin/perl -e 'alarm 20; exec @ARGV' git status --short > /dev/null 2>&1; echo "git $?"`,
      `/usr/bin/perl -e 'alarm 20; exec @ARGV' cast task ls > /dev/null 2>&1; echo "cast $?"`,
      `ls '${path.join(home, ".local", "share")}' > /dev/null 2>&1; echo "list-share $?"`,
    ].join("; ");
    const r = h.runWith({ FAKE_CLAUDE_BASH: bash, FAKE_CLAUDE_REC: path.join(run, ".rec"), FAKE_CLAUDE_STREAM: path.join(run, ".rec", "stream.jsonl") }, "--run", run, "--prompt", h.prompt, "--model", "m", "--account", "fake");
    expect(r.err).toBe("");
    const said = fs.readFileSync(path.join(run, ".rec", "bash"), "utf8");
    // Not a repository: git stopped at the run dir rather than walking the home's repository (128), and did not hang (142).
    expect(said).toContain("git 128");
    expect(said).toContain("cast 0");
    expect(said).not.toContain("list-share 0");
  }, 60_000);

  // Round-4 review (2026-11-16): a write run through a layer the end-of-run parse cannot see (a script, eval, a
  // subprocess) with DRY_RUN_BROKER blanked left no line; and a cast the shell never ran was counted as REFUSED.

  test.if(process.platform === "darwin" && !!PG)("end to end: a line replay and a Try station run git, tests and a read-only database in the closed world", async () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const pg = path.join(h.dir, "pg");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const sh = (cmd: string[], env: Record<string, string> = {}) => { const r = Bun.spawnSync(cmd, { env: { ...process.env, ...env } }); if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`); return r.stdout.toString(); };
    sh([`${PG}/initdb`, "-D", pg, "-U", "owner", "-A", "trust"], { LC_ALL: "C" });
    // A socket path has a ~100 byte limit, so the socket dir is a short one.
    const sock = fs.mkdtempSync("/tmp/pg-");
    sh([`${PG}/pg_ctl`, "-D", pg, "-l", path.join(h.dir, "pg.log"), "-o", `-p ${port} -k ${sock} -h 127.0.0.1`, "-w", "start"], { LC_ALL: "C" });
    try {
      const psql = (sql: string) => sh([`${PG}/psql`, "-h", "127.0.0.1", "-p", String(port), "-U", "owner", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tAc", sql]);
      psql("create table notes (note text); insert into notes values ('from-the-db'); create role reader login; grant select on notes to reader;");
      // A repository with a test file whose import resolves through its node_modules.
      const top = path.join(h.dir, "repo");
      const git = (cwd: string, ...args: string[]) => sh(["git", "-C", cwd, ...args], { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
      fs.mkdirSync(top, { recursive: true });
      git(top, "init", "-q", "-b", "main");
      write(path.join(top, "package.json"), '{"name":"e2e","private":true}\n');
      write(path.join(top, "math.test.ts"), 'import { expect, test } from "bun:test";\nimport { add } from "adder";\ntest("adds", () => expect(add(2, 3)).toBe(5));\n');
      write(path.join(top, ".gitignore"), "node_modules\n.env.e2e\n");
      git(top, "add", "-A");
      git(top, "commit", "-q", "-m", "e2e-commit");
      write(path.join(top, "node_modules", "adder", "package.json"), '{"name":"adder","main":"index.js"}\n');
      write(path.join(top, "node_modules", "adder", "index.js"), "exports.add = (a, b) => a + b;\n");
      write(path.join(top, ".env.e2e"), `DATABASE_URL=postgres://reader@127.0.0.1:${port}/postgres\n`);
      const agent = [
        'echo "log: $(git log -1 --format=%s 2>&1)"',
        `echo "test: $('${process.execPath}' test math.test.ts 2>&1 | grep -Eo '[0-9]+ pass' | head -1)"`,
        `url=$(sed -n 's/^DATABASE_URL=//p' .env.e2e); echo "db: $('${PG}/psql' "$url" -tAc 'select note from notes' 2>&1)"`,
        `url=$(sed -n 's/^DATABASE_URL=//p' .env.e2e); echo "db-write: $('${PG}/psql' "$url" -tAc "insert into notes values ('x')" 2>&1 | head -1)"`,
      ].join("; ");
      // The replay: line replay's clone of the repository, its linked dependencies and its env file with the read-only URL.
      fs.mkdirSync(h.runDir, { recursive: true });
      const at = replayCwd(top, { context: { project_path: top }, completed: [] }, false, h.runDir, { file: ".env.e2e", key: "DATABASE_URL" });
      if ("reason" in at) throw new Error(at.reason);
      const replay = h.runWith({ FAKE_CLAUDE_BASH: agent, DRY_RUN_HIDE_REGEX: at.hide ?? "" }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--cwd", at.cwd, "--read-only", ...(at.reads ?? []).flatMap((r) => ["--read", r]), "--allow-port", String(at.port));
      expect(replay.err).toBe("");
      const replaySaid = h.recorded("bash")!;
      console.log(`line replay (clone ${at.cwd}):\n${replaySaid}`);
      expect(replaySaid).toContain("log: e2e-commit");
      expect(replaySaid).toContain("test: 1 pass");
      expect(replaySaid).toContain("db: from-the-db");
      expect(replaySaid).toMatch(/db-write: .*permission denied/);
      // The Try station: a worktree of the repository (its .git points into the main checkout's), read-only.
      const wt = path.join(h.dir, "wt");
      git(top, "worktree", "add", "-q", wt);
      fs.symlinkSync(path.join(top, "node_modules"), path.join(wt, "node_modules"));
      fs.copyFileSync(path.join(top, ".env.e2e"), path.join(wt, ".env.e2e"));
      const h2 = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
      const tryAgent = agent.replace(/\.env\.e2e/g, "/dev/null");
      const station = h2.runWith({ FAKE_CLAUDE_BASH: tryAgent }, "--run", h2.runDir, "--prompt", h2.prompt, "--model", "m", "--account", "fake", "--cwd", wt, "--read-only", "--read", path.join(top, "node_modules"));
      expect(station.err).toBe("");
      const stationSaid = h2.recorded("bash")!;
      console.log(`Try station (worktree ${wt}):\n${stationSaid}`);
      expect(stationSaid).toContain("log: e2e-commit");
      expect(stationSaid).toContain("test: 1 pass");
      // A station's checkout keeps its env files to itself: the database is reachable only for a replay that was given its URL.
      expect(fs.readFileSync(path.join(wt, ".env.e2e"), "utf8")).toContain("reader@");
    } finally {
      Bun.spawnSync([`${PG}/pg_ctl`, "-D", pg, "-m", "immediate", "stop"]);
    }
  }, 120_000);
});
