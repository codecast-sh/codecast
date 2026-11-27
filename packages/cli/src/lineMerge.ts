// The line's merge step (docs/architecture/the-line.md L12): what the shipped
// line's `merge` node runs after an approved review. It asks the server
// whether this run's line may merge (the role's merge authority, its daily
// limit, the line's own switch), checks the branch is green and lands on the
// default branch without a merge commit (replayed onto it when the default
// branch has moved on), pushes, and records the merge so the role reports
// it. Every refusal exits 0 with one line saying why: an approved task whose
// merge is left to a person is not a failed run.

import { spawnSync } from "./proc.js";

export type Exec = (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => { status: number; stdout: string; stderr: string };

export const defaultExec: Exec = (cmd, args, cwd, env) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, ...(env ? { env: { ...process.env, ...env } } : {}) });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export type MergeCheck = {
  allowed: boolean;
  reason: string | null;
  on: boolean;
  used: number;
  limit: number | null;
  role: { handle: string; short_id: string; name: string } | null; // null: no role started the run; `authorized` says whose word lets it merge
  authorized?: { user_id: string; why: string };
  task: { short_id: string; title: string; pr_url: string | null } | null;
};

export type MergeOutcome =
  | { kind: "merged"; sha: string; into: string; via: "pr" | "push" }
  | { kind: "left"; reason: string };

/** The checks a pull request must show before the line merges: every
 *  reported check concluded well. Unknown shapes refuse, never pass. */
export function checksGreen(rollup: unknown): { green: boolean; detail: string } {
  if (!Array.isArray(rollup)) return { green: false, detail: "no check rollup" };
  if (rollup.length === 0) return { green: true, detail: "no checks reported" };
  const bad: string[] = [];
  for (const c of rollup as any[]) {
    const state = String(c?.conclusion ?? c?.state ?? "").toUpperCase();
    const ok = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state);
    if (!ok) bad.push(`${c?.name ?? c?.context ?? "check"}=${state || "pending"}`);
  }
  return bad.length ? { green: false, detail: bad.join(", ") } : { green: true, detail: `${rollup.length} checks green` };
}

/** Merge `branch` into `into`. With a pull request, `mergePullRequest` after
 *  its checks are green; without one, a fast forward push onto the default
 *  branch of what landingCommit says lands, read again when the default branch
 *  moves between the read and the push. */
export function mergeBranch(args: { cwd: string; branch: string; into: string; pr_url: string | null; exec?: Exec; wait?: Wait }): MergeOutcome {
  const exec = args.exec ?? defaultExec;
  const { cwd, branch, into } = args;
  const fetch = exec("git", ["fetch", "origin", branch, into], cwd);
  if (fetch.status !== 0) return { kind: "left", reason: `git fetch failed: ${(fetch.stderr || fetch.stdout).trim().split("\n")[0]}` };
  const headOf = exec("git", ["rev-parse", `origin/${branch}`], cwd);
  if (headOf.status !== 0) return { kind: "left", reason: `no branch ${branch} on origin` };
  const sha = headOf.stdout.trim();
  if (args.pr_url) {
    const view = exec("gh", ["pr", "view", args.pr_url, "--json", "statusCheckRollup,mergeable,state"], cwd);
    if (view.status !== 0) return { kind: "left", reason: `gh pr view failed: ${(view.stderr || view.stdout).trim().split("\n")[0]}` };
    let info: any;
    try { info = JSON.parse(view.stdout); } catch { return { kind: "left", reason: "gh pr view returned no JSON" }; }
    if (info.state && info.state !== "OPEN") return { kind: "left", reason: `the pull request is ${String(info.state).toLowerCase()}` };
    const checks = checksGreen(info.statusCheckRollup);
    if (!checks.green) return { kind: "left", reason: `checks are not green: ${checks.detail}` };
    if (info.mergeable && info.mergeable !== "MERGEABLE") return { kind: "left", reason: `the pull request is ${String(info.mergeable).toLowerCase()}` };
    const onto = exec("git", ["rev-parse", `origin/${into}`], cwd).stdout.trim();
    const undone = onto ? undoneChanges(exec, cwd, onto, sha) : [];
    if (undone.length) return { kind: "left", reason: undoneReason(branch, into, undone) };
    const merged = mergePullRequest(exec, cwd, { pr: args.pr_url, branch, head: sha, into, wait: args.wait });
    if ("reason" in merged) return { kind: "left", reason: merged.reason };
    return { kind: "merged", sha: merged.sha, into, via: "pr" };
  }
  // No pull request: the push is a fast forward, so history stays flat.
  for (let attempt = 1; ; attempt++) {
    const landing = landingCommit(exec, cwd, branch, into, sha);
    if ("reason" in landing) return { kind: "left", reason: landing.reason };
    const undone = undoneChanges(exec, cwd, exec("git", ["rev-parse", `origin/${into}`], cwd).stdout.trim(), landing.sha, { head: sha });
    if (undone.length) return { kind: "left", reason: undoneReason(branch, into, undone) };
    // CODECAST_SHIP_PUSH tells the repository's pre-push hook this is the line's own landing, not a hand push.
    const push = exec("git", ["push", "origin", `${landing.sha}:refs/heads/${into}`], cwd, { CODECAST_SHIP_PUSH: "1" });
    if (push.status === 0) {
      exec("git", ["push", "origin", "--delete", branch], cwd);
      return { kind: "merged", sha: landing.sha, into, via: "push" };
    }
    // Another push reached the default branch after the fetch (a merge, a run's record commit): read it again.
    const said = (push.stderr || push.stdout).trim();
    if (attempt >= 3 || !/\[rejected\]|non-fast-forward|fetch first/i.test(said)) return { kind: "left", reason: `git push failed: ${said.split("\n")[0]}` };
    exec("git", ["fetch", "origin", into], cwd);
  }
}

