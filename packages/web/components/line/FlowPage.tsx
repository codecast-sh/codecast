"use client";
// /flows/<owner>: one flow's page (docs/architecture/flows.md FL0). The flows
// app pinned to the flow's projects: its overview leads (FlowsView), and
// Decisions, Problems, Timeline, Steps and Deploys read the project picked
// among the flow's own, the first by default.
import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useLineSpace } from "../../hooks/useLineSpace";
import { useOrgScope, useSyncOrgTreeFeeder } from "../../hooks/useSyncOrgTree";
import { WorkspaceScopeProvider } from "../../hooks/useWorkspaceScope";
import { useLineProjectId } from "../../hooks/useLineWorkspace";
import { useInboxStore } from "../../store/inboxStore";
import { readLineSelection } from "../../lib/line/lineWorkspaceUrl";
import { lineRoleOf } from "./map/useLineAdmission";
import type { OrgRole } from "../org/orgTypes";
import { LineWorkspace, type FlowFrame } from "./workspace/LineWorkspace";
import { FlowPageContext } from "../../lib/line/flowPageContext";

type Project = { _id: string; title?: string | null };

export function FlowPage({ owner }: { owner: string }) {
  const search = useSearchParams();
  const selection = useMemo(() => readLineSelection(search), [search]);
  const space = useLineSpace(selection);
  useOrgScope(space.key);
  useSyncOrgTreeFeeder();
  const roles = useInboxStore((s) => s.orgTree?.roles) as OrgRole[] | undefined;
  const projects = useInboxStore((s) => s.projects) as Record<string, Project> | undefined;
  const role = roles?.find((r) => r.handle === owner) ?? null;
  const intake = useMemo(() => {
    if (!role || !roles || !projects) return [];
    return role.scope.project_ids
      .filter((id) => projects[id] && lineRoleOf(roles, id)?._id === role._id)
      .map((id) => ({ id, title: projects[id].title ?? "Untitled" }));
  }, [role, roles, projects]);
  const asked = useLineProjectId(selection.project);
  const projectId = intake.find((p) => p.id === asked)?.id ?? intake[0]?.id ?? null;
  const flow = useMemo<FlowFrame | null>(() => (role ? { owner, name: role.name, projects: intake } : null), [role, owner, intake]);
  return (
    <WorkspaceScopeProvider value={space.key}>
      <FlowPageContext.Provider value={owner}>
        <LineWorkspace space={space} projectId={projectId} flow={flow ?? { owner, name: `@${owner}`, projects: [] }} />
      </FlowPageContext.Provider>
    </WorkspaceScopeProvider>
  );
}
