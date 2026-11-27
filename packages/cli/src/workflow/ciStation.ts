// `cast flow ci`: the change flow's CI station. It parks on a pull request's
// CI and writes the verdict as ci.json. Green is GitHub's own: every workflow
// run on the head concluded success (GitHub already accounts for
// continue-on-error and for jobs that gate on others) and every check from
// outside Actions passed. Nothing else is ever green. A change that edits CI
// itself is flagged beside the verdict (ci_changed), since CI cannot vouch for
// a change to itself: the flow takes it to a person before Merge.
//
// When the head is red, the station reruns the failed jobs once to absorb
// flakes, then splits the failures by whether main's own CI has them too, or
// main's CI never reached a verdict on them (its run at the tested sha was
// cancelled or still going, and no later run of main holding that sha judged
// them either). A job that fails only because jobs it needs failed (a summary
// job like `verify`) is no failure of its own. That split only routes: a change
// whose every failure is main's, or one main's CI never judged, is blocked by
// main (the flow waits for main and reruns on a rebased head) rather than sent
// back to its author. A wrong split misroutes and corrects itself on the
// rebased rerun; it can never make a change green. It always exits 0.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "../proc.js";
import { LINE_PROFILE_REL_PATH, parseLineProfileText } from "../lineProfile.js";
import { jobFailures, type CiFailure, type NamedFailure } from "@codecast/shared/contracts/ciFailures";
import { stationCli, type StationCli } from "./stationReexec.js";

export type Gh = (args: string[]) => { code: number; out: string };

export interface CiResult {
  /** GitHub's verdict on the head, whether or not the change edits CI. */
  green: boolean;
  /** The pull request head this verdict judged. */
  head_sha: string | null;
  tested_main_sha: string | null;
  /** The failures main's CI does not have: the change's to fix. */
  failing: CiFailure[];
  /** The failures main's CI has too, at the tested sha or its nearest run of that job. */
  preexisting: CiFailure[];
  /**
   * The failures main's CI never judged: its run at the tested sha was cancelled or still going, and no later run of
   * main holding that sha reached a verdict on the job. Neither the change's for sure nor main's.
   */
  unjudged: CiFailure[];
  /** Red, and every failure is main's or one main's CI never judged: wait for main, then rerun on a rebased head. */
  blocked_by_main: boolean;
  /** The change edits CI (`.github/**`, a `[line] ci_paths` path, or a file list too long to rule it out): a person must Ship it. */
  ci_changed: boolean;
  /**
   * With ci_changed, what the CI edit is: a digest of the change's own edit to each CI path the pull request touches
   * (ci_edit_files). An approval of the edit holds while this is the same; null when it could not be read.
   */
  ci_edit: string | null;
  /** The digest of each CI path's edit, by path (a renamed file by its new path), so a re-ask can say which changed. */
  ci_edit_files: Record<string, string> | null;
  /** What was still running, or never started, when the deadline passed. */
  pending: string[];
  /** Of `pending`, the workflows that never started on the head. */
  not_started: string[];
  reran: boolean;
  timed_out: boolean;
  /** No workflow runs on this pull request and no outside check reports on it. */
  no_ci: boolean;
  /** Waiting for `--head`, the pull request's head moved past or away from it: that head will never be judged. */
  head_moved: boolean;
  /** With head_moved, the head the pull request has instead. */
  observed_head: string | null;
}

interface Check {
  name: string;
  done: boolean;
  failed: boolean;
  /** A GitHub Actions job, else an outside app or status. */
  actions: boolean;
  url: string | null;
  runId: number | null;
  jobId: string | null;
  skipped: boolean;
  started: number;
  completed: number;
}

interface HeadRun { databaseId: number; status: string; conclusion?: string; attempt?: number; workflowName?: string; event?: string }
interface Job { name: string; databaseId: number; status: string; conclusion: string }
interface MainRun { databaseId: number; headSha?: string; createdAt: string; status?: string; conclusion?: string }

const CHECK_PASSED = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const JOB_PASSED = new Set(["success", "skipped", "neutral"]);
// A run whose every job was skipped concludes skipped: nothing in it failed.
const RUN_PASSED = JOB_PASSED;
// Always CI, whatever the line profile says: the workflows, and codecast's own config (the line profile among it).
const ALWAYS_CI = [".github/**", ".codecast/**"];
// The events whose runs on the head are the change's CI.
const CI_EVENTS = new Set(["pull_request", "pull_request_target", "push"]);
const POLL_MS = 30_000;
// Reading logs after the wait: enough for a handful of jobs and main's runs, and never an open-ended tail.
const GRACE_MS = 5 * 60_000;
// How long to look for a run before saying the repository runs no CI on this pull request.
const NO_CI_SETTLE_MS = 2 * 60_000;
// GitHub lists at most this many of a pull request's files; at the cap the list may be cut short.
const FILES_CAP = 3000;

/** "90s", "60m", "2h", "1h30m"; a bare number is minutes. */
export function parseDeadline(s: string): number | null {
  const t = s.trim();
  if (/^\d+$/.test(t)) return Number(t) * 60_000;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!t || !m) return null;
  const ms = Number(m[1] ?? 0) * 3_600_000 + Number(m[2] ?? 0) * 60_000 + Number(m[3] ?? 0) * 1000;
  return ms > 0 ? ms : null;
}

