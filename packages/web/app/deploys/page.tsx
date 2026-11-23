"use client";
// /deploys: every place the team's code goes live, what waits to go out there, and the press that sends it (deploys.md DP12).
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { DeploysPage } from "../../components/deploys/DeploysPage";
import { FOCUS_PARAMS, filtersOf, focusOf, labelsOf } from "../../lib/deploys/focus";

export default function DeploysRoute() {
  const params = useSearchParams();
  const focus = focusOf(params);
  // A new link while the page is open (another chip clicked) opens it afresh at that thing.
  const linkKey = ["team", "repo", "target", ...FOCUS_PARAMS].map((k) => params.get(k) ?? "").join("|");
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="Deploys">
          <DeploysPage key={linkKey} initialTarget={params.get("target")} initialTeam={params.get("team")} initialDeploy={params.get("deploy")} initialFocus={focus} initialLabels={labelsOf(params, focus)} initialFilters={filtersOf(params)} initialRepo={params.get("repo")} />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
