// /ops and everything under it (docs/architecture/external-data.md X10): one
// registered area whose sub-paths components/ops/opsPaths.ts reads. Each
// view loads on its own, so the timeline does not pay for the replay player.

import { lazy, Suspense, useMemo, type ComponentType } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { OpsShell } from "../../components/ops/OpsShell";
import { parseOpsPath, type OpsTab, type OpsView } from "../../components/ops/opsPaths";
import { useOpsSources } from "../../hooks/useSyncOps";

type TabPage = ComponentType<{ source: string | null; app: string | null }>;

const TABS: Record<OpsTab, TabPage> = {
  timeline: lazy(() => import("../../components/ops/TimelineTab").then((m) => ({ default: m.TimelineTab }))),
  issues: lazy(() => import("../../components/ops/IssuesTab").then((m) => ({ default: m.IssuesTab }))),
  replays: lazy(() => import("../../components/ops/ReplaysTab").then((m) => ({ default: m.ReplaysTab }))),
  metrics: lazy(() => import("../../components/ops/MetricsTab").then((m) => ({ default: m.MetricsTab }))),
  apps: lazy(() => import("../../components/ops/AppsTab").then((m) => ({ default: m.AppsTab }))),
};
const IssuePage = lazy(() => import("../../components/ops/IssuePage").then((m) => ({ default: m.IssuePage })));
const ReplayPage = lazy(() => import("../../components/ops/ReplayPage").then((m) => ({ default: m.ReplayPage })));

function OpsViewPage({ view }: { view: OpsView }) {
  if (view.view === "issue") return <IssuePage id={view.id} />;
  if (view.view === "replay") return <ReplayPage id={view.id} t={view.t} />;
  if (view.view === "tab") {
    const Tab = TABS[view.tab];
    return <Tab source={view.source} app={view.app} />;
  }
  return <EmptyState title="No Ops page here" description={`${view.path} names no view. Ops has a timeline, issues, replays, metrics and apps.`} action={{ label: "Open Ops", href: "/ops" }} />;
}

export default function OpsPage() {
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search.toString();
  const parsed = useMemo(() => parseOpsPath(pathname, query), [pathname, query]);
  // The tabs narrow by a source's name; a reference opens Ops by its `src-N`
  // (entityRoute), so a short id or Convex id reads as the name it stands for.
  const sources = useOpsSources();
  const view = useMemo<OpsView>(() => {
    if (parsed.view !== "tab" || !parsed.source) return parsed;
    const named = sources.find((s) => s.short_id === parsed.source || s._id === parsed.source);
    return named ? { ...parsed, source: named.name } : parsed;
  }, [parsed, sources]);
  return (
    <AuthGuard>
      <div className="h-full min-h-0">
        <OpsShell view={view}>
          <Suspense fallback={null}>
            <OpsViewPage view={view} />
          </Suspense>
        </OpsShell>
      </div>
    </AuthGuard>
  );
}
