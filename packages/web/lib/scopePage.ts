// Pure rules the scope page paints from (docs/architecture/scopes-and-feed.md
// F3): a standing agent's state in role words, the colour a feed row's state
// earns, which feed links the SPA does not own, and which scope a role's
// queries read. Kept out of the components so they test without React.
import type { WorkState } from "@codecast/shared/contracts";
import { isNonTabRoute } from "./tabRoutes";
import { ORG_STATE_META } from "../components/org/orgMeta";
import type { FeedKind } from "../components/org/scope/scopeTypes";
import type { OrgAnchor, OrgRole, OrgTree } from "../components/org/orgTypes";
import { CHIEF_OF_STAFF_HANDLE } from "../components/org/orgStaffingTypes";

/** The seat a scope page opens on, by the id in its address: a role by short
 *  id or row id, or "workspace" for the root. `anchor` is the seat's anchor
 *  row. The root's standing agent is the workspace anchor no role holds, else
 *  the Chief of Staff's seat (org-staffing.md S16: the workspace's one root
 *  agent is the chief once seated), so the root never offers to create a
 *  second anchor beside the one it has. */
export function scopeSeatOf(tree: OrgTree | null, id: string): { role: OrgRole | null; anchor: OrgAnchor | null } {
  if (!tree) return { role: null, anchor: null };
  const role = id === "workspace" ? null : tree.roles.find((r) => r.short_id === id || r._id === id) ?? null;
  if (role) return { role, anchor: role.anchor_id ? tree.anchors.find((a) => a.anchor_id === role.anchor_id) ?? null : null };
  const roleAnchorIds = new Set(tree.roles.map((r) => r.anchor_id).filter(Boolean));
  const chief = tree.roles.find((r) => r.handle === CHIEF_OF_STAFF_HANDLE && r.status !== "retired" && r.anchor_id);
  return { role: null, anchor: tree.anchors.find((a) => !roleAnchorIds.has(a.anchor_id)) ?? (chief ? tree.anchors.find((a) => a.anchor_id === chief.anchor_id) ?? null : null) };
}

/** Who may reshape a role: an admin of the workspace (every personal
 *  workspace is its owner's), or the role's host. The same rule gates the
 *  scope page's header and settings and the wake card's pause control. */
export function canEditRole(tree: OrgTree | null, role: OrgRole | null | undefined, meId: string | null | undefined): boolean {
  if (!tree || !role) return false;
  const me = tree.people.find((p) => p.is_me) ?? (meId ? tree.people.find((p) => p.user_id === meId) : undefined);
  const isAdmin = me?.role === "admin" || me?.role === "owner" || tree.workspace.kind === "user";
  return isAdmin || role.host_user_id === (me?.user_id ?? meId);
}

/** A standing agent is never "done": between wakes it stands by. The chip
 *  and the stripe say so in role words; the colour is the one work state
 *  table every org surface paints from, so the header stripe matches the
 *  role's node on the org page. */
export type RoleStanding = { label: string; color: string; pulse: boolean };
export function roleStanding(state: WorkState | undefined | null): RoleStanding | null {
  if (!state) return null;
  const color = (ORG_STATE_META[state] ?? ORG_STATE_META.idle).color;
  if (state === "working") return { label: "awake", color, pulse: true };
  if (state === "needs_input") return { label: "needs you", color, pulse: false };
  return { label: "standing by", color, pulse: false };
}

/** Tokens are counted from Claude transcripts only (org-roles-standing.md
 *  T4). When every session the role runs is on another backend, the header
 *  says "uncounted" rather than a zero that reads as "spent nothing". */
export function tokensUncounted(input: { tokens: number; uncounted: number; sessions: number }): boolean {
  return input.tokens === 0 && input.uncounted > 0 && input.uncounted >= input.sessions;
}

const SESSION_TONE: Record<string, string> = {
  needs_input: "var(--sol-yellow)", blocked: "var(--sol-yellow)",
  working: "var(--sol-green)", done: "var(--sol-cyan)", dormant: "var(--sol-blue)",
};
/** The bar colour of a row whose state asks nothing of anyone. */
export const FEED_NEUTRAL_TONE = "color-mix(in srgb, var(--sol-border) 60%, transparent)";

/** Yellow means "a person must act" everywhere else on the org surfaces, so
 *  only a session waiting on input and a pending decision earn it here. An
 *  open task is the neutral border; moving work is green; finished cyan. */
export function feedStateTone(kind: FeedKind, state?: string): string {
  if (!state) return FEED_NEUTRAL_TONE;
  const s = state.toLowerCase();
  if (kind === "session") return SESSION_TONE[s] ?? "var(--sol-text-dim)";
  if (kind === "decision") return s === "pending" ? "var(--sol-yellow)" : s === "answered" ? "var(--sol-cyan)" : "var(--sol-text-dim)";
  // A run row's state starts with the run status ("paused · Ship it?").
  if (kind === "run") {
    if (s.startsWith("running")) return "var(--sol-green)";
    if (s.startsWith("paused")) return "var(--sol-yellow)";
    if (s.startsWith("failed")) return "var(--sol-red)";
    if (s.startsWith("completed")) return "var(--sol-cyan)";
    return FEED_NEUTRAL_TONE;
  }
  if (s === "done" || s === "answered" || s === "completed" || s === "merged") return "var(--sol-cyan)";
  if (s === "in_progress" || s === "active" || s === "working") return "var(--sol-green)";
  if (s === "dropped" || s === "dismissed" || s === "withdrawn") return "var(--sol-red)";
  return FEED_NEUTRAL_TONE;
}

