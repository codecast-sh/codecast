// The change flow's Wait for main station (flows.md FL4): `cast flow
// wait-main` holds a change whose every CI failure also fails on the default
// branch until that branch's own CI is green again, then the run rebases the
// change onto it and runs CI once more. It reads the default branch's CI with
// `gh run list`, so it works for any repository on GitHub Actions.
//
// Main's CI is the push runs of the workflows the repository runs on pull
// requests, the ones the CI station judges: a release or deploy workflow
// dispatched on main is not CI. A commit CI never runs on (a release's version
// bump, pushed by a workflow's token, which starts no workflow) is judged by
// the newest commit under it that CI ran on. A person's commit with no run is
// one CI has not started on yet, unless it was pushed long enough ago that CI
// would have: until then main's head is still to be judged.
import { defaultExec, type Exec } from "../lineMerge.js";
import { stationCli, type StationCli } from "./stationReexec.js";

type Run = { databaseId: number; workflowName?: string; headSha: string; status: string; conclusion: string | null; event?: string };

const PASSING = new Set(["success", "neutral", "skipped"]);
/** How far under main's head the wait looks for a commit CI ran on. */
const DEPTH = 100;
/** How long after its commit CI has always started on a person's push: a commit older with no run never gets one. */
const CI_STARTS_MS = 10 * 60_000;
const short = (sha: string) => sha.slice(0, 10);

