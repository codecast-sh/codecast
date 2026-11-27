// The Deploys page's two columns as data (doc s97bnygafm0x6p6cwn1f5bn6258jyjfa): on the left, Ship runs on their way to
// main; on the right, Next deploy and each deploy card, with what each carried listed by session, PR, SHA, task,
// branch or priority. Every commit is credited to the session that pressed Ship, the same on both columns.
// Pure: no store, no React.
import type { QueueCommit, QueueGroup, ShippingRun, ShippingShipper } from "@codecast/shared/contracts/deployTargets";
import type { CheckoutRow } from "@codecast/shared/contracts/checkouts";
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
 * The four steps before main and their stations, by the last part of a station's id: codecast's change flow names
 * them plainly (`pr`, `ci`), Union's land segment inside a segment (`land__pr`, `land__ci_alone`).
 */
export const STEPS = [
  { word: "PR", stations: ["pr"] },
  { word: "CI", stations: ["checks", "ci", "ci_alone", "retest"] },
  { word: "Review", stations: ["review", "changes"] },
  { word: "Merge", stations: ["merge", "landed"] },
] as const;
export type StepState = "done" | "active" | "waiting" | "failed" | "idle";

/** The step a station belongs to, -1 for one outside the four. */
export function stepOfStation(id: string | null | undefined): number {
  const leaf = id?.split("__").pop();
  return leaf ? STEPS.findIndex((s) => (s.stations as readonly string[]).includes(leaf)) : -1;
}

/** What each step's facts say, else its stations: done, in trouble (red verdict, failed station), running, or not reached. */
type Read = "done" | "trouble" | "active" | "idle";
function readSteps(run: Pick<ShippingRun, "node_statuses" | "pr" | "ci_verdict" | "review_verdict" | "merge">): Read[] {
  const byStep: string[][] = STEPS.map(() => []);
  for (const [id, status] of new Map(run.node_statuses.map((n) => [n.node_id, n.status]))) {
    const i = stepOfStation(id);
    if (i >= 0) byStep[i].push(status);
  }
  const facts: Array<Read | null> = [
    run.pr ? "done" : null,
    run.ci_verdict ? (run.ci_verdict.green ? "done" : "trouble") : null,
    run.review_verdict ? (run.review_verdict.verdict === "ship" ? "done" : "trouble") : null,
    run.merge ? "done" : null,
  ];
  // A station's status says it ran, not what it found: a completed CI station without a verdict counts as done.
  return facts.map((fact, i) => {
    if (fact) return fact;
    const st = byStep[i];
    if (st.includes("failed")) return "trouble";
    if (st.includes("running")) return "active";
    return st.length && st.every((x) => x === "completed" || x === "skipped") ? "done" : "idle";
  });
}

/** Merged: the run recorded a merge, a merge station passed, or it moved on to deploying. Its work then waits on the right. */
export function isMerged(run: Pick<ShippingRun, "node_statuses" | "current_node_id" | "merge">): boolean {
  return !!run.merge || run.node_statuses.some((n) => stepOfStation(n.node_id) === 3 && n.status === "completed") || (run.current_node_id ?? "").startsWith("deploy");
}

/**
 * PR · CI · Review · Merge. Trouble is the run's to fix while it runs (active); a paused run is blue on the step it
 * waits at; a stopped run is red on exactly one step, the one where it stopped, with everything after it not reached.
 */
export function stepper(run: Pick<ShippingRun, "status" | "node_statuses" | "current_node_id" | "gate_node_id" | "pr" | "ci_verdict" | "review_verdict" | "merge">): StepState[] {
  const read = readSteps(run);
  const steps: StepState[] = read.map((x) => (x === "trouble" ? "active" : x));
  const firstNotDone = () => read.findIndex((x) => x !== "done");
  if (run.status === "paused") {
    let at = stepOfStation(run.current_node_id);
    if (at < 0) at = stepOfStation(run.gate_node_id);
    if (at < 0) at = firstNotDone();
    if (at >= 0) steps[at] = "waiting";
    return steps;
  }
  if (run.status !== "failed") return steps;
  let at = read.indexOf("trouble");
  if (at < 0) at = stepOfStation(run.current_node_id);
  if (at < 0) at = [...run.node_statuses].reverse().map((n) => stepOfStation(n.node_id)).find((i) => i >= 0) ?? -1;
  if (at < 0) at = firstNotDone();
  if (at < 0) return steps;
  return steps.map((x, i) => (i < at ? "done" : i === at ? "failed" : "idle"));
}

