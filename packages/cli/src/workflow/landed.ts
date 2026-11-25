// What Land checks before it says a change shipped (flows.md FL4): the land
// command's exit 0 is a claim, and the change on origin's default branch is the
// fact. `cast flow landed` finds the commit there that carries the branch and
// writes it to the run's merge.json, where the Deploy stage starts from; a land
// command that exited 0 with nothing on main (one that applied the change to a
// working tree and never committed) ends Land at Not merged. Where Land only
// opened a pull request (Ship's session merges it later), it waits for that
// merge, bounded, naming the pull request while it waits.
import { spawnSync } from "../proc.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultExec } from "../lineMerge.js";
import { git, gitTry } from "../wipSnapshot.js";
import { mergeTree } from "./gitMergeTree.js";

/**
 * The commit on `base` that carries the change on `branch`: the branch itself once main holds it (a fast-forward or
 * a merge), else the commit whose every file reads as the branch left it (a squash), else the first commit that
 * already holds all of it (a replay onto a main that moved in the same files). Null when main does not carry it.
 * A false "landed" sends a change that never merged on to Deploy, so anything short of that proof is null.
 *
 * `since` is where the change started (the branch's fork from main before it landed): a branch with no change of its
 * own since then carries nothing, and is never called landed because its tip happens to be on main; without it a tip
 * main holds is never called landed either. `known` is the change's files when the run knows them; else the files of
 * the branch's own commits since `since` (or its fork), leaving out what a merge of main brought in.
 */
export async function landedCommit(cwd: string, branch: string, base: string, opts: { known?: ReadonlyArray<string>; since?: string } = {}): Promise<{ sha: string; files: string[] } | null> {
  await gitTry(cwd, ["fetch", "-q", "origin", base]);
  const upstream = `origin/${base}`;
  const tip = (await git(cwd, ["rev-parse", branch])).trim();
  if (opts.since) {
    const diff = await git(cwd, ["diff", "--name-only", "--no-renames", opts.since, tip, ...(opts.known?.length ? ["--", ...opts.known] : [])]).catch(() => "");
    if (!diff.trim()) return null;
  }
  // The branch's own commits along its first parent: a merge of main into the branch brings main's files, not the change's.
  const ownFiles = async (from: string) =>
    [...new Set((await git(cwd, ["log", "--first-parent", "--no-merges", "--no-renames", "--format=", "--name-only", `${from}..${tip}`]).catch(() => "")).split("\n").filter(Boolean))].sort();
  const fork = (await git(cwd, ["merge-base", tip, upstream])).trim();
  const known = opts.known?.length ? [...opts.known] : null;
  // A tip main already holds is the change only when the run knows where the change started: else it may be a branch
  // with no commit of its own, sitting on an old main commit.
  if (fork === tip) return opts.since ? { sha: tip, files: known ?? (await ownFiles(opts.since)) } : null;
  const files = known ?? (await ownFiles(opts.since ?? fork));
  if (!files.length) return null;
  const blob = (rev: string, f: string) => gitTry(cwd, ["rev-parse", "-q", "--verify", `${rev}:${f}`]).then((s) => s?.trim() ?? "");
  const want = await Promise.all(files.map((f) => blob(tip, f)));
  const candidates = (await git(cwd, ["log", "--reverse", "--format=%H", `${fork}..${upstream}`, "--", ...files])).split("\n").filter(Boolean);
  // Main holds all of the branch at `c` when merging the branch into it changes nothing. That is the proof: a match of
  // the change's files alone misses what lies outside them (a branch merged into this one, files the run did not
  // list, a mode change the blobs do not show).
  const holdsAll = async (c: string) => {
    const merged = mergeTree(defaultExec, cwd, c, tip);
    return !!merged && !merged.conflicts.length && merged.tree === (await git(cwd, ["rev-parse", `${c}^{tree}`])).trim();
  };
  // A change that only deletes files proves nothing by their absence (main may have moved them): it needs the merge
  // below. Any other lands at the first commit whose every file reads as the branch left it, and that holds it all.
  if (want.some((w) => w !== "")) {
    for (const c of candidates) {
      const got = await Promise.all(files.map((f) => blob(c, f)));
      if (got.every((g, i) => g === want[i]) && (await holdsAll(c))) return { sha: c, files };
    }
  }
  // A replay onto a main that changed the same files elsewhere has no commit reading as the branch left it: it landed
  // at the first commit that already holds all of it.
  for (const c of candidates) if (await holdsAll(c)) return { sha: c, files };
  return null;
}

export type LandedOptions = { branch?: string; as?: string; base: string; files?: string; out?: string; since?: string; wait?: string; interval?: string; run?: string; node?: string };

