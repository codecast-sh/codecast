// The org tree contract (docs/architecture/org-roles.md S3). The server query
// `org.tree` returns this shape; the page paints it from the `orgTree` store
// singleton. Types live here so the fixture, the layout, the cards and the
// store slice all agree on one definition.
import type { WorkState } from "@codecast/shared/contracts";
import type { OrgTenureSpec } from "@codecast/shared/contracts/orgProposal";

export type StateCounts = Record<WorkState, number>;

export type OrgSession = {
  _id: string;
  short_id: string;
  title: string;
  agent_type: string;
  state: WorkState;
  updated_at: number;
  owner_user_id?: string;
  org_role_id?: string;
  subagent_count: number;
  is_anchor: boolean;
  project_path?: string;
  git_branch?: string;
};

export type OrgPerson = {
  user_id: string;
  name: string;
  image?: string;
  role: "admin" | "member" | "owner";
  is_me: boolean;
  presence?: "online" | "away" | "offline";
  counts: StateCounts;
  sessions: OrgSession[];
  total: number;
};

export type OrgReportsTo =
  | { kind: "user"; user_id: string }
  | { kind: "role"; role_id: string };

export type OrgScope = { project_ids: string[]; plan_ids: string[] };

/** A standing session's pinned state as the tree carries it: the first line
 *  (what it is working on), the declared status (who acts next: the node's
 *  colour), and when it was written. `state` is the observed work state, absent
 *  when the row fell outside the tree's recency window. */
export type OrgStandingState = {
  state?: WorkState;
  state_line?: string | null;
  state_status?: string | null;
  state_at?: number | null;
};

export type OrgStanding = OrgStandingState & { conversation_id?: string; short_id?: string };

export type OrgRole = {
  _id: string;
  short_id: string;
  scope_type: "team" | "user";
  team_id?: string;
  scope_user_id?: string;
  host_user_id: string;
  name: string;
  handle: string;
  scope: OrgScope;
  reports_to: OrgReportsTo;
  status: "active" | "paused" | "retired";
  charter?: string;
  anchor_id?: string;
  /** Chat channels whose lines ride the role's next wake frame
   *  (docs/architecture/agent-channels.md C1). */
  follow_channel_ids?: string[];
  // The standing agent's documents, autonomy and spend
  // (docs/architecture/org-roles-standing.md T1 to T4); the row's own fields.
  charter_doc_id?: string;
  brief_doc_id?: string;
  trust?: "understand" | "decide" | "direct";
  caps?: { hands_per_day: number; wakes_per_day: number; tokens_per_day: number };
  counters?: { day: string; hands: number; wakes: number; tokens: number };
  coalesce_ms?: number;
  review_backend?: string;
  // Standing or program (org-staffing.md S10); absent = undeclared, drawn as
  // standing. A program's ends carries plan/project ids as strings on the tree.
  tenure?: OrgTenureSpec;
  // The face (org-staffing.md S13): the chosen avatar key, else the default for
  // the handle. org.tree always stamps this through avatarOf, so it is present.
  avatar?: string;
  /** The standing agent this seat replaced, when it was seated fresh (S16):
   *  the old thread is kept, not deleted, and the role's page links it so a
   *  workspace never loses the assistant it had. Rides org.tree on the role
   *  row's own spread. */
  previous_standing_conversation_id?: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  counts: StateCounts;
  sessions: OrgSession[];
  total: number;
  /** The role's standing agent and its pinned state; null when none is provisioned. */
  standing?: OrgStanding | null;
  scope_names: {
    projects: { id: string; title: string; short_id?: string }[];
    plans: { id: string; title: string; short_id: string }[];
  };
};

export type OrgAnchor = OrgStandingState & {
  anchor_id: string;
  name: string;
  bot_user_id: string;
  host_user_id: string;
  /** A role's seat names its role (org-roles-standing.md T1); the workspace
   *  anchor has none. The chart draws a seat inside its role's card, never as
   *  its own node under the host (org-staffing.md S16). */
  org_role_id?: string;
  scope_type: "team" | "user";
  team_id?: string;
  scope_user_id?: string;
  conversation_id?: string;
  short_id?: string;
  status: string;
};

export type OrgTree = {
  workspace: { kind: "team" | "user"; id: string; name: string };
  people: OrgPerson[];
  roles: OrgRole[];
  anchors: OrgAnchor[];
  generated_at: number;
  truncated?: boolean;
};

/** The server's per parent page size (S3 TOP_N). */
export const ORG_TOP_N = 8;

/** A parent a session or role can report to. */
export type OrgParentRef = OrgReportsTo;

export const EMPTY_COUNTS: StateCounts = { working: 0, needs_input: 0, done: 0, dormant: 0, idle: 0 };

/** The order sessions sort in under a parent (S3): who needs a human first. */
export const ORG_STATE_ORDER: WorkState[] = ["needs_input", "working", "dormant", "done", "idle"];

export function sortOrgSessions(list: OrgSession[]): OrgSession[] {
  const rank = new Map(ORG_STATE_ORDER.map((s, i) => [s, i]));
  return [...list].sort((a, b) => {
    const d = (rank.get(a.state) ?? 9) - (rank.get(b.state) ?? 9);
    return d !== 0 ? d : b.updated_at - a.updated_at;
  });
}

export function countStates(list: OrgSession[]): StateCounts {
  const out: StateCounts = { ...EMPTY_COUNTS };
  for (const s of list) out[s.state] = (out[s.state] ?? 0) + 1;
  return out;
}

export function sameParent(a: OrgParentRef | null | undefined, b: OrgParentRef | null | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === "user" ? a.user_id === (b as any).user_id : a.role_id === (b as any).role_id;
}
