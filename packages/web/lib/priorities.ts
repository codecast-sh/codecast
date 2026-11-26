// Priorities as pure functions over the rows convex/priorities.ts returns:
// each owner's active priorities in order and their finished and past ones
// after, the paints the store's priority actions make and the restore when
// the server refuses one, and the pass's timing. What the list page derives
// from them lives in lib/priorityList.
import type { PriorityDetail, PriorityHistory, PriorityHistoryLane, PriorityList, PriorityRow, PriorityStatus, PriorityStep, PriorityStepTier } from "@codecast/shared/contracts/priorities";
import { effectivePriorityOrder, lastPriorityKey, placePriority, priorityPositions, rankSourceOf } from "@codecast/shared/contracts/priorities";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
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

/** Where a priority opens: its own page. */
export function priorityHref(shortId: string): string {
  return `/priorities/${encodeURIComponent(shortId)}`;
}

export type { PriorityDetail, PriorityHistory, PriorityHistoryLane };

/** Who set the rank, in words: the person's own placement, or the pass's. */
export function rankProvenance(row: Pick<PriorityRow, "rank" | "rank_set_by" | "mine" | "owner">): string | null {
  if (row.rank == null) return null;
  if (row.rank_set_by !== "person") return "ranked by AI";
  return row.mine ? "you placed it" : `${row.owner || "owner"} placed it`;
}



const sameOwner = (a: PriorityRow, b: PriorityRow) => String(a.user_id) === String(b.user_id) && a.workspace === b.workspace;

// The paints the store's priority actions make on their draft rows
// (store/prioritiesSlice), in place. The server's push settles each one.

/**
 * The rows with `rank` and `rank_source` read live from their places
 * (shared/contracts/priorities priorityPositions), not the server's
 * snapshot, so a move paints at once. A row whose rank holds is the same row.
 */
export function withLiveRanks(rows: readonly PriorityRow[]): PriorityRow[] {
  const positions = priorityPositions(rows, (r) => String(r._id));
  return rows.map((r) => {
    const rank = positions.get(String(r._id)) ?? null;
    const rank_source = rankSourceOf(r);
    return rank === r.rank && rank_source === r.rank_source ? r : { ...r, rank, rank_source };
  });
}

/** Where the person moves a priority: a position (1 = first), or one up or down. */
export type PriorityMove = number | "up" | "down";

/** Places a priority as the server's move does (shared/contracts/priorities placePriority): its person_pos between its new neighbours'. */
export function paintMove(rows: PriorityRow[], shortId: string, to: PriorityMove): void {
  const row = rows.find((r) => r.short_id === shortId);
  if (!row || row.status !== "active") return;
  const peers = rows.filter((r) => sameOwner(r, row) && r.status !== "merged");
  const at = effectivePriorityOrder(peers).indexOf(row) + 1;
  for (const w of placePriority(peers, row, to === "up" ? at - 1 : to === "down" ? at + 1 : to)) {
    if (w.person_pos !== undefined) w.row.person_pos = w.person_pos;
    else w.row.ai_rank = w.ai_rank ?? null;
  }
}

/** Puts one step on the critical path or among the polish, as the person's choice. */
export function paintTier(row: PriorityRow, stepKey: string, tier: PriorityStepTier): void {
  const step = row.steps.find((s) => s.key === stepKey);
  if (!step) return;
  step.tier = tier;
  step.tier_set_by = "person";
  row.counts = criticalCounts(row.steps);
}

/** Set aside leaves the ranking; restore brings it back active as the pass's, after its owner's ranked ones (lastPriorityKey, as the server does). */
export function paintStatus(rows: PriorityRow[], shortId: string, status: "active" | "set_aside"): void {
  const row = rows.find((r) => r.short_id === shortId);
  if (!row) return;
  row.person_pos = null;
  row.ai_rank = status === "active" ? lastPriorityKey(rows.filter((r) => sameOwner(r, row))) : null;
  row.status = status;
  if (status === "active") row.done_at = null;
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
    g.active = effectivePriorityOrder(g.active);
    g.past.sort((a, b) => (PAST_ORDER[a.status] ?? 9) - (PAST_ORDER[b.status] ?? 9) || (b.done_at ?? b.last_active_at) - (a.done_at ?? a.last_active_at));
  }
  return groups;
}

type StartPlan = { short_id: string } | null;
export type StartTask = { title?: string; status?: string };

/**
 * Start on a milestone: a new session's composer holding a short brief of
 * live references (the priority, the milestone, its open tasks, its plan) for
 * the person to edit, and the create links the session to the milestone and
 * binds it to the plan (the milestone's own, else the priority's). The first
 * open task is attached as a compose link's task is. `task` reads the
 * viewer's store for a task: its title goes beside its id, and one known
 * to be finished is left out, so it is never the attached task either.
 */
export function milestoneStartHref(
  priority: Pick<PriorityRow, "short_id"> & { plan?: StartPlan },
  milestone: { step: Pick<PriorityStep, "key" | "title" | "refs">; plan?: StartPlan },
  task: (shortId: string) => StartTask | undefined,
): string {
  const pri = priority.short_id;
  const plan = (milestone.plan ?? priority.plan)?.short_id;
  const open = milestone.step.refs
    .filter((r) => r.kind === "task")
    .map((r) => ({ id: r.id, ...task(r.id) }))
    .filter((t) => !isTerminalTaskStatus(t.status));
  const draft = [
    `${pri}, milestone: ${milestone.step.title}`,
    ...(open.length ? ["Open tasks:", ...open.map((t) => `- ${t.id}${t.title ? ` ${t.title}` : ""}`)] : []),
    ...(plan ? [`Plan: ${plan}`] : []),
    `Run \`cast priorities show ${pri}\` for current detail.`,
  ].join("\n");
  return composeLinkHref(draft, { task: open[0]?.id, priority: pri, step: milestone.step.key, plan });
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
  return [r.rank, r.person_pos, r.ai_rank, r.status, r.title, r.summary, r.serves, r.done_at, r.last_active_at, r.owner, steps, sessions, links, plan].join("|");
}

/** The person's controls, as the page hands them to its rows. */
export type PriorityWrites = {
  move: (shortId: string, to: PriorityMove) => void;
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
