// The PR station against a real git origin and a fake `gh` on PATH that keeps
// the pull requests it opened in a file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultExec, type Exec } from "../lineMerge";
import { writeFrozenChange } from "./flowChangeFile";
import { prStation, rebasePr, refreshPr, standingReview, type MergeProof, type PrStationResult } from "./prStation";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
let sandbox = "";
let worlds = 0;

beforeAll(() => { sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-pr-station-"))); });
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV } }).trim();

// gh pr list prints what prs.json holds for the head branch; gh pr create adds one there and prints its URL.
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$GH_LOG"
state="$GH_STATE"
[ -f "$state" ] || echo '[]' > "$state"
head=""; prev=""
for a in "$@"; do [ "$prev" = "--head" ] && head="$a"; prev="$a"; done
case "$1 $2" in
  "pr list") jq -c --arg h "$head" '[.[] | select(.head == $h) | {number, url, isCrossRepository: (.fork // false)}]' "$state" ;;
  "pr create")
    [ -n "$GH_CREATE_FAILS" ] && { echo "GraphQL: something went wrong" >&2; exit 1; }
    n=$(( $(jq length "$state") + 41 ))
    jq --arg h "$head" --argjson n "$n" '. + [{head: $h, fork: (env.GH_FORK != null), number: $n, url: ("https://github.com/acme/app/pull/" + ($n|tostring))}]' "$state" > "$state.tmp" && mv "$state.tmp" "$state"
    echo "https://github.com/acme/app/pull/$n" ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
`;

function world() {
  const root = path.join(sandbox, `w${++worlds}`);
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const bin = path.join(root, "bin");
  const dir = path.join(root, "run");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  fs.writeFileSync(path.join(work, "a.txt"), "base\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  const log = path.join(root, "gh.log");
  const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH}`, GH_LOG: log, GH_STATE: path.join(root, "prs.json"), ...ENV };
  const exec: Exec = (cmd, args, cwd, extra) => defaultExec(cmd, args, cwd, { ...env, ...extra });
  /** A commit on `branch` cut from main, the way a freeze cuts one: never a child of the branch's last tip. */
  const freeze = (branch: string, text: string) => {
    git(work, "checkout", "-q", "-B", branch, "main");
    fs.writeFileSync(path.join(work, "a.txt"), text);
    git(work, "commit", "-qam", `say ${text.trim()}`);
    git(work, "checkout", "-q", "main");
    return git(work, "rev-parse", branch);
  };
  return { origin, work, dir, env, exec, freeze, ghLog: () => fs.readFileSync(log, "utf-8").trim().split("\n") };
}

