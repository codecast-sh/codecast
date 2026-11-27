// The Deploys page's two columns as data (doc s97bnygafm0x6p6cwn1f5bn6258jyjfa): on the left, Ship runs on their way to
// main; on the right, Next deploy and each deploy card, with what each carried listed by session, PR, SHA, task,
// branch or priority. Every commit is credited to the session that pressed Ship, the same on both columns.
// Pure: no store, no React.
import { verdictOnHead, type QueueCommit, type QueueGroup, type ShippingRun, type ShippingShipper } from "@codecast/shared/contracts/deployTargets";
import type { CheckoutRow } from "@codecast/shared/contracts/checkouts";
import type { SessionPriorityRef } from "@codecast/shared/contracts/priorities";
import { entityRoute } from "@codecast/shared/entities";
import { isOpen, prOfSubject, sessionsOf, supersededBy, type DeploySession, type TeamDeployRow } from "./targets";
import { ageShort } from "../lineFlow";

/* ───────────── What the page reads ───────────── */

type Lines = { insertions?: number; deletions?: number };

/**
 * What deployRefs.deployLines says of one commit a finished deploy lists, read per card shown: its lines (a missing
 * count is not recorded), the pull request and the branch it came from.
 */
export type DeployLine = Lines & { sha: string; pr_number: number | null; branch: string | null };

export type BoardQueueCommit = QueueCommit;
export type BoardQueueGroup = QueueGroup;
/** A deploy's recorded commit, with its line once deployLines answered for its card. */
export type BoardDeployRow = NonNullable<TeamDeployRow["commit_rows"]>[number] & Partial<Omit<DeployLine, "sha">>;
export type BoardDeploy = Omit<TeamDeployRow, "commit_rows"> & { commit_rows?: BoardDeployRow[] };

/* ───────────── Ship runs (workflow_runs.shippingRuns) ───────────── */

export const DROPPED_AFTER_MS = 7 * 24 * 60 * 60_000;
/** A stopped run nobody has touched for this long has ended, not paused on its way: it folds away with the dropped. */
export const STOPPED_AFTER_MS = 60 * 60_000;

/** The repository a run ships to: its PR's, else that of the checkout it runs in (the longest path holding it). */
export function repositoryOfRun(run: Pick<ShippingRun, "pr" | "project_path">, checkouts: ReadonlyArray<Pick<CheckoutRow, "path" | "repository">>): string | null {
  if (run.pr?.repository) return run.pr.repository.toLowerCase();
  const at = run.project_path;
  if (!at) return null;
  let best: Pick<CheckoutRow, "path" | "repository"> | null = null;
  for (const c of checkouts) {
    const root = c.path.replace(/\/+$/, "");
    const holds = at === root || at.startsWith(`${root}/`);
    if (holds && (!best || root.length > best.path.replace(/\/+$/, "").length)) best = c;
  }
  return best ? best.repository.toLowerCase() : null;
}


/**
 * One step of a Ship run's track: its word, the stations it reads (by the last part of a station's id), and the words
 * for a run fixing what it found there. `forks`: a fan-out that runs this step beside another, whose running says this
 * step runs and whose end says nothing of it. `passes`: a segment's exit that settles the step, outranking an earlier
 * round's red (an approval after changes were asked). `landedIf`: stations whose mere presence says the change is on
 * main, however they ended. `lands`: on a last step whose stations include some that only
 * lead there (a rebase, a conflict fixed), the ones that put the change on main; the step is done only then.
 */
export type Step = { word: string; stations: readonly string[]; forks?: readonly string[]; passes?: readonly string[]; fixing?: string; lands?: readonly string[]; landedIf?: readonly string[] };

/**
 * A change that goes up as a pull request: PR · CI · Review · Merge. Codecast's change flow names its stations
 * plainly (`pr`, `ci`), Union's land segment inside a segment (`land__pr`, `land__ci_alone`).
 */
export const CHANGE_STEPS: readonly Step[] = [
  { word: "PR", stations: ["pr"] },
  // A flow that checks the change on its own machine before the pull request (Local CI) runs that as part of CI.
  { word: "CI", stations: ["checks", "ci", "ci_alone", "retest", "local_ci", "local_ci_fix"], fixing: "Fixing CI failures" },
  { word: "Review", stations: ["review", "changes"], fixing: "Fixing review findings" },
  { word: "Merge", stations: ["merge", "landed"] },
];

/**
 * A change that goes straight onto main with no pull request: Check · Review · Land. A personal workspace's Ship
 * (`personal`), a repository's own flows built of the library's check, review and ship segments (`check__verify`,
 * `review__review`, `ship__rebase`), and the change flow's direct mode (`direct_check`, `land`). A segment's own node
 * (`ship` beside `ship__ship`) completes however the segment ended, so its stations speak for it (segmentNodes); the
 * review's exits say what it found (`review__changes` red until `review__approved`). A round's start (`round`) and the
 * join of a check beside a review (`joined`) belong to no step; the fan-out (`checks`) says Check runs, since the
 * personal Ship reports its check only when it ends.
 */
