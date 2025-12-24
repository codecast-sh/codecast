"use client";

import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { TeamActivityFeed } from "../../../components/TeamActivityFeed";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { EmptyState } from "../../../components/EmptyState";

export default function TeamActivityPage() {
  const user = useQuery(api.users.getCurrentUser);

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <LoadingSkeleton />
      </div>
    );
  }

  if (!user.team_id) {
    return (
      <div className="flex items-center justify-center min-h-screen p-6">
        <EmptyState
          title="No team"
          description="You need to be part of a team to view team activity"
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-sol-bg">
      <div className="max-w-4xl mx-auto p-6">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-sol-text mb-2">Team Activity</h1>
          <p className="text-sol-text-muted">
            See what your team has been working on
          </p>
        </div>
        <TeamActivityFeed teamId={user.team_id} />
      </div>
    </div>
  );
}
