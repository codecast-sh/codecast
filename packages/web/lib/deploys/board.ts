// The Deploys page's two columns as data (doc s97bnygafm0x6p6cwn1f5bn6258jyjfa): on the left, Ship runs on their way to
// main; on the right, Next deploy and each deploy card, with what each carried listed by session, PR, SHA, task,
// branch or priority. Every commit is credited to the session that pressed Ship, the same on both columns.
// Pure: no store, no React.
import type { QueueCommit, QueueGroup } from "@codecast/shared/contracts/deployTargets";
import type { CheckoutRow } from "@codecast/shared/contracts/checkouts";
import { isOpen, prOfSubject, sessionsOf, type DeploySession, type TeamDeployRow } from "./targets";

/* ───────────── Fields the server adds to queue commits and deploy rows (optional until it does) ───────────── */

type Lines = { insertions?: number; deletions?: number };
type SessionExtra = { user_id?: string; priority?: { id: string; title: string | null } };
type CommitExtra = Lines & { pr_number?: number; branch?: string | null };

export type BoardSession = NonNullable<QueueCommit["session"]> & SessionExtra;
export type BoardQueueCommit = Omit<QueueCommit, "session"> & CommitExtra & { session: BoardSession | null };
export type BoardQueueGroup = Omit<QueueGroup, "commits" | "session"> & { session: BoardSession | null; commits: BoardQueueCommit[] };
export type BoardDeployRow = NonNullable<TeamDeployRow["commit_rows"]>[number] & CommitExtra;
export type BoardDeploySession = DeploySession & SessionExtra & {
  /** The tasks its commits on the deploy named, all of them (not only the listed rows). */
  task_short_ids?: string[];
};
export type BoardDeploy = Omit<TeamDeployRow, "commit_rows" | "sessions"> & { commit_rows?: BoardDeployRow[]; sessions: BoardDeploySession[] };

/* ───────────── Ship runs (workflow_runs.shippingRuns) ───────────── */

export type ShipRun = {
  _id: string;
  status: "pending" | "running" | "paused" | "failed";
  task_id?: string;
  task_short_id?: string;
  task_title?: string;
  workflow_slug?: string;
  workflow_label?: string;
  current_node_id?: string;
  current_node_label?: string;
  node_statuses: Array<{ node_id: string; status: string }>;
  pr?: { repository: string; number: number };
  fail_reason?: string;
  gate_prompt?: string;
  gate_decision_short_id?: string;
  spawner_conversation_id?: string;
  spawner_title?: string | null;
  primary_conversation_id?: string;
  project_path?: string;
  user_id?: string;
  created_at: number;
  updated_at: number;
};

export const DROPPED_AFTER_MS = 7 * 24 * 60 * 60_000;