export type LandedIO = {
  landed: () => Promise<{ sha: string; files: string[] } | null>;
  /** The pull request open for the branch, when there is one. */
  pr: () => { url: string; state: string } | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  progress: (line: string) => void;
};

/**
 * `cast flow landed`: the commit on origin's `base` that carries `branch`, written to `out` as merge.json
 * ({ sha, files }) and printed last. Exits 1 with the line that ends Land at Not merged when nothing was merged, or,
 * with `wait`, 1 when the branch's pull request was closed unmerged and 2 when it has not merged in time.
 */
export async function landedOrWait(opts: LandedOptions, io: LandedIO): Promise<{ code: 0 | 1 | 2; line: string; sha?: string; files?: string[]; pr_url?: string }> {
  const nothing = `Land reported success but ${opts.branch || "the run's branch"} is not on ${opts.base}: nothing was merged`;
  if (!opts.branch) return { code: 1, line: nothing };
  const waitMs = Math.max(0, Number(opts.wait) || 0) * 1000;
  const every = Math.max(5, Number(opts.interval) || 30) * 1000;
  const start = io.now();
  let pr: { url: string; state: string } | null = null;
  for (;;) {
    const found = await io.landed().catch(() => null);
    if (found) return { code: 0, line: found.sha, sha: found.sha, files: found.files, ...(pr ? { pr_url: pr.url } : {}) };
    if (!waitMs) return { code: 1, line: nothing };
    pr = io.pr();
    const waited = Math.floor((io.now() - start) / 60_000);
    if (pr?.state === "CLOSED") return { code: 1, line: `The ship session's pull request ${pr.url} was closed without merging: nothing was merged` };
    if (io.now() - start >= waitMs) return { code: 2, line: `The ship session's ${pr ? `pull request ${pr.url}` : `branch ${opts.branch}`} has not merged after ${waited}m, so this run will not deploy the change` };
    io.progress(`Waiting for ${pr ? `pull request ${pr.url}` : `${opts.branch} to reach ${opts.base}`} to merge (${waited}m of ${Math.round(waitMs / 60_000)}m)`);
    await io.sleep(every);
  }
}

/** The command, wired to this checkout. */
export async function runLanded(cwd: string, opts: LandedOptions, post?: (path: string, body: Record<string, unknown>) => Promise<unknown>): Promise<number> {
  const known = (opts.files ?? "").split(/\s+/).filter(Boolean);
  const r = await landedOrWait(opts, {
    landed: () => landedCommit(cwd, opts.branch!, opts.base, { known, ...(opts.since ? { since: opts.since } : {}) }),
    pr: () => {
      const view = spawnSync("gh", ["pr", "view", opts.branch!, "--json", "url,state"], { cwd, encoding: "utf-8", timeout: 30_000 });
      try { return view.status === 0 ? JSON.parse(view.stdout) : null; } catch { return null; }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    progress: (line) => {
      if (opts.run && opts.node && post) void post("/cli/workflow-runs/progress", { run_id: opts.run, current_node_id: opts.node, node_id: opts.node, node_status: "running", result_preview: line }).catch(() => {});
      else console.error(line);
    },
  });
  if (r.code === 0 && opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, `${JSON.stringify({ sha: r.sha, files: r.files })}\n`);
  }
  if (r.code === 0 && opts.run && post) await recordMerge(post, { run_id: opts.run, sha: r.sha!, branch: opts.as || opts.branch!, into: opts.base, ...(r.pr_url ? { pr_url: r.pr_url } : {}) }, (l) => console.error(l));
  console.log(r.line);
  return r.code;
}

/**
 * Put the landed commit on the run through the record `cast line merge` and the Merge station use
 * (`/cli/line/merge/record`), so run.merge.sha is the one landed truth whatever path landed it. It goes as an observed
 * landing: no merge allowance was checked for it, so it spends none and says nothing on the task, and the server
 * fills only an empty run.merge, never one the Merge station recorded. A run whose merge already names this commit is
 * not asked at all. A record that fails is logged and Land goes on: the commit is on main either way.
 */
export async function recordMerge(post: (path: string, body: Record<string, unknown>) => Promise<unknown>, merge: { run_id: string; sha: string; branch: string; into: string; pr_url?: string }, log: (line: string) => void): Promise<"recorded" | "already" | "failed"> {
  try {
    const read = (await post("/cli/workflow-runs/get", { run_id: merge.run_id })) as { run?: { merge?: { sha?: string } } } | null;
    if (read?.run?.merge?.sha === merge.sha) return "already";
    await post("/cli/line/merge/record", { ...merge, observed: true });
    return "recorded";
  } catch (err) {
    log(`Could not record the merge of ${merge.sha.slice(0, 10)} on the run: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}
