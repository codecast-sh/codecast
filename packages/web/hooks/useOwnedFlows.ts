// The team's owned flows (lib/line/ownedFlows), derived from the workspace the
// flows app reads and the roles that lead its projects.
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useSyncOrgTreeFeeder } from "./useSyncOrgTree";
import { ownedFlows, type OwnedFlow } from "../lib/line/ownedFlows";
import type { OrgRole } from "../components/org/orgTypes";
import type { LineWorkspace } from "./useLineWorkspace";

/** One flow per role that leads a project of `workspace`; empty until the roles arrive. */
export function useOwnedFlows(workspace: Pick<LineWorkspace, "projects" | "admissions">): OwnedFlow[] {
  useSyncOrgTreeFeeder();
  const roles = useInboxStore((s) => s.orgTree?.roles) as OrgRole[] | undefined;
  return useMemo(() => (roles ? ownedFlows(workspace.projects, workspace.admissions, roles) : []), [roles, workspace.projects, workspace.admissions]);
}
