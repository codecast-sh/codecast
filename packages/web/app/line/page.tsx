"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { LinePage } from "../../components/line/LinePage";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { lineWorkspaceRedirect } from "../../lib/line/lineWorkspaceUrl";

// /line: every project's line (the-line-end-to-end.md LE13). One project's
// line is its workspace, /line/<project> (line-workspace.md LW1): an old
// `?project=` address goes there, unless it opens a panel on the map.
export default function LineRoute() {
  const router = useRouter();
  const search = useSearchParams();
  const to = lineWorkspaceRedirect(search);
  useWatchEffect(() => { if (to) router.replace(to); }, [router, to]);
  if (to) return null;
  return (
    <AuthGuard>
      <ErrorBoundary name="Line">
        <LinePage />
      </ErrorBoundary>
    </AuthGuard>
  );
}
