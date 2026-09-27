// Who owns a piece of work, and who leads a project (docs/architecture/
// org-staffing.md S26, org-roles-run-work.md R4). ONE rule, read by the
// server (takeover, the line, task routing, org health), the analyzer
// (`cast org init`) and the web (ProjectLeadChip, the scope view), so no two
// surfaces name a different owner for the same work.
//
// Work belongs to the most specific live role that covers it (ownerOf):
// - a role whose scope names the work's plan, over
// - a role whose scope names the work's project, over
// - a role whose scope is the whole workspace (no projects, no plans), which
//   owns only what no narrower role covers.
// A child's scope sits inside its parent's (scopes-and-feed.md F1), so a head
// of engineering and the platform lead under it both list Platform. Among
// roles at the same depth the one closest to the work owns it: a role that
// another match reports up to, at any depth, steps aside. Only roles on
// separate lines can tie, and then they watch the work together. Among roles
// with no scope the root owns the remainder, never a role under it.
//
// A project's lead (projectLeadOf) is the role the project names
// (`owner_role_id`), else the owner of the project by the rule above. A
// retired role owns nothing: a project that still names one falls through to
// the rule, the way the owner chip already reads it.
//
// Pure, generic over the caller's own role rows (a Convex doc, the web's
// OrgRole, the analyzer's input), and ids are compared as strings so an
// `Id<"org_roles">` and its string form agree.

export type LeadProject = { _id: unknown; owner_role_id?: unknown };

export type LeadRole = {
  _id: unknown;
  status?: string;
  scope?: { project_ids?: readonly unknown[]; plan_ids?: readonly unknown[] } | null;
  reports_to?: { kind: string; role_id?: unknown } | null;
};

export type ProjectLead<R> =
  /** `by` says why: the project names the role, the role's scope lists it, or
   *  the role looks after the whole workspace and no narrower role covers it. */
  | { kind: "lead"; role: R; by: "owner" | "scope" | "workspace" }
  /** Two or more roles list the project and it names none of them. */
  | { kind: "watchers"; roles: R[] }
  | { kind: "none" };

const MAX_DEPTH = 32;

const live = (r: LeadRole) => r.status !== "retired";

export function scopeListsProject(role: LeadRole, projectId: unknown): boolean {
  const id = String(projectId);
  return (role.scope?.project_ids ?? []).some((p) => String(p) === id);
}

const scopeListsPlan = (role: LeadRole, planId: unknown) => (role.scope?.plan_ids ?? []).some((p) => String(p) === String(planId));

export const isWholeWorkspaceRole = (r: LeadRole) => (r.scope?.project_ids ?? []).length === 0 && (r.scope?.plan_ids ?? []).length === 0;

/** A piece of work as the rule reads it: the plan it is filed under and the
 *  project it belongs to (a plan's own project when the work names none).
 *  Work under neither is covered by a whole workspace role alone. */
export type OwnedWork = { project_id?: unknown; plan_id?: unknown };

export type WorkOwner<R> = { kind: "owner"; role: R } | { kind: "watchers"; roles: R[] } | { kind: "none" };

/** How specifically `role` covers `work`: 2 names its plan, 1 names its
 *  project, 0 is the whole workspace, -1 does not cover it. */
export function coverDepth(role: LeadRole, work: OwnedWork): number {
  if (work.plan_id && scopeListsPlan(role, work.plan_id)) return 2;
  if (work.project_id && scopeListsProject(role, work.project_id)) return 1;
  return isWholeWorkspaceRole(role) ? 0 : -1;
}

