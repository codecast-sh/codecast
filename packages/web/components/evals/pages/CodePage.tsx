// One commit or one kept tree patch on a page of its own (/evals/c/:sha and
// /evals/p/:sha): where a run's head chip and its dirty chip lead, so the
// code a rep ran opens from anywhere a rep is named.

import { CommitPanel, PatchPanel } from "../CommitPanel";
import type { EvalsView } from "@platform/evals/client";

export function CommitPage({ view }: { view: Extract<EvalsView, { view: "commit" }> }) {
  return (
    <div data-evals-page="commit" className="ev-page">
      <CommitPanel key={`${view.sha}|${view.surface ?? ""}`} sha={view.sha} surface={view.surface} />
    </div>
  );
}

export function PatchPage({ view }: { view: Extract<EvalsView, { view: "patch" }> }) {
  return (
    <div data-evals-page="patch" className="ev-page">
      <PatchPanel key={view.sha} sha={view.sha} />
    </div>
  );
}
