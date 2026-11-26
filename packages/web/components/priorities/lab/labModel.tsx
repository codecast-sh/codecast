// Priorities lab (throwaway prototype): the pure derivations the redesigned
// list draws from real rows. Nothing here writes.
import type { PriorityDetail, PriorityHistory, PriorityRow, PriorityStep } from "@codecast/shared/contracts/priorities";
import type { SessionStatus } from "../../../lib/sessionStatus";

export const LAB_DAYS = 10;

/** "2026-11-25" for a timestamp, in the viewer's local calendar. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The last `n` local days, oldest first, today last. */
export function lastDays(n: number, now: number): string[] {
  const out: string[] = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) out.push(localDayKey(d.getTime() - i * 86_400_000));
  return out;
}

/** A history series re-keyed onto `days` (the server's own days when they match). */
export function alignCounts(history: PriorityHistory | undefined, days: string[], counts: readonly number[] | undefined): number[] {
  if (!history || !counts) return days.map(() => 0);
  return days.map((d) => {
    const i = history.days.indexOf(d);
    return i === -1 ? 0 : counts[i] ?? 0;
  });
}

export type SessionView = {
  short_id: string;
  why: Why[];
  title: string;
  /** null: this device holds no live facts for it (a teammate's session). */
  status: SessionStatus | null;
  updated_at: number;
  href: string;
};

const STATUS_RANK: Partial<Record<SessionStatus, number>> = { needs_you: 0, error: 0, working: 1, starting: 1, dormant: 2, stashed: 4, killed: 4 };

export function sessionRank(s: SessionView): number {
  return s.status ? STATUS_RANK[s.status] ?? 3 : 3;
}

/** needs-you > working > dormant > most recently updated. */
export function orderSessions(list: SessionView[]): SessionView[] {
  return [...list].sort((a, b) => sessionRank(a) - sessionRank(b) || b.updated_at - a.updated_at);
}

/** Why a session counts as working a milestone. */
export type Why = "mapped" | "linked" | `via ${string}`;

export type ConnectedRaw = { short_id: string; title: string; updated_at: number; why: Why[] };

export type TaskRow = { short_id?: string; title?: string; status?: string; plan_id?: string; closed_at?: number; conversation_ids?: string[] };
export type TaskOf = (shortId: string) => TaskRow | undefined;
export type PlanRow = { _id: string; short_id?: string; title?: string; status?: string; progress?: { done: number; total: number }; task_ids?: string[] };
export type PlanOf = (id: string) => PlanRow | undefined;

/** A session short id is its conversation id's first seven characters. */
const shortOf = (convId: string) => convId.slice(0, 7);

/**
 * Every session connected to a milestone, deduped, each with why: the pass
 * mapped it (every one once `show` answered; a list row holds only its newest
 * three), the milestone's refs name it, or one of its tasks is bound to it.
 * A session reached only through a plan is not the milestone's.
 */
export function connectedSessions(row: PriorityRow, step: PriorityStep, detail: PriorityDetail | null | undefined, taskOf: TaskOf): ConnectedRaw[] {
  const out = new Map<string, ConnectedRaw>();
  const add = (short_id: string, why: Why, title = "", updated_at = 0) => {
    const id = short_id.slice(0, 7);
    const cur = out.get(id);
    if (!cur) out.set(id, { short_id: id, title, updated_at, why: [why] });
    else {
      if (!cur.why.includes(why)) cur.why.push(why);
      if (!cur.title && title) cur.title = title;
      cur.updated_at = Math.max(cur.updated_at, updated_at);
    }
  };
  const mapped = detail ? detail.steps.find((s) => s.key === step.key)?.sessions ?? [] : row.sessions.filter((s) => s.step_key === step.key);
  for (const s of mapped) add(s.short_id, "mapped", s.title, s.updated_at);
  for (const ref of step.refs) if (ref.kind === "session") add(ref.id, "linked");
  for (const ref of step.refs) {
    if (ref.kind !== "task") continue;
    for (const c of taskOf(ref.id)?.conversation_ids ?? []) add(shortOf(c), `via ${ref.id}`);
  }
  return [...out.values()];
}

export type PlanInfo = { _id: string; short_id: string; title: string; done: number; total: number; size: number };
export type TaskInfo = { short_id: string; title: string; done: boolean };
export type PrInfo = { repository: string; number: number; title: string; state: string };
export type DeployInfo = { short_id: string; target: string; status: string; at: number };

/** A plan as big as this is a program, not a milestone's plan: it only shows inside an open milestone. */
export const SMALL_PLAN_MAX = 40;
const DEAD_PLAN = new Set(["abandoned", "cancelled", "canceled"]);

const planInfo = (p: PlanRow): PlanInfo => ({
  _id: p._id,
  short_id: p.short_id ?? "",
  title: p.title ?? "",
  done: p.progress?.done ?? 0,
  total: p.progress?.total ?? 0,
  size: p.task_ids?.length ?? p.progress?.total ?? 0,
});