/** The most specific live role covering `work` (S26). */
export function ownerOf<R extends LeadRole>(work: OwnedWork, roles: readonly R[] | null | undefined): WorkOwner<R> {
  if (!roles) return { kind: "none" };
  let best = -1;
  let matches: R[] = [];
  for (const r of roles) {
    if (!live(r)) continue;
    const d = coverDepth(r, work);
    if (d < 0 || d < best) continue;
    if (d > best) { best = d; matches = []; }
    matches.push(r);
  }
  if (matches.length <= 1) return matches[0] ? { kind: "owner", role: matches[0] } : { kind: "none" };

  // Walk each match's chain once. On a named area the role closest to the
  // work owns it: every match another one reports up to steps aside. On the
  // whole workspace it is the other way round: the root's view is the
  // company's, so a role with no scope under another one with no scope owns
  // nothing of the remainder.
  const byId = new Map(roles.map((r) => [String(r._id), r]));
  const ids = new Set(matches.map((r) => String(r._id)));
  const above = new Set<string>();
  const under = new Set<string>();
  for (const r of matches) {
    let cur: LeadRole | undefined = r;
    const seen = new Set<string>();
    for (let depth = 0; cur && depth < MAX_DEPTH; depth++) {
      const parentId: string | null = cur.reports_to?.kind === "role" && cur.reports_to.role_id ? String(cur.reports_to.role_id) : null;
      if (!parentId || seen.has(parentId)) break;
      seen.add(parentId);
      if (ids.has(parentId) && parentId !== String(r._id)) { above.add(parentId); under.add(String(r._id)); }
      cur = byId.get(parentId);
    }
  }
  const closest = matches.filter((r) => !(best === 0 ? under : above).has(String(r._id)));
  // A cycle in a corrupt chain could put every match above another; fall
  // back to the matches as they stand rather than naming no one.
  const watchers = closest.length ? closest : matches;
  return watchers.length === 1 ? { kind: "owner", role: watchers[0] } : { kind: "watchers", roles: watchers };
}

/** True when `role` is the one owner of `work` by the rule. */
export const ownsWork = (role: LeadRole, work: OwnedWork, roles: readonly LeadRole[]): boolean => {
  const o = ownerOf(work, roles);
  return o.kind === "owner" && String(o.role._id) === String(role._id);
};

export function projectLeadOf<R extends LeadRole>(project: LeadProject | null | undefined, roles: readonly R[] | null | undefined): ProjectLead<R> {
  if (!project || !roles) return { kind: "none" };
  if (project.owner_role_id) {
    const owner = roles.find((r) => live(r) && String(r._id) === String(project.owner_role_id));
    if (owner) return { kind: "lead", role: owner, by: "owner" };
  }
  const o = ownerOf({ project_id: project._id }, roles);
  if (o.kind === "owner") return { kind: "lead", role: o.role, by: isWholeWorkspaceRole(o.role) ? "workspace" : "scope" };
  // Whole workspace roles on separate lines tie on everything nobody listed:
  // that is no claim on this project, so nobody leads it.
  if (o.kind === "watchers" && !isWholeWorkspaceRole(o.roles[0])) return o;
  return { kind: "none" };
}

/** What naming `role` the lead of `project` does to the role's scope. The
 *  server acts on this answer and the web says it in the same breath, so the
 *  person is told both things by the one gesture:
 *  - `add`: the scope does not list the project, so it is added.
 *  - `listed`: it is already there; only the lead changes.
 *  - `whole_workspace`: the role already looks after everything. Adding one
 *    project would NARROW it to that project, so nothing is added.
 *  - `outside_parent`: the role reports to a role that does not look after
 *    the project, and a scope sits inside its parent's (F1). The lead is still
 *    set; the scope waits for the parent's. */
export type LeadScopeChange<R> = { kind: "add" } | { kind: "listed" } | { kind: "whole_workspace" } | { kind: "outside_parent"; parent: R };

export function leadScopeChange<R extends LeadRole>(projectId: unknown, role: R, roles: readonly R[]): LeadScopeChange<R> {
  if (isWholeWorkspaceRole(role)) return { kind: "whole_workspace" };
  if (scopeListsProject(role, projectId)) return { kind: "listed" };
  const parentId = role.reports_to?.kind === "role" && role.reports_to.role_id ? String(role.reports_to.role_id) : null;
  const parent = parentId ? roles.find((r) => String(r._id) === parentId) : undefined;
  if (parent && !isWholeWorkspaceRole(parent) && !scopeListsProject(parent, projectId)) return { kind: "outside_parent", parent };
  return { kind: "add" };
}

/** "two roles watch this", "3 roles watch this": the words every surface says. */
export function watchersLabel(count: number): string {
  return `${count === 2 ? "two" : count} roles watch this`;
}

/** The projects that need the analyzer's eye: several roles list them and
 *  they name no owner. One line each in the analyzer's inputs. */
export function projectsWithoutAnOwnerAmongWatchers<P extends LeadProject, R extends LeadRole>(projects: readonly P[], roles: readonly R[]): Array<{ project: P; roles: R[] }> {
  const out: Array<{ project: P; roles: R[] }> = [];
  for (const project of projects) {
    const lead = projectLeadOf(project, roles);
    if (lead.kind === "watchers") out.push({ project, roles: lead.roles });
  }
  return out;
}