/** The repository a run ships to: its PR's, else that of the checkout it runs in (the longest path holding it). */
export function repositoryOfRun(run: Pick<ShipRun, "pr" | "project_path">, checkouts: ReadonlyArray<Pick<CheckoutRow, "path" | "repository">>): string | null {
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

/** The stations a change passes before main, each read from the run's own station ids. */
export const STEPS = [
  { word: "PR", ids: ["land__pr"] },
  { word: "CI", ids: ["land__ci", "land__checks", "check", "check__verify"] },
  { word: "Review", ids: ["land__review", "review", "review__review", "land__changes", "review__changes"] },
  { word: "Merge", ids: ["land__merge", "land__landed", "merge"] },
] as const;
export type StepState = "done" | "active" | "waiting" | "failed" | "idle";

const statusesOf = (run: Pick<ShipRun, "node_statuses">) => new Map(run.node_statuses.map((n) => [n.node_id, n.status]));

/** Merged: a merge station passed, or the run has moved on to deploying. Its work then waits on the right. */
export function isMerged(run: Pick<ShipRun, "node_statuses" | "current_node_id">): boolean {
  const by = statusesOf(run);
  return STEPS[3].ids.some((id) => by.get(id) === "completed") || (run.current_node_id ?? "").startsWith("deploy");
}

/** PR · CI · Review · Merge. A stopped run is red on exactly one step, the one where it stopped. */
export function stepper(run: Pick<ShipRun, "status" | "node_statuses" | "current_node_id">): StepState[] {
  const by = statusesOf(run);
  const stopped = run.status === "failed";
  const steps: StepState[] = STEPS.map((s) => {
    const st = s.ids.map((id) => by.get(id)).filter((x): x is string => !!x);
    // A failed station is the run's to fix while it runs, a person's turn while it waits; red only once it stopped.
    if (st.includes("failed")) return stopped ? "failed" : run.status === "paused" ? "waiting" : "active";
    if (st.includes("running")) return "active";
    if (st.length && st.every((x) => x === "completed" || x === "skipped")) return "done";
    return "idle";
  });
  if (!stopped) return steps;
  // Where it stopped: the first failed step, else the step it was on, else the first it had not finished.
  let at = steps.indexOf("failed");
  if (at < 0) at = STEPS.findIndex((s) => (s.ids as readonly string[]).includes(run.current_node_id ?? ""));
  if (at < 0) at = steps.findIndex((x) => x !== "done");
  if (at < 0) return steps;
  return steps.map((x, i) => (i < at ? "done" : i === at ? "failed" : "idle"));
}

export type RunState = { word: string; tone: "yellow" | "blue" | "red"; detail?: string };

/** What the run is doing now, in words a person reads at a glance. */
export function runState(run: Pick<ShipRun, "status" | "fail_reason" | "gate_prompt" | "gate_decision_short_id" | "current_node_label" | "node_statuses">): RunState {
  if (run.status === "failed") {
    const detail = run.fail_reason?.replace(/^Stopped:\s*/i, "").trim();
    return detail ? { word: "Stopped", tone: "red", detail } : { word: "Stopped", tone: "red" };
  }
  if (run.status === "paused") return { word: run.gate_prompt || run.gate_decision_short_id ? "Waiting on a decision" : "Paused", tone: "blue" };
  const node = run.current_node_label;
  if (node === "Fix findings") {
    const by = statusesOf(run);
    return { word: STEPS[1].ids.some((id) => by.get(id) === "failed") ? "Fixing CI failures" : "Fixing review findings", tone: "yellow" };
  }
  if (node === "CI and review") return { word: "CI and review running", tone: "yellow" };
  return { word: node || "Starting", tone: "yellow" };
}

const RANK: Record<ShipRun["status"], number> = { failed: 0, paused: 1, running: 2, pending: 2 };
const byUrgency = (a: ShipRun, b: ShipRun) => RANK[a.status] - RANK[b.status] || b.updated_at - a.updated_at;

/** The left column: this repository's unmerged Ship runs, moving ones and those with no movement for 7 days. */
export function shippingRuns(
  runs: ReadonlyArray<ShipRun>,
  o: { repository: string; checkouts: ReadonlyArray<Pick<CheckoutRow, "path" | "repository">>; now: number; mineUserId?: string | null; mine: boolean },
): { moving: ShipRun[]; dropped: ShipRun[] } {
  const repo = o.repository.toLowerCase();
  const open = runs.filter((r) => !isMerged(r) && repositoryOfRun(r, o.checkouts) === repo && (!o.mine || (!!o.mineUserId && r.user_id === o.mineUserId)));
  return {
    moving: open.filter((r) => o.now - r.updated_at <= DROPPED_AFTER_MS).sort(byUrgency),
    dropped: open.filter((r) => o.now - r.updated_at > DROPPED_AFTER_MS).sort(byUrgency),
  };
}

/* ───────────── Crediting: the session that pressed Ship ───────────── */

export type SessionRef = { id: string; short_id: string | null; title: string | null; user_id: string | null; priority: { id: string; title: string | null } | null };

export type Shipper = (taskShortIds: ReadonlyArray<string>, own: SessionRef | null) => SessionRef | null;

/**
 * Who a commit belongs to: the session that sent its task through Ship (the newest run of that task that names one),
 * else the session its own trailer names. A flow's station sessions ("Review · ct-N") land commits but did not write
 * the change. Give it every run the page has, completed ones included: both columns credit through it.
 */
export function shipperOf(runs: ReadonlyArray<Pick<ShipRun, "task_short_id" | "spawner_conversation_id" | "spawner_title" | "user_id" | "created_at">>): Shipper {
  const byTask = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    if (!r.task_short_id || !r.spawner_conversation_id) continue;
    const was = byTask.get(r.task_short_id);
    if (!was || r.created_at > was.created_at) byTask.set(r.task_short_id, r);
  }
  return (tasks, own) => {
    const run = tasks.map((t) => byTask.get(t)).find(Boolean);
    if (!run) return own;
    const id = run.spawner_conversation_id!;
    const same = own?.id === id ? own : null;
    return { id, short_id: same?.short_id ?? null, title: run.spawner_title ?? same?.title ?? null, user_id: run.user_id ?? same?.user_id ?? null, priority: same?.priority ?? null };
  };
}

const refOf = (s: { conversation_id: string; short_id?: string | null; title?: string | null } & SessionExtra): SessionRef => ({
  id: s.conversation_id, short_id: s.short_id ?? null, title: s.title ?? null, user_id: s.user_id ?? null, priority: s.priority ?? null,
});

/* ───────────── The queue: commits on main waiting to deploy ───────────── */

/** The queue's commits, newest first. */
export const queueCommits = (groups: ReadonlyArray<BoardQueueGroup>): BoardQueueCommit[] => groups.flatMap((g) => g.commits).sort((a, b) => b.at - a.at);

const sameSha = (a: string, b: string) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

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
  /** Whether its commits record their branch (deploys from before branches were recorded do not). */
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

