// The Ops area at /ops: the shell and the page an address names. Every Ops
// view renders through here, so this is the one switch from a view to its
// page (the home, a tab, an issue, a replay, a watch). It reads the
// workspace the app's switcher has active.
import { lazy, Suspense, useMemo, type ComponentType, type ReactNode } from "react";
import { useOpsSources } from "../../hooks/useSyncOps";
import { OpsShell } from "./OpsShell";
import { resolveSource } from "./opsHomeModel";
import { OpsHome } from "./OpsHome";
import { OpsNotFound } from "./OpsShellParts";
import { useForeignSourceLookup } from "./opsShellHooks";
import { useOpsFeed } from "./parts";
import type { OpsTab, OpsView } from "./opsPaths";

type TabPage = ComponentType<{ source: string | null; app: string | null }>;
const TABS: Record<OpsTab, TabPage> = {
  timeline: lazy(() => import("./TimelineTab").then((m) => ({ default: m.TimelineTab }))),
  issues: lazy(() => import("./IssuesTab").then((m) => ({ default: m.IssuesTab }))),
  replays: lazy(() => import("./ReplaysTab").then((m) => ({ default: m.ReplaysTab }))),
  metrics: lazy(() => import("./MetricsTab").then((m) => ({ default: m.MetricsTab }))),
  apps: lazy(() => import("./AppsTab").then((m) => ({ default: m.AppsTab }))),
};
const IssuePage = lazy(() => import("./IssuePage").then((m) => ({ default: m.IssuePage })));
const ReplayPage = lazy(() => import("./ReplayPage").then((m) => ({ default: m.ReplayPage })));
const MetricPage = lazy(() => import("./MetricPage").then((m) => ({ default: m.MetricPage })));

/**
 * A page narrowed to a source this workspace does not have (renamed, removed,
 * or a link from another workspace, Flows > Signals' rows included) says so,
 * on every tab, never the page's list under a name it does not hold. The
 * cached sources give the verdict at once; only a cold cache waits on the
 * feed, and only the other-workspace lookup is marked as still running.
 */
function SourceGate({ source, children }: { source: string; children: ReactNode }) {
  const sources = useOpsSources();
  const feed = useOpsFeed("sources");
  const named = resolveSource(sources, source);
  const foreign = useForeignSourceLookup(named ? null : source);
  if (named) return <>{children}</>;
  return <OpsNotFound id={source} kind="source" workspace={foreign.workspace} checking={!feed?.ready && !sources.length} lookingElsewhere={foreign.pending} />;
}

function OpsPage({ view }: { view: OpsView }) {
  if ((view.view === "home" || view.view === "tab") && view.source) return <SourceGate source={view.source}><OpsViewPage view={view} /></SourceGate>;
  return <OpsViewPage view={view} />;
}

function OpsViewPage({ view }: { view: OpsView }) {
  if (view.view === "home") return <OpsHome source={view.source} show={view.show} />;
  if (view.view === "issue") return <IssuePage id={view.id} />;
  if (view.view === "replay") return <ReplayPage id={view.id} t={view.t} />;
  if (view.view === "metric") return <MetricPage id={view.id} />;
  if (view.view === "tab") {
    const Tab = TABS[view.tab];
    return <Tab source={view.source} app={view.app} />;
  }
  // An address under /ops that names no view is said, never the Overview under a wrong address.
  return <OpsNotFound id={view.path} kind="page" />;
}

/** A source is named by its name in an address; `src-N` or its row id read as the name they stand for. */
export function OpsArea({ view: asked }: { view: OpsView }) {
  const sources = useOpsSources();
  const view = useMemo<OpsView>(() => {
    if ((asked.view !== "tab" && asked.view !== "home") || !asked.source) return asked;
    const named = resolveSource(sources, asked.source);
    return named ? { ...asked, source: named.name } : asked;
  }, [asked, sources]);
  return (
    <OpsShell view={view}>
      <Suspense fallback={null}><OpsPage view={view} /></Suspense>
    </OpsShell>
  );
}
