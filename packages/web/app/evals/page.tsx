// /evals and everything under it: one registered area whose sub-paths
// components/evals/evalsPaths.ts reads. The views and their pages are the
// shared ones (@platform/evals/react's EvalsApp), drawn through codecast's
// host (components/evals/host.tsx); the Multiplayer sim pages are codecast's
// own and load on their own, so the wall does not pay for the sim lanes. This
// is the area's mount root: it imports the shared stylesheet, its tokens and
// codecast's own rules once.

import { lazy } from "react";
import { usePathname } from "next/navigation";
import { EvalsApp, type EvalsPage, type EvalsPages } from "@platform/evals/react";
import { AuthGuard } from "../../components/AuthGuard";
import { CodecastEvalsProvider } from "../../components/evals/host";
import "@platform/evals/react/tokens.css";
import "@platform/evals/react/styles.css";
import "../../components/evals/host.css";
import "../../components/evals/runPanels.css";

const page = <V extends "sim" | "sim-run">(load: () => Promise<EvalsPage<V>>) => lazy(async () => ({ default: await load() }));

/** Codecast's own views: the Multiplayer sim. */
const SIM_PAGES: EvalsPages = {
  sim: page(() => import("../../components/evals/pages/SimCatalogPage").then((m) => m.SimCatalogPage)),
  "sim-run": page(() => import("../../components/evals/pages/SimRunPage").then((m) => m.SimRunPage)),
};

export default function EvalsPage() {
  const pathname = usePathname();
  return (
    <AuthGuard>
      <div className="h-full min-h-0">
        <CodecastEvalsProvider>
          <EvalsApp path={pathname} pages={SIM_PAGES} />
        </CodecastEvalsProvider>
      </div>
    </AuthGuard>
  );
}
