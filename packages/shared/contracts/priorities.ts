// Priorities (design doc s97c8407b2g6brbrbf6mz93n298jxjn0): what one person is
// driving at for a day to a month, inferred from their own sessions by a pass
// that follows their work. A priority is a lens over existing work, not work
// itself: it points up to at most one company goal (`serves`, an initiative)
// and down, through its steps, at tasks, sessions, PRs and commits. One level
// only, and never across workspaces. The person's own settings (rank, a step's
// tier, set aside) always win over the pass.

export type PriorityStatus = "active" | "done" | "quiet" | "set_aside" | "merged";
export const PRIORITY_STATUSES: PriorityStatus[] = ["active", "done", "quiet", "set_aside", "merged"];

/** Critical path = the 80/20 that makes the priority done; polish = follow-ups and nice-to-haves. */
export type PriorityStepTier = "critical" | "polish";

/** Who last decided a field the person can also set. The pass never overwrites "person". */
export type PrioritySetBy = "pass" | "person";

export type PriorityRefKind = "task" | "session" | "pr" | "commit";
/**
 * task: a task short id ("ct-123"); session: a conversation short id or _id;
 * pr: "owner/repo#N"; commit: "owner/repo@sha".
 */
export type PriorityRef = { kind: PriorityRefKind; id: string };

export type PriorityStep = {
  /** Stable within its priority across passes ("s1", "s2", …). */
  key: string;
  title: string;
  tier: PriorityStepTier;
  tier_set_by: PrioritySetBy;
  refs: PriorityRef[];
  /** Computed: every referenced task done; with no task, judged by the pass from its sessions and PRs. */
  done: boolean;
  done_at?: number;
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
  /** Proposed position among the person's active priorities (1 = first); ignored once the person ranked it. */
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
export type PrioritySession = { short_id: string; title: string; step_key: string | null; updated_at: number };

/** One priority as a list, a write's echo and `cast priorities --json` return it. */
export type PriorityRow = {
  _id: string;
  short_id: string;
  title: string;
  summary: string;
  status: PriorityStatus;
  /** Its position among the owner's active priorities in its workspace (null unless active). */
  rank: number | null;
  rank_set_by: PrioritySetBy;
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
};

/** One priority with every step's sessions (`show`). */
export type PriorityDetail = Omit<PriorityRow, "steps"> & {
  steps: Array<PriorityStep & { sessions: PrioritySession[] }>;
  /** Mapped sessions whose step is unknown or gone. */
  other_sessions: PrioritySession[];
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
  /** No counts to show for this lane (the API returns none such since teammates' priorities follow the session list's sharing rule). */
  counts_hidden?: boolean;
  /** The owner's read stopped at its cap; the oldest days may be short. */
  truncated?: boolean;
};
export type PriorityHistory = {
  days: string[];
  lanes: PriorityHistoryLane[];
  /** Per session short id, the same daily counts: only sessions a priority lane above holds, and the reader can open. */
  sessions?: Record<string, number[]>;
};
