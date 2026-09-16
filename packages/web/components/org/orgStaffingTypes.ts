// The staffing contract as the client reads it (docs/architecture/org-staffing.md
// S3, S4). `org.health` and the `org_proposals` rows land in the store in these
// shapes; the pane, the fixture, the model helpers and the store slots agree
// on one definition here.
import type { HealthFlag } from "@codecast/shared/contracts/orgCapacity";
import type { OrgChange, OrgChangeKind, OrgChangeStatus, OrgEvidenceLink, OrgProposalMode } from "@codecast/shared/contracts/orgProposal";

export type { HealthFlag, OrgChange, OrgChangeKind, OrgChangeStatus, OrgEvidenceLink };

// ---------------------------------------------------------------- org.health

export type OrgRoleHealth = {
  role_id: string;
  short_id: string;
  handle: string;
  load: { open_tasks: number; in_flight: number; active_plans: number; live_hands: number; direct_reports: number };
  spend: { wakes_today: number; wakes_7d_avg: number; wakes_cap: number; tokens_today: number; tokens_7d_avg: number; tokens_cap: number; cap_hits_7d: number };
  flow: {
    decisions_7d: number;
    median_recommend_min: number | null;
    escalations_7d: number;
    frames_dropped_7d: number;
    done_7d: number;
    handoffs_7d: { done: number; blocked: number; needs_context: number };
    review_stalls: number;
    sends_7d: { to: { role_id: string; n: number }[]; from: { role_id: string; n: number }[] };
  };
  last_move_at: number | null;
  idle_days: number;
  flags: HealthFlag[];
};

export type OrgPersonHealth = {
  user_id: string;
  direct_roles: number;
  decisions_waiting: { n: number; oldest_min: number };
  flags: HealthFlag[];
};

export type OrgCompanyHealth = {
  unowned_projects: { id: string; title: string }[];
  unfiled_tasks: number;
  plans_without_goal: { id: string; title: string; short_id?: string }[];
  projects_without_charter: { id: string; title: string }[];
  flags: HealthFlag[];
};

export type OrgHealth = {
  roles: OrgRoleHealth[];
  people: OrgPersonHealth[];
  company: OrgCompanyHealth;
  generated_at: number;
};

// ---------------------------------------------------------------- proposals

export type OrgProposalChange = {
  _id: string;
  proposal_id: string;
  seq: number;
  change: OrgChange;
  rationale: string;
  evidence: OrgEvidenceLink[];
  expected_effect?: string;
  risk?: string;
  status: OrgChangeStatus;
  edits?: Record<string, unknown>;
  decided_by?: string;
  decided_at?: number;
  applied_note?: string;
  applied_at?: number;
};

/** Who wrote a proposal (S15). The server stores kind and id; the rest is
 *  what a pill needs and is filled by the server when it enriches, else by
 *  the web from the store (a session row, the org tree's role row). */
export type OrgProposalAuthor = {
  kind: "role" | "session" | "user";
  id: string;
  /** A role's or a person's name; a session's title. */
  name?: string;
  /** "jx7abcd" for a session, "or-N" for a role. */
  short_id?: string;
  /** A session's title, when the server names it apart from `name`. */
  title?: string;
  /** A role's handle and avatar key (orgAvatars). */
  handle?: string;
  avatar?: string;
};

export type OrgProposalRow = {
  _id: string;
  short_id: string;
  team_id?: string;
  scope_user_id?: string;
  author: OrgProposalAuthor;
  title: string;
  summary_md: string;
  mode: OrgProposalMode;
  status: "open" | "resolved" | "withdrawn";
  evidence_doc_id?: string;
  created_at: number;
  resolved_at?: number;
  /** orgProposals.list and get both stamp these. */
  link?: string;
  counts?: { total: number; decided: number; applied: number; failed: number; skipped: number };
  /** The proposal's changes, in seq order: the `orgProposalChanges` store
   *  collection joined by proposal_id (orgProposals.get feeds it). */
  changes: OrgProposalChange[];
};

/** A row as orgProposals.list returns it and the `orgProposals` collection
 *  holds it: the proposal without its changes. */
export type OrgProposalListRow = Omit<OrgProposalRow, "changes">;

/** Join the two collections into the rows the pane reads. */
export function joinProposals(rows: Record<string, OrgProposalListRow>, changes: Record<string, OrgProposalChange>): OrgProposalRow[] {
  const byProposal = new Map<string, OrgProposalChange[]>();
  for (const c of Object.values(changes)) {
    const list = byProposal.get(c.proposal_id) ?? [];
    list.push(c);
    byProposal.set(c.proposal_id, list);
  }
  return Object.values(rows).map((p) => ({ ...p, changes: (byProposal.get(p._id) ?? []).sort((a, b) => a.seq - b.seq) }));
}

/** The handle the chief of staff always carries (S6). */
export const CHIEF_OF_STAFF_HANDLE = "chief-of-staff";