export const PERSONAL_STEPS: readonly Step[] = [
  { word: "Check", stations: ["find_check", "check", "verify", "fix_check", "direct_check", "direct_fix"], forks: ["checks"], fixing: "Fixing check failures" },
  { word: "Review", stations: ["review", "changes", "rejected", "verdicts", "brief", "fix", "fix_review", "direct_review", "direct_revise"], passes: ["approved"], fixing: "Fixing review findings" },
  // A ship command's own station (`ship__ship`) is followed by its segment's exit (`shipped`, `landed` when already
  // merged); `ship` alone also names the Ship a person picks on a decision card (`decide__ship`), so it lands nothing.
  // The personal Ship's Left the run (`leftrun`, always completes) means the change is on main already, put there
  // another way; Land cut off (`landcut`) completes however it ended, and its `cutlanded` exit means it landed.
  {
    word: "Land", stations: ["rebase", "fix_conflict", "direct_conflict", "land", "landed", "ship", "shipped", "landcut", "leftrun", "cutlanded"],
    lands: ["land", "landed", "shipped", "leftrun"], landedIf: ["cutlanded"],
  },
];
export type StepState = "done" | "active" | "waiting" | "failed" | "idle";

const leafOf = (id: string | null | undefined) => id?.split("__").pop() ?? "";

/** The nodes that hold a segment's stations (`ship` for `ship__rebase`): they speak for nothing of their own. */
function segmentNodes(statuses: ShippingRun["node_statuses"]): Set<string> {
  const out = new Set<string>();
  for (const { node_id } of statuses) {
    const parts = node_id.split("__");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("__"));
  }
  return out;
}

/**
 * Each node's latest status, segments' own nodes left out. A bare `land` is the personal Ship's own Land station only
 * in a run that went through a round; anywhere else it is a land segment's node before its first station has started
 * (Union's change opens on it), and says nothing.
 */
function stationStatuses(run: Pick<ShippingRun, "node_statuses">): Map<string, string> {
  const segments = segmentNodes(run.node_statuses);
  const rounds = run.node_statuses.some((n) => n.node_id === "round");
  return new Map(run.node_statuses.filter((n) => !segments.has(n.node_id) && (n.node_id !== "land" || rounds)).map((n) => [n.node_id, n.status]));
}

/**
 * The steps a run's track draws: the flow's own track when the server names it. An older server's run is read from
 * itself: a pull request, or a `pr` station anywhere, makes it a change that goes up as one; a run that has done
 * anything past its start other than open a land segment (Union's change opens on `land`, before `land__pr`) goes
 * straight onto main. A run with nothing to read yet keeps the pull request's track.
 */
export function stepsFor(run: Pick<ShippingRun, "pr" | "node_statuses" | "current_node_id" | "track">): readonly Step[] {
  if (run.track) return run.track === "direct" ? PERSONAL_STEPS : CHANGE_STEPS;
  const ids = [...run.node_statuses.map((n) => n.node_id), ...(run.current_node_id ? [run.current_node_id] : [])];
  if (run.pr || ids.some((id) => leafOf(id) === "pr")) return CHANGE_STEPS;
  return ids.some((id) => id !== "start" && id !== "land") ? PERSONAL_STEPS : CHANGE_STEPS;
}

/** The step a station belongs to among `steps`, -1 for one outside them. */
export function stepOfStation(id: string | null | undefined, steps: readonly Step[] = CHANGE_STEPS): number {
  const leaf = leafOf(id);
  return leaf ? steps.findIndex((s) => s.stations.includes(leaf)) : -1;
}

type RunFacts = Pick<ShippingRun, "node_statuses" | "current_node_id" | "pr" | "ci_verdict" | "check_verdict" | "review_verdict" | "station_rebases" | "merge" | "track">;

/** What each step's facts say, else its stations: done, in trouble (red verdict, failed station), running, or not reached. */
type Read = "done" | "trouble" | "active" | "idle";
function readSteps(run: RunFacts, steps: readonly Step[] = stepsFor(run)): Read[] {
  const byStep: string[][] = steps.map(() => []);
  const forked = steps.map(() => false);
  const passed = steps.map(() => false);
  for (const [id, status] of stationStatuses(run)) {
    const i = stepOfStation(id, steps);
    if (i >= 0) byStep[i].push(status);
    steps.forEach((s, j) => {
      if (status === "running" && s.forks?.includes(leafOf(id))) forked[j] = true;
      if (status === "completed" && s.passes?.includes(leafOf(id))) passed[j] = true;
    });
  }
  // A review binds to the head it read: once a fix round pushed another, the verdict (and the review station's earlier
  // pass) says nothing of the head the PR is on, as the PR's header says (changePage reviewOnHead).
  const v = run.review_verdict;
  const staleReview = !!(v?.head_sha && run.pr?.head_sha && !verdictOnHead(v.head_sha, run.pr.head_sha, run.station_rebases));
  const reviewAt = steps.findIndex((s) => s.word === "Review");
  const review: Read | null = v && !staleReview ? (v.verdict === "ship" ? "done" : "trouble") : null;
  const facts: Array<Read | null> = steps === CHANGE_STEPS
    ? [run.pr ? "done" : null, run.ci_verdict ? (run.ci_verdict.green ? "done" : "trouble") : null, review, run.merge ? "done" : null]
    : [run.check_verdict ? (run.check_verdict.green ? "done" : "trouble") : null, review, isMerged(run) ? "done" : null];
  // A station's status says it ran, not what it found: a completed CI station without a verdict counts as done.
  return facts.map((fact, i) => {
    if (fact) return fact;
    if (i === reviewAt && staleReview) return byStep[i].includes("running") ? "active" : "idle";
    const st = passed[i] ? byStep[i].filter((x) => x !== "failed") : byStep[i];
    if (st.includes("failed")) return "trouble";
    if (st.includes("running") || forked[i]) return "active";
    if (!st.length || !st.every((x) => x === "completed" || x === "skipped")) return "idle";
    // A step that lands is done only once a landing station passed (its fact): a rebase alone only leads there.
    return steps[i].lands ? "active" : "done";
  });
}

