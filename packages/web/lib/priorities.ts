// Priorities as pure functions over the rows convex/priorities.ts returns:
// each owner's active priorities in order and their finished and past ones
// after, the paints the store's priority actions make and the restore when
// the server refuses one, and the pass's timing. What the list page derives
// from them lives in lib/priorityList.
import type { PriorityCorrection, PriorityDetail, PriorityHistory, PriorityHistoryLane, PriorityList, PriorityMilestoneLinks, PriorityPlanRef, PriorityRow, PriorityStatus, PriorityStep, PriorityStepTier } from "@codecast/shared/contracts/priorities";
import type { PriorityDetailRow } from "./priorityDetail";
import { effectivePriorityOrder, lastPriorityKey, placePriority, priorityPositions, rankSourceOf } from "@codecast/shared/contracts/priorities";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { composeLinkHref } from "./composeLink";
import { lookup } from "./liveEntities";
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
export function rankProvenance(row: Pick<PriorityRow, "rank" | "rank_source" | "mine" | "owner">): string | null {
  if (row.rank == null) return null;
  if (row.rank_source !== "person") return "ranked by AI";
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

/**
 * Set aside leaves the ranking; restore brings it back active as the pass's,
 * after its owner's ranked ones (lastPriorityKey, as the server does).
 * Reopening a priority the pass marked done becomes the person's call.
 */
export function paintStatus(rows: PriorityRow[], shortId: string, status: "active" | "set_aside"): void {
  const row = rows.find((r) => r.short_id === shortId);
  if (!row) return;
  row.person_pos = null;
  row.ai_rank = status === "active" ? lastPriorityKey(rows.filter((r) => sameOwner(r, row))) : null;
  if (status === "active") {
    row.status_set_by = row.status === "done" && row.status_set_by !== "person" ? "person" : "pass";
    row.done_at = null;
  }
  row.status = status;
}

/** The rows a write paints: the list's, and the detail rows (lib/priorityDetail) a page or a reference opened. */
export type PaintState = { priorities: Record<string, PriorityRow>; priorityDetails?: Record<string, PriorityDetailRow> };

const detailOf = (s: PaintState, shortId: string) => Object.values(s.priorityDetails ?? {}).find((d) => d.short_id === shortId);

/** The priority a write paints: the list's row, else the detail's own copy of one the list does not hold. */
export function paintedRow(s: PaintState, shortId: string): PriorityRow | undefined {
  return (lookup(s.priorities, shortId) as PriorityRow | undefined) ?? detailOf(s, shortId)?.base;
}

/** Its milestones' links where its surfaces read them: the row's, else the detail's (a teammate's or a past priority). */
function linksOf(s: PaintState, row: PriorityRow): PriorityMilestoneLinks[] {
  return row.links ?? detailOf(s, row.short_id)?.links ?? [];
}

/** A move on a priority the list does not hold (the phone opens one page): its own rank steps, as the server's echo will say. */
export function paintDetachedMove(row: PriorityRow, to: PriorityMove): void {
  if (row.status !== "active" || row.rank == null) return;
  row.rank = Math.max(1, to === "up" ? row.rank - 1 : to === "down" ? row.rank + 1 : to);
  row.rank_source = "person";
}

/** The person's done or not done on a milestone, which the pass then keeps. */
export function paintStepDone(row: PriorityRow, stepKey: string, done: boolean, now: number): void {
  const step = row.steps.find((s) => s.key === stepKey);
  if (!step) return;
  step.done = done;
  step.done_set_by = "person";
  if (done) step.done_at = step.done_at ?? now;
  else delete step.done_at;
  row.counts = criticalCounts(row.steps);
}

export function paintRename(row: PriorityRow, stepKey: string, title: string): void {
  const step = row.steps.find((s) => s.key === stepKey);
  const next = title.trim();
  if (!step || !next) return;
  step.title = next;
  step.title_set_by = "person";
}

/** A dropped milestone leaves every read (the server keeps it as a tombstone only the pass sees). */
export function paintDrop(s: PaintState, row: PriorityRow, stepKey: string): void {
  row.steps = row.steps.filter((st) => st.key !== stepKey);
  if (row.links) row.links = row.links.filter((l) => l.key !== stepKey);
  const detail = detailOf(s, row.short_id);
  if (detail?.links) detail.links = detail.links.filter((l) => l.key !== stepKey);
  row.counts = criticalCounts(row.steps);
}

/** The person marks a priority done: it leaves the ranking and the pass keeps it done. */
export function paintPriorityDone(row: PriorityRow, now: number): void {
  row.done_at = row.status === "done" ? row.done_at ?? now : now;
  row.status = "done";
  row.status_set_by = "person";
  row.person_pos = null;
  row.ai_rank = null;
}

const keyNumber = (key: string) => Number(/^s(\d+)$/.exec(key)?.[1] ?? 0);

/** One priority merged into another of the owner's: its milestones join under new keys, its sessions follow, and it is merged. */
export function paintMerge(s: PaintState, from: PriorityRow, into: PriorityRow): void {
  let next = Math.max(0, ...into.steps.map((st) => keyNumber(st.key)));
  const remap = new Map(from.steps.map((st) => [st.key, `s${++next}`]));
  into.steps = [...into.steps, ...from.steps.map((st) => ({ ...st, key: remap.get(st.key)! }))];
  into.counts = criticalCounts(into.steps);
  if (into.links) into.links = [...into.links, ...linksOf(s, from).map((l) => ({ ...l, key: remap.get(l.key) ?? l.key }))];
  into.sessions = [...from.sessions.map((x) => ({ ...x, step_key: x.step_key ? remap.get(x.step_key) ?? null : null })), ...into.sessions];
  into.session_count += from.session_count;
  from.status = "merged";
  from.status_set_by = "person";
  from.person_pos = null;
  from.ai_rank = null;
}

/** Takes a session off every milestone of a priority (and, unless it stays on the priority, off the priority). */
function takeSession(s: PaintState, row: PriorityRow, session: string, stays: boolean) {
  let linked: PriorityMilestoneLinks["sessions"][number] | undefined;
  for (const l of linksOf(s, row)) {
    linked ??= l.sessions.find((x) => x.short_id === session);
    l.sessions = l.sessions.filter((x) => x.short_id !== session);
  }
  const held = row.sessions.find((x) => x.short_id === session);
  if (!stays) {
    row.sessions = row.sessions.filter((x) => x.short_id !== session);
    if (held) row.session_count = Math.max(0, row.session_count - 1);
  }
  return { linked, held };
}

/** The person puts one of their sessions on a priority, on a milestone of it or none: the pass never moves it. */
export function paintSessionMove(s: PaintState, session: string, from: PriorityRow, to: PriorityRow, stepKey: string | null, now: number): void {
  const { linked, held } = takeSession(s, from, session, from === to);
  const entry = { short_id: session, title: held?.title ?? linked?.title ?? "", step_key: stepKey, updated_at: held?.updated_at ?? now, set_by_person: true };
  const kept = to.sessions.find((x) => x.short_id === session);
  if (kept) Object.assign(kept, entry);
  else {
    to.sessions = [entry, ...to.sessions];
    to.session_count += 1;
  }
  const target = stepKey ? linksOf(s, to).find((l) => l.key === stepKey) : undefined;
  if (target && linked) target.sessions = [{ ...linked, why: ["mapped"] }, ...target.sessions];
}

/** "Not this priority": the session leaves it, and the pass never maps it there again. */
export function paintSessionNotThis(s: PaintState, session: string, from: PriorityRow): void {
  takeSession(s, from, session, false);
}

/** A correction the person wrote: the row reads "correction pending" until a pass reads it, and the page lists it. */
export function paintCorrection(s: PaintState, row: PriorityRow, correction: PriorityCorrection): void {
  row.correction_pending = true;
  const link = correction.step_key ? linksOf(s, row).find((l) => l.key === correction.step_key) : undefined;
  if (link) link.correction_pending = true;
  const detail = detailOf(s, row.short_id);
  if (detail) detail.corrections = [correction, ...detail.corrections];
}

/** A deleted correction leaves the page, and "correction pending" goes with the last one still waiting. */
export function paintCorrectionDelete(s: PaintState, correctionId: string): void {
  const detail = Object.values(s.priorityDetails ?? {}).find((d) => d.corrections.some((c) => c._id === correctionId));
  if (!detail) return;
  detail.corrections = detail.corrections.filter((c) => c._id !== correctionId);
  const row = paintedRow(s, detail.short_id);
  if (!row) return;
  const waiting = detail.corrections.filter((c) => c.status === "pending");
  row.correction_pending = waiting.length > 0;
  for (const l of linksOf(s, row)) l.correction_pending = waiting.some((c) => c.step_key === l.key);
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
  const { draft, task: first, start } = milestoneStart(priority, milestone, task);
  return composeLinkHref(draft, { task: first, priority: start.priority, step: start.priority_step, plan: start.plan });
}

/**
 * What Start on a milestone opens, as both apps open it: the brief (the
 * milestone, its open tasks, its plan, and how to read the priority's
 * current detail), the first open task, and what the session is linked to
 * at creation (createSession's SessionStart: priority, milestone, plan).
 */
export function milestoneStart(
  priority: Pick<PriorityRow, "short_id"> & { plan?: StartPlan },
  milestone: { step: Pick<PriorityStep, "key" | "title" | "refs">; plan?: StartPlan },
  task: (shortId: string) => StartTask | undefined,
): { draft: string; task?: string; start: { priority: string; priority_step: string; plan?: string } } {
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
  return { draft, task: open[0]?.id, start: { priority: pri, priority_step: milestone.step.key, ...(plan ? { plan } : {}) } };
}

const shortDate = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** A priority's page, open at one of its milestones (PriorityPage reads `milestone`). */
export function milestoneHref(shortId: string, stepKey: string): string {
  return `${priorityHref(shortId)}?milestone=${encodeURIComponent(stepKey)}`;
}

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
  const planSig = (p: PriorityPlanRef | null | undefined) => (p ? `${p.short_id}.${p.title}.${p.done}/${p.total}/${p.size}` : "");
  const links = (r.links ?? []).map((l) => [
    l.key, l.correction_pending ? 1 : 0, l.looks_done ? 1 : 0, l.sessions_more, planSig(l.plan), l.part_of.map(planSig).join("+"),
    l.sessions.map((x) => `${x.conversation_id}.${x.short_id}.${x.state}.${x.mine ? 1 : 0}.${x.workflow ? 1 : 0}.${x.title}.${x.last_active_at}`).join(";"),
  ].join(":")).join(",");
  const plan = planSig(r.plan);
  return [r.rank, r.person_pos, r.ai_rank, r.status, r.title, r.summary, r.serves, r.done_at, r.last_active_at, r.owner, r.correction_pending, steps, sessions, links, plan].join("|");
}

