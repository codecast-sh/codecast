"use client";
// /deploys: every place the team's code goes live, what is shipping toward it, what waits and went out, and the press that sends it (deploys.md DP12).
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { DeploysPage } from "../../components/deploys/DeploysPage";
import { FOCUS_PARAMS, LINK_PARAMS, focusOf, mineOf, viewOf } from "../../lib/deploys/focus";
import { useRememberedFilters } from "../../lib/rememberedFilters";

export default function DeploysRoute() {
  const params = useSearchParams();
  const focus = focusOf(params);
  // A link opens as it names; a bare address opens the viewer's last view and Mine (lib/rememberedFilters).
  const opened = useRememberedFilters("deploys", LINK_PARAMS, params);
  // A new link while the page is open (another chip clicked) opens it afresh at that thing.
  const linkKey = ["team", "repo", "target", ...FOCUS_PARAMS].map((k) => params.get(k) ?? "").join("|");
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="Deploys">
          <DeploysPage key={linkKey} initialTarget={params.get("target")} initialTeam={params.get("team")} initialDeploy={params.get("deploy")} initialFocus={focus} initialShow={viewOf(opened, focus)} initialMine={mineOf(opened)} initialRepo={params.get("repo")} initialProjects={params.get("projects")} />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