/** Merged: the run recorded a merge, a landing station passed, or it moved on to deploying. Its work then waits on the right. */
export function isMerged(run: Pick<ShippingRun, "node_statuses" | "current_node_id" | "merge" | "pr" | "track">): boolean {
  const last = stepsFor(run).at(-1)!;
  const lands = last.lands ?? last.stations;
  const landed = ([id, status]: [string, string]) => (status === "completed" && lands.includes(leafOf(id))) || !!last.landedIf?.includes(leafOf(id));
  return !!run.merge || [...stationStatuses(run)].some(landed) || (run.current_node_id ?? "").startsWith("deploy");
}

/**
 * The run's track (stepsFor): PR · CI · Review · Merge, or Check · Review · Land. Trouble is the run's to fix while it
 * runs (active); a paused run is blue on the step it waits at; a stopped run is red on exactly one step, the one where
 * it stopped, with everything after it not reached.
 */
export function stepper(run: Pick<ShippingRun, "status" | "node_statuses" | "current_node_id" | "gate_node_id" | "pr" | "ci_verdict" | "check_verdict" | "review_verdict" | "station_rebases" | "merge" | "track">): StepState[] {
  const steps = stepsFor(run);
  const at = (id: string | null | undefined) => stepOfStation(id, steps);
  const read = readSteps(run, steps);
  const states: StepState[] = read.map((x) => (x === "trouble" ? "active" : x));
  const firstNotDone = () => read.findIndex((x) => x !== "done");
  if (run.status === "paused") {
    let i = at(run.current_node_id);
    if (i < 0) i = at(run.gate_node_id);
    if (i < 0) i = firstNotDone();
    if (i >= 0) states[i] = "waiting";
    return states;
  }
  if (run.status === "running") {
    // A running run is at the step its station belongs to: a later step holds only what an earlier round left (Merge's
    // conflict, while the fixed change goes through Local CI again), unless one of its stations runs now.
    const stations = stationStatuses(run);
    const now = run.current_node_id && stations.has(run.current_node_id) ? at(run.current_node_id) : -1;
    if (now < 0) return states;
    const running = steps.map(() => false);
    for (const [id, status] of stations) if (status === "running" && at(id) >= 0) running[at(id)] = true;
    return states.map((x, j) => (j < now ? x : running[j] ? "active" : j === now ? x : "idle"));
  }
  if (run.status !== "failed") return states;
  let i = read.indexOf("trouble");
  if (i < 0) i = at(run.current_node_id);
  if (i < 0) i = [...run.node_statuses].reverse().map((n) => at(n.node_id)).find((x) => x >= 0) ?? -1;
  // Stopped at a station outside every step before any step started (a build stopped at Implement): nothing is red.
  if (i < 0 && read.every((x) => x === "idle") && run.node_statuses.some((n) => n.node_id !== "start")) return states;
  if (i < 0) i = firstNotDone();
  if (i < 0) return states;
  return states.map((x, j) => (j < i ? "done" : j === i ? "failed" : "idle"));
}

export type RunState = { word: string; tone: "yellow" | "blue" | "red"; detail?: string };

/** What the run is doing now, in words a person reads at a glance. */
export function runState(run: Pick<ShippingRun, "status" | "fail_reason" | "gate_prompt" | "gate_decision_short_id" | "current_node_label" | "current_node_id" | "node_statuses" | "pr" | "ci_verdict" | "check_verdict" | "review_verdict" | "station_rebases" | "merge" | "track">): RunState {
  if (run.status === "failed") {
    const detail = run.fail_reason?.replace(/^Stopped:\s*/i, "").trim();
    return detail ? { word: "Stopped", tone: "red", detail } : { word: "Stopped", tone: "red" };
  }
  if (run.status === "paused") return { word: run.gate_prompt || run.gate_decision_short_id ? "Waiting on a decision" : "Paused", tone: "blue" };
  const node = run.current_node_label;
  if (node === "Fix findings") {
    // What it fixes: the first step in trouble that names its fixing, else what the reviewer found.
    const steps = stepsFor(run);
    const read = readSteps(run, steps);
    return { word: steps.find((s, i) => s.fixing && read[i] === "trouble")?.fixing ?? "Fixing review findings", tone: "yellow" };
  }
  if (node === "CI and review") return { word: "CI and review running", tone: "yellow" };
  return { word: node || "Starting", tone: "yellow" };
}

const RANK: Record<ShippingRun["status"], number> = { failed: 0, paused: 1, running: 2, pending: 2 };
/** Shipping's order: stopped runs first, then paused, then moving, each newest first. */
export const byUrgency = (a: ShippingRun, b: ShippingRun) => RANK[a.status] - RANK[b.status] || b.updated_at - a.updated_at;

/**
 * Whose a run is, as Mine reads it: the owner of the session that pressed Ship (the same person the deploy column
 * credits its commits to), else the run's own user.
 */
export function runOwner(run: Pick<ShippingRun, "_id" | "user_id" | "stand_in">, shippers: ReadonlyArray<Pick<ShippingShipper, "run_id" | "user_id">>): string {
  // A stand-in spawner is the project lead's standing session: the run is its runner's, as the deploy column credits it.
  if (run.stand_in) return run.user_id;
  return shippers.find((s) => s.run_id === run._id)?.user_id ?? run.user_id;
}