describe("cast flow pr", () => {
  test("opens a pull request for a frozen session change, then updates it by force when the session's fix is frozen again", () => {
    const w = world();
    const branch = "codecast/change-ct-1";
    const first = w.freeze(branch, "one\n");
    writeFrozenChange(w.dir, { source: "session", session: "jx7aaaa", base: "x", tip: first, branch, worktree: "change-ct-1", paths: ["a.txt"], shared: [], held: [], title: "Say one" });

    const opened = prStation({ cwd: w.work, dir: w.dir, branch, base: "main", body: "For ct-1.", exec: w.exec });
    expect(opened).toEqual({ ok: true, pr: { url: "https://github.com/acme/app/pull/41", number: 41, head_sha: first, branch, round: expect.any(String) } });
    expect(git(w.origin, "rev-parse", branch)).toBe(first);
    expect(JSON.parse(fs.readFileSync(path.join(w.dir, "pr.json"), "utf-8"))).toEqual({ url: "https://github.com/acme/app/pull/41", number: 41, head_sha: first, branch, round: expect.any(String) });
    expect(w.ghLog().find((l) => l.startsWith("pr create"))).toBe(`pr create --head ${branch} --base main --title Say one --body For ct-1.`);

    // The refreeze is a new commit off main, not a child of the first: the push takes it by force, and no second PR opens.
    const second = w.freeze(branch, "two\n");
    const updated = prStation({ cwd: w.work, dir: w.dir, branch, base: "main", exec: w.exec });
    expect(updated).toEqual({ ok: true, pr: { url: "https://github.com/acme/app/pull/41", number: 41, head_sha: second, branch, round: expect.any(String) } });
    // Each round has a nonce of its own, so a verdict pinned in the last round does not count in this one.
    expect(updated.ok && opened.ok && updated.pr.round !== opened.pr.round).toBe(true);
    expect(git(w.origin, "rev-parse", branch)).toBe(second);
    expect(w.ghLog().filter((l) => l.startsWith("pr create"))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(w.dir, "pr.json"), "utf-8")).head_sha).toBe(second);
  }, 60_000);

  test("a branch Merge rebased on origin is kept while the change has not moved, and replaced once the session's fix moves it", () => {
    const w = world();
    const branch = "codecast/change-ct-3";
    const first = w.freeze(branch, "one\n");
    writeFrozenChange(w.dir, { source: "session", session: "jx7aaaa", base: "x", tip: first, branch, worktree: "change-ct-3", paths: ["a.txt"], shared: [], held: [], title: "Say one" });
    expect(prStation({ cwd: w.work, dir: w.dir, branch, base: "main", exec: w.exec }).ok).toBe(true);

    // Merge put the change on a moved main and pushed that.
    fs.writeFileSync(path.join(w.work, "b.txt"), "main moved\n");
    git(w.work, "add", "b.txt");
    git(w.work, "commit", "-qm", "main moves");
    git(w.work, "checkout", "-q", "-b", "rebased");
    fs.writeFileSync(path.join(w.work, "a.txt"), "one\n");
    git(w.work, "commit", "-qam", "say one");
    const rebased = git(w.work, "rev-parse", "rebased");
    git(w.work, "push", "-q", "--force", "origin", `rebased:refs/heads/${branch}`);
    git(w.work, "checkout", "-q", "main");

    // A refreeze with nothing new cuts a new commit of the same tree: origin's rebased tip stays the change.
    git(w.work, "update-ref", `refs/heads/${branch}`, git(w.work, "commit-tree", `${first}^{tree}`, "-p", `${first}^`, "-m", "say one"));
    expect(prStation({ cwd: w.work, dir: w.dir, branch, base: "main", exec: w.exec })).toMatchObject({ ok: true, pr: { head_sha: rebased } });
    expect(git(w.origin, "rev-parse", branch)).toBe(rebased);

    // The session's fix moves the change: it goes up by force, and Merge rebases it again.
    const fixed = w.freeze(branch, "two\n");
    expect(prStation({ cwd: w.work, dir: w.dir, branch, base: "main", exec: w.exec })).toMatchObject({ ok: true, pr: { head_sha: fixed } });
    expect(git(w.origin, "rev-parse", branch)).toBe(fixed);
  }, 60_000);

  test("a named branch is never rewritten: a push that is not a fast forward stops with why", () => {
    const w = world();
    w.freeze("feat", "theirs\n");
    git(w.work, "push", "-q", "origin", "feat");
    w.freeze("feat", "mine\n");
    writeFrozenChange(w.dir, { source: "branch", base: "x", tip: "x", branch: "feat", worktree: "change-ct-2", paths: [], shared: [], held: [] });
    const r = prStation({ cwd: w.work, dir: w.dir, branch: "feat", base: "main", title: "Feat", exec: w.exec });
    expect(r.ok).toBe(false);
    // The reason is git's own last lines, the rejection, not the "To <remote>" line before it.
    expect(!r.ok && r.reason).toMatch(/^Could not push feat: .*rejected/);
    expect(fs.existsSync(path.join(w.dir, "pr.json"))).toBe(false);
  }, 60_000);

  test("a session's fix that rebased a named branch goes up over exactly the head this run pushed there", () => {
    const w = world();
    const first = w.freeze("feat", "one\n");
    writeFrozenChange(w.dir, { source: "branch", base: "x", tip: first, branch: "feat", worktree: "change-ct-7", paths: [], shared: [], held: [] });
    expect(prStation({ cwd: w.work, dir: w.dir, branch: "feat", base: "main", title: "Feat", exec: w.exec }).ok).toBe(true);
    // The session rebases its branch: the new tip is not a child of what origin holds.
    const rebased = w.freeze("feat", "one, on a newer main\n");
    expect(prStation({ cwd: w.work, dir: w.dir, branch: "feat", base: "main", exec: w.exec })).toMatchObject({ ok: true, pr: { head_sha: rebased } });
    expect(git(w.origin, "rev-parse", "feat")).toBe(rebased);
  }, 60_000);

  test("a missing branch and a gh that cannot open the pull request each say why, and leave no pr.json", () => {
    const w = world();
    expect(prStation({ cwd: w.work, dir: w.dir, branch: "nope", base: "main", exec: w.exec })).toEqual({ ok: false, reason: "There is no branch nope here to push." });
    w.freeze("feat", "x\n");
    const failing: Exec = (cmd, args, cwd) => w.exec(cmd, args, cwd, { GH_CREATE_FAILS: "1" });
    expect(prStation({ cwd: w.work, dir: w.dir, branch: "feat", base: "main", title: "T", exec: failing })).toEqual({ ok: false, reason: "gh pr create failed: GraphQL: something went wrong" });
    expect(fs.existsSync(path.join(w.dir, "pr.json"))).toBe(false);
  }, 60_000);

  test("a round on the head the server holds the reviewer's ship for carries it; any file, a changes, a new attempt or a new commit does not", () => {
    const w = world();
    const branch = "codecast/change-ct-1";
    const first = w.freeze(branch, "one\n");
    writeFrozenChange(w.dir, { source: "session", session: "jx7aaaa", base: "x", tip: first, branch, worktree: "change-ct-1", paths: ["a.txt"], shared: [], held: [], title: "Say one" });
    const pr = (proof?: MergeProof | null) => prStation({ cwd: w.work, dir: w.dir, branch, base: "main", exec: w.exec, proof }) as Extract<PrStationResult, { ok: true }>;
    expect(pr().ok).toBe(true);
    // The session changed nothing: the same head goes up, and the ship the server recorded on it stands.
    expect(pr({ review: { verdict: "ship", head_sha: first }, rebases: [] }).pr).toMatchObject({ head_sha: first, reviewed: { verdict: "ship", head_sha: first } });
    // review.json saying ship counts for nothing: only the server's record is carried.
    fs.writeFileSync(path.join(w.dir, "review.json"), JSON.stringify({ verdict: "ship", findings: [], round: "r1", head_sha: first }));
    expect(pr(null).pr.reviewed).toBeUndefined();
    // A changes verdict goes to a fresh reviewer; a new attempt (resume) holds no review the server counts.
    expect(pr({ review: { verdict: "changes", head_sha: first }, rebases: [] }).pr.reviewed).toBeUndefined();
    expect(pr({ review: null, rebases: [] }).pr.reviewed).toBeUndefined();
    const second = w.freeze(branch, "two\n");
    const moved = pr({ review: { verdict: "ship", head_sha: first }, rebases: [] }).pr;
    expect(moved.head_sha).toBe(second);
    expect(moved.reviewed).toBeUndefined();
  }, 60_000);

  test("a ship stands for a head the run's recorded station rebases made from the one it read, carrying that chain, and no other", () => {
    const proof = { review: { verdict: "ship", head_sha: "abc" }, rebases: [{ from: "abc", to: "r1b" }, { from: "r1b", to: "r2b" }] };
    expect(standingReview(proof, "r2b")).toEqual({ reviewed: { verdict: "ship", head_sha: "abc" }, rebases: [{ from: "abc", to: "r1b" }, { from: "r1b", to: "r2b" }] });
    expect(standingReview(proof, "abc")).toEqual({ reviewed: { verdict: "ship", head_sha: "abc" } });
    expect(standingReview(proof, "pushed")).toBeNull();
    expect(standingReview({ ...proof, rebases: [] }, "r1b")).toBeNull();
    expect(standingReview({ review: { verdict: "rejected", head_sha: "abc" } }, "abc")).toBeNull();
    expect(standingReview(null, "abc")).toBeNull();
  });

  test("each round starts with no verdict files from the last one", () => {
    const w = world();
    w.freeze("feat", "x\n");
    fs.mkdirSync(w.dir, { recursive: true });
    for (const f of ["ci.json", "review.json", "merge.json"]) fs.writeFileSync(path.join(w.dir, f), '{"stale": true}');
    expect(prStation({ cwd: w.work, dir: w.dir, branch: "feat", base: "main", title: "T", exec: w.exec }).ok).toBe(true);
    for (const f of ["ci.json", "review.json", "merge.json"]) expect(fs.existsSync(path.join(w.dir, f))).toBe(false);
  }, 60_000);

  test("after Merge rebased a named branch for a retest, the session's fix on the lagging local branch goes onto origin's", () => {
    const w = world();
    git(w.work, "checkout", "-q", "-b", "feat");
    fs.writeFileSync(path.join(w.work, "a.txt"), "change\n");
    git(w.work, "commit", "-qam", "the change");
    const pushed = git(w.work, "rev-parse", "HEAD");
    git(w.work, "checkout", "-q", "main");
    writeFrozenChange(w.dir, { source: "branch", base: "x", tip: pushed, branch: "feat", worktree: "change-ct-4", paths: [], shared: [], held: [] });
    expect(prStation({ cwd: w.work, dir: w.dir, branch: "feat", base: "main", title: "Feat", exec: w.exec })).toMatchObject({ ok: true, pr: { head_sha: pushed } });

    // Merge: main moved, the branch is rebased onto it and pushed; then the run takes origin's head for the retest.
    fs.writeFileSync(path.join(w.work, "b.txt"), "main moved\n");
    git(w.work, "add", "b.txt");
    git(w.work, "commit", "-qm", "main moves");
    git(w.work, "push", "-q", "origin", "main");
    git(w.work, "checkout", "-q", "-b", "scratch");
    git(w.work, "cherry-pick", pushed);
    const rebased = git(w.work, "rev-parse", "HEAD");
    git(w.work, "push", "-q", "--force", "origin", "scratch:refs/heads/feat");
    git(w.work, "checkout", "-q", "main");
    fs.writeFileSync(path.join(w.dir, "review.json"), '{"verdict":"ship"}');
    fs.writeFileSync(path.join(w.dir, "ci.json"), '{"green":true}');
    const round = JSON.parse(fs.readFileSync(path.join(w.dir, "pr.json"), "utf-8")).round;
    // What Merge leaves when it pushes a rebase for a retest.
    fs.writeFileSync(path.join(w.dir, "rebase.json"), JSON.stringify({ from: pushed, to: rebased }));
    // A retest is the same round: the review it already has keeps counting.
    // A head Merge did not make is someone else's push: a new round reviews it.
    fs.writeFileSync(path.join(w.dir, "rebase.json"), JSON.stringify({ from: pushed, to: "f".repeat(40) }));
    expect(refreshPr({ cwd: w.work, dir: w.dir, exec: w.exec })).toMatchObject({ ok: false, new_round: true });
    fs.writeFileSync(path.join(w.dir, "rebase.json"), JSON.stringify({ from: pushed, to: rebased }));
    expect(refreshPr({ cwd: w.work, dir: w.dir, exec: w.exec })).toMatchObject({ ok: true, pr: { head_sha: rebased, local_sha: pushed, round, rebases: [{ from: pushed, to: rebased }] } });
    expect(fs.existsSync(path.join(w.dir, "review.json"))).toBe(true);
    expect(fs.existsSync(path.join(w.dir, "ci.json"))).toBe(false);

    // CI went red on the retest; the session commits its fix on its local branch, which never saw the rebase.
    git(w.work, "checkout", "-q", "feat");
    fs.writeFileSync(path.join(w.work, "c.txt"), "the fix\n");
    git(w.work, "add", "c.txt");
    git(w.work, "commit", "-qm", "the fix");
    const fixed = git(w.work, "rev-parse", "HEAD");
    git(w.work, "checkout", "-q", "main");
    const r = prStation({ cwd: w.work, dir: w.dir, branch: "feat", base: "main", exec: w.exec });
    expect(r.ok).toBe(true);
    const head = r.ok ? r.pr.head_sha : "";
    expect(r).toMatchObject({ pr: { local_sha: fixed } });
    // Origin now holds the rebased change with the fix on top: a fast forward, main's move kept.
    expect(git(w.origin, "rev-parse", "feat")).toBe(head);
    expect(git(w.origin, "rev-parse", `${head}^`)).toBe(rebased);
    expect(git(w.origin, "show", `${head}:b.txt`)).toBe("main moved");
    expect(git(w.origin, "show", `${head}:c.txt`)).toBe("the fix");

    // A second fix after that replays only itself.
    git(w.work, "checkout", "-q", "feat");
    fs.writeFileSync(path.join(w.work, "c.txt"), "the fix, fixed\n");
    git(w.work, "commit", "-qam", "fix again");
    git(w.work, "checkout", "-q", "main");
    const again = prStation({ cwd: w.work, dir: w.dir, branch: "feat", base: "main", exec: w.exec });
    expect(again.ok).toBe(true);
    expect(git(w.origin, "rev-parse", "feat^")).toBe(head);
    expect(git(w.origin, "show", "feat:c.txt")).toBe("the fix, fixed");
  }, 60_000);

  test("once main is green again, the branch goes onto it and up, keeping the round and its review, the rebase recorded as Merge records one", async () => {
    const w = world();
    w.freeze("feat", "x\n");
    writeFrozenChange(w.dir, { source: "branch", base: "x", tip: "x", branch: "feat", worktree: "change-ct-5", paths: [], shared: [], held: [] });
    const first = prStation({ cwd: w.work, dir: w.dir, branch: "feat", base: "main", title: "T", exec: w.exec });
    expect(first.ok).toBe(true);
    const pushed = first.ok ? first.pr : null;
    // Main gets its fix.
    fs.writeFileSync(path.join(w.work, "fix.txt"), "main is green\n");
    git(w.work, "add", "fix.txt");
    git(w.work, "commit", "-qm", "fix main");
    git(w.work, "push", "-q", "origin", "main");
    fs.writeFileSync(path.join(w.dir, "ci.json"), '{"green":false}');
    fs.writeFileSync(path.join(w.dir, "review.json"), '{"verdict":"ship"}');
    const posted: Array<{ route: string; body: unknown }> = [];
    const post = async (route: string, body: Record<string, unknown>) => { posted.push({ route, body: structuredClone(body) }); return { attempt: 1 }; };
    const r = await rebasePr({ cwd: w.work, dir: w.dir, base: "main", runId: "run-5", post, exec: w.exec });
    expect(r).toMatchObject({ ok: true, pr: { round: pushed!.round, local_sha: pushed!.head_sha } });
    const head = r.ok ? r.pr.head_sha : "";
    expect(r).toMatchObject({ pr: { rebases: [{ from: pushed!.head_sha, to: head }] } });
    // Recorded on the server and in rebase.json, as Merge records its own.
    expect(posted).toEqual([{ route: "/cli/workflow-runs/rebase", body: { run_id: "run-5", from: pushed!.head_sha, to: head } }]);
    expect(JSON.parse(fs.readFileSync(path.join(w.dir, "rebase.json"), "utf-8"))).toEqual({ from: pushed!.head_sha, to: head, links: [{ from: pushed!.head_sha, to: head }] });
    expect(git(w.origin, "rev-parse", "feat")).toBe(head);
    expect(git(w.origin, "rev-parse", `${head}^`)).toBe(git(w.work, "rev-parse", "main"));
    expect(git(w.origin, "show", `${head}:a.txt`)).toBe("x");
    expect(fs.existsSync(path.join(w.dir, "ci.json"))).toBe(false);
    expect(fs.existsSync(path.join(w.dir, "review.json"))).toBe(true);

    // Someone pushes to the branch while the run waits: the next rebase starts a new round instead of keeping the review.
    git(w.work, "fetch", "-q", "origin", "feat");
    git(w.work, "checkout", "-q", "-B", "theirs", "FETCH_HEAD");
    fs.writeFileSync(path.join(w.work, "theirs.txt"), "pushed\n");
    git(w.work, "add", "theirs.txt");
    git(w.work, "commit", "-qm", "theirs");
    git(w.work, "push", "-q", "origin", "theirs:refs/heads/feat");
    git(w.work, "checkout", "-q", "main");
    expect(await rebasePr({ cwd: w.work, dir: w.dir, base: "main", runId: "run-5", post, exec: w.exec })).toMatchObject({ ok: false, new_round: true });
  }, 60_000);

  test("a second retest in a round keeps the review: Merge records each rebase from the head the reviewer read", () => {
    const dir = fs.mkdtempSync(path.join(sandbox, "refresh-"));
    let origin = "r1";
    const exec: Exec = (cmd, args) => (cmd === "git" && args[0] === "ls-remote" ? { status: 0, stdout: `${origin}\trefs/heads/feat\n`, stderr: "" } : (() => { throw new Error(`unexpected ${cmd}`); })());
    fs.writeFileSync(path.join(dir, "pr.json"), JSON.stringify({ url: "u", number: 7, head_sha: "h0", branch: "feat", round: "r" }));
    fs.writeFileSync(path.join(dir, "rebase.json"), JSON.stringify({ from: "h0", to: "r1" }));
    expect(refreshPr({ cwd: ".", dir, exec })).toMatchObject({ ok: true, pr: { head_sha: "r1", round: "r" } });
    origin = "r2";
    fs.writeFileSync(path.join(dir, "rebase.json"), JSON.stringify({ from: "h0", to: "r2" }));
    expect(refreshPr({ cwd: ".", dir, exec })).toMatchObject({ ok: true, pr: { head_sha: "r2", round: "r", rebases: [{ from: "h0", to: "r1" }, { from: "h0", to: "r2" }] } });
    // A rebase of a head that is not this round's is no station's of the reviewed change.
    origin = "r3";
    fs.writeFileSync(path.join(dir, "rebase.json"), JSON.stringify({ from: "elsewhere", to: "r3" }));
    expect(refreshPr({ cwd: ".", dir, exec })).toMatchObject({ ok: false, new_round: true });
  });

  test("a server that will not record the rebase stops the run: the rebased head stays one nobody reviewed", async () => {
    const w = world();
    w.freeze("feat", "x\n");
    writeFrozenChange(w.dir, { source: "branch", base: "x", tip: "x", branch: "feat", worktree: "change-ct-8", paths: [], shared: [], held: [] });
    const first = prStation({ cwd: w.work, dir: w.dir, branch: "feat", base: "main", title: "T", exec: w.exec });
    fs.writeFileSync(path.join(w.work, "fix.txt"), "main is green\n");
    git(w.work, "add", "fix.txt");
    git(w.work, "commit", "-qm", "fix main");
    git(w.work, "push", "-q", "origin", "main");
    const refuse = async () => { throw new Error("onto_main is not a running script station"); };
    const r = await rebasePr({ cwd: w.work, dir: w.dir, base: "main", runId: "run-8", post: refuse, exec: w.exec });
    expect(r).toEqual({ ok: false, reason: "Could not record the rebase of feat onto main: onto_main is not a running script station" });
    expect(fs.existsSync(path.join(w.dir, "rebase.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(w.dir, "pr.json"), "utf-8")).head_sha).toBe(first.ok ? first.pr.head_sha : "");
  }, 60_000);

  test("the run's own branch is forced only over the head it last pushed: a push by anyone else stops it", () => {
    const w = world();
    const branch = "codecast/change-ct-6";
    w.freeze(branch, "one\n");
    writeFrozenChange(w.dir, { source: "session", session: "jx7aaaa", base: "x", tip: "x", branch, worktree: "change-ct-6", paths: ["a.txt"], shared: [], held: [] });
    expect(prStation({ cwd: w.work, dir: w.dir, branch, base: "main", title: "T", exec: w.exec }).ok).toBe(true);
    // Someone else force-pushes the run's branch; the session's next freeze must not silently replace it.
    const stranger = w.freeze("elsewhere", "theirs\n");
    git(w.work, "push", "-q", "--force", "origin", `${stranger}:refs/heads/${branch}`);
    w.freeze(branch, "two\n");
    const r = prStation({ cwd: w.work, dir: w.dir, branch, base: "main", exec: w.exec });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^Could not push codecast\/change-ct-6: /);
    expect(git(w.origin, "rev-parse", branch)).toBe(stranger);
  }, 60_000);

  test("a pull request from a fork stops before any push, saying it is not supported", () => {
    const w = world();
    w.freeze("feat", "x\n");
    const fork: Exec = (cmd, args, cwd) => w.exec(cmd, args, cwd, { GH_FORK: "1" });
    expect(prStation({ cwd: w.work, dir: w.dir, branch: "feat", base: "main", title: "T", exec: fork }).ok).toBe(true);
    const ref = git(w.origin, "rev-parse", "feat");
    w.freeze("feat", "y\n");
    const r = prStation({ cwd: w.work, dir: w.dir, branch: "feat", base: "main", exec: w.exec });
    expect(r).toEqual({ ok: false, reason: "Pull request https://github.com/acme/app/pull/41 comes from a fork: the change flow pushes only to origin, so it cannot ship a fork's branch." });
    expect(git(w.origin, "rev-parse", "feat")).toBe(ref);
  }, 60_000);
});
