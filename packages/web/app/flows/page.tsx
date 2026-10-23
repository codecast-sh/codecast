"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { LinePage } from "../../components/line/LinePage";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { lineWorkspaceRedirect } from "../../lib/line/lineWorkspaceUrl";

// /flows: the flows app (line-workspace.md LW1): the flows, every project or the one
// `?project=` names. An old map address (`node`, `edge`, `trace`) goes where
// it now lives.
export default function FlowsRoute() {
  const router = useRouter();
  const search = useSearchParams();
  const to = lineWorkspaceRedirect(search);
  useWatchEffect(() => { if (to) router.replace(to); }, [router, to]);
  if (to) return null;
  return (
    <AuthGuard>
      <ErrorBoundary name="Flows">
        <LinePage />
      </ErrorBoundary>
    </AuthGuard>
  );
}