function readChecks(rollup: any[]): Check[] {
  return rollup.map((c) => {
    if (c.__typename === "StatusContext") {
      const state = String(c.state ?? "").toUpperCase();
      return { name: String(c.context), done: state !== "PENDING" && state !== "EXPECTED", failed: state !== "SUCCESS" && state !== "PENDING" && state !== "EXPECTED", actions: false, url: c.targetUrl ?? null, runId: null, jobId: null, skipped: false, started: NaN, completed: NaN };
    }
    const done = String(c.status ?? "").toUpperCase() === "COMPLETED";
    const conclusion = String(c.conclusion ?? "").toUpperCase();
    const ids = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(String(c.detailsUrl ?? ""));
    return {
      name: String(c.name),
      done,
      failed: done && !CHECK_PASSED.has(conclusion),
      actions: !!ids,
      url: c.detailsUrl ?? null,
      runId: ids ? Number(ids[1]) : null,
      jobId: ids?.[2] ?? null,
      skipped: conclusion === "SKIPPED",
      started: Date.parse(c.startedAt),
      completed: Date.parse(c.completedAt),
    };
  });
}

// ── workflow files: which ones run on this pull request ─────────────────────

/** A workflow job as its file declares it: the name its runs carry, and the jobs it needs. */
interface WorkflowJob { name: string; needs: string[] }
interface Workflow { name: string; on: unknown; jobs: Record<string, WorkflowJob> }