/** "1h 5m", "23m", "40s". */
export function spoken(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

export type MainCi = {
  head: string;
  /** The commit judged: main's head, or the newest commit under it that CI ran on. */
  judged: string;
  /** Commits on top of the judged one that no CI ran on. */
  skipped: number;
  state: "green" | "red" | "pending";
  /** The workflow runs judging it (none: CI has not started on main's head yet). */
  runs: number;
  failed: Run[];
};

/** Why the judged commit is not main's head, or "" when it is. */
export function judgedWhy(ci: Pick<MainCi, "head" | "skipped">): string {
  if (!ci.skipped) return "";
  return ci.skipped === 1 ? `main's head ${short(ci.head)} has no CI run` : `main's ${ci.skipped} newest commits, up to ${short(ci.head)}, have no CI run`;
}

/** The workflows the repository runs on pull requests, by name; null when gh cannot say. */
function prWorkflows(exec: Exec, cwd: string): Set<string> | null {
  const list = exec("gh", ["run", "list", "--event", "pull_request", "--limit", "50", "--json", "workflowName"], cwd);
  try {
    const names = (JSON.parse(list.stdout) as Array<{ workflowName?: string }>).map((r) => r.workflowName).filter(Boolean) as string[];
    return names.length ? new Set(names) : null;
  } catch { return null; }
}

/** Main's first-parent commits from its head down, newest first: fetched when the checkout does not hold them yet. */
function commitsUnder(exec: Exec, cwd: string, base: string, head: string): string[] {
  const list = () => exec("git", ["rev-list", "--first-parent", `--max-count=${DEPTH}`, head], cwd);
  let r = list();
  if (r.status !== 0) {
    exec("git", ["fetch", "-q", "origin", base], cwd);
    r = list();
  }
  return r.status === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [head];
}

/** Whether CI never runs on a commit that has no run: a bot's push (a workflow's token starts no workflow), or one old enough that CI would have started. */
function noCiComing(exec: Exec, cwd: string, sha: string, now: number): boolean {
  const r = exec("git", ["log", "-1", "--format=%an%x1f%cn%x1f%ct", sha], cwd);
  const [author = "", committer = "", at = ""] = r.stdout.trim().split("\x1f");
  if (r.status !== 0) return false;
  return /\[bot\]$/.test(author) || /\[bot\]$/.test(committer) || now - Number(at) * 1000 >= CI_STARTS_MS;
}

/** The default branch's head and its CI: green, red (with the failed runs), or still going, on the commit it judged. */
export function mainCi(exec: Exec, cwd: string, base: string, now = Date.now()): MainCi | { reason: string } {
  const ls = exec("git", ["ls-remote", "origin", `refs/heads/${base}`], cwd);
  const head = ls.stdout.trim().split(/\s/)[0] ?? "";
  if (!head) return { reason: `cannot read origin's ${base}: ${(ls.stderr || ls.stdout).trim().split("\n")[0] ?? ""}` };
  const list = exec("gh", ["run", "list", "--branch", base, "--limit", "100", "--json", "databaseId,workflowName,headSha,status,conclusion,event"], cwd);
  let runs: Run[];
  try { runs = JSON.parse(list.stdout) as Run[]; } catch { return { reason: `gh run list failed: ${(list.stderr || list.stdout).trim().split("\n")[0] ?? ""}` }; }
  const ci = prWorkflows(exec, cwd);
  // A run ci.yml's concurrency replaced (cancelled) never judged its commit: the newer run holds it.
  runs = runs.filter((r) => (r.event ?? "push") === "push" && r.conclusion !== "cancelled" && (!ci || ci.has(r.workflowName ?? "")));
  const on = (sha: string) => runs.filter((r) => r.headSha === sha);
  let judged = head;
  let skipped = 0;
  if (!on(head).length) {
    const under = commitsUnder(exec, cwd, base, head);
    const at = under.findIndex((sha) => on(sha).length > 0);
    // No CI run on any of them yet, or one above it that CI may still start on: main's head is still to be judged.
    if (at > 0 && under.slice(0, at).every((sha) => noCiComing(exec, cwd, sha, now))) { judged = under[at]!; skipped = at; }
  }
  // Each workflow by its newest run on the commit.
  const newest = new Map<string, Run>();
  for (const r of on(judged)) {
    const key = r.workflowName ?? String(r.databaseId);
    if (!newest.has(key) || newest.get(key)!.databaseId < r.databaseId) newest.set(key, r);
  }
  const judging = [...newest.values()];
  const failed = judging.filter((r) => r.status === "completed" && !PASSING.has(r.conclusion ?? ""));
  const state = failed.length ? "red" : judging.length && judging.every((r) => r.status === "completed") ? "green" : "pending";
  return { head, judged, skipped, state, runs: judging.length, failed };
}

/** The failed jobs of the failed runs, as "<workflow>: <job>". */
function redJobs(exec: Exec, cwd: string, failed: Run[]): string[] {
  return failed.flatMap((r) => {
    const view = exec("gh", ["run", "view", String(r.databaseId), "--json", "jobs"], cwd);
    try {
      const jobs = (JSON.parse(view.stdout).jobs ?? []) as Array<{ name: string; conclusion: string | null }>;
      const bad = jobs.filter((j) => j.conclusion && !PASSING.has(j.conclusion)).map((j) => `${r.workflowName ?? "CI"}: ${j.name}`);
      return bad.length ? bad : [r.workflowName ?? `run ${r.databaseId}`];
    } catch {
      return [r.workflowName ?? `run ${r.databaseId}`];
    }
  });
}

/** What the wait is on while main is not green: red since a commit, CI still running on the judged one, or none there yet. */
function pendingWords(ci: MainCi, redSince: string): string {
  const why = judgedWhy(ci);
  const at = redSince ? `red since ${short(redSince)}` : ci.runs ? `CI running at ${short(ci.judged)}` : `no CI run yet at ${short(ci.judged)}`;
  return why ? `${at}; ${why}` : at;
}

export async function waitForMain(args: {
  cwd: string;
  base: string;
  deadlineMs: number;
  intervalMs: number;
  exec?: Exec;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  say?: (line: string) => void;
  /** Moves the wait onto a newer installed CLI between polls (stationReexec.ts). */
  cli?: StationCli;
}): Promise<{ ok: boolean; line: string }> {
  const exec = args.exec ?? defaultExec;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cli = args.cli ?? stationCli();
  const back = cli.resumed<{ start: number; redSince: string }>();
  const start = back?.start ?? now();
  let redSince = back?.redSince ?? "";
  let last: ReturnType<typeof mainCi> | null = null;
  for (;;) {
    last = mainCi(exec, args.cwd, args.base, now());
    if ("state" in last && last.state === "green") return { ok: true, line: `Main CI is green at ${short(last.judged)}${last.skipped ? `: ${judgedWhy(last)}, so the newest commit under it that CI ran on is judged` : ""}.` };
    if ("state" in last && last.state === "red" && !redSince) redSince = last.judged;
    const waited = now() - start;
    if (waited >= args.deadlineMs) break;
    args.say?.("reason" in last
      ? `Waiting for main CI to go green (${last.reason}; ${spoken(waited)} of ${spoken(args.deadlineMs)})`
      : `Waiting for main CI to go green (${pendingWords(last, redSince)}; ${spoken(waited)} of ${spoken(args.deadlineMs)})`);
    await sleep(args.intervalMs);
    await cli.between({ start, redSince });
  }
  if ("reason" in last) return { ok: false, line: `Main CI never read green in ${spoken(args.deadlineMs)}: ${last.reason}.` };
  const jobs = last.failed.length ? redJobs(exec, args.cwd, last.failed) : [];
  const why = judgedWhy(last);
  return { ok: false, line: `Main CI stayed red for ${spoken(args.deadlineMs)}${redSince ? ` (red since ${short(redSince)})` : ""}, at ${short(last.judged)}${why ? ` (${why})` : ""}${jobs.length ? `: ${jobs.join(", ")}` : !last.runs ? ": no CI run on it yet" : ", still running"}.` };
}