/** The left column: this repository's unmerged Ship runs, moving ones and those dropped (stopped an hour ago, or no movement for 7 days); `keep` narrows them (Mine). */
export function shippingRuns(
  runs: ReadonlyArray<ShippingRun>,
  o: { repository: string; checkouts: ReadonlyArray<Pick<CheckoutRow, "path" | "repository">>; now: number; keep?: (r: ShippingRun) => boolean; landedPrs?: ReadonlySet<number> },
): { moving: ShippingRun[]; dropped: ShippingRun[] } {
  const repo = o.repository.toLowerCase();
  // A pull request merged outside the flow (by hand on GitHub) is on main already: its commit names it.
  const landed = (r: ShippingRun) => !!r.pr && r.pr.repository.toLowerCase() === repo && !!o.landedPrs?.has(r.pr.number);
  const open = runs.filter((r) => !isMerged(r) && !landed(r) && repositoryOfRun(r, o.checkouts) === repo && (!o.keep || o.keep(r)));
  const gone = (r: ShippingRun) => o.now - r.updated_at > (r.status === "failed" ? STOPPED_AFTER_MS : DROPPED_AFTER_MS);
  return {
    moving: open.filter((r) => !gone(r)).sort(byUrgency),
    dropped: open.filter(gone).sort(byUrgency),
  };
}

/* ───────────── Open pull requests with no Ship run ───────────── */

/** An open pull request as the left column reads it: a pullRequests list row, GitHub's state mirrored on it. */
export type OpenPr = {
  _id: string;
  repository: string;
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  head_ref?: string;
  /** The commit the PR is on: a run reviewer's verdict counts for it only on this head (reviewOnHead). */
  head_sha?: string;
  author_github_username?: string;
  /** When it was opened. Its updated_at is no measure of movement: a push to main restamps every open PR at once. */
  created_at: number;
  /** The tasks it names (ct-N in its title, body or branch): a run of one of them carries it. */
  task_ids?: string[];
  /** "none" | "pending" | "success" | "failure" */
  checks_state?: string;
  /** "approved" | "changes_requested" | "review_required" | "none" */
  review_decision?: string;
  /** GitHub's mergeable_state: "clean", "behind", "dirty", "blocked", "unstable", "unknown", "draft". */
  mergeable_state?: string;
  behind_by?: number;
};

/**
 * The left column's second half: this repository's open pull requests no Ship run carries (a run's card already
 * stands for its PR: by its number, or by a task the PR names when the run recorded no PR) and whose commit is not on
 * main yet; `keep` narrows them (Mine). Newest opened first. None fold away: a PR has no honest "last moved" to judge.
 */
export function openPrs(
  prs: ReadonlyArray<OpenPr>,
  o: { repository: string; runs: ReadonlyArray<Pick<ShippingRun, "pr" | "task_id">>; landedPrs?: ReadonlySet<number>; keep?: (pr: OpenPr) => boolean },
): OpenPr[] {
  const repo = o.repository.toLowerCase();
  const carried = new Set(o.runs.flatMap((r) => (r.pr && r.pr.repository.toLowerCase() === repo ? [r.pr.number] : [])));
  // Only a run that recorded no PR stands for the PRs naming its task: one with a PR stands for that PR alone.
  const runTasks = new Set(o.runs.flatMap((r) => (!r.pr && r.task_id ? [String(r.task_id)] : [])));
  const byRun = (p: OpenPr) => carried.has(p.number) || !!p.task_ids?.some((t) => runTasks.has(String(t)));
  return prs
    .filter((p) => p.state === "open" && p.repository.toLowerCase() === repo && !byRun(p) && !o.landedPrs?.has(p.number) && (!o.keep || o.keep(p)))
    .sort((a, b) => b.created_at - a.created_at);
}

/** The review a pull request has, from GitHub's decision and the verdict a codecast run's reviewer gave on its head
 *  (changePage reviewOnHead), which never reaches GitHub. Changes asked by either wins: GitHub blocks the merge on a
 *  person's, and the run sends its reviewer's back to the session. */
const reviewOf = (pr: Pick<OpenPr, "review_decision">, runVerdict?: string | null) =>
  pr.review_decision === "changes_requested" || runVerdict === "changes" || runVerdict === "rejected" ? "changes_requested"
    : pr.review_decision === "approved" || runVerdict === "ship" ? "approved"
    : pr.review_decision;

/** PR · CI · Review · Merge for a pull request no run carries, read from what GitHub says of it. */
export function prStepper(pr: Pick<OpenPr, "draft" | "checks_state" | "review_decision" | "mergeable_state">, runVerdict?: string | null): StepState[] {
  const ci: StepState = pr.checks_state === "success" ? "done" : pr.checks_state === "failure" ? "failed" : pr.checks_state === "pending" ? "active" : "idle";
  const decision = reviewOf(pr, runVerdict);
  const review: StepState = decision === "approved" ? "done" : decision === "changes_requested" ? "failed" : "idle";
  const merge: StepState = pr.mergeable_state === "dirty" ? "failed" : "idle";
  return [pr.draft ? "waiting" : "done", ci, review, merge];
}

/** What a pull request no run carries waits on, the first that applies, in the words its card and its page say. */
export function prState(pr: Pick<OpenPr, "draft" | "checks_state" | "review_decision" | "mergeable_state" | "behind_by">, runVerdict?: string | null): RunState {
  const decision = reviewOf(pr, runVerdict);
  if (pr.draft) return { word: "Draft", tone: "blue" };
  if (pr.checks_state === "failure") return { word: "CI failing", tone: "red" };
  if (pr.mergeable_state === "dirty") return { word: "Merge conflicts", tone: "red" };
  if (decision === "changes_requested") return { word: "Changes requested", tone: "red" };
  if (pr.checks_state === "pending") return { word: "CI running", tone: "yellow" };
  const behind = pr.mergeable_state === "behind" || (pr.behind_by ?? 0) > 0;
  const detail = behind ? `behind main${pr.behind_by ? ` by ${pr.behind_by}` : ""}` : undefined;
  const state: RunState = decision === "approved" ? { word: "Ready to merge", tone: "blue" } : { word: "Waiting on review", tone: "blue" };
  return detail ? { ...state, detail } : state;
}

