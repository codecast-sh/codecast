"use client";
// The company as one document (companyModel), assembled once for every reader:
// the Read lens draws it whole, and a goal's sheet lists what carries the goal
// from it, so the two always show the same projects, sub goals and proposed
// changes in the same order. Reads the store only; the feeders are mounted by
// the screen that hosts the readers.
import { useMemo } from "react";
import { useInboxStore, type ProjectItem } from "../../store/inboxStore";
import { useBoardTasks, useInitiatives, useTasksBackfilled } from "../../hooks/useInitiatives";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { joinProposals, type OrgProposalRow } from "../org/orgStaffingTypes";
import { openProposals, proposalWorkspace, sameWorkspace } from "../org/staffingModel";
import { useLineTree } from "../org/lines/lineTree";
import { companyDoc, flatGoals, type CompanyDoc, type CompanyMember, type CompanyProject, type DocGoal } from "./companyModel";

const projectSig = (p: ProjectItem) => `${p.title}|${p.status}|${p.short_id ?? ""}|${p.owner_role_id ?? ""}|${p.updated_at}|${p.color ?? ""}|${p.target_date ?? ""}|${p.risks?.length ?? 0}`;

/** The roster with the day each person joined: identity from the roster, the
 *  date from the members row, under a signature of the two (the members list
 *  re-pushes on every heartbeat). */
function useCompanyRoster(): CompanyMember[] {
  const roster = useTeamRosterIdentity();
  const joinedSig = useInboxStore((s) => ((s.teamMembers ?? []) as { _id?: string; joined_at?: number }[]).map((m) => `${m._id}:${m.joined_at ?? ""}`).join(","));
  return useMemo(() => {
    const joined = new Map(joinedSig.split(",").filter(Boolean).map((x) => { const [id, at] = x.split(":"); return [id, Number(at) || undefined] as const; }));
    return roster.map((m) => ({ ...m, ...(joined.get(m._id) ? { joined_at: joined.get(m._id) } : {}) }));
  }, [roster, joinedSig]);
}

/** The document, and the open proposals of this workspace it draws in violet. */
export function useCompanyDoc(): { doc: CompanyDoc; open: OrgProposalRow[] } {
  const tree = useLineTree();
  const initiatives = useInitiatives();
  const projects = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const tasks = useBoardTasks();
  const tasksCounted = useTasksBackfilled();
  const roster = useCompanyRoster();
  const teamName = useInboxStore((s) => { const id = s.clientState.ui?.active_team_id; return id ? ((s.teams ?? []) as { _id?: string; name?: string }[]).find((t) => t?._id === id)?.name ?? null : null; });
  const proposalRows = useInboxStore((s) => s.orgProposals);
  const proposalChanges = useInboxStore((s) => s.orgProposalChanges);

  const workspace = tree?.workspace;
  const open = useMemo<OrgProposalRow[]>(
    () => (workspace ? openProposals(joinProposals(proposalRows, proposalChanges)).filter((p) => sameWorkspace(proposalWorkspace(p), workspace)) : []),
    [proposalRows, proposalChanges, workspace?.kind, workspace?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const doc = useMemo(
    () => companyDoc({ tree, workspaceName: teamName, initiatives, projects: projects as CompanyProject[], roster, tasks, tasksCounted, changes: open.flatMap((p) => p.changes), proposals: open }),
    [tree, teamName, initiatives, projects, roster, tasks, tasksCounted, open],
  );
  return { doc, open };
}

/** One goal of the document by its row id. */
export function docGoalOf(doc: CompanyDoc, goalId: string): DocGoal | undefined {
  return flatGoals(doc.goals).find((g) => g.id === goalId || g.row?._id === goalId);
}
