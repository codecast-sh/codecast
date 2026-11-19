import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { bringBranchTo, fetchDefault, freshestBranch, isWorktreeRoot, remoteBranches, requireOwnCommits } from "./freshChange.js";

// A flow run's change read from the remote as it is now (freshChange.ts), on
// real repositories: an origin, this machine's checkout, and a laptop clone
// that pushes the work, the way the build-box incident happened.

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

describe("a flow run's change, fresh from the remote", () => {
  let root: string;
  let origin: string;
  let here: string;
  let laptop: string;
  const saved: Record<string, string | undefined> = {};

  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, ...ENV } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (cwd: string, file: string, text: string, msg: string) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
    git(cwd, "add", file);
    git(cwd, "commit", "-qm", msg);
    return git(cwd, "rev-parse", "HEAD");
  };
  const rev = (cwd: string, ref: string) => git(cwd, "rev-parse", ref);
  // The run-start sequence flowCommand.ts follows: fetch, decide the tip, stop on an empty branch, then move it.
  const runStart = async (cwd: string, branch: string, movable: string | null) => {
    const up = await fetchDefault(cwd);
    const head = await freshestBranch(cwd, up?.remote ?? null, branch, movable);
    if (up) await requireOwnCommits(cwd, branch, head.tip, up);
    await bringBranchTo(cwd, branch, head.local, head.tip, movable);
    return head;
  };

  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-fresh-change-")));
    origin = path.join(root, "origin.git");
    here = path.join(root, "here");
    laptop = path.join(root, "laptop");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, here);
    commit(here, "intro.txt", "say who offers what\n", "base");
    commit(here, "other.txt", "x\n", "base 2");
    git(here, "push", "-q", "origin", "main");
    git(root, "clone", "-q", origin, laptop);
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("the default branch is fetched first: a commit pushed elsewhere is what the run reads", async () => {
    const landed = commit(laptop, "other.txt", "y\n", "someone else's change");
    git(laptop, "push", "-q", "origin", "main");
    const up = (await fetchDefault(here))!;
    expect(up).toEqual({ remote: "origin", branch: "main", ref: "origin/main", sha: landed });
    expect(rev(here, "origin/main")).toBe(landed);
  });

  test("a default branch that cannot be fetched stops the run", async () => {
    git(here, "remote", "set-url", "origin", path.join(root, "gone.git"));
    const err = String(await fetchDefault(here).catch((e: Error) => e));
    expect(err).toContain("Could not fetch origin/main (");
    expect(err).toContain("so the run would work from a stale copy");
    expect(err).not.toContain("and the repository exists");
  });

  test("the incident: a local branch left behind origin's moves to origin's tip", async () => {
    git(here, "branch", "my-branch");
    const stale = rev(here, "my-branch");
    git(laptop, "checkout", "-qb", "my-branch");
    const work = commit(laptop, "intro.txt", "say which side offers what to whom\n", "the change");
    git(laptop, "push", "-q", "origin", "my-branch");
    const r = await runStart(here, "my-branch", null);
    expect(r).toEqual({ tip: work, remoteTip: work, local: stale });
    expect(rev(here, "my-branch")).toBe(work);
    expect(stale).not.toBe(work);
  });

  test("a branch only origin has is made here at origin's tip", async () => {
    git(laptop, "checkout", "-qb", "my-branch");
    const work = commit(laptop, "intro.txt", "y\n", "the change");
    git(laptop, "push", "-q", "origin", "my-branch");
    expect((await runStart(here, "my-branch", null)).tip).toBe(work);
    expect(rev(here, "refs/heads/my-branch")).toBe(work);
  });

  test("unpushed commits stand, and so does a branch origin lacks", async () => {
    git(here, "checkout", "-qb", "my-branch");
    commit(here, "intro.txt", "pushed\n", "pushed");
    git(here, "push", "-q", "origin", "my-branch");
    const ahead = commit(here, "intro.txt", "not yet pushed\n", "unpushed");
    expect(await freshestBranch(here, "origin", "my-branch", null)).toMatchObject({ tip: ahead });
    git(here, "checkout", "-qb", "local-only");
    expect(await freshestBranch(here, "origin", "local-only", null)).toEqual({ tip: ahead, remoteTip: null, local: ahead });
    await expect(freshestBranch(here, "origin", "nowhere", null)).rejects.toThrow("No branch nowhere here or on origin. If the work is on another machine, push it from there first");
  });

  test("a branch that diverged from origin's stops, naming both tips, and nothing moves", async () => {
    git(here, "branch", "my-branch");
    git(laptop, "checkout", "-qb", "my-branch");
    const theirs = commit(laptop, "intro.txt", "theirs\n", "theirs");
    git(laptop, "push", "-q", "origin", "my-branch");
    git(here, "checkout", "-q", "my-branch");
    const mine = commit(here, "other.txt", "mine\n", "mine");
    git(here, "checkout", "-q", "main");
    const err = await freshestBranch(here, "origin", "my-branch", null).catch((e: Error) => e);
    expect(String(err)).toContain("have diverged");
    expect(String(err)).toContain("git branch -f my-branch origin/my-branch");
    expect(String(err)).toContain(mine.slice(0, 10));
    expect(String(err)).toContain(theirs.slice(0, 10));
    expect(rev(here, "my-branch")).toBe(mine);
  });

  test("a behind branch checked out in someone's tree is not moved under it; the run's own worktree may hold it", async () => {
    git(here, "checkout", "-qb", "my-branch");
    const stale = rev(here, "HEAD");
    git(laptop, "checkout", "-qb", "my-branch");
    const work = commit(laptop, "intro.txt", "y\n", "the change");
    git(laptop, "push", "-q", "origin", "my-branch");
    await expect(freshestBranch(here, "origin", "my-branch", null)).rejects.toThrow(`checked out at ${here}`);
    expect(rev(here, "my-branch")).toBe(stale);
    expect((await runStart(here, "my-branch", here)).tip).toBe(work);
    expect(rev(here, "HEAD")).toBe(work);
    expect(git(here, "status", "--porcelain")).toBe("");
  });

  test("a checkout with no remote reads its change as it stands: no fetch, the local branch untouched", async () => {
    const alone = path.join(root, "alone");
    git(root, "init", "-q", "-b", "main", alone);
    commit(alone, "intro.txt", "x\n", "base");
    git(alone, "checkout", "-qb", "my-branch");
    const tip = commit(alone, "intro.txt", "y\n", "the change");
    expect(await fetchDefault(alone)).toBeNull();
    expect(await remoteBranches(alone, null, ["my-branch"])).toEqual(new Set());
    expect(await runStart(alone, "my-branch", null)).toEqual({ tip, remoteTip: null, local: tip });
    expect(rev(alone, "my-branch")).toBe(tip);
    await expect(freshestBranch(alone, null, "nowhere", null)).rejects.toThrow(/^No branch nowhere here$/);
  });

  test("an origin never fetched is fetched once, its default branch named, and read", async () => {
    const fresh = path.join(root, "fresh");
    git(root, "init", "-q", "-b", "main", fresh);
    git(fresh, "remote", "add", "origin", origin);
    const up = (await fetchDefault(fresh))!;
    expect(up).toMatchObject({ remote: "origin", branch: "main", ref: "origin/main", sha: rev(here, "main") });
  });

  test("an empty branch stops at run start: one at an old default-branch commit, and one at its head", async () => {
    git(here, "branch", "stale", "main~1");
    git(here, "branch", "same", "main");
    for (const b of ["stale", "same"]) {
      const at = rev(here, b);
      await expect(runStart(here, b, null)).rejects.toThrow(`${b} holds no commit that origin/main lacks (it is at ${at.slice(0, 10)}): there is no change to run. If the work is on another machine, push it from there first`);
    }
  });

  test("a branch with a commit of its own behind the default branch runs: not stopped, not moved, not rebased", async () => {
    git(here, "checkout", "-qb", "my-branch");
    const tip = commit(here, "intro.txt", "mine\n", "the change");
    git(here, "push", "-q", "origin", "my-branch");
    git(here, "checkout", "-q", "main");
    commit(laptop, "other.txt", "y\n", "someone else's change");
    git(laptop, "push", "-q", "origin", "main");
    const head = await runStart(here, "my-branch", null);
    expect(head).toEqual({ tip, remoteTip: tip, local: tip });
    expect(rev(here, "my-branch")).toBe(tip);
    expect(git(origin, "rev-parse", "my-branch")).toBe(tip);
  });

  test("a renamed default branch names the fix", async () => {
    git(laptop, "push", "-q", "origin", "main:trunk");
    git(origin, "symbolic-ref", "HEAD", "refs/heads/trunk");
    git(laptop, "push", "-q", "origin", ":main");
    await expect(fetchDefault(here)).rejects.toThrow("Run git remote set-head origin --auto");
  });

  // The run's own earlier worktree holds the branch; a branch made here and checked out there, as a rerun finds it.
  const earlierWorktree = () => {
    git(here, "branch", "my-branch");
    const wt = path.join(root, "earlier");
    git(here, "worktree", "add", "-q", wt, "my-branch");
    git(laptop, "checkout", "-qb", "my-branch");
    return { wt, stale: rev(wt, "HEAD") };
  };

  test("an empty branch in the run's earlier worktree stops before anything moves: HEAD, index and files as they were", async () => {
    const { wt, stale } = earlierWorktree();
    const work = commit(laptop, "intro.txt", "y\n", "the change");
    git(laptop, "push", "-q", "origin", "my-branch");
    git(laptop, "push", "-q", "origin", `${work}:refs/heads/main`);
    await expect(runStart(here, "my-branch", wt)).rejects.toThrow("there is no change to run");
    expect(rev(wt, "HEAD")).toBe(stale);
    expect(rev(here, "my-branch")).toBe(stale);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  test("a branch origin moved ahead is fast-forwarded in the run's earlier worktree: new tip, clean status", async () => {
    const { wt } = earlierWorktree();
    const work = commit(laptop, "intro.txt", "y\n", "the change");
    git(laptop, "push", "-q", "origin", "my-branch");
    await runStart(here, "my-branch", wt);
    expect(rev(wt, "HEAD")).toBe(work);
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(wt, "intro.txt"), "utf-8")).toBe("y\n");
  });

  // The run's start and then what flowCommand.ts does next: the earlier worktree reset to the change's tip.
  const ignore = (wt: string, pattern: string) => {
    const exclude = path.resolve(wt, git(wt, "rev-parse", "--git-path", "info/exclude"));
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${pattern}\n`);
  };
  const runAndReset = async (wt: string) => {
    await runStart(here, "my-branch", wt);
    git(wt, "reset", "--quiet", "--hard", rev(here, "refs/remotes/origin/my-branch"));
  };
  // A user's file in the earlier worktree at a path origin's new commit takes: the run must stop with nothing moved.
  const refusal = (name: string, o: { detached: boolean; ignored?: string; file: string; change: () => void }) =>
    test(name, async () => {
      const { wt, stale } = earlierWorktree();
      if (o.detached) git(wt, "checkout", "-q", "--detach");
      if (o.ignored) ignore(wt, o.ignored);
      fs.mkdirSync(path.dirname(path.join(wt, o.file)), { recursive: true });
      fs.writeFileSync(path.join(wt, o.file), "mine\n");
      o.change();
      git(laptop, "push", "-q", "origin", "my-branch");
      const err = String(await runAndReset(wt).catch((e: Error) => e));
      expect(err).toContain(`Could not bring the run's worktree ${wt} to`);
      expect(err).toContain("nothing has moved");
      expect(fs.readFileSync(path.join(wt, o.file), "utf-8")).toBe("mine\n");
      expect(rev(here, "my-branch")).toBe(stale);
      expect(rev(wt, "HEAD")).toBe(stale);
    });
  const rename = (to: string) => () => { git(laptop, "mv", "intro.txt", to); git(laptop, "commit", "-qm", `rename to ${to}`); };

  refusal("on the branch: an untracked file origin's commit adds", { detached: false, file: "new.txt", change: () => commit(laptop, "new.txt", "theirs\n", "adds new.txt") });
  refusal("on the branch: an ignored .env origin's commit starts tracking", { detached: false, ignored: ".env", file: ".env", change: () => commit(laptop, ".env", "SECRET=theirs\n", "tracks .env") });
  refusal("detached: an untracked notes.md origin's commit adds", { detached: true, file: "notes.md", change: () => commit(laptop, "notes.md", "theirs\n", "adds notes.md") });
  refusal("on the branch: a tracked file renamed onto an untracked path", { detached: false, file: "moved.txt", change: rename("moved.txt") });
  refusal("detached: a tracked file renamed onto an ignored path", { detached: true, ignored: "moved.txt", file: "moved.txt", change: rename("moved.txt") });
  refusal("detached: untracked foo/mine.txt against a commit adding the file foo", { detached: true, file: "foo/mine.txt", change: () => commit(laptop, "foo", "theirs\n", "adds foo") });
  refusal("on the branch: ignored ignd/mine.txt against a commit adding the file ignd", { detached: false, ignored: "ignd/", file: "ignd/mine.txt", change: () => commit(laptop, "ignd", "theirs\n", "adds ignd") });
  refusal("detached: untracked file bar against a commit adding bar/x.txt", { detached: true, file: "bar", change: () => commit(laptop, "bar/x.txt", "theirs\n", "adds bar/x.txt") });
  refusal("on the branch: ignored file ignf against a commit adding ignf/x.txt", { detached: false, ignored: "ignf", file: "ignf", change: () => commit(laptop, "ignf/x.txt", "theirs\n", "adds ignf/x.txt") });

  test("an untracked file the new commits do not add stays, detached or on the branch, and the run goes on", async () => {
    for (const detached of [false, true]) {
      const { wt } = earlierWorktree();
      if (detached) git(wt, "checkout", "-q", "--detach");
      fs.writeFileSync(path.join(wt, "scratch.txt"), "keep\n");
      const work = commit(laptop, `intro-${detached}.txt`, "y\n", "the change");
      git(laptop, "push", "-q", "origin", "my-branch");
      await runAndReset(wt);
      expect(rev(wt, "HEAD")).toBe(work);
      expect(rev(here, "my-branch")).toBe(work);
      expect(git(wt, "symbolic-ref", "--short", "HEAD")).toBe("my-branch");
      expect(fs.readFileSync(path.join(wt, "scratch.txt"), "utf-8")).toBe("keep\n");
      git(here, "worktree", "remove", "--force", wt);
      git(here, "branch", "-D", "my-branch");
      git(laptop, "checkout", "-q", "main");
      git(laptop, "branch", "-D", "my-branch");
      git(laptop, "push", "-q", "origin", ":my-branch");
    }
  });

  test("an earlier path that is no worktree's root is never acted in: the main checkout around it stays as it was", async () => {
    git(here, "branch", "my-branch");
    git(laptop, "checkout", "-qb", "my-branch");
    const work = commit(laptop, "intro.txt", "y\n", "the change");
    git(laptop, "push", "-q", "origin", "my-branch");
    const leftover = path.join(here, "leftover");
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, "keep.txt"), "keep\n");
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    const [head, status] = [rev(here, "HEAD"), git(here, "status", "--porcelain")];
    await runStart(here, "my-branch", leftover);
    expect(rev(here, "my-branch")).toBe(work);
    git(here, "update-ref", "refs/heads/my-branch", head);
    await runStart(here, "my-branch", plain);
    expect(rev(here, "my-branch")).toBe(work);
    expect(git(here, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(rev(here, "HEAD")).toBe(head);
    expect(git(here, "status", "--porcelain")).toBe(status);
    expect(fs.readFileSync(path.join(here, "intro.txt"), "utf-8")).toBe("say who offers what\n");
    expect(fs.readFileSync(path.join(leftover, "keep.txt"), "utf-8")).toBe("keep\n");
  });

  test("only a worktree's own root counts as one: never a directory inside the main checkout, nor one outside any repo", async () => {
    const wt = path.join(root, "wt");
    git(here, "worktree", "add", "-q", "--detach", wt);
    const leftover = path.join(here, "leftover");
    fs.mkdirSync(leftover);
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    expect(await isWorktreeRoot(here)).toBe(true);
    expect(await isWorktreeRoot(wt)).toBe(true);
    expect(await isWorktreeRoot(leftover)).toBe(false);
    expect(await isWorktreeRoot(plain)).toBe(false);
    expect(await isWorktreeRoot(path.join(root, "missing"))).toBe(false);
  });

  // The local branch is already at the tip; only the run's earlier worktree is behind it, or on another branch.
  const atTipBehind = (cwd: string, base: string) => {
    git(cwd, "checkout", "-q", "-b", "my-branch");
    const wt = path.join(root, `earlier-${path.basename(cwd)}`);
    git(cwd, "worktree", "add", "-q", "--detach", wt, base);
    return wt;
  };
  const stopsAtTip = async (cwd: string, o: { ignored?: string; file: string }) => {
    const base = rev(cwd, "HEAD");
    const wt = atTipBehind(cwd, base);
    if (o.ignored) ignore(wt, o.ignored);
    fs.writeFileSync(path.join(wt, o.file), "mine\n");
    // The ignore rule is shared by every worktree of the repository, so the tip's commit adds the file past it.
    fs.writeFileSync(path.join(cwd, o.file), "theirs\n");
    git(cwd, "add", "-f", o.file);
    git(cwd, "commit", "-qm", `adds ${o.file}`);
    const tip = rev(cwd, "HEAD");
    git(cwd, "checkout", "-q", "main");
    if (cwd === here) git(cwd, "push", "-q", "origin", "my-branch");
    const err = String(await (async () => { await runStart(cwd, "my-branch", wt); git(wt, "reset", "--quiet", "--hard", tip); })().catch((e: Error) => e));
    expect(err).toContain(`Could not bring the run's worktree ${wt} to`);
    expect(fs.readFileSync(path.join(wt, o.file), "utf-8")).toBe("mine\n");
    expect(rev(wt, "HEAD")).toBe(base);
    expect(rev(cwd, "my-branch")).toBe(tip);
  };

  test("the branch already at the tip, the earlier worktree detached behind with an untracked file the tip adds: stops, file kept", async () => {
    await stopsAtTip(here, { file: "notes.md" });
  });

  test("the branch already at the tip, the earlier worktree detached behind with an ignored file the tip adds: stops, file kept", async () => {
    await stopsAtTip(here, { ignored: ".env", file: ".env" });
  });

  test("no origin, the earlier worktree detached behind with an untracked file the tip adds: stops, file kept", async () => {
    const alone = path.join(root, "alone");
    git(root, "init", "-q", "-b", "main", alone);
    commit(alone, "intro.txt", "x\n", "base");
    await stopsAtTip(alone, { file: "notes.md" });
  });

  test("an earlier worktree on another branch ends on the run's branch at the tip; that branch keeps its own commit", async () => {
    git(here, "branch", "other");
    const wt = path.join(root, "earlier-other");
    git(here, "worktree", "add", "-q", wt, "other");
    const own = commit(wt, "other.txt", "other's own\n", "other's own commit");
    git(here, "checkout", "-q", "-b", "my-branch", "main");
    const tip = commit(here, "intro.txt", "y\n", "the change");
    git(here, "push", "-q", "origin", "my-branch");
    git(here, "checkout", "-q", "main");
    await runStart(here, "my-branch", wt);
    git(wt, "reset", "--quiet", "--hard", tip);
    expect(rev(here, "other")).toBe(own);
    expect(rev(wt, "HEAD")).toBe(tip);
    expect(git(wt, "symbolic-ref", "--short", "HEAD")).toBe("my-branch");
  });

  test("a detached earlier worktree holding a commit on no branch stops the run, nothing moved, the commit named", async () => {
    const { wt, stale } = earlierWorktree();
    git(wt, "checkout", "-q", "--detach");
    const lone = commit(wt, "lone.txt", "only here\n", "a commit on no branch");
    commit(laptop, "intro.txt", "y\n", "the change");
    git(laptop, "push", "-q", "origin", "my-branch");
    const err = String(await runStart(here, "my-branch", wt).catch((e: Error) => e));
    expect(err).toContain(`The run's worktree ${wt} holds 1 commit on no branch (${lone.slice(0, 10)})`);
    expect(err).toContain(`git -C ${wt} branch <name>`);
    expect(rev(wt, "HEAD")).toBe(lone);
    expect(rev(here, "my-branch")).toBe(stale);
  });

  test("an earlier worktree on another branch, the run's branch behind origin: the worktree ends on the run's branch and its commits land there", async () => {
    git(here, "branch", "my-branch");
    git(here, "branch", "other");
    const wt = path.join(root, "earlier-other");
    git(here, "worktree", "add", "-q", wt, "other");
    const own = commit(wt, "other.txt", "other's own\n", "other's own commit");
    git(laptop, "checkout", "-qb", "my-branch");
    const tip = commit(laptop, "intro.txt", "y\n", "the change");
    git(laptop, "push", "-q", "origin", "my-branch");
    await runStart(here, "my-branch", wt);
    git(wt, "reset", "--quiet", "--hard", tip);
    expect(git(wt, "symbolic-ref", "--short", "HEAD")).toBe("my-branch");
    expect(rev(wt, "HEAD")).toBe(tip);
    expect(rev(here, "other")).toBe(own);
    const station = commit(wt, "station.txt", "a station's work\n", "a station's commit");
    expect(rev(here, "my-branch")).toBe(station);
  });

  test("an earlier worktree left detached at the tip, the ref already there, ends on the run's branch", async () => {
    git(here, "checkout", "-q", "-b", "my-branch");
    const tip = commit(here, "intro.txt", "y\n", "the change");
    git(here, "push", "-q", "origin", "my-branch");
    git(here, "checkout", "-q", "main");
    const wt = path.join(root, "earlier-at-tip");
    git(here, "worktree", "add", "-q", "--detach", wt, tip);
    await runStart(here, "my-branch", wt);
    expect(git(wt, "symbolic-ref", "--short", "HEAD")).toBe("my-branch");
    expect(rev(wt, "HEAD")).toBe(tip);
  });

});
