// A role's scope model from the store (lib/roleScope; org-roles-run-work.md
// R3). Paints from the slices already there (the org tree, projects, plans,
// tasks, sessions) and mounts no feeder: the role page feeds them, and a hover
// anywhere else reads what the store holds. When the tree does not hold the
// role, the caller's `org.roleCard` answer stands in for the role's own facts
// and the workspace rows still supply the counts.
//
// Re-render discipline (CLAUDE.md store rules): the tree carries `updated_at`
// and `state` for the sessions under every node, and tasks churn all day, so
// this subscribes to signatures of the fields the view shows and never to a
// collection or the tree itself.
import { useMemo } from "react";
import { useInboxStore, type PlanItem, type ProjectItem, type TaskItem } from "../store/inboxStore";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { useOrgRoles } from "./useOrgRoles";
import { buildRoleScope, sourceFromCard, sourceFromTree, type RoleCardAnswer, type RoleScopeModel } from "../lib/roleScope";
import type { OrgRole, OrgSession, OrgTree } from "../components/org/orgTypes";

const projectSig = (p: ProjectItem) => `${p.title}|${p.status}|${p.owner_role_id ?? ""}`;
const planSig = (p: PlanItem) => `${p.title}|${p.status}|${(p as any).project_id ?? ""}`;
const taskSig = (t: TaskItem) => `${t.status}|${(t as any).project_id ?? ""}|${(t as any).plan_id ?? ""}|${t.assignee ?? ""}`;

const findRole = (tree: OrgTree | null | undefined, ref: string): OrgRole | null =>
  tree?.roles.find((r) => r.short_id === ref || r._id === ref) ?? null;

/** A session the role has put in front of the person (R1), with its line. */
export type EscalatedSession = { session: OrgSession; line: string };

const escalationOf = (row: any): string | null => (row?.escalated_by_role?.line ? String(row.escalated_by_role.line) : null);

export function useRoleScope(roleRef: string, card?: RoleCardAnswer | null): { model: RoleScopeModel | null; role: OrgRole | null; escalated: EscalatedSession[] } {
  // The role's own facts as one string: the normalized source (names, scope,
  // counts, limits, who it reports to) plus each top session's escalation.
  const sig = useInboxStore((s) => {
    const role = findRole(s.orgTree, roleRef);
    if (!role || !s.orgTree) return "";
    return JSON.stringify(sourceFromTree(s.orgTree, role)) + "\n" + role.sessions.map((x) => `${x._id}|${x.state}|${x.title}|${escalationOf(s.sessions[x._id]) ?? ""}`).join("\n");
  });
  // The charter document's text, when the store holds the document.
  const charterDoc = useInboxStore((s) => {
    const id = findRole(s.orgTree, roleRef)?.charter_doc_id;
    return id ? ((s.docs[id] as any)?.content as string | undefined) ?? null : null;
  });
  const { roles } = useOrgRoles();
  const projects = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const plans = useWorkspaceCollection<PlanItem>("plans", planSig);
  const tasks = useWorkspaceCollection<TaskItem>("tasks", taskSig);
  const today = new Date().toISOString().slice(0, 10);

  return useMemo(() => {
    const st = useInboxStore.getState();
    const role = findRole(st.orgTree, roleRef);
    const source = role && st.orgTree ? sourceFromTree(st.orgTree, role) : card ? sourceFromCard(card) : null;
    if (!source) return { model: null, role, escalated: [] };
    if (charterDoc) source.charter = charterDoc;
    else if (!source.charter && card?.charter) source.charter = card.charter;
    const escalated = (role?.sessions ?? []).flatMap((session) => {
      const line = escalationOf(st.sessions[session._id]);
      return line ? [{ session, line }] : [];
    });
    return { model: buildRoleScope(source, { projects, plans, tasks, roles } as any, today), role, escalated };
  }, [sig, charterDoc, card, roles, projects, plans, tasks, today, roleRef]); // eslint-disable-line react-hooks/exhaustive-deps
}
