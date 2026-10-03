// /evals and everything under it: one registered area whose sub-paths
// components/evals/evalsPaths.ts reads. Each view's page loads on its own, so
// the wall does not pay for the Multiplayer sim lanes.

import { lazy, Suspense, useMemo, type ComponentType } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { EvalsShell } from "../../components/evals/EvalsShell";
import { parseEvalsPath, type EvalsView, type EvalsViewName } from "../../components/evals/evalsPaths";

type PageFor<V extends EvalsViewName> = ComponentType<{ view: Extract<EvalsView, { view: V }> }>;

const page = <V extends EvalsViewName>(load: () => Promise<PageFor<V>>) => lazy(async () => ({ default: await load() }));

const PAGES: { [V in Exclude<EvalsViewName, "not-found">]: PageFor<V> } = {
  home: page(() => import("../../components/evals/pages/HomePage").then((m) => m.HomePage)),
  surface: page(() => import("../../components/evals/pages/SurfacePage").then((m) => m.SurfacePage)),
  freeze: page(() => import("../../components/evals/pages/FreezePage").then((m) => m.FreezePage)),
  run: page(() => import("../../components/evals/pages/RunPage").then((m) => m.RunPage)),
  compare: page(() => import("../../components/evals/pages/ComparePage").then((m) => m.ComparePage)),
  "bisect-list": page(() => import("../../components/evals/pages/BisectListPage").then((m) => m.BisectListPage)),
  "bisect-new": page(() => import("../../components/evals/pages/BisectNewPage").then((m) => m.BisectNewPage)),
  bisect: page(() => import("../../components/evals/pages/BisectPage").then((m) => m.BisectPage)),
  sim: page(() => import("../../components/evals/pages/SimCatalogPage").then((m) => m.SimCatalogPage)),
  "sim-run": page(() => import("../../components/evals/pages/SimRunPage").then((m) => m.SimRunPage)),
};

function EvalsViewPage({ view }: { view: EvalsView }) {
  if (view.view === "not-found") {
    return <EmptyState title="No Evals page here" description={`${view.path} names no view. The wall at /evals links to every surface, bisect and Multiplayer sim run.`} action={{ label: "Open the wall", href: "/evals" }} />;
  }
  const Page = PAGES[view.view] as ComponentType<{ view: EvalsView }>;
  return <Page view={view} />;
}

export default function EvalsPage() {
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search.toString();
  const view = useMemo(() => parseEvalsPath(pathname, query), [pathname, query]);
  return (
    <AuthGuard>
      <div className="h-full min-h-0">
        <EvalsShell view={view}>
          <Suspense fallback={null}>
            <EvalsViewPage view={view} />
          </Suspense>
        </EvalsShell>
      </div>
    </AuthGuard>
  );
}
