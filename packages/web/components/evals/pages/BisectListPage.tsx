// Stub until its wave-2 unit builds it (docs/architecture/evals-ui.md section 8).
// It keeps the route, the props and the shell working end to end meanwhile.

import { EmptyState } from "../../EmptyState";
import type { EvalsView } from "../evalsPaths";

export function BisectListPage(_props: { view: Extract<EvalsView, { view: "bisect-list" }> }) {
  return (
    <div data-evals-page="bisect-list" data-evals-stub>
      <EmptyState title="Bisects is not built yet" description="Past and running bisects with surface, endpoints, outcome, culprit, spend and duration. Built next from GET /bisects." />
    </div>
  );
}