/* ───────────── Crediting: the session that pressed Ship ───────────── */

const sameSha = (a: string, b: string) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

export type SessionRef = { id: string; short_id: string | null; title: string | null; user_id: string | null; priority: SessionPriorityRef | null };

/** A commit as crediting reads it; `at` bounds which runs could have shipped it. */
export type CreditedCommit = { sha?: string; at?: number; tasks: ReadonlyArray<string> };
export type Shipper = (commit: CreditedCommit, own: SessionRef | null) => SessionRef | null;

/**
 * Who a commit belongs to: the session that pressed Ship on it, else the session its own trailer names. A flow's
 * station sessions ("Review · ct-N") land commits but did not write the change. The run whose merge put this very
 * commit on main decides it; else the newest run of one of its tasks started before the commit. Stand-in spawners
 * and runs without one credit nobody. Both columns credit through it.
 */
export function shipperOf(entries: ReadonlyArray<ShippingShipper>): Shipper {
  const bySha = new Map<string, ShippingShipper[]>();
  const byTask = new Map<string, ShippingShipper[]>();
  for (const e of entries) {
    if (e.merged_sha && e.merged_sha.length >= 7) bySha.set(e.merged_sha.slice(0, 7), [...(bySha.get(e.merged_sha.slice(0, 7)) ?? []), e]);
    if (e.task_short_id) byTask.set(e.task_short_id, [...(byTask.get(e.task_short_id) ?? []), e]);
  }
  const credits = (e: ShippingShipper | undefined): e is ShippingShipper => !!e && !!e.spawner_conversation_id && !e.stand_in;
  return (c, own) => {
    const merged = c.sha && c.sha.length >= 7 ? bySha.get(c.sha.slice(0, 7))?.find((e) => sameSha(e.merged_sha!, c.sha!)) : undefined;
    // The run that merged this commit settles it, even when it credits nobody.
    const run = merged ?? c.tasks.flatMap((t) => byTask.get(t) ?? []).filter((e) => credits(e) && (c.at == null || e.created_at < c.at)).sort((a, b) => b.created_at - a.created_at)[0];
    if (!credits(run)) return own;
    const id = run.spawner_conversation_id!;
    const same = own?.id === id ? own : null;
    return { id, short_id: same?.short_id ?? null, title: same?.title ?? null, user_id: run.user_id ?? same?.user_id ?? null, priority: same?.priority ?? null };
  };
}

const refOf = (s: Pick<DeploySession, "conversation_id" | "short_id" | "title" | "user_id" | "priority">): SessionRef => ({
  id: s.conversation_id, short_id: s.short_id ?? null, title: s.title ?? null, user_id: s.user_id ?? null, priority: s.priority ?? null,
});

/* ───────────── The queue: commits on main waiting to deploy ───────────── */

/**
 * The queue's commits, newest on main first: by when each reached main, never by commit time (a commit written last
 * week and merged today is the newest). A row from an older backend without its place on main sorts by commit time.
 */
export function queueCommits(groups: ReadonlyArray<BoardQueueGroup>): BoardQueueCommit[] {
  const at = (c: BoardQueueCommit) => c.main_at ?? c.at;
  return groups.flatMap((g) => g.commits).sort((a, b) => at(b) - at(a));
}

/** What an unfinished deploy at `sha` sends: that commit and everything older. Nothing when it is not waiting. */
export function upTo(commits: ReadonlyArray<BoardQueueCommit>, sha: string): BoardQueueCommit[] {
  const i = commits.findIndex((c) => sameSha(c.sha, sha));
  return i < 0 ? [] : commits.slice(i);
}

/** What remains for Next deploy once a deploy at `sha` goes: everything newer. All of it when `sha` is not waiting. */
export function after(commits: ReadonlyArray<BoardQueueCommit>, sha: string): BoardQueueCommit[] {
  const i = commits.findIndex((c) => sameSha(c.sha, sha));
  return i < 0 ? [...commits] : commits.slice(0, i);
}

/* ───────────── What a deploy carried ───────────── */

export type CarriedSession = SessionRef & Lines & { commits: number };
export type CarriedCommit = Lines & { sha: string; subject: string; pr: number | null; branch: string | null; session: string | null; tasks: string[] };
export type Carried = {
  sessions: CarriedSession[];
  commits: CarriedCommit[];
  tasks: Array<{ short_id: string; title: string | null }>;
  /** Commits no session claims. */
  loose: number;
  /** Commits it carried beyond the listed ones. */
  more: number;
  /** Whether any of its commits names a branch (a deploy whose lines are not read yet, or an old one, names none). */
  branchesKnown: boolean;
};

/** A sum that is unknown only when none of its parts is known. */
function addLines(to: Lines, x: Lines): void {
  if (x.insertions != null) to.insertions = (to.insertions ?? 0) + x.insertions;
  if (x.deletions != null) to.deletions = (to.deletions ?? 0) + x.deletions;
}
const fill = (to: SessionRef, x: SessionRef) => {
  to.short_id ??= x.short_id;
  to.title ??= x.title;
  to.user_id ??= x.user_id;
  to.priority ??= x.priority;
};

type Raw = { sha: string; at?: number; subject: string; pr_number?: number | null; branch?: string | null; tasks: string[]; own: SessionRef | null } & Lines;