const firstLine = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split("\n")[0];

export type Wait = (ms: number) => void;
export const sleepSync: Wait = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** The squash commit's body: each of the branch's own commits whole, as a `* ` bullet, the shape GitHub gives a
 *  squash, so every Codecast-Session trailer stays in the trailer block that ends its commit's bullet, where
 *  `cast blame` reads it (shared/blame splitSessionTrailer). A repository whose squash default is the PR's
 *  description would otherwise drop them all. Null when the branch's commits cannot be read, and gh writes its own. */
export function squashBody(exec: Exec, cwd: string, head: string, into: string): string | null {
  const log = exec("git", ["log", "--reverse", "--format=%B%x00", `origin/${into}..${head}`], cwd);
  if (log.status !== 0) return null;
  const messages = log.stdout.split("\0").map((m) => m.trim()).filter(Boolean);
  return messages.length ? messages.map((m) => `* ${m}`).join("\n\n") : null;
}

/** `gh pr merge --squash` pinned to the head that was checked (never --admin), and the sha that landed. A gh that
 *  exits non-zero may still have merged, so a failed merge is read again before it counts as one. Only origin's
 *  branch is deleted, and only while it still stands at the merged head: gh's --delete-branch also deletes the local
 *  branch, and gh 2.105 first removes any worktree that has it checked out, a person's or a session's own included
 *  (ct-99406). A branch already gone, or moved since, stays as it is. */
export function mergePullRequest(exec: Exec, cwd: string, args: { pr: string; branch: string; head: string; into: string; wait?: Wait }): { sha: string } | { reason: string } {
  const body = squashBody(exec, cwd, args.head, args.into);
  const merge = exec("gh", ["pr", "merge", args.pr, "--squash", "--match-head-commit", args.head, ...(body ? ["--body", body] : [])], cwd);
  if (merge.status !== 0) {
    let merged = false;
    try { merged = JSON.parse(exec("gh", ["pr", "view", args.pr, "--json", "state"], cwd).stdout)?.state === "MERGED"; } catch {}
    if (!merged) return { reason: `gh pr merge failed: ${firstLine(merge)}` };
  }
  const landed = landedSha(exec, cwd, args.pr, args.into, args.wait);
  if ("sha" in landed) exec("git", ["push", `--force-with-lease=refs/heads/${args.branch}:${args.head}`, "origin", "--delete", args.branch], cwd);
  return landed;
}

const LANDED_TRIES = 6;
const LANDED_WAIT_MS = 2000;

/** The sha a merged pull request landed as: its merge commit, read back from GitHub and found on origin's `into`.
 *  GitHub's git replicas can trail its API for a moment after a merge, so it reads again for about ten seconds
 *  before it calls the merge missing. A pull request GitHub calls merged whose commit the default branch does not
 *  hold has landed nothing. */
