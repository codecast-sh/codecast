// Priorities v2 (design doc s97cb1f047f6b8b6fyay8yxytx8jyd91): what is derived
// on read, never stored. Which plan a priority or a milestone belongs to, the
// one next action a priority offers (the same function for the list, the card
// and the page), and how a step's sessions rank. Pure, so the server's list
// and every client agree.
import type { PriorityPlanRef, PrioritySessionState } from "./priorities";

// ── Plan attribution ─────────────────────────────────────────────────────

/** A plan this big is a program, not a milestone's plan: it shows only inside an open milestone, as "Part of". A priority's plan has no size cap: coverage alone decides it. */
export const SMALL_PLAN_MAX = 40;
const DEAD_PLAN = new Set(["abandoned", "cancelled", "canceled"]);

export type PlanFacts = PriorityPlanRef & { id: string; status?: string };

export type PlanAttribution = {
  /** Holds tasks from at least half the priority's task-bearing milestones, whatever its size: shown once, on the priority. */
  priority: PlanFacts | null;
  /** Per milestone key: its own plan (≥ half its tasks, ≤ SMALL_PLAN_MAX, not the priority's), and the big plans it is part of. */
  steps: Map<string, { plan: PlanFacts | null; part_of: PlanFacts[] }>;
};

/**
 * The design doc's rules: ignore abandoned and cancelled plans; a plan holding
 * tasks from at least half the task-bearing milestones is the priority's,
 * whatever its size (a program that touches one milestone in four is not);
 * otherwise a plan holding at least half a milestone's tasks with at most
 * SMALL_PLAN_MAX tasks is that milestone's; bigger plans are only "part of".
 * `taskPlans` is each of a milestone's tasks' plan id (null with none).
 */
export function attributePlans(
  steps: ReadonlyArray<{ key: string; taskPlans: ReadonlyArray<string | null> }>,
  planOf: (id: string) => PlanFacts | undefined,
): PlanAttribution {
  const live = (id: string | null) => {
    const p = id ? planOf(id) : undefined;
    return p && !DEAD_PLAN.has(p.status ?? "") ? p : undefined;
  };
  const small = (p: PlanFacts) => p.size <= SMALL_PLAN_MAX;
  const best = (counts: Map<string, number>, ok: (p: PlanFacts, n: number) => boolean) =>
    [...counts.entries()]
      .filter(([id, n]) => ok(planOf(id)!, n))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];

  const perStep = steps.map((s) => {
    const counts = new Map<string, number>();
    for (const id of s.taskPlans) {
      const p = live(id);
      if (p) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    }
    return { key: s.key, tasks: s.taskPlans.length, counts };
  });
  const bearing = perStep.filter((x) => x.tasks > 0);
  const coverage = new Map<string, number>();
  for (const x of bearing) for (const id of x.counts.keys()) coverage.set(id, (coverage.get(id) ?? 0) + 1);
  const priorityId = bearing.length ? best(coverage, (_p, n) => n * 2 >= bearing.length) : undefined;

  const out = new Map<string, { plan: PlanFacts | null; part_of: PlanFacts[] }>();
  for (const x of perStep) {
    const own = best(x.counts, (p, n) => p.id !== priorityId && small(p) && n * 2 >= x.tasks);
    const part_of = [...x.counts.keys()].filter((id) => id !== priorityId).map((id) => planOf(id)!).filter((p) => !small(p));
    out.set(x.key, { plan: own ? planOf(own)! : null, part_of });
  }
  return { priority: priorityId ? planOf(priorityId)! : null, steps: out };
}

// ── Sessions and the next action ────────────────────────────────────────

/** `mine` false: someone else's session, which never asks the viewer anything. */
export type ActionSession = { state: PrioritySessionState; workflow: boolean; last_active_at: number; mine?: boolean };
export type ActionMilestone<S extends ActionSession = ActionSession> = { key: string; tier: "critical" | "polish"; done: boolean; sessions: S[] };

/** Finished or closed: never the session a line leads with. */
export const isClosedSession = (s: Pick<ActionSession, "state">) => s.state === "done" || s.state === "killed";
export const asksPerson = (s: Pick<ActionSession, "state" | "mine">) => s.state === "needs_you" && s.mine !== false;

const STATE_RANK: Record<PrioritySessionState, number> = { needs_you: 0, working: 1, dormant: 2, idle: 3, done: 4, killed: 5 };

/** Sessions a person drives before workflow runs, closed runs last; then needs you > working > dormant > idle, then the most recent. */
export function orderSessions<S extends ActionSession>(list: readonly S[]): S[] {
  const tier = (s: S) => (s.workflow ? (isClosedSession(s) ? 2 : 1) : 0);
  // Someone else's ask ranks as idle: it is not the viewer's to answer.
  const rank = (s: S) => (s.state === "needs_you" && !asksPerson(s) ? STATE_RANK.idle : STATE_RANK[s.state]);
  return [...list].sort((a, b) => tier(a) - tier(b) || rank(a) - rank(b) || b.last_active_at - a.last_active_at);
}

/** The session a line leads with: the best that is not closed. */
export function bestSession<S extends ActionSession>(list: readonly S[]): S | undefined {
  return orderSessions(list).find((s) => !isClosedSession(s));
}

export type NextKind = "answer" | "open" | "resume" | "start";
export type NextAction<M extends ActionMilestone> = { milestone: M; session?: M["sessions"][number]; kind: NextKind };

/**
 * A priority's one primary action. When any open milestone has a session that
 * needs the person, Answer the one that waited most recently (one a person
 * drives before a workflow run's). Otherwise the first open critical
 * milestone: Open its working session, Resume a dormant or idle one, or Start
 * one when nothing is live.
 */
export function nextActionOf<M extends ActionMilestone>(milestones: readonly M[]): NextAction<M> | null {
  const open = milestones.filter((m) => !m.done);
  const asking = open.flatMap((m) => m.sessions.filter(asksPerson).map((s) => ({ m, s })));
  if (asking.length) {
    const { m, s } = asking.sort((a, b) => Number(a.s.workflow) - Number(b.s.workflow) || b.s.last_active_at - a.s.last_active_at)[0];
    return { milestone: m, session: s, kind: "answer" };
  }
  const m = open.find((x) => x.tier === "critical");
  if (!m) return null;
  const session = bestSession(m.sessions);
  if (!session) return { milestone: m, kind: "start" };
  return { milestone: m, session, kind: session.state === "working" ? "open" : "resume" };
}

/** A workflow step's session title ("Review · ct-98544 …", "Ship · pl-12"). */
export const WORKFLOW_STEP_TITLE = /^[A-Z][A-Za-z]+ · (ct|pl)-\d+/;

/** A session a workflow run spawned: a real run field, or a subagent of a parent titled as a step. */
export function isWorkflowSession(c: {
  is_workflow_sub?: boolean | null;
  workflow_run_id?: unknown;
  is_workflow_primary?: boolean | null;
  is_subagent?: boolean | null;
  parent_conversation_id?: unknown;
  title?: string | null;
}): boolean {
  if (c.is_workflow_sub) return true;
  if (c.workflow_run_id && !c.is_workflow_primary) return true;
  return !!c.is_subagent && !!c.parent_conversation_id && WORKFLOW_STEP_TITLE.test(c.title ?? "");
}