export type RunState = { word: string; tone: "yellow" | "blue" | "red"; detail?: string };

/** What the run is doing now, in words a person reads at a glance. */
export function runState(run: Pick<ShippingRun, "status" | "fail_reason" | "gate_prompt" | "gate_decision_short_id" | "current_node_label" | "node_statuses" | "pr" | "ci_verdict" | "review_verdict" | "merge">): RunState {
  if (run.status === "failed") {
    const detail = run.fail_reason?.replace(/^Stopped:\s*/i, "").trim();
    return detail ? { word: "Stopped", tone: "red", detail } : { word: "Stopped", tone: "red" };
  }
  if (run.status === "paused") return { word: run.gate_prompt || run.gate_decision_short_id ? "Waiting on a decision" : "Paused", tone: "blue" };
  const node = run.current_node_label;
  if (node === "Fix findings") return { word: readSteps(run)[1] === "trouble" ? "Fixing CI failures" : "Fixing review findings", tone: "yellow" };
  if (node === "CI and review") return { word: "CI and review running", tone: "yellow" };
  return { word: node || "Starting", tone: "yellow" };
}

const RANK: Record<ShippingRun["status"], number> = { failed: 0, paused: 1, running: 2, pending: 2 };
const byUrgency = (a: ShippingRun, b: ShippingRun) => RANK[a.status] - RANK[b.status] || b.updated_at - a.updated_at;

/**
 * Whose a run is, as Mine reads it: the owner of the session that pressed Ship (the same person the deploy column
 * credits its commits to), else the run's own user.
 */
export function runOwner(run: Pick<ShippingRun, "_id" | "user_id" | "stand_in">, shippers: ReadonlyArray<Pick<ShippingShipper, "run_id" | "user_id">>): string {
  // A stand-in spawner is the project lead's standing session: the run is its runner's, as the deploy column credits it.
  if (run.stand_in) return run.user_id;
  return shippers.find((s) => s.run_id === run._id)?.user_id ?? run.user_id;
}