export function landedSha(exec: Exec, cwd: string, pr: string, into: string, wait: Wait = sleepSync): { sha: string } | { reason: string } {
  for (let attempt = 1; ; attempt++) {
    let sha = "";
    try { sha = String(JSON.parse(exec("gh", ["pr", "view", pr, "--json", "mergeCommit"], cwd).stdout)?.mergeCommit?.oid ?? ""); } catch {}
    let reason = `gh says ${pr} is merged, but names no merge commit`;
    if (sha) {
      const fetch = exec("git", ["fetch", "origin", into], cwd);
      if (fetch.status !== 0) reason = `gh says ${pr} merged as ${sha.slice(0, 10)}, but origin/${into} could not be fetched to find it: ${firstLine(fetch)}`;
      else if (exec("git", ["merge-base", "--is-ancestor", sha, `origin/${into}`], cwd).status === 0) return { sha };
      else reason = `gh says ${pr} merged as ${sha.slice(0, 10)}, but origin/${into} does not hold that commit`;
    }
    if (attempt >= LANDED_TRIES) return { reason };
    wait(LANDED_WAIT_MS);
  }
}

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** The files `landing` would set back to their content from before one of the default branch's own recent changes
 *  to them, each with the change it undoes. A commit squashed onto the default branch's head over a tree built on an
 *  older default branch carries all the work that landed in between back out, as a fast forward that every other
 *  check passes: on Nov 10 one such commit undid nine commits on Union's main. Reads each touched file's last
 *  `depth` changes on the default branch, and stops after `most` files it would set back.
 *
 *  A file the landing deletes reads as missing, which is also what it was before the commit that created it, so a
 *  deliberate deletion of any file with fewer than `depth` changes looked like undoing its creation (ct-98089: Union's
 *  ct-97881 replaced two files with one and was refused). A stale tree drops main's new files the same way, but it
 *  sets main's other recent changes back with them. So a deletion passes as the change's own when the branch's own
 *  commits, from where `head` left `onto`, deleted the file and the landing sets nothing else back. A file set back to
 *  before a commit the branch's own commits revert (branchReverts) is the branch's own too. */
export function undoneChanges(exec: Exec, cwd: string, onto: string, landing: string, opts: { head?: string; depth?: number; most?: number } = {}): Array<{ file: string; commit: string }> {
  const { head = landing, depth = 8, most = 5 } = opts;
  const git = (...args: string[]) => exec("git", args, cwd);
  // `rev:path` reads the path from the repository's top, wherever in it the step runs; a missing file reads empty.
  const blob = (rev: string, file: string) => { const r = git("rev-parse", "--verify", "-q", `${rev}:${file}`); return r.status === 0 ? r.stdout.trim() : ""; };
  const setBack: Array<{ file: string; commit: string }> = [];
  const dropped: Array<{ file: string; commit: string }> = [];
  const reverted = branchReverts(git, onto, head);
  for (const file of lines(git("diff", "--name-only", "--no-renames", onto, landing).stdout)) {
    const mine = blob(landing, file);
    if (mine === blob(onto, file)) continue;
    const changes = lines(git("log", "--format=%H", "-n", String(depth), onto, "--", `:(top,literal)${file}`).stdout);
    const commit = changes.find((c) => blob(`${c}^`, file) === mine);
    // A revert excuses its commit only while that commit is still the file's newest change on main: setting the
    // file back past it would also erase what main changed there since, so that newest change is named instead.
    if (commit && reverted.has(commit) && commit === changes[0]) continue;
    if (commit) (mine ? setBack : dropped).push({ file, commit: reverted.has(commit) ? changes[0] : commit });
    if (setBack.length >= most) break;
  }
  if (setBack.length || !dropped.length) return [...setBack, ...dropped].slice(0, most);
  const deleted = branchDeletions(git, onto, head);
  return dropped.filter((d) => !deleted.has(d.file)).slice(0, most);
}

/** The commits the branch's own commits revert on purpose, from where `head` left `onto`: `git revert` names each in
 *  its message ("This reverts commit <sha>."). Setting a file back to before one of them is the branch's point, not a
 *  stale tree, so the guard lets that one commit's undoing through, while it is still the file's newest change on
 *  main, and still reads every other file. */
function branchReverts(git: (...args: string[]) => ReturnType<Exec>, onto: string, head: string): Set<string> {
  const base = git("merge-base", onto, head).stdout.trim();
  if (!base) return new Set();
  return new Set([...git("log", "--format=%B", `${base}..${head}`).stdout.matchAll(/This reverts commit ([0-9a-f]{40})/g)].map((m) => m[1]));
}