type Raw = { sha: string; subject: string; pr_number?: number; branch?: string | null; tasks: string[]; own: SessionRef | null } & Lines;

function carriedOf(raw: ReadonlyArray<Raw>, credit: Shipper, extra: { more: number; branchesKnown: boolean; sessions?: ReadonlyArray<SessionRef & { tasks?: string[] }>; tasks?: ReadonlyArray<{ short_id?: string | null; title?: string | null }> }): Carried {
  const sessions = new Map<string, CarriedSession>();
  const commits: CarriedCommit[] = [];
  let loose = 0;
  for (const c of raw) {
    const who = credit(c.tasks, c.own);
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
    const who = (tasks && credit(tasks, x)) || x;
    const s = sessions.get(who.id);
    if (s) fill(s, who);
    else if (who.id !== x.id || !named.has(x.id)) sessions.set(who.id, { ...who, commits: 0 });
  }
  const tasks = new Map<string, string | null>();
  for (const t of extra.tasks ?? []) if (t.short_id) tasks.set(t.short_id, t.title ?? null);
  for (const c of raw) for (const t of c.tasks) if (!tasks.has(t)) tasks.set(t, null);
  return {
    sessions: [...sessions.values()], commits, loose, more: Math.max(0, extra.more), branchesKnown: extra.branchesKnown,
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
    { more, branchesKnown: true, tasks: [...titles].map(([short_id, title]) => ({ short_id, title })) },
  );
}

/** A finished deploy's recorded commits as its card lists them. */
export function carriedOfDeploy(d: Pick<BoardDeploy, "commit_rows" | "sessions" | "tasks" | "commits">, credit: Shipper): Carried {
  const rows = d.commit_rows ?? [];
  const listed = sessionsOf(d) as BoardDeploySession[];
  const info = new Map(listed.map((s) => [s.conversation_id, refOf(s)]));
  const sessions = listed.map((s) => ({ ...info.get(s.conversation_id)!, tasks: s.task_short_ids }));
  return carriedOf(
    rows.map((c) => ({ ...c, tasks: c.tasks ?? [], own: c.conversation_id ? (info.get(c.conversation_id) ?? refOf({ conversation_id: c.conversation_id })) : null })),
    credit,
    { more: d.commits - rows.length, branchesKnown: rows.some((c) => c.branch !== undefined), sessions, tasks: d.tasks },
  );
}

/* ───────────── Deploy cards ───────────── */

/** Deploys newest first, every attempt at one commit on one card, its newest attempt leading. */
export function attemptGroups<D extends Pick<TeamDeployRow, "sha">>(deploys: ReadonlyArray<D>): D[][] {
  const bySha = new Map<string, D[]>();
  const out: D[][] = [];
  for (const d of deploys) {
    const g = d.sha ? bySha.get(d.sha) : undefined;
    if (g) { g.push(d); continue; }
    const fresh = [d];
    if (d.sha) bySha.set(d.sha, fresh);
    out.push(fresh);
  }
  return out;
}

/** What one card carried: an unfinished deploy is sending the waiting commits up to its sha; any other, what an attempt recorded. */
export function carriedOfAttempts(group: ReadonlyArray<BoardDeploy>, queue: ReadonlyArray<BoardQueueCommit>, credit: Shipper): Carried {
  const lead = group[0];
  if (isOpen(lead) && lead.sha) return carriedOfQueue(upTo(queue, lead.sha), credit);
  const recorded = group.find((d) => (d.commit_rows ?? []).length) ?? lead;
  return carriedOfDeploy(recorded, credit);
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

/** Each task's newest place on main: waiting ("next"), else the newest deploy that carried it. */
export function tasksOnMain(queue: ReadonlyArray<BoardQueueCommit>, deploys: ReadonlyArray<BoardDeploy>): Map<string, CardId> {
  const out = new Map<string, CardId>();
  for (const c of queue) for (const t of c.tasks) if (t.short_id && !out.has(t.short_id)) out.set(t.short_id, "next");
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
    const key = view === "prs" ? (x.pr ? `#${x.pr}` : x.sha) : view === "shas" ? x.sha : (x.branch ?? "main");
    const row = rows.get(key) ?? (view === "branches"
      ? { key, label: x.branch ?? "main", branch: x.branch ?? "main", commits: 0, mine: false }
      : { key, label: x.subject, pr: x.pr, sha: x.sha, commits: 0, mine: false });
    row.commits!++;
    row.mine ||= mineCommit(x);
    addLines(row, x);
    rows.set(key, row);
  }
  return ownFirst([...rows.values()]);
}

/* ───────────── Folding ───────────── */

export const FOLD_SHOWN = 12;

/** How many rows a list shows folded: 12, but never folding away two or fewer (the button takes their room). */
export function fold(n: number): { shown: number; hidden: number } {
  const shown = n > FOLD_SHOWN + 2 ? FOLD_SHOWN : n;
  return { shown, hidden: n - shown };
}