/** A published page (/a/<slug>) is served by the server, not the SPA: the
 *  row must be a plain anchor, or React Router paints a blank pane. */
export function feedLinkIsServerOwned(href: string): boolean {
  return isNonTabRoute(href);
}

/** F1: an empty scope is the whole workspace. The server resolves a role's
 *  empty scope to nothing, so the page names every project for it, the way
 *  it does for the root anchor. */
export type ScopeQueryRef = { role_id: string } | { scope: { project_ids: string[]; plan_ids: string[] }; team_id?: string };
export function scopeQueryRef(
  role: { _id: string; scope: { project_ids: string[]; plan_ids: string[] } } | null,
  projectIds: string[],
  teamId: string | undefined,
): ScopeQueryRef {
  const whole = !role || (role.scope.project_ids.length === 0 && role.scope.plan_ids.length === 0);
  if (!whole) return { role_id: role!._id };
  return { scope: { project_ids: projectIds, plan_ids: [] }, ...(teamId ? { team_id: teamId } : {}) };
}

// ---------------------------------------------------------------- F4: the scope is a conversation

/** F4.3: the panel's Sessions tab groups hands the way the inbox groups
 *  sessions, in the inbox's order. GlobalSessionPanel renders Needs Input,
 *  Done, Working, Dormant, top down as "who acts next": you (a hand waiting on
 *  a person, a finished hand to review), the agent right now, then a machine
 *  wake. Idle rows, which the inbox never renders, close the list so a hand
 *  under the scope is never hidden. A source test keeps this order equal to
 *  the inbox's. */
export const HAND_GROUPS: { state: WorkState; label: string }[] = [
  { state: "needs_input", label: "Needs input" },
  { state: "done", label: "Done" },
  { state: "working", label: "Working" },
  { state: "dormant", label: "Dormant" },
  { state: "idle", label: "Idle" },
];

export type HandGroup<T> = { state: WorkState; label: string; color: string; rows: T[] };

/** Group hands by work state. An empty group is dropped, the way the inbox
 *  drops an empty section. Inside a group the inbox's direction holds: a
 *  queue a person clears reads oldest first (needs input, done); everything
 *  else reads freshest first. */
export function groupHands<T extends { state: WorkState; updated_at: number }>(rows: T[]): HandGroup<T>[] {
  const out: HandGroup<T>[] = [];
  for (const g of HAND_GROUPS) {
    const members = rows.filter((r) => r.state === g.state);
    if (members.length === 0) continue;
    const oldestFirst = g.state === "needs_input" || g.state === "done";
    members.sort((a, b) => (oldestFirst ? a.updated_at - b.updated_at : b.updated_at - a.updated_at));
    out.push({ state: g.state, label: g.label, color: ORG_STATE_META[g.state].color, rows: members });
  }
  return out;
}

/** The task a hand is bound to: the session row's own pointer when the store
 *  has the row, else the task that lists the session among its conversations
 *  (`cast task start` writes both). Null when the hand is bound to nothing. */
export function boundTaskOf<T extends { _id: string; conversation_ids?: string[] }>(
  sessionId: string,
  activeTaskId: string | null | undefined,
  tasks: T[],
): T | null {
  if (activeTaskId) {
    const hit = tasks.find((t) => t._id === activeTaskId);
    if (hit) return hit;
  }
  return tasks.find((t) => t.conversation_ids?.includes(sessionId)) ?? null;
}

/** A task's subtasks as open and closed counts, derived live from the store
 *  (never a stored twin). Null when the task has no subtasks, so the row
 *  shows nothing rather than "0/0". A dropped subtask counts for neither. */
export function subtaskCounts(taskId: string, tasks: Array<{ _id: string; parent_id?: string | null; status: string }>): { open: number; closed: number } | null {
  let open = 0, closed = 0;
  for (const t of tasks) {
    if (t.parent_id !== taskId || t.status === "dropped") continue;
    if (t.status === "done") closed++; else open++;
  }
  return open + closed === 0 ? null : { open, closed };
}

/** One honest line for a per view query that will not answer. */
export function queryProblem(error: Error | undefined, missing: boolean, what: string): string | null {
  if (!error) return null;
  if (missing) return `${what} is not available on this backend yet.`;
  const line = (error.message ?? "").replace(/^\[Request ID: [^\]]+\] Server Error\s*/i, "").split("\n")[0].trim();
  return line ? `${what} did not load: ${line}` : `${what} did not load.`;
}
