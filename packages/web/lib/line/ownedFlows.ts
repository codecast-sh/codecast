// The team's flows that start work by themselves (docs/architecture/flows.md
// FL0): one per role that leads a project. A flow is derived from its owner
// role, never stored on its own: its steps are the graph the role runs
// (`line_workflow_slug`, the shipped one when unset), its intake the projects
// the role leads, its switch the role's start switch, and its decider the
// person the role's reporting line ends at.
import { lineSlugOf } from "@codecast/shared/contracts/lineSlug";
import type { OrgRole } from "../../components/org/orgTypes";
import type { LineAdmission } from "../lineFlow";

export type OwnedFlow = {
  owner: OrgRole;
  /** The projects it takes problems from, by title. */
  projects: Array<{ id: string; title: string }>;
  on: boolean;
  /** The graph its runs walk, by slug. */
  steps: string;
  merge: boolean;
  /** The agent its review step runs on, when set. */
  reviewAgent: string | null;
  /** The person its cards go to: where the owner's reporting line ends. */
  deciderId: string | null;
};

/** The person a role's reporting line ends at, or null when it ends nowhere (a loop, a missing role). */
export function deciderOf(role: Pick<OrgRole, "reports_to">, roles: ReadonlyArray<Pick<OrgRole, "_id" | "reports_to">>): string | null {
  const byId = new Map(roles.map((r) => [r._id, r]));
  const seen = new Set<string>();
  let at: Pick<OrgRole, "reports_to"> | undefined = role;
  while (at) {
    const up: OrgRole["reports_to"] = at.reports_to;
    if (up.kind === "user") return up.user_id;
    if (seen.has(up.role_id)) return null;
    seen.add(up.role_id);
    at = byId.get(up.role_id);
  }
  return null;
}

/** One flow per role that leads a project here, its projects grouped under it, by owner name. */
export function ownedFlows(
  projects: ReadonlyArray<{ _id: string; title?: string | null }>,
  admissions: ReadonlyMap<string, LineAdmission>,
  roles: ReadonlyArray<OrgRole>,
): OwnedFlow[] {
  const byId = new Map(roles.map((r) => [r._id, r]));
  const by = new Map<string, OwnedFlow>();
  for (const p of projects) {
    const a = admissions.get(p._id);
    const owner = a?.role ? byId.get(a.role.id) : undefined;
    if (!owner || owner.status === "retired") continue;
    const flow: OwnedFlow = by.get(owner._id) ?? {
      owner,
      projects: [],
      on: !!a?.on,
      steps: lineSlugOf(owner),
      merge: !!owner.line_merge,
      reviewAgent: owner.review_backend ?? null,
      deciderId: deciderOf(owner, roles),
    };
    flow.projects.push({ id: p._id, title: p.title ?? "Untitled" });
    by.set(owner._id, flow);
  }
  return [...by.values()].sort((a, b) => a.owner.name.localeCompare(b.owner.name));
}

/** The flow a handle names, or null. */
export const flowOf = (flows: ReadonlyArray<OwnedFlow>, handle: string | null | undefined): OwnedFlow | null =>
  (handle ? flows.find((f) => f.owner.handle === handle) ?? null : null);

/** The items of `needs` from a flow's projects: what the flow holds for a person. */
export function flowNeeds<N extends { projectId: string | null }>(needs: ReadonlyArray<N>, flow: Pick<OwnedFlow, "projects">): N[] {
  const intake = new Set(flow.projects.map((p) => p.id));
  return needs.filter((n) => !!n.projectId && intake.has(n.projectId));
}
