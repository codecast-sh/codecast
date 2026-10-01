// The line's merge step (docs/architecture/the-line.md L12): what the shipped
// line's `merge` node runs after an approved review. It asks the server
// whether this run's line may merge (the role's merge authority, its daily
// limit, the line's own switch), checks the branch is green and lands on the
// default branch without a merge commit, pushes, and records the merge so
// the role reports it. Every refusal exits 0 with one line saying why: an
// approved task whose merge is left to a person is not a failed run.

import { spawnSync } from "child_process";

export type Exec = (cmd: string, args: string[], cwd: string) => { status: number; stdout: string; stderr: string };

export const defaultExec: Exec = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export type MergeCheck = {
  allowed: boolean;
  reason: string | null;
  on: boolean;
  used: number;
  limit: number | null;
  role: { handle: string; short_id: string; name: string };
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
 *  after its checks are green; without one, a fast forward push of the
 *  branch onto the default branch, refused when the branch is behind it. */
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
  // No pull request: the branch must already contain the default branch, so
  // the push is a fast forward and history stays flat.
  const ff = exec("git", ["merge-base", "--is-ancestor", `origin/${into}`, `origin/${branch}`], cwd);
  if (ff.status !== 0) return { kind: "left", reason: `${branch} is behind ${into}; rebase it first` };
  const push = exec("git", ["push", "origin", `${sha}:refs/heads/${into}`], cwd);
  if (push.status !== 0) return { kind: "left", reason: `git push failed: ${(push.stderr || push.stdout).trim().split("\n")[0]}` };
  exec("git", ["push", "origin", "--delete", branch], cwd);
  return { kind: "merged", sha, into, via: "push" };
}

/** The whole step, from the allowance to the record. `post` is the CLI's
 *  authenticated call. */
export async function runMergeStep(
  args: { cwd: string; run_id: string; branch: string; into: string; post: (path: string, body: Record<string, unknown>) => Promise<any>; exec?: Exec; log?: (line: string) => void },
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
