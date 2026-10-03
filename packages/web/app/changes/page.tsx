"use client";
// /changes: a daily edition of what the team shipped and why
// (docs/proposals/changes-page.md). The route holds the page's two gates, so
// they survive whatever ChangesPage becomes: Changes is written for a team,
// and only for a team that turned the feature on. Every entry point is
// hidden when the flag is off, so the gates only meet a direct URL or a
// stale tab.
import type { ReactNode } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { TeamFeatureOff } from "../../components/TeamFeatureOff";
import { ChangesPage } from "../../components/changes/ChangesPage";
import { useTeamFeature } from "../../lib/teamFeatures";
import { useInboxStore } from "../../store/inboxStore";

export function ChangesGate({ children }: { children: ReactNode }) {
  const hasTeam = useInboxStore((s) => !!s.clientState.ui?.active_team_id);
  const on = useTeamFeature("changes");
  if (!hasTeam) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-8">
        <p className="max-w-sm text-center text-sm text-sol-text">
          Changes is written for a team. Join or create one to see it.
        </p>
      </div>
    );
  }
  return on ? <>{children}</> : <TeamFeatureOff feature="changes" />;
}

export default function ChangesRoute() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="Changes">
          <ChangesGate>
            <ChangesPage />
          </ChangesGate>
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