/** The files the branch's own commits deleted, from where `head` left `onto`: a branch built before a file existed
 *  never deleted it, however its tree reads. */
function branchDeletions(git: (...args: string[]) => ReturnType<Exec>, onto: string, head: string): Set<string> {
  const base = git("merge-base", onto, head).stdout.trim();
  if (!base) return new Set();
  return new Set(lines(git("log", "--format=", "--name-only", "--no-renames", "--diff-filter=D", `${base}..${head}`).stdout));
}

const undoneReason = (branch: string, into: string, undone: Array<{ file: string; commit: string }>) =>
  `${branch} would undo changes ${into} made after it was built (${undone.map((u) => `${u.file} from ${u.commit.slice(0, 10)}`).join(", ")}); build it again on ${into} first`;

/** What lands on the default branch for the branch head `head`: the head itself when it already contains the default
 *  branch. When the default branch has moved on since they parted, and changed none of the files the branch touches
 *  (what the line's Up to date step calls fresh, so the change a person approved is the change that lands), the
 *  branch's own commits replayed on top, each keeping its author, date and message (its Codecast-Session trailer
 *  included), as a rebase would. A branch whose commits do not replay (the default branch took part of the change in
 *  another form, and the branch's merges of it reconcile the two) lands as one commit of the two merged, its commits'
 *  messages listed as a squash merge lists them. A branch whose files the default branch also changed is left, to be
 *  built again on it. */
function landingCommit(exec: Exec, cwd: string, branch: string, into: string, head: string): { sha: string } | { reason: string } {
  const git = (...args: string[]) => exec("git", args, cwd);
  const onto = git("rev-parse", `origin/${into}`).stdout.trim();
  if (!onto) return { reason: `no branch ${into} on origin` };
  if (git("merge-base", "--is-ancestor", onto, head).status === 0) return { sha: head };
  const base = git("merge-base", onto, head).stdout.trim();
  if (!base) return { reason: `${branch} shares no history with ${into}` };
  // Paths from the repository's top, wherever in it the step runs (a line's checkout can be a subdirectory).
  const touched = lines(git("diff", "--name-only", base, head).stdout);
  const clash = touched.length ? lines(git("diff", "--name-only", base, onto, "--", ...touched.map((f) => `:(top,literal)${f}`)).stdout) : [];
  if (clash.length) return { reason: `${branch} is behind ${into}, which changed files it touches (${clash.slice(0, 5).join(", ")}${clash.length > 5 ? ", ..." : ""}); build it again on ${into} first` };
  const merge = git("merge-tree", "--write-tree", onto, head);
  if (merge.status !== 0) return { reason: `${branch} does not merge cleanly onto ${into}` };
  const merged = lines(merge.stdout)[0];
  const own = lines(git("rev-list", "--reverse", "--no-merges", `${base}..${head}`).stdout).map((commit) => {
    const [name, email, date, message = ""] = git("show", "-s", "--format=%an%x00%ae%x00%ad%x00%B", "--date=raw", commit).stdout.split("\0");
    return { commit, message: message.trimEnd(), env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date } };
  });
  if (!own.length) return { reason: `${branch} has no commits of its own to land` };
  const make = (tree: string, parent: string, c: { message: string; env: Record<string, string> }) => {
    const made = exec("git", ["commit-tree", tree, "-p", parent, "-m", c.message], cwd, c.env);
    return made.status === 0 ? made.stdout.trim() : null;
  };
  let tip: string | null = onto;
  for (const c of own) {
    const tree = git("merge-tree", "--write-tree", `--merge-base=${c.commit}^`, tip, c.commit);
    tip = tree.status === 0 ? make(lines(tree.stdout)[0], tip, c) : null;
    if (!tip) break;
  }
  if (tip && git("rev-parse", `${tip}^{tree}`).stdout.trim() === merged) return { sha: tip };
  const lead = [...own].reverse().find((c) => /^fix\b/.test(c.message)) ?? own[own.length - 1];
  const squash = make(merged, onto, { env: lead.env, message: `${lead.message.split("\n")[0]}\n\n${own.map((c) => `* ${c.message}`).join("\n\n")}` });
  return squash ? { sha: squash } : { reason: `${branch} could not be committed onto ${into}` };
}

/** The whole step, from the allowance to the record. `post` is the CLI's
 *  authenticated call; `session` is who the step's comment signs as (the
 *  caller's own session, else its run's), never the person behind the token. */
