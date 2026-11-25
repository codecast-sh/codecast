// What /priorities draws, as pure functions over the rows convex/priorities.ts
// returns: each owner's active priorities in order and their finished and
// past ones after, a step's sessions and chips, the paints the store's
// priority actions make and the restore when the server refuses one, and the
// history strip's day cells.
import type { PriorityDetail, PriorityHistory, PriorityHistoryLane, PriorityRow, PrioritySession, PriorityStatus, PriorityStep, PriorityStepTier } from "@codecast/shared/contracts/priorities";
import { heatLevels } from "../components/ActivityHeatmap";
import { composeLinkHref } from "./composeLink";
import { serverErrorText } from "./errorCause";

export type { PriorityRow };

/** Where a priority opens: its row on /priorities, expanded. */
export function priorityHref(shortId: string): string {
  return `/priorities?open=${encodeURIComponent(shortId)}`;
}

/** "Nov 21" for a day key ("2026-11-21"), read as the calendar day it names. */
export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export type StripCell = { day: string; count: number; title: string };

export function stripCells(days: readonly string[], counts: readonly number[] | undefined): StripCell[] {
  return days.map((day, i) => {
    const count = counts?.[i] ?? 0;
    return { day, count, title: `${dayLabel(day)}: ${count} typed` };
  });
}

/** Level cutoffs shared by every strip on a page, so one priority's busy day reads as busy beside the others. */
export function stripLevels(lanes: Iterable<readonly number[]>): number[] {
  const all: number[] = [];
  for (const lane of lanes) all.push(...lane);
  return heatLevels(all);
}

export type { PriorityDetail, PriorityHistory, PriorityHistoryLane };



const sameOwner = (a: PriorityRow, b: PriorityRow) => String(a.user_id) === String(b.user_id) && a.workspace === b.workspace;
const byRank = (a: PriorityRow, b: PriorityRow) => (a.rank ?? Infinity) - (b.rank ?? Infinity);

// The paints the store's priority actions make on their draft rows
// (store/prioritiesSlice), in place. The server's push settles each one.

/** Moves a priority to `rank` among its owner's active ones in its workspace and renumbers them. */
export function paintRank(rows: PriorityRow[], shortId: string, rank: number): void {
  const row = rows.find((r) => r.short_id === shortId);
  if (!row || row.status !== "active") return;
  const peers = rows.filter((r) => sameOwner(r, row) && r.status === "active").sort(byRank);
  peers.splice(peers.indexOf(row), 1);
  peers.splice(Math.max(0, Math.min(peers.length, rank - 1)), 0, row);
  peers.forEach((r, i) => { r.rank = i + 1; });
  row.rank_set_by = "person";
}

/** Puts one step on the critical path or among the polish, as the person's choice. */
export function paintTier(row: PriorityRow, stepKey: string, tier: PriorityStepTier): void {
  const step = row.steps.find((s) => s.key === stepKey);
  if (!step) return;
  step.tier = tier;
  step.tier_set_by = "person";
  row.counts = criticalCounts(row.steps);
}

/** Set aside leaves the ranking; restore brings it back active, last among its owner's. */
export function paintStatus(rows: PriorityRow[], shortId: string, status: "active" | "set_aside"): void {
  const row = rows.find((r) => r.short_id === shortId);
  if (!row) return;
  if (status === "set_aside") {
    row.status = "set_aside";
    row.rank = null;
    return;
  }
  row.status = "active";
  row.done_at = null;
  row.rank = rows.filter((r) => r !== row && sameOwner(r, row) && r.status === "active").length + 1;
}

export function criticalCounts(steps: readonly PriorityStep[]): { critical_done: number; critical_total: number } {
  const critical = steps.filter((s) => s.tier === "critical");
  return { critical_done: critical.filter((s) => s.done).length, critical_total: critical.length };
}

export type OwnerGroup = { user_id: string; owner: string; mine: boolean; active: PriorityRow[]; past: PriorityRow[] };

const PAST_ORDER: Partial<Record<PriorityStatus, number>> = { done: 0, quiet: 1, set_aside: 2 };

/** One group per owner, the viewer's first, then by name: active in rank order, then done, quiet and set aside. */
export function ownerGroups(rows: readonly PriorityRow[]): OwnerGroup[] {
  const groups: OwnerGroup[] = [];
  for (const r of rows) {
    if (r.status === "merged") continue;
    let g = groups.find((x) => x.user_id === String(r.user_id));
    if (!g) groups.push((g = { user_id: String(r.user_id), owner: r.owner, mine: r.mine, active: [], past: [] }));
    (r.status === "active" ? g.active : g.past).push(r);
  }
  groups.sort((a, b) => Number(b.mine) - Number(a.mine) || a.owner.localeCompare(b.owner) || a.user_id.localeCompare(b.user_id));
  for (const g of groups) {
    g.active.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    g.past.sort((a, b) => (PAST_ORDER[a.status] ?? 9) - (PAST_ORDER[b.status] ?? 9) || (b.done_at ?? b.last_active_at) - (a.done_at ?? a.last_active_at));
  }
  return groups;
}

