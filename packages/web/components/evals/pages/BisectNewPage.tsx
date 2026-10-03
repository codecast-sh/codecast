// Stub until its wave-2 unit builds it (docs/architecture/evals-ui.md section 8).
// It keeps the route, the props and the shell working end to end meanwhile.

import { EmptyState } from "../../EmptyState";
import type { EvalsView } from "../evalsPaths";

export function BisectNewPage(_props: { view: Extract<EvalsView, { view: "bisect-new" }> }) {
  return (
    <div data-evals-page="bisect-new" data-evals-stub>
      <EmptyState title="Attribute a regression is not built yet" description="The free answer from records first, then a priced bisect plan when the range is narrowed but not pinned. Built next from GET /attribution and POST /bisect/plan." />
    </div>
  );
}
