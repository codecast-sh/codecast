import { useMutation, useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { ActivityFeed } from "../../../components/ActivityFeed";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { useInboxStore } from "../../../store/inboxStore";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

import { useWatchEffect } from "../../../hooks/useWatchEffect";
// The single activity feed (the former /dashboard folded in here). It's driven
// entirely by the URL so the sidebar/command-palette/team-avatar links and tab
// routing all share one source of truth:
//   ?filter=my  → your personal feed; otherwise the team feed (teamless users
//                 always get the personal feed since there's no team to show).
//   ?dir=<path> → scope the feed to a single workspace (sidebar "Workspaces").
export default function TeamActivityPage() {
  const searchParams = useSearchParams();
  const user = useQuery(api.users.getCurrentUser);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const teamId = activeTeamId || user?.active_team_id || user?.team_id;

  const mode: "personal" | "team" =
    searchParams.get("filter") === "my" || !teamId ? "personal" : "team";
  const directoryFilter = searchParams.get("dir");

  // Reading the team feed is what clears the sidebar Feed badge
  // (getTeamUnreadCount counts teammate activity past this mark). Stamp it on
  // entry and again on exit so activity that landed while the feed was open is
  // not re-counted.
  const markTeamSeen = useMutation(api.conversations.markTeamConversationsSeen);
  useWatchEffect(() => {
    if (mode !== "team") return;
    void markTeamSeen({});
    return () => { void markTeamSeen({}); };
  }, [mode, teamId, markTeamSeen]);

  if (!user) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <LoadingSkeleton />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto">
        <ErrorBoundary name="ActivityFeed" level="inline">
          <ActivityFeed mode={mode} teamId={teamId} directoryFilter={directoryFilter} />
        </ErrorBoundary>
      </div>
    </DashboardLayout>
  );
}
