import { useMemo } from "react";
import { projectLeadOf, type ProjectLead } from "@codecast/shared/contracts/orgLead";
import { useInboxStore, type ProjectItem } from "../store/inboxStore";
import { useOrgRoles } from "./useOrgRoles";
import type { OrgRole } from "../components/org/orgTypes";

/** What the chip branches on, as one string: a heartbeat on any other project
 *  field, or on any other project, re-renders nothing. */
function projectLeadSig(p: ProjectItem | undefined): string {
  return p ? `${p._id}|${p.owner_role_id ?? ""}|${p.team_id ?? ""}|${p.title}|${p.project_path ?? ""}` : "";
}

/** The project's lead, from the store. `roles` is null until the org tree on
 *  screen is the project's own workspace: a role lives in one workspace, so
 *  another workspace's roles can neither lead this project nor be offered. */
export function useProjectLead(projectId: string): { project: ProjectItem | undefined; roles: OrgRole[] | null; lead: ProjectLead<OrgRole>; otherWorkspace: boolean } {
  const sig = useInboxStore((s) => projectLeadSig(s.projects[projectId]));
  const { roles, workspace } = useOrgRoles();
  return useMemo(() => {
    const project = useInboxStore.getState().projects[projectId];
    const mine = !!workspace && !!project && (workspace.kind === "team" ? project.team_id === workspace.id : !project.team_id);
    const scoped = mine ? roles : null;
    return { project, roles: scoped, lead: projectLeadOf(project, scoped), otherWorkspace: !!workspace && !!project && !mine };
  }, [sig, roles, workspace, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
}
