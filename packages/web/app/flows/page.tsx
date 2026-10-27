"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { LinePage } from "../../components/line/LinePage";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { lineWorkspaceRedirect } from "../../lib/line/lineWorkspaceUrl";
import { useWorkspaceFeature } from "../../lib/teamFeatures";
import { TeamFeatureOff } from "../../components/TeamFeatureOff";

// /flows: the flows app (line-workspace.md LW1): the flows, every project or
// the one `?project=` names. An old map address (`node`, `edge`, `trace`) goes
// where it now lives. While the workspace has Flows off, this is the feature's
// landing, and every other Flows address lands here (surfaceRules).
export default function FlowsRoute() {
  const router = useRouter();
  const search = useSearchParams();
  const on = useWorkspaceFeature("line");
  const to = on ? lineWorkspaceRedirect(search) : null;
  useWatchEffect(() => { if (to) router.replace(to); }, [router, to]);
  if (to) return null;
  return (
    <AuthGuard>
      <ErrorBoundary name="Flows">
        {on ? <LinePage /> : <TeamFeatureOff feature="line" />}
      </ErrorBoundary>
    </AuthGuard>
  );
}
