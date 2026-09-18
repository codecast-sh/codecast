// Who leads a project (docs/architecture/org-roles-run-work.md R4). ONE rule,
// read by the server (org.ts, orgHealth), the analyzer (`cast org init`) and
// the web (ProjectLeadChip, the scope view), so no two surfaces name a
// different lead for the same project.
//
// 1. The role the project names (`owner_role_id`) leads it.
// 2. Else the one role whose scope lists the project leads it.
// 3. Else, when several roles' scopes list it, nobody leads it yet: they
//    watch it, and the next review proposes the owner.
//
// Three readings a person would expect, made explicit:
// - A retired role leads nothing. A project that still names one falls
//   through to its scope, the way the owner chip already reads it.
// - A whole workspace scope (no projects, no plans) is the root's view of
//   everything, never a claim on one project.
// - A child's scope sits inside its parent's (scopes-and-feed.md F1), so a
//   head of engineering and the platform lead under it both list Platform.
//   The role closest to the work leads: a role that another match reports up
//   to, at any depth, steps aside. Only roles on separate lines can tie.
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
  /** `by` says why: the project names the role, or the role's scope lists it. */
  | { kind: "lead"; role: R; by: "owner" | "scope" }
  /** Two or more roles list the project and it names none of them. */
  | { kind: "watchers"; roles: R[] }
  | { kind: "none" };

const MAX_DEPTH = 32;

const live = (r: LeadRole) => r.status !== "retired";

export function scopeListsProject(role: LeadRole, projectId: unknown): boolean {
  const id = String(projectId);
  return (role.scope?.project_ids ?? []).some((p) => String(p) === id);
}

export function projectLeadOf<R extends LeadRole>(project: LeadProject | null | undefined, roles: readonly R[] | null | undefined): ProjectLead<R> {
  if (!project || !roles) return { kind: "none" };
  const liveRoles = roles.filter(live);
  if (project.owner_role_id) {
    const owner = liveRoles.find((r) => String(r._id) === String(project.owner_role_id));
    if (owner) return { kind: "lead", role: owner, by: "owner" };
  }
  const listed = liveRoles.filter((r) => scopeListsProject(r, project._id));
  if (listed.length <= 1) return listed[0] ? { kind: "lead", role: listed[0], by: "scope" } : { kind: "none" };

  // Drop every role that another match reports up to.
  const byId = new Map(roles.map((r) => [String(r._id), r]));
  const above = new Set<string>();
  for (const r of listed) {
    let cur: LeadRole | undefined = r;
    for (let depth = 0; cur && depth < MAX_DEPTH; depth++) {
      const parentId: string | null = cur.reports_to?.kind === "role" && cur.reports_to.role_id ? String(cur.reports_to.role_id) : null;
      if (!parentId || above.has(parentId)) break;
      above.add(parentId);
      cur = byId.get(parentId);
    }
  }
  const closest = listed.filter((r) => !above.has(String(r._id)));
  // A cycle in a corrupt chain could put every match above another; fall
  // back to the matches as they stand rather than naming no one.
  const watchers = closest.length ? closest : listed;
  return watchers.length === 1 ? { kind: "lead", role: watchers[0], by: "scope" } : { kind: "watchers", roles: watchers };
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
