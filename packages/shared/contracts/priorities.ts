// Priorities (design doc s97c8407b2g6brbrbf6mz93n298jxjn0): what one person is
// driving at for a day to a month, inferred from their own sessions by a pass
// that follows their work. A priority is a lens over existing work, not work
// itself: it points up to at most one company goal (`serves`, an initiative)
// and down, through its milestones (stored as `steps`), at tasks, sessions,
// PRs and commits. One level only, and never across workspaces. The person's
// own settings always win over the pass, enforced where the pass writes
// (priorityPassRun applyPlan): a placed rank; a milestone's tier, title, done state and
// drop; a priority's set aside, done and merge; a session's move and "not
// this". The person's corrections are read by every later pass.

/**
 * A `cast state --serves` hint, "pri-N" or "pri-N/sK" (any case), normalized;
 * null when it is neither. The pass reads it as a hint and nothing links by it.
 */
export function parseServesHint(raw: string): string | null {
  const ref = raw.trim().toLowerCase();
  return /^pri-\d+(\/s\d+)?$/.test(ref) ? ref : null;
}

export type PriorityStatus = "active" | "done" | "quiet" | "set_aside" | "merged";
export const PRIORITY_STATUSES: PriorityStatus[] = ["active", "done", "quiet", "set_aside", "merged"];

/** Critical path = the 80/20 that makes the priority done; polish = follow-ups and nice-to-haves. */
export type PriorityStepTier = "critical" | "polish";

/** Who last decided a field the person can also set. The pass never overwrites "person". */
export type PrioritySetBy = "pass" | "person";

export type PriorityRankSource = "person" | "ai";

export type PriorityRefKind = "task" | "session" | "pr" | "commit";
/**
 * task: a task short id ("ct-123"); session: a conversation short id or _id;
 * pr: "owner/repo#N"; commit: "owner/repo@sha".
 */
export type PriorityRef = { kind: PriorityRefKind; id: string };

/** A milestone (stored as a step). */
export type PriorityStep = {
  /** Stable within its priority across passes ("s1", "s2", …). */
  key: string;
  title: string;
  /** "person" once the person renamed it. */
  title_set_by?: PrioritySetBy;
  tier: PriorityStepTier;
  tier_set_by: PrioritySetBy;
  refs: PriorityRef[];
  /** Computed: every referenced task done; with no task, judged by the pass from its sessions and PRs. The person's call, once made, stands. */
  done: boolean;
  done_at?: number;
  /** "person" once the person marked it done or not done; "evidence" once a done pin naming it closed it. The pass changes neither. */
  done_set_by?: PrioritySetBy | "evidence";
  /**
   * The person dropped it: a tombstone kept in the row so the pass neither
   * proposes it again nor adds a new one repeating its title (the same words,
   * lib/priorityPass repeatsDropped; a paraphrase is left to the prompt).
   * Reads never return a dropped milestone.
   */
  dropped?: boolean;
};

/** The shape a pass may propose for one priority. Ids it did not mint are existing priorities' short ids. */
export type PriorityProposal = {
  /** An existing priority's short id ("pri-12") to update, or absent to create one. */
  short_id?: string;
  title: string;
  /** One plain line on where it stands now. */
  summary: string;
  status: Exclude<PriorityStatus, "merged">;
  /** Short ids of existing priorities this one absorbs (they become status "merged"). */
  merges?: string[];
  /** An initiative short id ("in-5") it serves, or null for maintenance, workflow or personal work. */
  serves: string | null;
  /** Proposed position among the person's active priorities (1 = first); a priority the person placed keeps its place whatever this says. */
  rank: number;
  steps: Array<{ key?: string; title: string; tier: PriorityStepTier; refs: PriorityRef[]; done_judged?: boolean }>;
  /** Conversation short ids the pass maps to this priority, each with the step it serves (a step key or title). */
  sessions: Array<{ session: string; step?: string }>;
};

export type PriorityPassOutput = {
  priorities: PriorityProposal[];
  /** Sessions that belong to no priority: standing roles (recurring duties) and one-offs. */
  unassigned: Array<{ session: string; kind: "standing" | "one_off" }>;
};

/** The pinned-state line a mapped session shows. */
export type PriorityPinLine = {
  short_id: string;
  title: string;
  rank: number | null;
  critical_done: number;
  critical_total: number;
  step_title?: string;
};

// ── What the priorities API returns (convex/priorities.ts) ──

/** A session mapped to a priority, as the reader may open it. */
export type PrioritySession = {
  short_id: string;
  title: string;
  step_key: string | null;
  updated_at: number;
  /** The person moved it here: the pass never moves it. */
  set_by_person?: boolean;
};

