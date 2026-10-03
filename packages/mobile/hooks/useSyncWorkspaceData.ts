import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "@codecast/web/store/inboxStore";
import { useSyncTeams } from "@codecast/web/hooks/useSyncTeams";
import { useSyncCollection } from "@codecast/web/hooks/useSyncCollection";
import { useBootstrapCollection } from "@codecast/web/hooks/useBootstrapCollection";
import { useSyncOrgTreeFeeder } from "@codecast/web/hooks/useSyncOrgTree";
import { workspaceStamp } from "@codecast/web/hooks/useWorkspaceArgs";
import { useSyncTasks } from "./useSyncTasks";
import { useSyncPlans } from "./useSyncPlans";
import { useSyncDocs } from "./useSyncDocs";
import { useWorkspaceArgs } from "./useWorkspaceArgs";

// The workspace's work data, fed ahead of any screen: teams (feature gates),
// the roster, notifications, tasks, plans, docs, projects and the org's roles.
// Mounted once in StoreSyncBridge so the Tasks tab, a task/plan/doc opened
// from a push, the Notifications tab and Settings all open on rows already in
// the persisted store. Screens read the store; none of them waits on these.
export function useSyncWorkspaceData(): void {
  const wsArgs = useWorkspaceArgs();
  const teamId = useInboxStore((s) => (s.currentUser as any)?.active_team_id) as string | undefined;
  const userKnown = useInboxStore((s) => !!s.currentUser?._id);

  useSyncTeams();
  useSyncCollection(
    "teamMembers",
    api.teams.getTeamMembers,
    teamId && isConvexId(String(teamId)) ? { team_id: teamId as any } : "skip",
  );
  useSyncCollection("notifications", api.notifications.list, {});
  useSyncTasks();
  useSyncPlans();
  useSyncDocs();
  useBootstrapCollection(
    "projects",
    (api as any).projects.webList,
    wsArgs === "skip" ? "skip" : workspaceStamp(wsArgs as any),
    { liveLoadingScope: "projects" },
  );
  useSyncOrgTreeFeeder(userKnown ? (teamId ?? null) : undefined);
}

/** Is a workspace list still on its cold first load? True while its bootstrap
 *  floor is in flight, or before the workspace is known. Screens pair it with
 *  an empty store (`loading && rows.length === 0`) so a spinner shows only for
 *  a genuinely cold cache. */
export function useFeedLoading(scope: "tasks" | "plans" | "docs" | "projects"): boolean {
  const wsSkip = useWorkspaceArgs() === "skip";
  const loading = useInboxStore((s) => !!s.liveLoading?.[scope]);
  return wsSkip || loading;
}
