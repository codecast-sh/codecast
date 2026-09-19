// An initiative (docs/architecture/initiatives-projects-role-page.md I1): a
// goal the company is trying to reach, carried by an intentional set of
// projects, with one owner who drives it. ONE definition of its values and its
// synced row, read by the server validators (convex/initiatives.ts), the CLI
// (`cast initiative`) and the web store, so no two surfaces name a different
// status or health.
//
// The row is raw. Everything a page shows beside it is derived at render from
// the store: progress (tasks done over tasks in its projects), each project's
// lead (contracts/orgLead.ts), the owner's face and name, and sub initiatives
// (rows whose `parent_initiative_id` names this one).

export const INITIATIVE_STATUSES = ["proposed", "planned", "active", "completed", "cancelled"] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

/** What an update may say. `none` is the row's value before any update exists. */
export const INITIATIVE_UPDATE_HEALTHS = ["on_track", "at_risk", "off_track"] as const;
export type InitiativeUpdateHealth = (typeof INITIATIVE_UPDATE_HEALTHS)[number];
export type InitiativeHealth = "none" | InitiativeUpdateHealth;
export const INITIATIVE_HEALTHS = ["none", ...INITIATIVE_UPDATE_HEALTHS] as const;

export const INITIATIVE_STATUS_LABEL: Record<InitiativeStatus, string> = {
  proposed: "Proposed",
  planned: "Planned",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const INITIATIVE_HEALTH_LABEL: Record<InitiativeHealth, string> = {
  none: "No update",
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
};

/** A person or a role: roles are colleagues (org-roles-run-work.md R5). */
export type InitiativeOwner =
  | { kind: "user"; user_id: string }
  | { kind: "role"; role_id: string };

/** Who wrote an update: a person, or a role through its standing session. */
export type InitiativeUpdateAuthor =
  | { kind: "user"; user_id: string }
  | { kind: "role"; role_id: string; conversation_id?: string };

export type InitiativePriority = "p0" | "p1" | "p2" | "p3";

export type InitiativeRow = {
  _id: string;
  /** "in-N". */
  short_id: string;
  /** The optimistic stub's own key; the server row carrying it supersedes the stub. */
  client_key?: string;
  title: string;
  /** Purpose, scope and context. */
  description?: string;
  status: InitiativeStatus;
  /** Absent means nobody drives it, which is the first finding of a review. */
  owner?: InitiativeOwner;
  target_date?: number;
  priority?: InitiativePriority;
  labels?: string[];
  /** Project ids in the order the owner arranged them. A project may sit in several initiatives. */
  project_ids: string[];
  /** One level of nesting: a row that has a parent is never a parent itself. */
  parent_initiative_id?: string;
  /** Copied from the latest update when it is posted; `none` before one exists. */
  health: InitiativeHealth;
  /** When the latest update was posted, so a list shows the date with no updates loaded. */
  health_at?: number;
  latest_update_id?: string;
  /** ACCESS. */
  workspace: string;
  /** ROUTING. */
  team_id?: string;
  /** Who created it. Named `user_id` because the access stamp reads that field on every table. */
  user_id: string;
  created_at: number;
  updated_at: number;
};

export type InitiativeUpdateRow = {
  _id: string;
  client_key?: string;
  initiative_id: string;
  body: string;
  health: InitiativeUpdateHealth;
  by: InitiativeUpdateAuthor;
  at: number;
  workspace: string;
  user_id: string;
};

/** Reads `in-7`, `IN-7` and a bare `7` as the short id; anything else is returned untouched (a Convex id). */
export function normalizeInitiativeRef(ref: string): string {
  const t = (ref || "").trim();
  if (/^\d+$/.test(t)) return `in-${t}`;
  return /^in-\d+$/i.test(t) ? t.toLowerCase() : t;
}