/** The person's controls, as the page hands them to its rows. */
export type PriorityWrites = {
  move: (shortId: string, to: PriorityMove) => void;
  setStepTier: (shortId: string, stepKey: string, tier: PriorityStepTier) => void;
  setAside: (shortId: string) => void;
  restore: (shortId: string) => void;
  setStepDone: (shortId: string, stepKey: string, done: boolean) => void;
  renameStep: (shortId: string, stepKey: string, title: string) => void;
  dropStep: (shortId: string, stepKey: string) => void;
  markDone: (shortId: string) => void;
  merge: (shortId: string, into: string) => void;
  /** A session (its short id) from the priority it shows on to a priority and a milestone of it, or none. */
  moveSession: (session: string, from: string, to: string, stepKey: string | null) => void;
  sessionNotThis: (session: string, from: string) => void;
  correct: (shortId: string, text: string, stepKey: string | null) => void;
  deleteCorrection: (correctionId: string) => void;
};

/**
 * A write whose paint the server may refuse: runs it, and on a refusal puts
 * the rows as they were before it back and reports the server's reason. Any
 * other failure is a write still on its way (the outbox retries it), so its
 * paint stays.
 */
export async function writeOrRestore<T>(
  write: () => Promise<unknown>,
  before: T,
  restore: (rows: T) => void,
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
