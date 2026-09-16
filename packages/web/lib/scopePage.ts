// Pure rules the scope page paints from (docs/architecture/scopes-and-feed.md
// F3): a standing agent's state in role words, the colour a feed row's state
// earns, which feed links the SPA does not own, and which scope a role's
// queries read. Kept out of the components so they test without React.
import type { WorkState } from "@codecast/shared/contracts";
import { isNonTabRoute } from "./tabRoutes";
import { ORG_STATE_META } from "../components/org/orgMeta";
import type { FeedKind } from "../components/org/scope/scopeTypes";
import type { OrgRole, OrgTree } from "../components/org/orgTypes";

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

/** One honest line for a per view query that will not answer. */
export function queryProblem(error: Error | undefined, missing: boolean, what: string): string | null {
  if (!error) return null;
  if (missing) return `${what} is not available on this backend yet.`;
  const line = (error.message ?? "").replace(/^\[Request ID: [^\]]+\] Server Error\s*/i, "").split("\n")[0].trim();
  return line ? `${what} did not load: ${line}` : `${what} did not load.`;
}