/** The rank a priority takes when dropped at `toIndex` among its owner's active ones. */
export function rankAtDrop(toIndex: number): number {
  return Math.max(1, toIndex + 1);
}

export type StepSession = { short_id: string; title: string };

/**
 * The sessions working a step: those mapped to it, then any its refs name. A
 * list row carries only a priority's newest few sessions, so the open row's
 * `show` read (every session, by step) is the source once it has answered.
 */
export function stepSessions(row: PriorityRow, step: PriorityStep, detail?: PriorityDetail | null): StepSession[] {
  const mapped: PrioritySession[] = detail
    ? detail.steps.find((s) => s.key === step.key)?.sessions ?? []
    : row.sessions.filter((s) => s.step_key === step.key);
  const out: StepSession[] = mapped.map((s) => ({ short_id: s.short_id, title: s.title }));
  for (const ref of step.refs) {
    if (ref.kind === "session" && !out.some((s) => s.short_id === ref.id)) out.push({ short_id: ref.id, title: "" });
  }
  return out;
}

/** "+ new session" only on the viewer's own open step that `show` says no session works: the list's few sessions cannot say so. */
export function stepNeedsSession(row: Pick<PriorityRow, "mine">, step: PriorityStep, sessions: readonly StepSession[], detail: PriorityDetail | null | undefined): boolean {
  return row.mine && !!detail && !step.done && sessions.length === 0;
}

export function stepTask(step: PriorityStep): string | undefined {
  return step.refs.find((r) => r.kind === "task")?.id;
}

/** Opens a new session's composer on this step, its task attached. */
export function newSessionHref(row: Pick<PriorityRow, "title">, step: PriorityStep): string {
  return composeLinkHref(`${row.title}: ${step.title}`, stepTask(step));
}

/** Typed messages per day across a step's sessions, or undefined when the server sent none per session. */
export function stepCounts(history: PriorityHistory | undefined, sessions: readonly StepSession[]): number[] | undefined {
  const by = history?.sessions;
  if (!by || !history) return undefined;
  const out = new Array(history.days.length).fill(0);
  for (const s of sessions) (by[s.short_id] ?? []).forEach((n, i) => (out[i] += n));
  return out;
}

/** The priority's sessions with the most typing first (the most recently updated when the server sent no per-session counts). */
export function mostActiveSessions(row: PriorityRow, history: PriorityHistory | undefined, detail?: PriorityDetail | null, limit = 4): StepSession[] {
  const total = (id: string) => (history?.sessions?.[id] ?? []).reduce((a, b) => a + b, 0);
  return [...(detail?.sessions ?? row.sessions)]
    .sort((a, b) => total(b.short_id) - total(a.short_id) || b.updated_at - a.updated_at)
    .slice(0, limit)
    .map((s) => ({ short_id: s.short_id, title: s.title }));
}

const shortDate = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** What a finished or past priority's row says where its count would be. */
export function pastBadge(row: Pick<PriorityRow, "status" | "done_at" | "last_active_at">): string {
  if (row.status === "done") return `✓ Done ${row.done_at ? shortDate(row.done_at) : ""}`.trim();
  if (row.status === "quiet") return `Quiet since ${shortDate(row.last_active_at)}`;
  return "Set aside";
}

/** What a priority row paints, for the store reader's wake signature. */
export function prioritySig(r: PriorityRow): string {
  const steps = r.steps.map((s) => `${s.key}:${s.tier}:${s.done ? 1 : 0}:${s.refs.length}:${s.title}`).join(",");
  const sessions = r.sessions.map((s) => `${s.short_id}:${s.step_key ?? ""}:${s.title}`).join(",");
  return [r.rank, r.status, r.title, r.summary, r.serves, r.done_at, r.last_active_at, r.owner, steps, sessions].join("|");
}

/** The person's controls, as the page hands them to its rows. */
export type PriorityWrites = {
  rank: (shortId: string, rank: number) => void;
  setStepTier: (shortId: string, stepKey: string, tier: PriorityStepTier) => void;
  setAside: (shortId: string) => void;
  restore: (shortId: string) => void;
};

/**
 * A write whose paint the server may refuse: runs it, and on a refusal puts
 * the rows as they were before it back and reports the server's reason. Any
 * other failure is a write still on its way (the outbox retries it), so its
 * paint stays.
 */
export async function writeOrRestore(
  write: () => Promise<unknown>,
  before: PriorityRow[],
  restore: (rows: PriorityRow[]) => void,
  onError: (message: string) => void,
  refused: (error: unknown) => boolean,
): Promise<void> {
  try {
    await write();
  } catch (e) {
    if (!refused(e)) return;
    restore(before);
    onError(serverErrorText(e));
  }
}
