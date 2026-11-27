// Priorities v2 (design doc s97cb1f047f6b8b6fyay8yxytx8jyd91): what is derived
// on read, never stored. Which plan a priority or a milestone belongs to, each
// milestone's state in the session language (design doc
// s970aanfa345d2w12zt9menbys8k0wan), and how a step's sessions rank. Pure, so
// the server's list and every client agree.
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

// ── Sessions and milestone states ───────────────────────────────────────

/** `mine` false: someone else's session; its state ranks the same. */
export type ActionSession = { state: PrioritySessionState; workflow: boolean; last_active_at: number; mine?: boolean };

/** Finished or closed: never the session a line leads with. */
export const isClosedSession = (s: Pick<ActionSession, "state">) => s.state === "done" || s.state === "killed";

const STATE_RANK: Record<PrioritySessionState, number> = { needs_you: 0, working: 1, dormant: 2, idle: 3, done: 4, killed: 5 };

/**
 * Live sessions a person drives, then live workflow runs, then every closed
 * session (so a cut, convex priorityRead's per-milestone cap, never keeps a
 * closed one over a live one); within each, needs you > working > dormant >
 * idle, then the most recent. Whoever owns a session, its needs_you ranks as
 * needs_you: a teammate's milestone reads the same as the viewer's own.
 */
export function orderSessions<S extends ActionSession>(list: readonly S[]): S[] {
  const tier = (s: S) => (isClosedSession(s) ? 2 : s.workflow ? 1 : 0);
  return [...list].sort((a, b) => tier(a) - tier(b) || STATE_RANK[a.state] - STATE_RANK[b.state] || b.last_active_at - a.last_active_at);
}

/** What a milestone's state mark says, in the session language: done, or its live sessions' best state, or, with none live, a new session to start (an active priority) or nothing to show. */
export type MilestoneStateKind = "done" | "needs_you" | "working" | "dormant" | "idle" | "start" | "none";
/** `session`: the one the state is about; for needs_you, the session to answer. */
export type MilestoneState<S extends ActionSession = ActionSession> = { kind: MilestoneStateKind; session?: S };

/**
 * The sidebar's order: needs you > working > dormant > idle, closed last; then
 * the most recent. Each state is the session's own (web lib/priorityList
 * buildModels lays the inbox's verdict over it): a needs_you ranks first
 * whoever owns the session.
 */
export function orderByState<S extends ActionSession>(list: readonly S[]): S[] {
  return [...list].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.last_active_at - a.last_active_at);
}

/**
 * A milestone's one state (the same function for the list, the card, the
 * page and the phone), from its sessions' final verdicts: the best of its
 * live sessions, needs you > working > dormant > idle, the session to answer
 * being the most recent ask. Needs you outranks done: a done milestone reads
 * Done unless one of its sessions asks. With no live session, `canStart` (an
 * active priority, anyone's) makes it a new session to start, else nothing. A
 * teammate's session that needs input makes the milestone needs_you, as the
 * viewer's own does.
 */
export function milestoneStateOf<S extends ActionSession>(m: { done: boolean; sessions: readonly S[] }, { canStart }: { canStart: boolean }): MilestoneState<S> {
  const best = orderByState(m.sessions.filter((s) => !isClosedSession(s)))[0];
  if (m.done) return best?.state === "needs_you" ? { kind: "needs_you", session: best } : { kind: "done" };
  if (!best) return { kind: canStart ? "start" : "none" };
  return { kind: best.state as MilestoneStateKind, session: best };
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
