"use client";
// /deploys: every place the team's code goes live, what waits to go out there, and the press that sends it (deploys.md DP12).
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { DeploysPage } from "../../components/deploys/DeploysPage";

export default function DeploysRoute() {
  const params = useSearchParams();
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="Deploys">
          <DeploysPage initialTarget={params.get("target")} initialTeam={params.get("team")} initialDeploy={params.get("deploy")} />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
