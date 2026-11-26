// Priorities (design doc s97c8407b2g6brbrbf6mz93n298jxjn0): what one person is
// driving at for a day to a month, inferred from their own sessions by a pass
// that follows their work. A priority is a lens over existing work, not work
// itself: it points up to at most one company goal (`serves`, an initiative)
// and down, through its milestones (stored as `steps`), at tasks, sessions,
// PRs and commits. One level only, and never across workspaces. The person's
// own settings always win over the pass, enforced where the pass writes
// (priorityPassRun applyPlan): rank; a milestone's tier, title, done state and
// drop; a priority's set aside, done and merge; a session's move and "not
// this". The person's corrections are read by every later pass.

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
  /** "person" once the person marked it done or not done. */
  done_set_by?: PrioritySetBy;
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
  /** Its position among the owner's active priorities in its workspace (null unless active). */
  rank: number | null;
  rank_set_by: PrioritySetBy;
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
  /** A list's links per step (priorityDerive), on the viewer's own active rows only; absent elsewhere and from a server that predates them. */
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
  /** When the next pass here runs: now while one runs, else the next scheduled sweep; null with no workspace named. */
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