/** A workflow file's name and triggers, or null when it does not parse (or this runtime has no YAML parser). */
function parseWorkflow(text: string, file: string): Workflow | null {
  if (typeof Bun === "undefined") return null;
  let doc: any;
  try { doc = Bun.YAML.parse(text); } catch { return null; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const jobs: Record<string, WorkflowJob> = {};
  for (const [id, j] of Object.entries(doc.jobs && typeof doc.jobs === "object" ? doc.jobs as Record<string, any> : {})) {
    jobs[id] = { name: typeof j?.name === "string" ? j.name : id, needs: [j?.needs ?? []].flat().map(String) };
  }
  // GitHub names a workflow without `name:` by its path.
  return { name: typeof doc.name === "string" ? doc.name : file, on: doc.on ?? doc.true, jobs };
}

const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^$()|{}[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*")}$`);
/** GitHub's filter match: patterns in order, a later `!pattern` taking a match back. */
function filterMatches(value: string, patterns: unknown): boolean {
  let hit = false;
  for (const p of [patterns].flat().map(String)) {
    const negated = p.startsWith("!");
    if (globRe(negated ? p.slice(1) : p).test(value)) hit = !negated;
  }
  return hit;
}

/**
 * Whether a push to this pull request runs the workflow: on pull_request (its base branch) or on push (its head
 * branch), with paths filters read against the changed files. True, false, or null when the station cannot tell
 * (an activity-type filter, or a paths filter over a file list that may be cut short).
 */
function runsOnPullRequest(wf: Workflow, pr: { base: string; head: string }, files: string[] | null): boolean | null {
  const on = wf.on;
  const events: Record<string, any> | null = typeof on === "string" ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((e) => [String(e), null])) : on && typeof on === "object" ? (on as Record<string, any>) : null;
  if (!events) return null;
  let verdict: boolean | null = false;
  for (const [event, branch] of [["pull_request", pr.base], ["pull_request_target", pr.base], ["push", pr.head]] as const) {
    if (!(event in events)) continue;
    const f = events[event] ?? {};
    if (f.branches && !filterMatches(branch, f.branches)) continue;
    if (f["branches-ignore"] && filterMatches(branch, f["branches-ignore"])) continue;
    if (event === "push" && f.tags && !f.branches) continue;
    if (f.types && ![f.types].flat().includes("synchronize")) { verdict = null; continue; }
    if (f.paths || f["paths-ignore"]) {
      if (!files) { verdict = null; continue; }
      if (f.paths && !files.some((p) => filterMatches(p, f.paths))) continue;
      if (f["paths-ignore"] && files.every((p) => filterMatches(p, f["paths-ignore"]))) continue;
    }
    return true;
  }
  return verdict;
}

// ── the station ─────────────────────────────────────────────────────────────

export interface CiStationOptions {
  pr: number;
  dir: string;
  deadlineMs: number;
  /** Judge only this head: wait until the pull request's head is it (the sha the flow pushed). */
  head?: string;
  gh?: Gh;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Each new progress line (the card's line for the station while it waits). */
  progress?: (line: string) => void;
  /** Moves the wait onto a newer installed CLI between polls (stationReexec.ts). */
  cli?: StationCli;
}

/** Where the wait stands, handed to a newer CLI: a resumed station keeps its deadline and never reruns twice. */
type CiPlace = { started: number; reran: boolean; reruns: Array<[number, number]>; seen: string | null; settled: boolean; said: string };

const minutes = (ms: number) => `${Math.floor(ms / 60_000)}m`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const stationFailure = (excerpt: string): CiFailure => ({ job: "ci-station", test: null, assertion: null, file: null, line: null, excerpt });

/** Wait, rerun once, judge, write ci.json; returns the result, its one-line summary, and whether ci.json was written. Never throws. */
export async function runCiStation(o: CiStationOptions): Promise<{ result: CiResult; summary: string; written: boolean }> {
  const file = path.join(o.dir, "ci.json");
  // A verdict left by an earlier visit, perhaps on another head, must never stand in for this one.
  try { fs.rmSync(file, { force: true }); } catch {}
  const result: CiResult = { green: false, head_sha: null, tested_main_sha: null, failing: [], preexisting: [], unjudged: [], blocked_by_main: false, ci_changed: false, ci_edit: null, ci_edit_files: null, pending: [], not_started: [], reran: false, timed_out: false, no_ci: false, head_moved: false, observed_head: null };
  let summary: string;
  try {
    if (!(o.deadlineMs > 0)) throw new Error("--deadline is not a duration (90s, 60m, 2h, 1h30m)");
    summary = await new Station(o, result).watch();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    Object.assign(result, { green: false, blocked_by_main: false });
    result.failing.push(stationFailure(why));
    summary = `CI station could not judge #${o.pr}: ${why.split("\n")[0]}`;
  }
  let written = false;
  try {
    fs.mkdirSync(o.dir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(result, null, 2) + "\n");
    fs.renameSync(`${file}.tmp`, file);
    written = true;
  } catch {}
  return { result, summary, written };
}

class Station {
  private gh: Gh;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private progress: (line: string) => void;
  private cli: StationCli;
  private repo = "";
  private files = new Map<string, string[] | null>();
  private moved = new Map<string, boolean>();
  private expected = new Map<string, { names: string[]; unsure: boolean }>();
  /** Each workflow's jobs as its file at the head declares them, by the workflow's name. */
  private workflowJobs = new Map<string, Record<string, WorkflowJob>>();
  private holds = new Map<string, boolean>();
  private tested = new Map<string, string>();
  private logs = new Map<string, { code: number; out: string }>();
  private jobs = new Map<number, Job[]>();
  private mainRuns = new Map<string, MainRun[]>();
  private allowEscapes = true;
  /** After the wait, every gh call must start before this. */
  private limit = Infinity;

  constructor(private o: CiStationOptions, private result: CiResult) {
    this.gh = o.gh ?? ghCli;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.progress = o.progress ?? (() => {});
    this.cli = o.cli ?? stationCli();
  }

  private call(args: string[]): { code: number; out: string } {
    return this.now() < this.limit ? this.gh(args) : { code: 1, out: "the station ran out of time to read it" };
  }

  async watch(): Promise<string> {
    const { o, result } = this;
    const back = this.cli.resumed<CiPlace>();
    const started = back?.started ?? this.now();
    const deadline = started + o.deadlineMs;
    const clock = () => `${minutes(this.now() - started)} of ${minutes(o.deadlineMs)}`;
    // The attempt each rerun run was on: until GitHub starts the next attempt and finishes it, the run is still going.
    let reruns = new Map<number, number>(back?.reruns ?? []);
    result.reran = back?.reran ?? false;
    // A green must hold over two looks, so an outside check that registers once Actions finishes is still seen.
    let settled = back?.settled ?? false;
    let said = back?.said ?? "";
    // The head the last look saw. ci.json's head_sha names only a head the station judged.
    let seen: string | null = back?.seen ?? null;
    // Between polls nothing is in flight, so that is where the wait may move onto a newer CLI.
    const rest = async () => {
      await this.sleep(o.pollMs ?? POLL_MS);
      await this.cli.between({ started, reran: result.reran, reruns: [...reruns], seen, settled, said } satisfies CiPlace);
    };
    for (;;) {
      const read = this.read();
      if (typeof read === "string") {
        if (this.now() >= deadline) {
          result.timed_out = true;
          result.failing.push(stationFailure(`Could not read the pull request's CI before the deadline: ${read}`));
          return `CI timed out on #${o.pr} after ${minutes(o.deadlineMs)}: gh kept failing (${read.split("\n")[0]})`;
        }
        const line = `Cannot read CI for #${o.pr} (${read.split("\n")[0]}); trying again, ${clock()}`;
        if (line !== said) this.progress((said = line));
        await rest();
        continue;
      }
      const { pr, runs, files, expected } = read;
      if (seen && pr.headRefOid !== seen) {
        // A new head is a new change: its failures get their own rerun.
        reruns = new Map();
        result.reran = false;
        settled = false;
      }
      seen = pr.headRefOid;
      const head = pr.headRefOid.slice(0, 7);
      const wanted = !o.head || pr.headRefOid === o.head;
      const checks = readChecks(pr.statusCheckRollup ?? []);
      const ciRuns = runs.filter((r) => CI_EVENTS.has(r.event ?? "pull_request"));
      // A check from any other run on the head (a workflow_run follow-up, say) must pass like an outside app's.
      const outside = checks.filter((c) => !c.actions || !ciRuns.some((r) => r.databaseId === c.runId));
      const going = ciRuns.filter((r) => r.status !== "completed" || (reruns.has(r.databaseId) && (r.attempt ?? 1) <= reruns.get(r.databaseId)!));
      const lost = [...reruns.keys()].filter((id) => !ciRuns.some((r) => r.databaseId === id));
      // A workflow registers its run only when it starts: one that has not yet is still to come.
      const missing = expected.names.filter((n) => !ciRuns.some((r) => r.workflowName === n));
      const running = checks.filter((c) => !c.done).map((c) => c.name);

      let waitingOn: string | null = null;
      let noCi = false;
      if (!wanted && this.movedAway(pr.headRefOid, o.head!)) {
        result.head_moved = true;
        result.observed_head = pr.headRefOid;
        return `PR head moved to ${head} while waiting for ${o.head!.slice(0, 7)}; a new round starts`;
      }
      if (!wanted) waitingOn = `the head to be ${o.head!.slice(0, 7)} (it is ${head})`;
      else if (!ciRuns.length) {
        if (pr.mergeable === "CONFLICTING") {
          result.head_sha = pr.headRefOid;
          result.failing.push(stationFailure(`#${o.pr} has a merge conflict with ${pr.baseRefName || "its base"}, so GitHub runs no CI on it. Rebase it and push.`));
          return `CI red on #${o.pr}: it has a merge conflict, so GitHub runs no CI on it`;
        }
        if (expected.names.length || expected.unsure) waitingOn = "no workflow run yet";
        else if (!outside.length) {
          if (this.now() - started < NO_CI_SETTLE_MS) waitingOn = "no workflow run yet";
          else noCi = true;
        }
      } else if (missing.length) waitingOn = `${missing.join(", ")} not started yet`;
      if (!waitingOn && (running.length || going.length || lost.length)) {
        waitingOn = `${checks.length - running.length} of ${plural(checks.length, "job")} done`;
      }

      if (!waitingOn) {
        const failedRuns = ciRuns.filter((r) => !RUN_PASSED.has(r.conclusion ?? ""));
        const failedOutside = outside.filter((c) => c.failed);
        if (failedRuns.length && !result.reran) {
          const rerun = failedRuns.filter((r) => this.gh(["run", "rerun", String(r.databaseId), "--failed", "--repo", this.repo]).code === 0);
          if (rerun.length) {
            result.reran = true;
            reruns = new Map(rerun.map((r) => [r.databaseId, r.attempt ?? 1]));
            this.progress((said = `Rerunning the failed jobs of ${rerun.map((r) => r.workflowName ?? `run ${r.databaseId}`).join(", ")} on #${o.pr}`));
            await rest();
            continue;
          }
        }
        if (failedRuns.length || failedOutside.length || settled) {
          result.no_ci = noCi;
          result.head_sha = pr.headRefOid;
          this.limit = this.now() + GRACE_MS;
          return this.judge(pr, checks, failedRuns, failedOutside, files);
        }
        settled = true;
      } else settled = false;

      if (this.now() >= deadline) {
        result.timed_out = true;
        // Still waiting for the head it was asked to judge: no head was judged.
        if (wanted) result.head_sha = pr.headRefOid;
        const still = running.length ? running : going.map((r) => r.workflowName ?? `run ${r.databaseId}`);
        result.pending = [...still, ...missing];
        result.not_started = missing;
        this.limit = this.now() + GRACE_MS;
        const why = still.length ? `${plural(still.length, "job")} still running (${still.join(", ")})`
          : missing.length ? `${missing.join(", ")} never started on ${head}`
          : `waiting on ${waitingOn ?? "CI"}`;
        result.failing.push(stationFailure(`CI did not finish within ${minutes(o.deadlineMs)}: ${why}.`));
        // What already failed is still split, so the flow can tell its author what to fix while it waits.
        if (wanted) this.judge(pr, checks, ciRuns.filter((r) => r.status === "completed" && !RUN_PASSED.has(r.conclusion ?? "") && !going.includes(r)), outside.filter((c) => c.failed), files);
        return `CI timed out on #${o.pr} after ${minutes(o.deadlineMs)}: ${why}`;
      }
      const line = `Waiting on ${result.reran ? "the rerun of CI" : "CI"} for #${o.pr} at ${head}: ${waitingOn ?? "a second look before calling it green"}, ${clock()}`;
      if (line !== said) this.progress((said = line));
      await rest();
    }
  }

  /** The pull request, the workflow runs on its head, its files and the workflows it should run; or why they could not be read. */
  private read(): { pr: any; runs: HeadRun[]; files: string[] | null; expected: { names: string[]; unsure: boolean } } | string {
    const view = this.gh(["pr", "view", String(this.o.pr), "--json", "url,headRefOid,headRefName,baseRefName,baseRefOid,mergeable,statusCheckRollup"]);
    if (view.code !== 0) return `gh pr view failed: ${view.out.trim().split("\n").slice(-3).join(" | ")}`;
    let pr: any;
    try { pr = JSON.parse(view.out); } catch { return "gh pr view returned no JSON"; }
    this.repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url ?? "")?.[1] ?? this.repo;
    const list = this.gh(["run", "list", "--repo", this.repo, "--commit", pr.headRefOid, "--limit", "50", "--json", "databaseId,status,conclusion,attempt,workflowName,event"]);
    if (list.code !== 0) return `gh run list failed: ${list.out.trim().split("\n").slice(-3).join(" | ")}`;
    let runs: HeadRun[];
    try { runs = JSON.parse(list.out || "[]"); } catch { return "gh run list returned no JSON"; }
    const files = this.changedFiles(pr.headRefOid);
    if (typeof files === "string") return files;
    const expected = this.expectedWorkflows(pr, files);
    if (typeof expected === "string") return expected;
    return { pr, runs, files, expected };
  }

  /**
   * Whether the pull request's head left the one the station waits for: it is not an ancestor of it (pushed past
   * or replaced). An ancestor is a head that has not caught up yet, and GitHub not knowing the awaited sha yet is
   * the same lag; both keep the wait.
   */
  private movedAway(observed: string, wanted: string): boolean {
    if (this.moved.has(observed)) return this.moved.get(observed)!;
    const r = this.gh(["api", `repos/${this.repo}/compare/${observed}...${wanted}`, "--jq", ".status"]);
    // A failed compare (GitHub does not have the awaited sha yet) answers nothing: ask again on the next look.
    if (r.code !== 0) return false;
    // "ahead": the awaited head descends from the observed one. "behind" or "diverged": the branch went elsewhere.
    const moved = ["behind", "diverged"].includes(r.out.trim());
    this.moved.set(observed, moved);
    return moved;
  }

  /** Every path the pull request touches (a renamed file's old path too), or null when GitHub's list may be cut short. */
  private changedFiles(head: string): string[] | null | string {
    if (this.files.has(head)) return this.files.get(head)!;
    const r = this.gh(["api", "--paginate", `repos/${this.repo}/pulls/${this.o.pr}/files`, "--jq", ".[] | .filename, (.previous_filename // empty)"]);
    if (r.code !== 0) return `gh api pulls/${this.o.pr}/files failed: ${r.out.trim().split("\n").slice(-3).join(" | ")}`;
    const paths = r.out.split("\n").map((l) => l.trim()).filter(Boolean);
    const files = paths.length >= FILES_CAP ? null : paths;
    this.files.set(head, files);
    return files;
  }

  /**
   * The workflows a push to this pull request runs, by the name its runs carry, read from each active workflow
   * file at the head; `unsure` when one could not be read or its filters decided. With nothing expected and
   * nothing unsure, the repository runs no CI on this pull request.
   */
  private expectedWorkflows(pr: any, files: string[] | null): { names: string[]; unsure: boolean } | string {
    const cached = this.expected.get(pr.headRefOid);
    if (cached) return cached;
    const list = this.gh(["api", "--paginate", `repos/${this.repo}/actions/workflows`, "--jq", '.workflows[] | select(.state == "active") | .path']);
    if (list.code !== 0) return `gh api actions/workflows failed: ${list.out.trim().split("\n").slice(-3).join(" | ")}`;
    const out = { names: [] as string[], unsure: false };
    for (const file of list.out.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const r = this.gh(["api", `repos/${this.repo}/contents/${file}?ref=${pr.headRefOid}`, "--jq", ".content"]);
      const wf = r.code === 0 ? parseWorkflow(Buffer.from(r.out.replace(/\s/g, ""), "base64").toString("utf-8"), file) : null;
      const runs = wf ? runsOnPullRequest(wf, { base: pr.baseRefName || "main", head: pr.headRefName ?? "" }, files) : null;
      if (wf) this.workflowJobs.set(wf.name, wf.jobs);
      if (runs === null) out.unsure = true;
      else if (runs) out.names.push(wf!.name);
    }
    this.expected.set(pr.headRefOid, out);
    return out;
  }

  /**
   * gh 2.105 refuses to print a response with terminal escape sequences unless told to, and every Actions log has
   * them (the parser strips them). A gh older than the flag rejects it, so it is dropped for the rest of the run.
   */
  private log(jobId: string | number): { code: number; out: string } {
    const key = String(jobId);
    if (!this.logs.has(key)) {
      const read = () => this.call(["api", `repos/${this.repo}/actions/jobs/${key}/logs`, ...(this.allowEscapes ? ["--allow-escape-sequences"] : [])]);
      let r = read();
      if (this.allowEscapes && r.code !== 0 && /unknown flag: --allow-escape-sequences/.test(r.out)) {
        this.allowEscapes = false;
        r = read();
      }
      this.logs.set(key, r);
    }
    return this.logs.get(key)!;
  }

  /** A run's jobs, as its latest attempt ran them. */
  private jobsOf(runId: number): Job[] {
    if (!this.jobs.has(runId)) {
      const v = this.call(["run", "view", String(runId), "--repo", this.repo, "--json", "jobs"]);
      let jobs: Job[] = [];
      try { jobs = v.code === 0 ? JSON.parse(v.out).jobs ?? [] : []; } catch {}
      if (v.code === 0) this.jobs.set(runId, jobs);
      return jobs;
    }
    return this.jobs.get(runId)!;
  }

  /**
   * A pull_request run tests refs/pull/N/merge, made when the run started, whose first parent is main at that
   * moment; the checkout step of any job that ran logs `Merge <head> into <main>`. Failing that, the base sha
   * the pull request names, which GitHub moves when the head is pushed, so it is the main its last run tested.
   */
  private testedMainSha(pr: any, checks: Check[]): string | null {
    const head: string = pr.headRefOid;
    if (this.tested.has(head)) return this.tested.get(head)!;
    const took = (c: Check) => c.completed - c.started;
    const ran = checks.filter((c) => c.jobId && c.done && !c.skipped && took(c) >= 0).sort((a, b) => took(a) - took(b));
    for (const c of ran.slice(0, 3)) {
      const log = this.log(c.jobId!);
      const m = log.code === 0 ? /Merge ([0-9a-f]{40}) into ([0-9a-f]{40})/.exec(log.out) : null;
      if (m && m[1] === head) {
        this.tested.set(head, m[2]!);
        return m[2]!;
      }
    }
    // Not kept: a job that runs later (a rerun's) may still log the merge.
    return pr.baseRefOid ?? null;
  }

  /**
   * How main's CI ran a job: its run of the workflow on the tested sha. Where that run skipped the job (codecast's
   * CI skips the jobs a commit's paths do not reach) or main has no run there, the nearest earlier main run where
   * the job ran. Where that run never reached a verdict on it (cancelled, still going), the nearest later run of
   * main that holds the tested sha, and failing that an earlier run speaks only for the failures it has (`unsure`):
   * an earlier pass says nothing of the commits after it, so the job is `unjudged`. Null when no run within reach ran
   * it. Returns whether it failed and the failures its log names.
   */
  private mainJob(workflow: string, base: string, tested: string, name: string): MainJob | "unjudged" | null {
    const atTested = this.mainRunsOf(workflow, ["--commit", tested]);
    const when = atTested[atTested.length - 1]?.createdAt ?? this.commitDate(tested);
    const earlier = when ? this.mainRunsOf(workflow, ["--branch", base, "--event", "push", "--created", `<=${when}`]) : [];
    // A job's verdict in a run: the job, or that it did not run there ("skipped") or has no verdict yet ("open").
    const verdictIn = (run: MainRun): Job | "skipped" | "open" => {
      if (run.status && run.status !== "completed") return "open";
      const job = this.jobsOf(run.databaseId).find((j) => j.name === name);
      if (!job) return run.conclusion === "cancelled" ? "open" : "skipped";
      if (job.status !== "completed" || ["cancelled", ""].includes(job.conclusion ?? "")) return "open";
      return job.conclusion === "skipped" ? "skipped" : job;
    };
    const judged = (job: Job): MainJob => {
      if (JOB_PASSED.has(job.conclusion)) return { failed: false, failures: [] };
      const log = this.log(job.databaseId);
      return { failed: true, failures: log.code === 0 ? jobFailures(name, log.out) : [] };
    };
    const seen = new Set<number>();
    let open = false;
    for (const run of atTested) {
      seen.add(run.databaseId);
      const v = verdictIn(run);
      if (typeof v === "object") return judged(v);
      if (v === "open") open = true;
      else { open = false; break; }
    }
    if (open && when) {
      const later = this.mainRunsOf(workflow, ["--branch", base, "--event", "push", "--created", `>=${when}`]).filter((r) => !seen.has(r.databaseId)).reverse();
      for (const run of later.slice(0, 8)) {
        seen.add(run.databaseId);
        const v = verdictIn(run);
        if (typeof v === "object" && run.headSha && this.holdsSha(run.headSha, tested)) return judged(v);
      }
    }
    for (const run of earlier.slice(0, 12)) {
      if (seen.has(run.databaseId)) continue;
      seen.add(run.databaseId);
      const v = verdictIn(run);
      if (typeof v !== "object") continue;
      const main = judged(v);
      // An earlier run vouches only for what it failed: a failure of the change's it lacks is unjudged, not the change's.
      return !open ? main : main.failed ? { ...main, unsure: true } : "unjudged";
    }
    return open ? "unjudged" : null;
  }

  /** Whether `head` holds `sha` (GitHub's compare of the two says the head is ahead of it, or is it). */
  private holdsSha(head: string, sha: string): boolean {
    const key = `${sha}...${head}`;
    if (!this.holds.has(key)) {
      const r = this.call(["api", `repos/${this.repo}/compare/${key}`, "--jq", ".status"]);
      this.holds.set(key, r.code === 0 && ["ahead", "identical"].includes(r.out.trim()));
    }
    return this.holds.get(key)!;
  }

  /**
   * What a person approves when they let a CI edit merge: the change's own edit to each CI path the pull request
   * touches, as GitHub's patch for the pull request has it (against where the change forked from the base, so main's
   * own edits to the file, which a rebase brings in, never count), only its added and removed lines (a rebase moves
   * line numbers and context), with the file's status, old path and its mode at the head. A file GitHub gives no patch
   * for (binary, too large, a mode-only change) counts as its blob at the head. Null when the list or the head's tree
   * could not be read whole, or a CI path is missing from it.
   */
  private ciEdit(ciFiles: string[], head: string): { digest: string; files: Record<string, string> } | null {
    const paths = [...new Set(ciFiles)];
    const listed = this.call(["api", "--paginate", `repos/${this.repo}/pulls/${this.o.pr}/files`, "--jq", `.[] | . as $f | select(${JSON.stringify(paths)} | any(. == $f.filename or . == ($f.previous_filename // ""))) | {filename, previous_filename, status, patch} | tojson`]);
    if (listed.code !== 0) return null;
    const r = this.call(["api", `repos/${this.repo}/git/trees/${head}?recursive=1`, "--jq", `(if .truncated then "truncated" else empty end), (.tree[] | select(.type != "tree") | "\\(.mode) \\(.sha) \\(.path)")`]);
    if (r.code !== 0) return null;
    const lines = r.out.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.includes("truncated")) return null;
    const at = new Map(lines.map((l) => { const [mode, sha, ...p] = l.split(" "); return [p.join(" "), `${mode} ${sha}`] as const; }));
    type Listed = { filename: string; previous_filename?: string | null; status?: string; patch?: string | null };
    let entries: Listed[];
    try { entries = listed.out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Listed); } catch { return null; }
    if (paths.some((p) => !entries.some((f) => f.filename === p || f.previous_filename === p))) return null;
    const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
    const files: Record<string, string> = {};
    for (const f of entries) {
      const blob = at.get(f.filename) ?? "absent";
      const edit = typeof f.patch === "string" ? f.patch.split("\n").filter((l) => /^[+-]/.test(l)).join("\n") : `blob ${blob}`;
      files[f.filename] = hash(`${f.status ?? ""} ${f.previous_filename ?? ""} ${blob.split(" ")[0]}\n${edit}`);
    }
    return { digest: hash(Object.keys(files).sort().map((p) => `${files[p]} ${p}`).join("\n")), files };
  }

  /**
   * A failed job that needs another job that failed in the same run, which is why it ran at all (a summary job,
   * `if: always()`): it fails because they did, and is no failure of its own.
   */
  private gatesOnFailed(workflow: string | undefined, job: Job, bad: Job[]): boolean {
    const jobs = workflow ? this.workflowJobs.get(workflow) : undefined;
    if (!jobs) return false;
    // A matrix job's runs carry its name with each `${{ … }}` filled in (`test-web (1/4)` from
    // `test-web (${{ matrix.shard }}/4)`), or, with no expression in it, the name and its matrix values in parentheses.
    const named = (id: string, j: Job) => {
      const n = jobs[id]?.name ?? id;
      const shape = new RegExp(`^${n.split(/\$\{\{.*?\}\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+")}(?: \\(.+\\))?$`);
      return shape.test(j.name);
    };
    const own = Object.keys(jobs).find((id) => named(id, job));
    return !!own && jobs[own]!.needs.some((need) => bad.some((b) => b !== job && named(need, b)));
  }

  private mainRunsOf(workflow: string, filter: string[]): MainRun[] {
    const key = `${workflow}\u0000${filter.join(" ")}`;
    if (!this.mainRuns.has(key)) {
      const r = this.call(["run", "list", "--repo", this.repo, "--workflow", workflow, ...filter, "--limit", "20", "--json", "databaseId,headSha,createdAt,status,conclusion"]);
      let runs: MainRun[] = [];
      try { runs = r.code === 0 ? JSON.parse(r.out || "[]") : []; } catch {}
      this.mainRuns.set(key, runs);
    }
    return this.mainRuns.get(key)!;
  }

  private commitDate(sha: string): string | null {
    const r = this.call(["api", `repos/${this.repo}/commits/${sha}`, "--jq", ".commit.committer.date"]);
    return r.code === 0 && r.out.trim() ? r.out.trim() : null;
  }

  /**
   * `[line] ci_paths` as the base holds it (main at the tested sha), never as the change's own checkout does: a
   * change could otherwise drop its own path from the list in the same commit. With no profile there, or one that
   * does not parse, only the paths that are always CI count.
   */
  private baseCiPaths(ref: string): string[] {
    const r = this.call(["api", `repos/${this.repo}/contents/${LINE_PROFILE_REL_PATH}?ref=${ref}`, "--jq", ".content"]);
    if (r.code !== 0) return [];
    try {
      return parseLineProfileText(Buffer.from(r.out.replace(/\s/g, ""), "base64").toString("utf-8")).values.ci_paths ?? [];
    } catch {
      return [];
    }
  }

  private judge(pr: any, checks: Check[], failedRuns: HeadRun[], failedOutside: Check[], files: string[] | null): string {
    const { o, result } = this;
    const base = pr.baseRefName || "main";
    result.tested_main_sha = this.testedMainSha(pr, checks);
    const tested = result.tested_main_sha;
    const ciPatterns = [...ALWAYS_CI, ...this.baseCiPaths(tested ?? base)];
    const ciFiles = files ? files.filter((f) => ciPatterns.some((p) => filterMatches(f, p))) : null;
    result.ci_changed = !files || ciFiles!.length > 0;
    const edit = ciFiles?.length ? this.ciEdit(ciFiles, pr.headRefOid) : null;
    result.ci_edit = edit?.digest ?? null;
    result.ci_edit_files = edit?.files ?? null;
    for (const run of failedRuns) {
      const workflow = run.workflowName ?? `run ${run.databaseId}`;
      const bad = this.jobsOf(run.databaseId).filter((j) => j.status === "completed" && !JOB_PASSED.has(j.conclusion));
      if (!bad.length) {
        const why = run.conclusion === "action_required"
          ? `${workflow} is waiting for approval to run: a maintainer must approve this pull request's workflows on GitHub.`
          : `${workflow} concluded ${run.conclusion || "without success"} with no failed job: a workflow file that does not load, or a run that could not start.`;
        result.failing.push({ job: workflow, test: null, assertion: null, file: null, line: null, excerpt: why });
        continue;
      }
      for (const j of bad) {
        if (this.gatesOnFailed(run.workflowName, j, bad)) continue;
        const log = this.log(j.databaseId);
        if (log.code !== 0) {
          result.failing.push({ job: j.name, test: null, assertion: null, file: null, line: null, excerpt: `${j.name} ${j.conclusion}; its log could not be read: ${log.out.trim().slice(0, 300)}` });
          continue;
        }
        const main = tested && run.workflowName ? this.mainJob(run.workflowName, base, tested, j.name) : null;
        for (const named of jobFailures(j.name, log.out)) {
          const unjudged = main === "unjudged" || (!!main?.unsure && !onMain(main, named));
          (unjudged ? result.unjudged : onMain(main as MainJob | null, named) ? result.preexisting : result.failing).push(named.failure);
        }
      }
    }
    for (const c of failedOutside) result.failing.push({ job: c.name, test: null, assertion: null, file: null, line: null, excerpt: `${c.name} failed: ${c.url ?? "no link"}` });

    const red = failedRuns.length > 0 || failedOutside.length > 0;
    // Green is GitHub's verdict alone; a change to CI is flagged beside it, for a person to judge before Merge.
    result.green = !red && !result.timed_out;
    result.blocked_by_main = red && !result.timed_out && !result.failing.length && result.preexisting.length + result.unjudged.length > 0;
    const edits = result.ci_changed ? (ciFiles ? `it edits CI (${ciFiles.slice(0, 3).join(", ")}${ciFiles.length > 3 ? ", ..." : ""})` : "its file list is too long to rule out an edit to CI") : "";
    if (!red) {
      if (result.ci_changed) return `CI green on #${o.pr}, but ${edits}: a person must look`;
      if (result.no_ci) return `CI green on #${o.pr}: the repository runs no CI on this pull request`;
      return `CI green on #${o.pr}${result.reran ? " after a rerun" : ""}`;
    }
    if (result.timed_out) return "";
    const tail = result.ci_changed ? `; ${edits}` : "";
    const unjudged = result.unjudged.length ? `${plural(result.unjudged.length, "failure")} main's CI had no verdict on at ${String(tested).slice(0, 10)}` : "";
    if (result.blocked_by_main) {
      const onMainToo = result.preexisting.length ? `all ${plural(result.preexisting.length, "failure")} also fail on main` : "";
      return `CI red on #${o.pr}, blocked by main: ${[onMainToo, unjudged].filter(Boolean).join(", and ")}${tail}`;
    }
    const jobs = [...new Set(result.failing.map((f) => f.job))];
    const also = [result.preexisting.length ? `${result.preexisting.length} that main has too` : "", unjudged].filter(Boolean).join("; ");
    return `CI red on #${o.pr}: ${plural(result.failing.length, "failure")} in ${jobs.join(", ")}${also ? ` (and ${also})` : ""}${tail}`;
  }
}

