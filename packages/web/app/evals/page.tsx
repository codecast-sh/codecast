// /evals and everything under it: one registered area whose sub-paths
// components/evals/evalsPaths.ts reads. Each view's page loads on its own, so
// the wall does not pay for the Multiplayer sim lanes. This is the area's
// mount root: it hands the views codecast's host (components/evals/host.tsx)
// and imports the area's tokens and stylesheet, once.

import { lazy, Suspense, useMemo, type ComponentType } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { EmptyState } from "../../components/EmptyState";
import { EvalsShell } from "../../components/evals/EvalsShell";
import { parseEvalsPath, type EvalsView, type EvalsViewName } from "../../components/evals/evalsPaths";
import { codecastEvalsHost, EvalsHostProvider } from "../../components/evals/host";
import "../../components/evals/tokens.css";
import "../../components/evals/evals.css";
import "../../components/evals/surface.css";
import "../../components/evals/wall.css";
import "../../components/evals/bisect.css";
import "../../components/evals/run.css";
import "../../components/evals/runPanels.css";
import "../../components/evals/freeze.css";

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
  commit: page(() => import("../../components/evals/pages/CodePage").then((m) => m.CommitPage)),
  patch: page(() => import("../../components/evals/pages/CodePage").then((m) => m.PatchPage)),
};

/** What a view's page is called while its code loads: under load a hop can take seconds, and a blank pane reads as broken. */
const OPENING: { [V in Exclude<EvalsViewName, "not-found">]: string } = {
  home: "the wall",
  surface: "the surface",
  freeze: "the freeze",
  run: "the run",
  compare: "the comparison",
  "bisect-list": "the bisects",
  "bisect-new": "the attribution",
  bisect: "the bisect",
  sim: "the Multiplayer sim",
  "sim-run": "the Multiplayer sim run",
  commit: "the commit",
  patch: "the patch",
};

function Opening({ view }: { view: EvalsView }) {
  return (
    <div className="ev-page ev-note" data-evals-loading="page">
      Opening {view.view === "not-found" ? "the page" : OPENING[view.view]}...
    </div>
  );
}

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
        <EvalsHostProvider host={codecastEvalsHost}>
          <EvalsShell view={view}>
            <Suspense fallback={<Opening view={view} />}>
              <EvalsViewPage view={view} />
            </Suspense>
          </EvalsShell>
        </EvalsHostProvider>
      </div>
    </AuthGuard>
  );
}
