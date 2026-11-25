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
  title: string;
  /** null: this device holds no live facts for it (a teammate's session). */
  status: SessionStatus | null;
  updated_at: number;
  href: string;
};

const STATUS_RANK: Partial<Record<SessionStatus, number>> = { needs_you: 0, error: 0, working: 1, starting: 1, dormant: 2 };

export function sessionRank(s: SessionView): number {
  return s.status ? STATUS_RANK[s.status] ?? 3 : 3;
}

/** needs-you > working > dormant > most recently updated. */
export function orderSessions(list: SessionView[]): SessionView[] {
  return [...list].sort((a, b) => sessionRank(a) - sessionRank(b) || b.updated_at - a.updated_at);
}

/** Short ids of the sessions working a milestone: those mapped to it (every one once `show` answered), then any its refs name. */
export function milestoneSessionIds(row: PriorityRow, step: PriorityStep, detail: PriorityDetail | null | undefined): Array<{ short_id: string; title: string; updated_at: number }> {
  const mapped = detail
    ? detail.steps.find((s) => s.key === step.key)?.sessions ?? []
    : row.sessions.filter((s) => s.step_key === step.key);
  const out = mapped.map((s) => ({ short_id: s.short_id, title: s.title, updated_at: s.updated_at }));
  for (const ref of step.refs) {
    if (ref.kind === "session" && !out.some((s) => s.short_id === ref.id)) out.push({ short_id: ref.id, title: "", updated_at: 0 });
  }
  return out;
}

export type DerivedPlan = { _id: string; short_id: string; title: string; done: number; total: number };

/** The plan most of a milestone's tasks are filed under, or null when none of them is in a plan. */
export function derivePlan(
  step: PriorityStep,
  taskOf: (shortId: string) => { plan_id?: string } | undefined,
  planOf: (id: string) => { _id: string; short_id?: string; title?: string; progress?: { done: number; total: number } } | undefined,
): DerivedPlan | null {
  const votes = new Map<string, number>();
  for (const ref of step.refs) {
    if (ref.kind !== "task") continue;
    const pid = taskOf(ref.id)?.plan_id;
    if (pid) votes.set(pid, (votes.get(pid) ?? 0) + 1);
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!best) return null;
  const plan = planOf(best);
  if (!plan?.short_id) return null;
  return { _id: plan._id, short_id: plan.short_id, title: plan.title ?? "", done: plan.progress?.done ?? 0, total: plan.progress?.total ?? 0 };
}

export type Landed = { day: string; title: string; priority: string; tier: PriorityStep["tier"] };

/** Every milestone that landed inside `days`, by day. */
export function landedByDay(rows: PriorityRow[], days: string[]): Map<string, Landed[]> {
  const out = new Map<string, Landed[]>(days.map((d) => [d, []]));
  for (const r of rows) {
    if (r.status === "merged") continue;
    for (const s of r.steps) {
      if (!s.done || !s.done_at) continue;
      const day = localDayKey(s.done_at);
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

export type ShowRefs = { sessions: boolean; plans: boolean; tasks: boolean; prs: boolean };
export type LabFilters = { mine: boolean; hideDone: boolean; show: ShowRefs };

export function readFilters(search: string): LabFilters {
  const p = new URLSearchParams(search);
  const show = p.get("show");
  const kinds = new Set((show ?? "sessions,plans").split(",").filter(Boolean));
  return {
    mine: p.get("mine") !== "0",
    hideDone: p.get("done") !== "1",
    show: { sessions: kinds.has("sessions"), plans: kinds.has("plans"), tasks: kinds.has("tasks"), prs: kinds.has("prs") },
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