/** The left column: this repository's unmerged Ship runs, moving ones and those with no movement for 7 days; `keep` narrows them (Mine). */
export function shippingRuns(
  runs: ReadonlyArray<ShippingRun>,
  o: { repository: string; checkouts: ReadonlyArray<Pick<CheckoutRow, "path" | "repository">>; now: number; keep?: (r: ShippingRun) => boolean; landedPrs?: ReadonlySet<number> },
): { moving: ShippingRun[]; dropped: ShippingRun[] } {
  const repo = o.repository.toLowerCase();
  // A pull request merged outside the flow (by hand on GitHub) is on main already: its commit names it.
  const landed = (r: ShippingRun) => !!r.pr && r.pr.repository.toLowerCase() === repo && !!o.landedPrs?.has(r.pr.number);
  const open = runs.filter((r) => !isMerged(r) && !landed(r) && repositoryOfRun(r, o.checkouts) === repo && (!o.keep || o.keep(r)));
  return {
    moving: open.filter((r) => o.now - r.updated_at <= DROPPED_AFTER_MS).sort(byUrgency),
    dropped: open.filter((r) => o.now - r.updated_at > DROPPED_AFTER_MS).sort(byUrgency),
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
  author_github_username?: string;
  updated_at: number;
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
 * stands for its PR) and whose commit is not on main yet; `keep` narrows them (Mine). Moving ones first, newest update
 * first; those with no update for 7 days fold away with the quiet runs.
 */
export function openPrs(
  prs: ReadonlyArray<OpenPr>,
  o: { repository: string; runs: ReadonlyArray<Pick<ShippingRun, "pr">>; now: number; landedPrs?: ReadonlySet<number>; keep?: (pr: OpenPr) => boolean },
): { moving: OpenPr[]; quiet: OpenPr[] } {
  const repo = o.repository.toLowerCase();
  const carried = new Set(o.runs.flatMap((r) => (r.pr && r.pr.repository.toLowerCase() === repo ? [r.pr.number] : [])));
  const open = prs
    .filter((p) => p.state === "open" && p.repository.toLowerCase() === repo && !carried.has(p.number) && !o.landedPrs?.has(p.number) && (!o.keep || o.keep(p)))
    .sort((a, b) => b.updated_at - a.updated_at);
  return {
    moving: open.filter((p) => o.now - p.updated_at <= DROPPED_AFTER_MS),
    quiet: open.filter((p) => o.now - p.updated_at > DROPPED_AFTER_MS),
  };
}

/** PR · CI · Review · Merge for a pull request no run carries, read from what GitHub says of it. */
export function prStepper(pr: Pick<OpenPr, "draft" | "checks_state" | "review_decision" | "mergeable_state">): StepState[] {
  const ci: StepState = pr.checks_state === "success" ? "done" : pr.checks_state === "failure" ? "failed" : pr.checks_state === "pending" ? "active" : "idle";
  const review: StepState = pr.review_decision === "approved" ? "done" : pr.review_decision === "changes_requested" ? "failed" : "idle";
  const merge: StepState = pr.mergeable_state === "dirty" ? "failed" : "idle";
  return [pr.draft ? "waiting" : "done", ci, review, merge];
}

/** What a pull request no run carries waits on, the first that applies, in the words its card and its page say. */
export function prState(pr: Pick<OpenPr, "draft" | "checks_state" | "review_decision" | "mergeable_state" | "behind_by">): RunState {
  if (pr.draft) return { word: "Draft", tone: "blue" };
  if (pr.checks_state === "failure") return { word: "CI failing", tone: "red" };
  if (pr.mergeable_state === "dirty") return { word: "Merge conflicts", tone: "red" };
  if (pr.review_decision === "changes_requested") return { word: "Changes requested", tone: "red" };
  if (pr.checks_state === "pending") return { word: "CI running", tone: "yellow" };
  const behind = pr.mergeable_state === "behind" || (pr.behind_by ?? 0) > 0;
  const detail = behind ? `behind main${pr.behind_by ? ` by ${pr.behind_by}` : ""}` : undefined;
  const state: RunState = pr.review_decision === "approved" ? { word: "Ready to merge", tone: "blue" } : { word: "Waiting on review", tone: "blue" };
  return detail ? { ...state, detail } : state;
}

/* ───────────── Crediting: the session that pressed Ship ───────────── */

const sameSha = (a: string, b: string) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

export type SessionRef = { id: string; short_id: string | null; title: string | null; user_id: string | null; priority: { id: string; title: string | null } | null };

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
 * deploy. With none going, or one at a sha no longer waiting, everything is next.
 */
export function splitQueue(queue: ReadonlyArray<BoardQueueCommit>, deploys: ReadonlyArray<BoardDeploy>): { going: BoardDeploy | null; sending: BoardQueueCommit[]; next: BoardQueueCommit[] } {
  // One asked for before the live deploy never went out (targets openOf): it sends nothing, so everything waits for Next deploy.
  const live = deploys.filter((d) => d.status === "live").sort((a, b) => (b.live_at ?? b.created_at) - (a.live_at ?? a.created_at))[0] ?? null;
  const going = [...deploys].sort((a, b) => b.created_at - a.created_at).find((d) => isOpen(d) && d.sha && !supersededBy(d, live)) ?? null;
  if (!going) return { going, sending: [], next: [...queue] };
  return { going, sending: upTo(queue, going.sha!), next: after(queue, going.sha!) };
}

/** Each task's newest place on main: waiting ("next"), going out in an unfinished deploy, else the newest deploy that carried it. */
export function tasksOnMain(queue: ReadonlyArray<BoardQueueCommit>, deploys: ReadonlyArray<BoardDeploy>): Map<string, CardId> {
  const out = new Map<string, CardId>();
  const { going, sending, next } = splitQueue(queue, deploys);
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
  commits?: number;
};

/** Own rows first; otherwise the order they came in (newest work first). */
const ownFirst = (rows: BoardRow[]) => rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => Number(b.mine) - Number(a.mine) || i - j).map(([r]) => r);

export function rowsFor(c: Carried, view: BoardView, isMine: (sessionId: string) => boolean): BoardRow[] {
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
      const g = groups.get(key) ?? { key, label: s.priority?.title ?? null, sessions: [], commits: 0, mine: false };
      g.sessions!.push(s.id);
      g.commits! += s.commits;
      g.mine ||= isMine(s.id);
      addLines(g, s);
      groups.set(key, g);
    }
    const none = groups.get("none");
    groups.delete("none");
    return ownFirst([...groups.values(), ...(none ? [none] : [])]);
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
    row.mine ||= mineCommit(x);
    addLines(row, x);
    rows.set(key, row);
  }
  return ownFirst([...rows.values()]);
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