export async function runMergeStep(
  args: { cwd: string; run_id: string; branch: string; into: string; task?: string; session?: string; post: (path: string, body: Record<string, unknown>) => Promise<any>; exec?: Exec; log?: (line: string) => void },
): Promise<{ outcome: MergeOutcome; check: MergeCheck | null; recorded: any | null }> {
  const out = await mergeStep(args);
  // The person said Ship and the change is not on the default branch: the
  // task says so as a blocker, where they look, with what is left to land.
  const task = args.task ?? out.check?.task?.short_id;
  if (out.outcome.kind === "left" && task) {
    const text = `Merge left to a person: ${out.outcome.reason}. ${args.branch} is not on ${args.into}; land it by hand.`;
    try { await args.post("/cli/work/comment", { short_id: task, comment_type: "blocker", text, ...(args.session ? { conversation_id: args.session } : {}) }); } catch {}
  }
  return out;
}

async function mergeStep(
  args: Parameters<typeof runMergeStep>[0],
): Promise<{ outcome: MergeOutcome; check: MergeCheck | null; recorded: any | null }> {
  const log = args.log ?? (() => {});
  let check: MergeCheck | null = null;
  try {
    check = (await args.post("/cli/line/merge/check", { run_id: args.run_id })) as MergeCheck;
  } catch (err: any) {
    const reason = `could not read the merge allowance: ${err?.message ?? String(err)}`;
    log(`merge left to a person: ${reason}`);
    return { outcome: { kind: "left", reason }, check: null, recorded: null };
  }
  if (!check.allowed) {
    log(`merge left to a person: ${check.reason}`);
    return { outcome: { kind: "left", reason: check.reason ?? "not allowed" }, check, recorded: null };
  }
  const held = await beforeMergeSteps(args.exec ?? defaultExec, args.cwd, args.branch, args.into);
  if (held) {
    log(`merge left to a person: ${held}`);
    return { outcome: { kind: "left", reason: held }, check, recorded: null };
  }
  const outcome = mergeBranch({ cwd: args.cwd, branch: args.branch, into: args.into, pr_url: check.task?.pr_url ?? null, exec: args.exec });
  if (outcome.kind === "left") {
    log(`merge left to a person: ${outcome.reason}`);
    return { outcome, check, recorded: null };
  }
  const recorded = await args.post("/cli/line/merge/record", { run_id: args.run_id, sha: outcome.sha, branch: args.branch, into: outcome.into, ...(check.task?.pr_url ? { pr_url: check.task.pr_url } : {}) });
  log(`merged ${args.branch} into ${outcome.into} at ${outcome.sha.slice(0, 10)} (${recorded.used} of ${recorded.limit} today)`);
  return { outcome, check, recorded };
}

/** Why the line may not merge this branch itself, or null. The default branch's own workspace.toml can name steps
 *  that must run before a change lands (a backend deploy ahead of the web build a push starts): this merge runs
 *  none of them, so a change those steps cover goes through the change flow's Merge, which does. Fails closed: a
 *  profile or diff it cannot read holds the merge. */
async function beforeMergeSteps(exec: Exec, cwd: string, branch: string, into: string): Promise<string | null> {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { shipSpec, deploysFor } = await import("./land/shipCheckout.js");
  const fetch = exec("git", ["fetch", "origin", branch, into], cwd);
  if (fetch.status !== 0) return `git fetch failed: ${firstLine(fetch)}`;
  const toml = exec("git", ["show", `origin/${into}:.codecast/workspace.toml`], cwd);
  if (toml.status !== 0) return null; // no workspace profile on the default branch: no before-merge steps
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "line-merge-profile-"));
  try {
    fs.mkdirSync(path.join(dir, ".codecast"));
    fs.writeFileSync(path.join(dir, ".codecast", "workspace.toml"), toml.stdout);
    let steps;
    try { steps = shipSpec(dir).deploy.filter((s) => s.stage === "before_push"); } catch (err: any) { return `could not read the default branch's ship steps: ${err?.message ?? String(err)}`; }
    if (!steps.length) return null;
    const diff = exec("git", ["diff", "--name-only", `origin/${into}...origin/${branch}`], cwd);
    if (diff.status !== 0) return `could not list the change's files: ${firstLine(diff)}`;
    const due = deploysFor(steps, diff.stdout.split("\n").filter(Boolean));
    if (!due.length) return null;
    return `${due.map((s) => s.name).join(", ")} must run before this change lands, and a line merge runs none; ship it through the change flow (cast flow run change --branch ${branch})`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