/** One priority as a list, a write's echo and `cast priorities --json` return it. */
export type PriorityRow = {
  _id: string;
  short_id: string;
  title: string;
  summary: string;
  status: PriorityStatus;
  /** Its position among the owner's active priorities in its workspace (null unless active): priorityPositions over the rows' keys. */
  rank: number | null;
  /** Where the person placed it, on one scale with ai_rank (null until they move it). */
  person_pos: number | null;
  /** Where the pass slotted it, on the same scale (read only while it is not placed). */
  ai_rank: number | null;
  /** "person": they placed it ("you placed it"); "ai": the pass did ("ranked by AI"). */
  rank_source: PriorityRankSource;
  /** "person" when the person marked it done or merged it: the pass leaves its status alone. */
  status_set_by: PrioritySetBy;
  serves: string | null;
  steps: PriorityStep[];
  counts: { critical_done: number; critical_total: number };
  workspace: string;
  user_id: string;
  owner: string;
  mine: boolean;
  first_seen_at: number;
  last_active_at: number;
  done_at: number | null;
  /** Mapped sessions the reader can open, counted among the newest read (50 in a list, 200 in `show`). */
  session_count: number;
  /** More sessions were mapped than were read: show the count as "50+". */
  session_count_more: boolean;
  /** The newest of them: three in a list, every one read in `show`. */
  sessions: PrioritySession[];
  /** The owner wrote a correction no pass has read yet (always false for a teammate). */
  correction_pending: boolean;
  /** Links per step (priorityDerive): a list carries them on the viewer's own active rows only, `show` on every priority; absent from a server that predates them. */
  links?: PriorityMilestoneLinks[];
  /** The plan holding tasks from at least half the task-bearing steps (attributePlans); absent as above. */
  plan?: PriorityPlanRef | null;
};

/** A correction the person wrote on a priority or one of its milestones: every later pass reads it until it is deleted. */
export type PriorityCorrection = {
  _id: string;
  /** The milestone it is about, if any. */
  step_key: string | null;
  text: string;
  /** "applied" once a pass that read it succeeded. */
  status: "pending" | "applied";
  created_at: number;
};

/**
 * A session's state on the list, in the inbox's words. The server reads it
 * off the conversation alone (no liveness), so it never says "working"; a
 * client holding the session's inbox row lays the inbox's own verdict over it.
 */
export type PrioritySessionState = "needs_you" | "working" | "dormant" | "idle" | "done" | "killed";

/** Why a session counts as working a step: the pass mapped it, a step ref names it, a task of the step ("via ct-12"), or the step's plan. */
export type PriorityLinkWhy = "mapped" | "linked" | `via ${string}`;

export type PriorityLinkedSession = {
  short_id: string;
  conversation_id: string;
  title: string;
  state: PrioritySessionState;
  /** The viewer's own (or co-owned): only these ask the viewer anything; another's needs-you reads idle. */
  mine: boolean;
  /** A step a workflow run spawned, not a session a person drives. */
  workflow: boolean;
  why: PriorityLinkWhy[];
  /** Its last activity, to the 10 minutes (a heartbeat leaves the list's answer as it was). */
  last_active_at: number;
};

export type PriorityPlanRef = { short_id: string; title: string; done: number; total: number; size: number };

/** One step's links as a list row carries them. */
export type PriorityMilestoneLinks = {
  key: string;
  /** Best first (priorityDerive orderSessions), at most a handful. */
  sessions: PriorityLinkedSession[];
  /** Linked sessions past those shown. */
  sessions_more: number;
  /** Its own plan (never the priority's), and the big plans it is part of. */
  plan: PriorityPlanRef | null;
  part_of: PriorityPlanRef[];
  /** Still open, but every task it names is done: "Looks done?". */
  looks_done: boolean;
  /** A correction on this milestone waits for the next pass. */
  correction_pending: boolean;
};

/** A list answer: the rows, what it left out, and when the viewer's pass in the listed workspace runs. */
export type PriorityList = {
  priorities: PriorityRow[];
  /** The viewer's own past the newest read were left out. */
  own_truncated: boolean;
  /** Teammates' past the most recently active judged were left out. */
  teammates_truncated: boolean;
  /** How far the viewer's pass here lags now (now − its cursor); null before its first run or with no workspace named. */
  behind_by_ms: number | null;
  /** When the next pass here runs: now while one runs, else the one the viewer's activity scheduled; null when none is pending or no workspace is named. */
  next_pass_at: number | null;
};

/** One priority with every step's sessions (`show`). */
export type PriorityDetail = Omit<PriorityRow, "steps"> & {
  steps: Array<PriorityStep & { sessions: PrioritySession[] }>;
  /** Mapped sessions whose step is unknown or gone. */
  other_sessions: PrioritySession[];
  /** The owner's corrections, newest first (empty for a teammate). */
  corrections: PriorityCorrection[];
};

/** Typed messages per local day: one lane per priority, and "unassigned" for sessions no priority holds. */
export type PriorityHistoryLane = {
  key: string;
  short_id: string | null;
  title: string;
  status: PriorityStatus | null;
  /** The priority owner's typing per day (the reader's own lanes: theirs). */
  counts: number[];
  total: number;
  /** The owner's name, on a teammate's lane. */
  owner?: string;
  /** The owner's share of the read ran out; the oldest days may be short. */
  truncated?: boolean;
};
export type PriorityHistory = {
  days: string[];
  lanes: PriorityHistoryLane[];
  /** Per session short id, the same daily counts: only sessions a priority lane above holds, and the reader can open. */
  sessions?: Record<string, number[]>;
  /** The viewer's sessions typed into today that no priority holds (the unassigned lane's today), newest first. */
  unassigned_today?: PriorityLooseSession[];
};