type CliPost = (urlPath: string, body: Record<string, any>, opts?: { throwOnError?: boolean }) => Promise<any>;

/**
 * `cast flow ci`. Waiting lines go to stderr, and to the run's card when the station is named, so the station's
 * output (stdout) is the summary alone, which the brief back to the subject quotes. With nowhere to write
 * ci.json, the verdict prints on stdout above the summary. `station` overrides the station's own options (a
 * test's fake gh and clock).
 */
export async function ciCommand(
  opts: { pr: string; dir: string; deadline: string; head?: string; run?: string; node?: string },
  cliPost: CliPost,
  station: Partial<CiStationOptions> = {},
): Promise<void> {
  const run = opts.run ?? process.env.run_id;
  const node = opts.node ?? process.env.station_id;
  const deadlineMs = parseDeadline(opts.deadline);
  if (deadlineMs === null) console.error(`--deadline ${JSON.stringify(opts.deadline)} is not a duration: use 90s, 60m, 2h or 1h30m`);
  const { result, summary, written } = await runCiStation({
    pr: Number(opts.pr),
    dir: opts.dir,
    deadlineMs: deadlineMs ?? NaN,
    head: opts.head,
    progress: (line) => {
      console.error(line);
      // Every post passes throwOnError: without it the CLI's cliPost exits the process on an error reply, and the
      // station would die without its ci.json.
      if (run && node) void cliPost("/cli/workflow-runs/progress", { run_id: run, current_node_id: node, node_id: node, node_status: "running", result_preview: line }, { throwOnError: true }).catch(() => {});
    },
    ...station,
  });
  // The verdict on the server, from this station while it runs: Merge's clearance stands on it, not on ci.json.
  // Green goes exactly as ci.json holds it; ci_changed rides along only when set, so Merge requires a person's Ship
  // on a CI edit. A verdict that cannot be recorded leaves the run uncleared, and the station still exits 0.
  if (run && node && result.head_sha) {
    try {
      await cliPost("/cli/workflow-runs/ci-verdict", { run_id: run, node_id: node, green: result.green, head_sha: result.head_sha, ...(result.ci_changed ? { ci_changed: true } : {}) }, { throwOnError: true });
    } catch (err) {
      console.error(`The CI verdict could not be recorded on the run, so Merge will refuse it: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!written) console.log(JSON.stringify(result));
  console.log(summary);
}

function ghCli(args: string[]): { code: number; out: string } {
  // A full job log runs to megabytes.
  const r = spawnSync("gh", args, { encoding: "utf-8", timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.status === 0 ? "" : r.stderr || r.error?.message || ""}` };
}

/** How main's CI ran a job: whether it failed, and the failures its log names. */
type MainJob = { failed: boolean; failures: NamedFailure[]; /** From a run before the tested sha, which main's CI never judged. */ unsure?: boolean };

/**
 * Whether a change's failure is one main's job has too: a named one by its test and file. One the log cannot name
 * (`step:<header>`) only when main's failed the same step with the same excerpt, its numbers aside (a duration, a pass
 * count): the same step broken another way (a typecheck red on different errors) is the change's.
 */
export function onMain(main: MainJob | null, n: NamedFailure): boolean {
  if (!main?.failed) return false;
  return main.failures.some((m) => m.id === n.id && (!n.id.startsWith("step:") || excerptShape(m.failure.excerpt) === excerptShape(n.failure.excerpt)));
}

/** An excerpt with its numbers masked: bun's `[1.20s]`, `in 12.3s`, `412 pass` differ run to run on the same failure. */
export const excerptShape = (excerpt: string) => excerpt.replace(/\d+(?:\.\d+)?/g, "#");
