// Stub until its wave-2 unit builds it (docs/architecture/evals-ui.md section 8).
// It keeps the route, the props and the shell working end to end meanwhile.

import { EmptyState } from "../../EmptyState";
import type { EvalsView } from "../evalsPaths";

export function BisectPage(_props: { view: Extract<EvalsView, { view: "bisect" }> }) {
  return (
    <div data-evals-page="bisect" data-evals-stub>
      <EmptyState title="One bisect is not built yet" description="The commit ruler, probes filling as reps land, spend against budget and the answer. Built next from GET /bisect/:id." />
    </div>
  );
}
