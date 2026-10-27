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
  role: { handle: string; short_id: string; name: string } | null; // null: a person answered Ship on a run no role started
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

/** Merge `branch` into `into`. With a pull request, `gh pr merge --rebase`
 *  after its checks are green; without one, a fast forward push onto the
 *  default branch of what landingCommit says lands, read again when the
 *  default branch moves between the read and the push. */
export function mergeBranch(args: { cwd: string; branch: string; into: string; pr_url: string | null; exec?: Exec }): MergeOutcome {
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
    const merge = exec("gh", ["pr", "merge", args.pr_url, "--rebase", "--delete-branch"], cwd);
    if (merge.status !== 0) return { kind: "left", reason: `gh pr merge failed: ${(merge.stderr || merge.stdout).trim().split("\n")[0]}` };
    return { kind: "merged", sha, into, via: "pr" };
  }
  // No pull request: the push is a fast forward, so history stays flat.
  for (let attempt = 1; ; attempt++) {
    const landing = landingCommit(exec, cwd, branch, into, sha);
    if ("reason" in landing) return { kind: "left", reason: landing.reason };
    const push = exec("git", ["push", "origin", `${landing.sha}:refs/heads/${into}`], cwd);
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

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

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
 *  authenticated call. */
export async function runMergeStep(
  args: { cwd: string; run_id: string; branch: string; into: string; task?: string; post: (path: string, body: Record<string, unknown>) => Promise<any>; exec?: Exec; log?: (line: string) => void },
): Promise<{ outcome: MergeOutcome; check: MergeCheck | null; recorded: any | null }> {
  const out = await mergeStep(args);
  // The person said Ship and the change is not on the default branch: the
  // task says so as a blocker, where they look, with what is left to land.
  const task = args.task ?? out.check?.task?.short_id;
  if (out.outcome.kind === "left" && task) {
    const text = `Merge left to a person: ${out.outcome.reason}. ${args.branch} is not on ${args.into}; land it by hand.`;
    try { await args.post("/cli/work/comment", { short_id: task, comment_type: "blocker", text }); } catch {}
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
  const outcome = mergeBranch({ cwd: args.cwd, branch: args.branch, into: args.into, pr_url: check.task?.pr_url ?? null, exec: args.exec });
  if (outcome.kind === "left") {
    log(`merge left to a person: ${outcome.reason}`);
    return { outcome, check, recorded: null };
  }
  const recorded = await args.post("/cli/line/merge/record", { run_id: args.run_id, sha: outcome.sha, branch: args.branch, into: outcome.into, ...(check.task?.pr_url ? { pr_url: check.task.pr_url } : {}) });
  log(`merged ${args.branch} into ${outcome.into} at ${outcome.sha.slice(0, 10)} (${recorded.used} of ${recorded.limit} today)`);
  return { outcome, check, recorded };
}
