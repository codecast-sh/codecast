"use client";

import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { ActivityFeed } from "../../../components/ActivityFeed";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { EmptyState } from "../../../components/EmptyState";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { useInboxStore } from "../../../store/inboxStore";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

export default function TeamActivityPage() {
  const user = useQuery(api.users.getCurrentUser);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const teamId = activeTeamId || user?.active_team_id || user?.team_id;

  if (!user) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <LoadingSkeleton />
        </div>
      </DashboardLayout>
    );
  }

  if (!teamId) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[60vh] p-6">
          <EmptyState
            title="No team"
            description="You need to be part of a team to view team activity"
          />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto py-6">
        <ActivityFeed mode="team" teamId={teamId} />
      </div>
    </DashboardLayout>
  );
}
