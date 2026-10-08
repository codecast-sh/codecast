"use client";
// The rows every sheet and the pane read: the workspace's goals and projects,
// the org tree as the lines read it, and the roster. Each under the wake
// signature its own reader already uses, so a heartbeat or a session's churn
// repaints no sheet.
import { createContext, useContext, useMemo } from "react";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import type { ProjectItem } from "../../../store/inboxStore";
import { useInitiatives } from "../../../hooks/useInitiatives";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { useTeamRosterIdentity } from "../../../hooks/useTeamRoster";
import { useLineTree } from "../lines/lineTree";
import type { OrgTree } from "../orgTypes";
import type { Member } from "./objects";

const projectSig = (p: ProjectItem) => `${p.title}|${p.status}|${p.short_id ?? ""}|${p.owner_role_id ?? ""}|${p.color ?? ""}|${p.target_date ?? ""}|${p.goal ?? ""}|${p.updated_at}`;

export type CompanyRows = { goals: InitiativeRow[]; projects: ProjectItem[]; tree: OrgTree | null; members: Member[] };

/** Rows that stand in for the store's: the Org screen's dev preview hands its
 *  fixture here, so the pane and every sheet read what the preview map draws. */
export const CompanyRowsOverride = createContext<CompanyRows | null>(null);

export function useCompanyRows(): CompanyRows {
  const override = useContext(CompanyRowsOverride);
  const goals = useInitiatives();
  const projects = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const tree = useLineTree();
  const members = useTeamRosterIdentity() as Member[];
  const live = useMemo(() => ({ goals, projects, tree, members }), [goals, projects, tree, members]);
  return override ?? live;
}
