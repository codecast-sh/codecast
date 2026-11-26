"use client";
// /deploys: every place the team's code goes live, what is shipping toward it, what waits and went out, and the press that sends it (deploys.md DP12).
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { DeploysPage } from "../../components/deploys/DeploysPage";
import { FOCUS_PARAMS, focusOf, mineOf, viewOf } from "../../lib/deploys/focus";

export default function DeploysRoute() {
  const params = useSearchParams();
  const focus = focusOf(params);
  // A new link while the page is open (another chip clicked) opens it afresh at that thing.
  const linkKey = ["team", "repo", "target", ...FOCUS_PARAMS].map((k) => params.get(k) ?? "").join("|");
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="Deploys">
          <DeploysPage key={linkKey} initialTarget={params.get("target")} initialTeam={params.get("team")} initialDeploy={params.get("deploy")} initialFocus={focus} initialShow={viewOf(params, focus)} initialMine={mineOf(params)} initialRepo={params.get("repo")} />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