function carriedOf(raw: ReadonlyArray<Raw>, credit: Shipper, extra: { more: number; at?: number; sessions?: ReadonlyArray<SessionRef & { tasks?: string[] }>; tasks?: ReadonlyArray<{ short_id?: string | null; title?: string | null }> }): Carried {
  const sessions = new Map<string, CarriedSession>();
  const commits: CarriedCommit[] = [];
  let loose = 0;
  for (const c of raw) {
    const who = credit({ sha: c.sha, at: c.at ?? extra.at, tasks: c.tasks }, c.own);
    const { pr: subjectPr, subject } = prOfSubject(c.subject);
    commits.push({ sha: c.sha, subject, pr: c.pr_number ?? subjectPr, branch: c.branch ?? null, insertions: c.insertions, deletions: c.deletions, session: who?.id ?? null, tasks: c.tasks });
    if (!who) { loose++; continue; }
    const s = sessions.get(who.id) ?? { ...who, commits: 0 };
    fill(s, who);
    if (c.own && c.own.id === who.id) fill(s, c.own);
    s.commits++;
    addLines(s, c);
    sessions.set(who.id, s);
  }
  // The deploy's own session list names sessions beyond its listed commits. One that says which tasks its commits
  // named is credited like a commit, so a station session becomes its shipper's row; without them, one whose listed
  // commits all went to their shipper is a station session and stays off.
  const named = new Set(raw.map((c) => c.own?.id).filter(Boolean));
  for (const { tasks, ...x } of extra.sessions ?? []) {
    const who = (tasks && credit({ at: extra.at, tasks }, x)) || x;
    const s = sessions.get(who.id);
    if (s) fill(s, who);
    else if (who.id !== x.id || !named.has(x.id)) sessions.set(who.id, { ...who, commits: 0 });
  }
  const tasks = new Map<string, string | null>();
  for (const t of extra.tasks ?? []) if (t.short_id) tasks.set(t.short_id, t.title ?? null);
  for (const c of raw) for (const t of c.tasks) if (!tasks.has(t)) tasks.set(t, null);
  return {
    sessions: [...sessions.values()], commits, loose, more: Math.max(0, extra.more), branchesKnown: raw.some((c) => !!c.branch),
    tasks: [...tasks].map(([short_id, title]) => ({ short_id, title })),
  };
}

/** Queue commits (newest first) as a card lists them; `more` counts the waiting commits the queue did not list. */
export function carriedOfQueue(commits: ReadonlyArray<BoardQueueCommit>, credit: Shipper, more = 0): Carried {
  const titles = new Map<string, string | null>();
  for (const c of commits) for (const t of c.tasks) if (t.short_id && !titles.get(t.short_id)) titles.set(t.short_id, t.title);
  return carriedOf(
    commits.map((c) => ({ ...c, tasks: c.tasks.map((t) => t.short_id).filter((x): x is string => !!x), own: c.session ? refOf(c.session) : null })),
    credit,
    { more, tasks: [...titles].map(([short_id, title]) => ({ short_id, title })) },
  );
}

/** A finished deploy's recorded commits as its card lists them. */
export function carriedOfDeploy(d: Pick<BoardDeploy, "commit_rows" | "sessions" | "tasks" | "commits" | "created_at">, credit: Shipper): Carried {
  const rows = d.commit_rows ?? [];
  const listed = sessionsOf(d);
  const info = new Map(listed.map((s) => [s.conversation_id, refOf(s)]));
  const sessions = listed.map((s) => ({ ...info.get(s.conversation_id)!, tasks: s.task_short_ids }));
  return carriedOf(
    rows.map((c) => ({ ...c, tasks: c.tasks ?? [], own: c.conversation_id ? (info.get(c.conversation_id) ?? refOf({ conversation_id: c.conversation_id })) : null })),
    credit,
    // Its rows carry no commit time; the deploy's own time bounds which runs could have shipped them.
    { more: d.commits - rows.length, at: d.created_at, sessions, tasks: d.tasks },
  );
}

/* ───────────── Deploy cards ───────────── */

/**
 * Deploys newest first, every attempt at one commit on one card, its newest attempt leading. A rollback or a
 * redeploy is its own event, never an attempt at an earlier deploy of the same commit: it stands on its own card.
 */
export function attemptGroups<D extends Pick<TeamDeployRow, "sha" | "action">>(deploys: ReadonlyArray<D>): D[][] {
  const bySha = new Map<string, D[]>();
  const out: D[][] = [];
  for (const d of deploys) {
    const attempt = d.sha && d.action === "deploy" ? d.sha : null;
    const g = attempt ? bySha.get(attempt) : undefined;
    if (g) { g.push(d); continue; }
    const fresh = [d];
    if (attempt) bySha.set(attempt, fresh);
    out.push(fresh);
  }
  return out;
}

/**
 * The attempt whose recorded commits a card lists, or null while it is sending the waiting commits (an unfinished
 * deploy whose sha is still waiting). Its lines are read per card (deployLines), by this deploy's id.
 */
export function recordedOf(group: ReadonlyArray<BoardDeploy>, queue: ReadonlyArray<BoardQueueCommit>): BoardDeploy | null {
  const lead = group[0];
  if (isOpen(lead) && lead.sha && upTo(queue, lead.sha).length) return null;
  return group.find((d) => (d.commit_rows ?? []).length) ?? lead;
}

/** A deploy's recorded commits with the lines its card read, matched by sha; unread ones stay unknown. */
export function withLines(d: BoardDeploy, lines: ReadonlyArray<DeployLine> | undefined): BoardDeploy {
  if (!lines?.length || !d.commit_rows?.length) return d;
  const bySha = new Map(lines.map((l) => [l.sha, l]));
  return { ...d, commit_rows: d.commit_rows.map((c) => { const l = bySha.get(c.sha); if (!l) return c; const { sha: _, ...line } = l; return { ...c, ...line }; }) };
}

