"use client";

import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { TeamActivityFeed } from "../../../components/TeamActivityFeed";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { EmptyState } from "../../../components/EmptyState";
import { DashboardLayout } from "../../../components/DashboardLayout";

export default function TeamActivityPage() {
  const user = useQuery(api.users.getCurrentUser);

  if (!user) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <LoadingSkeleton />
        </div>
      </DashboardLayout>
    );
  }

  if (!user.team_id) {
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
        <TeamActivityFeed teamId={user.team_id} />
      </div>
    </DashboardLayout>
  );
}