export type PriorityLooseSession = { short_id: string; conversation_id: string; title: string; last_active_at: number; count: number };

// ── Rank: relative to the priorities the person placed ──

/**
 * What the order reads off a priority. `rank` and `rank_set_by` are the
 * absolute rank relative rank replaced, read only until the backfill
 * (convex priorityRankBackfill) rewrites a row: a rank the person set counts
 * as placed, so nothing they ordered before it ran loses its place.
 */
export type PriorityOrderRow = { status: PriorityStatus; person_pos?: number | null; ai_rank?: number | null; rank?: number | null; rank_set_by?: PrioritySetBy | null; last_active_at: number };

/** A priority's place on the one scale: the person's (person_pos, else a rank they set that the backfill has not rewritten yet), else the pass's (ai_rank, else its old rank), else none. */
const orderKey = (r: PriorityOrderRow): number | null => r.person_pos ?? (r.rank_set_by === "person" ? r.rank : null) ?? r.ai_rank ?? r.rank ?? null;

/** The person placed it: a person_pos, or an absolute rank they set that the backfill has not rewritten yet. */
const isPlaced = (r: PriorityOrderRow): boolean => r.person_pos != null || (r.rank_set_by === "person" && r.rank != null);

export const rankSourceOf = (r: PriorityOrderRow): PriorityRankSource => (isPlaced(r) ? "person" : "ai");

/** By place on the scale, the placed one first on a tie, then the most recently active; no place last. */
const byPlace = (a: PriorityOrderRow, b: PriorityOrderRow) =>
  (orderKey(a) ?? Infinity) - (orderKey(b) ?? Infinity) || Number(isPlaced(b)) - Number(isPlaced(a)) || b.last_active_at - a.last_active_at;

/**
 * One person's priorities in one workspace, the active ones in the order they
 * show. A priority the person placed keeps its place among the others they
 * placed (person_pos); one they did not sits where the pass slotted it
 * between them (ai_rank, on the same scale). On a tie the placed one goes
 * first, then the most recently active; one with neither key goes last. The
 * one order list, pin line, CLI and web all read.
 */
export function effectivePriorityOrder<T extends PriorityOrderRow>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.status === "active").sort(byPlace);
}

/** Each active priority's position (1 = first) among its owner's active ones in its workspace, by `id`. `rows` holds every active priority of each owner and workspace it covers. */
export function priorityPositions<T extends PriorityOrderRow & { user_id: string; workspace: string }>(rows: Iterable<T>, id: (r: T) => string): Map<string, number> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = `${r.user_id}|${r.workspace}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out = new Map<string, number>();
  for (const g of groups.values()) effectivePriorityOrder(g).forEach((r, i) => out.set(id(r), i + 1));
  return out;
}

/** The pass's place for a priority that comes back active (a restore): after every active one, so no active priority is ever without a place. */
export function lastPriorityKey(rows: readonly PriorityOrderRow[]): number {
  return Math.max(0, ...rows.filter((r) => r.status === "active").map((r) => orderKey(r) ?? 0)) + 1;
}

export type PriorityPlacement<T> = { row: T; person_pos?: number; ai_rank?: number };

/**
 * The person moves `row` to position `to` (clamped) among the active ones of
 * `rows`, every priority of its owner in one workspace whatever its status:
 * its person_pos goes between its new neighbours' places. When a neighbour
 * has no place, or the two are too close to fit one between, every priority
 * with a place (quiet, done and set aside too, so one that comes back lands
 * where it was) and every active one is renumbered in place order, the moved
 * one at its new place: the placed ones' person_pos, the others' ai_rank, so
 * nothing else moves.
 */
export function placePriority<T extends PriorityOrderRow>(rows: readonly T[], row: T, to: number): Array<PriorityPlacement<T>> {
  const others = effectivePriorityOrder(rows).filter((r) => r !== row);
  const at = Math.max(0, Math.min(others.length, Math.round(to) - 1));
  const lo = at > 0 ? orderKey(others[at - 1]) : undefined;
  const hi = at < others.length ? orderKey(others[at]) : undefined;
  let pos: number | null = null;
  if (lo === undefined && hi === undefined) pos = 1;
  else if (lo === undefined) pos = hi === null ? null : hi! - 1;
  else if (hi === undefined) pos = lo === null ? null : lo + 1;
  else if (lo !== null && hi !== null) {
    const mid = (lo + hi) / 2;
    pos = lo < mid && mid < hi ? mid : null;
  }
  if (pos !== null) return [{ row, person_pos: pos }];
  const order = rows.filter((r) => r !== row && (orderKey(r) !== null || r.status === "active")).sort(byPlace);
  order.splice(at < others.length ? order.indexOf(others[at]) : order.indexOf(others[at - 1]) + 1, 0, row);
  return order.map((r, i) => (r === row || isPlaced(r) ? { row: r, person_pos: i + 1 } : { row: r, ai_rank: i + 1 }));
}