/**
 * What one card carried: an unfinished deploy whose sha is waiting is sending the waiting commits up to it; any other
 * (or one at a sha no longer waiting), what an attempt recorded, with the lines read for it.
 */
export function carriedOfAttempts(group: ReadonlyArray<BoardDeploy>, queue: ReadonlyArray<BoardQueueCommit>, credit: Shipper, lines?: ReadonlyMap<string, ReadonlyArray<DeployLine>>, unlisted = 0): Carried {
  const recorded = recordedOf(group, queue);
  // A deploy sending the queue also sends its oldest commits, the ones the queue counted but did not list.
  if (!recorded) return carriedOfQueue(upTo(queue, group[0].sha!), credit, unlisted);
  return carriedOfDeploy(withLines(recorded, lines?.get(recorded._id)), credit);
}

export type DeployCard = { deploys: BoardDeploy[]; carried: Carried };
export type Bucket = "waiting" | "going" | "live";
/** A card by its address on the page: "next", or the leading deploy's short id. */
export type CardId = string;

/**
 * Each of the viewer's sessions once, by where its newest work is: waiting in Next deploy, going out in an unfinished
 * deploy, or live. Each bucket links to the newest card holding one of its sessions. `newer` says, for any session
 * whose newest work is waiting or going out, which card that is, so an older card can say its row is only part of it.
 */
export function yourSessions(next: Carried | null, cards: ReadonlyArray<DeployCard>, mine: ReadonlySet<string>): {
  buckets: Record<Bucket, { count: number; card: CardId | null }>;
  bySession: Map<string, { bucket: Bucket; card: CardId }>;
  newer: Map<string, CardId>;
} {
  const bySession = new Map<string, { bucket: Bucket; card: CardId }>();
  const newer = new Map<string, CardId>();
  for (const s of next?.sessions ?? []) {
    newer.set(s.id, "next");
    if (mine.has(s.id)) bySession.set(s.id, { bucket: "waiting", card: "next" });
  }
  for (const { deploys, carried } of cards) {
    const lead = deploys[0];
    const bucket: Bucket | null = isOpen(lead) ? "going" : deploys.some((d) => d.status === "live") ? "live" : null;
    if (!bucket) continue;
    for (const s of carried.sessions) {
      if (bucket === "going" && !newer.has(s.id)) newer.set(s.id, lead.short_id);
      if (mine.has(s.id) && !bySession.has(s.id)) bySession.set(s.id, { bucket, card: lead.short_id });
    }
  }
  const buckets = { waiting: { count: 0, card: null }, going: { count: 0, card: null }, live: { count: 0, card: null } } as Record<Bucket, { count: number; card: CardId | null }>;
  for (const { bucket, card } of bySession.values()) {
    buckets[bucket].count++;
    buckets[bucket].card ??= card;
  }
  return { buckets, bySession, newer };
}

/**
 * The queue around the newest unfinished deploy: what it is sending (its sha and older) and what is left for Next
 * deploy. With none going, or one at a sha no longer waiting, everything is next. `head`: main's newest commit as the
 * queue counted it (queue.head_sha), which may touch none of the target's paths and so go unlisted.
 */
export function splitQueue(queue: ReadonlyArray<BoardQueueCommit>, deploys: ReadonlyArray<BoardDeploy>, head?: string | null): { going: BoardDeploy | null; sending: BoardQueueCommit[]; next: BoardQueueCommit[] } {
  // One asked for before the live deploy never went out (targets openOf): it sends nothing, so everything waits for Next deploy.
  const live = deploys.filter((d) => d.status === "live").sort((a, b) => (b.live_at ?? b.created_at) - (a.live_at ?? a.created_at))[0] ?? null;
  const going = [...deploys].sort((a, b) => b.created_at - a.created_at).find((d) => isOpen(d) && d.sha && !supersededBy(d, live)) ?? null;
  if (!going) return { going, sending: [], next: [...queue] };
  // A deploy at main's head sends the whole queue, listed or not (a push target's build of main, a marker with no
  // commits). One at another commit the queue does not list (it touched none of the target's paths) sends what its own
  // records name, and everything older on main.
  if (head && sameSha(going.sha!, head) && !queue.some((c) => sameSha(c.sha, going.sha!))) return { going, sending: [...queue], next: [] };
  const at = queue.some((c) => sameSha(c.sha, going.sha!)) ? going.sha! : queue.find((c) => going.commit_rows?.some((r) => sameSha(r.sha, c.sha)))?.sha;
  if (!at) return { going, sending: [], next: [...queue] };
  return { going, sending: upTo(queue, at), next: after(queue, at) };
}

/** Each task's newest place on main: waiting ("next"), going out in an unfinished deploy, else the newest deploy that carried it. */
export function tasksOnMain(queue: ReadonlyArray<BoardQueueCommit>, deploys: ReadonlyArray<BoardDeploy>, head?: string | null): Map<string, CardId> {
  const out = new Map<string, CardId>();
  const { going, sending, next } = splitQueue(queue, deploys, head);
  for (const c of next) for (const t of c.tasks) if (t.short_id && !out.has(t.short_id)) out.set(t.short_id, "next");
  for (const c of sending) for (const t of c.tasks) if (t.short_id && !out.has(t.short_id)) out.set(t.short_id, going!.short_id);
  for (const d of [...deploys].sort((a, b) => b.created_at - a.created_at)) {
    for (const t of d.tasks ?? []) if (t.short_id && !out.has(t.short_id)) out.set(t.short_id, d.short_id);
    for (const c of d.commit_rows ?? []) for (const id of c.tasks ?? []) if (!out.has(id)) out.set(id, d.short_id);
  }
  return out;
}