export type PlanAttribution = {
  /** Holds tasks from at least half the priority's milestones that have tasks: shown once, on the priority. */
  priority: PlanInfo | null;
  /** Per milestone key: its own plan (≥ half its tasks, ≤ 40 tasks, not the priority's), and the big plans it is part of. */
  steps: Map<string, { plan: PlanInfo | null; partOf: PlanInfo[] }>;
};

export function attributePlans(steps: PriorityStep[], taskOf: TaskOf, planOf: PlanOf): PlanAttribution {
  const live = (id: string | undefined) => {
    const p = id ? planOf(id) : undefined;
    return p?.short_id && !DEAD_PLAN.has(p.status ?? "") ? p : undefined;
  };
  const perStep = steps.map((s) => {
    const tasks = s.refs.filter((r) => r.kind === "task");
    const counts = new Map<string, number>();
    for (const t of tasks) {
      const p = live(taskOf(t.id)?.plan_id);
      if (p) counts.set(p._id, (counts.get(p._id) ?? 0) + 1);
    }
    return { step: s, taskCount: tasks.length, counts };
  });
  const withTasks = perStep.filter((x) => x.taskCount > 0);
  const coverage = new Map<string, number>();
  for (const x of withTasks) for (const id of x.counts.keys()) coverage.set(id, (coverage.get(id) ?? 0) + 1);
  const small = (id: string) => planInfo(planOf(id)!).size <= SMALL_PLAN_MAX;
  const priorityId = [...coverage.entries()]
    .filter(([id, n]) => small(id) && n * 2 >= withTasks.length)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const out = new Map<string, { plan: PlanInfo | null; partOf: PlanInfo[] }>();
  for (const x of perStep) {
    const own = [...x.counts.entries()]
      .filter(([id, n]) => id !== priorityId && small(id) && n * 2 >= x.taskCount)
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    const partOf = [...x.counts.keys()].filter((id) => !small(id)).map((id) => planInfo(planOf(id)!));
    out.set(x.step.key, { plan: own ? planInfo(planOf(own)!) : null, partOf });
  }
  return { priority: priorityId ? planInfo(planOf(priorityId)!) : null, steps: out };
}

export type Landed = { day: string; title: string; priority: string; tier: PriorityStep["tier"] };

/**
 * When a done milestone landed: its tasks' latest close. A step's own done_at
 * is a poor clock (every one on record was stamped by the same pass run), so
 * it is only the fallback for a milestone with no task in the store.
 */
export function landedAt(step: PriorityStep, taskOf: TaskOf): number | undefined {
  if (!step.done) return undefined;
  const closes = step.refs.filter((r) => r.kind === "task").map((r) => taskOf(r.id)?.closed_at).filter((t): t is number => !!t);
  return closes.length ? Math.max(...closes) : step.done_at;
}

/** Every milestone that landed inside `days`, by day. */
export function landedByDay(rows: PriorityRow[], days: string[], taskOf: TaskOf): Map<string, Landed[]> {
  const out = new Map<string, Landed[]>(days.map((d) => [d, []]));
  for (const r of rows) {
    if (r.status === "merged") continue;
    for (const s of r.steps) {
      const at = landedAt(s, taskOf);
      if (!at) continue;
      const day = localDayKey(at);
      out.get(day)?.push({ day, title: s.title, priority: r.title, tier: s.tier });
    }
  }
  for (const list of out.values()) list.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "critical" ? -1 : 1));
  return out;
}

/** "3h ago", "2d ago". */
export function ago(ts: number, now: number): string {
  if (!ts) return "";
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export type ShowRefs = { sessions: boolean; plans: boolean; tasks: boolean; prs: boolean; branches: boolean; deploys: boolean };
export type LabFilters = { mine: boolean; hideDone: boolean; show: ShowRefs };

export function readFilters(search: string): LabFilters {
  const p = new URLSearchParams(search);
  const show = p.get("show");
  const kinds = new Set((show ?? "sessions,plans").split(",").filter(Boolean));
  return {
    mine: p.get("mine") !== "0",
    hideDone: p.get("done") !== "1",
    show: { sessions: kinds.has("sessions"), plans: kinds.has("plans"), tasks: kinds.has("tasks"), prs: kinds.has("prs"), branches: kinds.has("branches"), deploys: kinds.has("deploys") },
  };
}

/** The filters as the address carries them: only what differs from the default. */
export function writeFilters(f: LabFilters): void {
  const url = new URL(window.location.href);
  const set = (k: string, v: string | null) => (v === null ? url.searchParams.delete(k) : url.searchParams.set(k, v));
  set("mine", f.mine ? null : "0");
  set("done", f.hideDone ? null : "1");
  const kinds = (Object.keys(f.show) as Array<keyof ShowRefs>).filter((k) => f.show[k]).join(",");
  set("show", kinds === "sessions,plans" ? null : kinds || "none");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

