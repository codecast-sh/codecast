// Priorities as pure functions over the rows convex/priorities.ts returns:
// each owner's active priorities in order and their finished and past ones
// after, the paints the store's priority actions make and the restore when
// the server refuses one, and the pass's timing. What the list page derives
// from them lives in lib/priorityList.
import type { PriorityDetail, PriorityHistory, PriorityHistoryLane, PriorityList, PriorityRow, PriorityStatus, PriorityStep, PriorityStepTier } from "@codecast/shared/contracts/priorities";
import { composeLinkHref } from "./composeLink";
import { serverErrorText } from "./errorCause";

export type { PriorityRow };

/** When the viewer's pass here runs, beside the list's rows (shared/contracts PriorityList). */
export type PriorityListMeta = Pick<PriorityList, "next_pass_at" | "behind_by_ms">;

/** The rows the store mirrors, out of a list answer. */
export function listRows(payload: PriorityList | null | undefined): PriorityRow[] | undefined {
  return payload?.priorities;
}

export function listMeta(payload: PriorityList | null | undefined): PriorityListMeta {
  return { next_pass_at: payload?.next_pass_at ?? null, behind_by_ms: payload?.behind_by_ms ?? null };
}

/** The list says a pass runs now: its next pass is due. */
export function passDue(meta: PriorityListMeta, now: number): boolean {
  return meta.next_pass_at != null && meta.next_pass_at <= now;
}

/** Under this the pass is on time and the header says nothing. */
export const BEHIND_SHOWN_MS = 6 * 3_600_000;

/** "Behind by 8h" once the pass is more than six hours late, else null. */
export function behindLabel(ms: number | null | undefined): string | null {
  if (ms == null || ms <= BEHIND_SHOWN_MS) return null;
  return `Behind by ${Math.floor(ms / 3_600_000)}h`;
}

/** "Next pass 3:00 PM" today, "Next pass Wed 3:00 PM" on another day; null with no time or one already past. */
export function nextPassLabel(at: number | null | undefined, now: number): string | null {
  if (at == null || at <= now) return null;
  const when = new Date(at);
  const time = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const sameDay = when.toDateString() === new Date(now).toDateString();
  return `Next pass ${sameDay ? time : `${when.toLocaleDateString("en-US", { weekday: "short" })} ${time}`}`;
}

/** Where a priority opens: its row on /priorities, expanded. */
export function priorityHref(shortId: string): string {
  return `/priorities?open=${encodeURIComponent(shortId)}`;
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

export function stepTask(step: PriorityStep): string | undefined {
  return step.refs.find((r) => r.kind === "task")?.id;
}

/** Opens a new session's composer on this step, its task attached. */
export function newSessionHref(row: Pick<PriorityRow, "title">, step: PriorityStep): string {
  return composeLinkHref(`${row.title}: ${step.title}`, stepTask(step));
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
  const links = (r.links ?? []).map((l) => `${l.key}:${l.sessions_more}:${l.plan?.short_id ?? ""}:${l.plan?.done ?? ""}:${l.part_of.length}:${l.sessions.map((x) => `${x.short_id}.${x.state}.${x.title}.${x.last_active_at}`).join(";")}`).join(",");
  const plan = r.plan ? `${r.plan.short_id}:${r.plan.done}/${r.plan.total}` : "";
  return [r.rank, r.status, r.title, r.summary, r.serves, r.done_at, r.last_active_at, r.owner, steps, sessions, links, plan].join("|");
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