/** The viewer's sessions among the cards: those their user owns. */
export function mineSessionIds(carried: ReadonlyArray<Carried | null>, userId: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!userId) return out;
  for (const c of carried) for (const s of c?.sessions ?? []) if (s.user_id === userId) out.add(s.id);
  return out;
}

/* ───────────── The switch: one row list per view ───────────── */

/** The Branches row of commits that name no branch. */
export const NO_BRANCH = "no-branch";

export const VIEWS = ["sessions", "prs", "shas", "tasks", "branches", "priorities"] as const;
export type BoardView = (typeof VIEWS)[number];

export type BoardRow = Lines & {
  key: string;
  /** Session or task title, commit subject, branch name or priority title; null where the pill resolves it or none is known. */
  label: string | null;
  mine: boolean;
  session?: string;
  task?: string;
  pr?: number | null;
  sha?: string;
  branch?: string;
  /** A priority's sessions. */
  sessions?: string[];
  /** The priority a Priorities row groups, with its owner's rank. */
  priority?: SessionPriorityRef;
  commits?: number;
};

/** Own rows first; otherwise the order they came in (newest work first). */
const ownFirst = (rows: BoardRow[]) => rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => Number(b.mine) - Number(a.mine) || i - j).map(([r]) => r);

/** Priorities: yours by rank, then teammates' by rank, then the unranked (own rows first), No priority last. */
function byRank(rows: BoardRow[], me: string | null): BoardRow[] {
  const tier = (r: BoardRow) => (!r.priority ? 3 : r.priority.rank == null ? 2 : me && r.priority.user_id === me ? 0 : 1);
  return ownFirst(rows).sort((a, b) => tier(a) - tier(b) || (a.priority?.rank ?? 0) - (b.priority?.rank ?? 0));
}

/** `me` (the viewer's user id) orders the Priorities view: their own priorities first. */
export function rowsFor(c: Carried, view: BoardView, isMine: (sessionId: string) => boolean, me: string | null = null): BoardRow[] {
  const mineCommit = (x: CarriedCommit) => !!x.session && isMine(x.session);
  if (view === "sessions") {
    const rows: BoardRow[] = c.sessions.map((s) => ({ key: s.id, label: s.title, session: s.id, commits: s.commits, insertions: s.insertions, deletions: s.deletions, mine: isMine(s.id) }));
    if (c.loose) {
      const loose: BoardRow = { key: "loose", label: null, commits: c.loose, mine: false };
      for (const x of c.commits) if (!x.session) addLines(loose, x);
      rows.push(loose);
    }
    return ownFirst(rows);
  }
  if (view === "tasks") {
    return ownFirst(c.tasks.map((t) => ({ key: t.short_id, label: t.title, task: t.short_id, mine: c.commits.some((x) => x.tasks.includes(t.short_id) && mineCommit(x)) })));
  }
  if (view === "priorities") {
    const groups = new Map<string, BoardRow>();
    for (const s of c.sessions) {
      const key = s.priority?.id ?? "none";
      const g = groups.get(key) ?? { key, label: s.priority?.title ?? null, ...(s.priority ? { priority: s.priority } : {}), sessions: [], commits: 0, mine: false };
      g.sessions!.push(s.id);
      g.commits! += s.commits;
      g.mine ||= isMine(s.id);
      addLines(g, s);
      groups.set(key, g);
    }
    return byRank([...groups.values()], me);
  }
  if (view === "branches" && !c.branchesKnown) return [];
  const rows = new Map<string, BoardRow>();
  for (const x of c.commits) {
    // A commit naming no branch is "not recorded", never the default branch.
    const key = view === "prs" ? (x.pr ? `#${x.pr}` : x.sha) : view === "shas" ? x.sha : (x.branch ?? NO_BRANCH);
    const row = rows.get(key) ?? (view === "branches"
      ? { key, label: x.branch ?? null, ...(x.branch ? { branch: x.branch } : {}), commits: 0, mine: false }
      : { key, label: x.subject, pr: x.pr, sha: x.sha, commits: 0, mine: false });
    row.commits!++;
    // A branch opens its pull request (branchHref): the first of its commits that names one.
    if (view === "branches" && x.branch) row.pr ??= x.pr;
    row.mine ||= mineCommit(x);
    addLines(row, x);
    rows.set(key, row);
  }
  return ownFirst([...rows.values()]);
}

/**
 * Where a branch opens: its pull request's page when it has one, else the branch on GitHub. Moves to the Branch page
 * (proposed `/branch/<owner>/<repo>/<name…>`) when that ships.
 */
export function branchHref(repository: string, branch: string, pr: number | null | undefined): string {
  const page = pr ? entityRoute("pr", `${repository}#${pr}`) : null;
  return page ?? `https://github.com/${repository}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

/** How long ago, as a card or run says it: "now" inside a minute. */
export const ago = (now: number, at: number | null | undefined): string => (at ? (now - at < 60_000 ? "now" : ageShort(now - at)) : "");

/* ───────────── Folding ───────────── */

export const FOLD_SHOWN = 12;

/** How many rows a list shows folded: 12, but never folding away two or fewer (the button takes their room). */
export function fold(n: number): { shown: number; hidden: number } {
  const shown = n > FOLD_SHOWN + 2 ? FOLD_SHOWN : n;
  return { shown, hidden: n - shown };
}
