// Stub until its wave-2 unit builds it (docs/architecture/evals-ui.md section 8).
// It keeps the route, the props and the shell working end to end meanwhile.

import { EmptyState } from "../../EmptyState";
import type { EvalsView } from "../evalsPaths";

export function SurfacePage(_props: { view: Extract<EvalsView, { view: "surface" }> }) {
  return (
    <div data-evals-page="surface" data-evals-stub>
      <EmptyState title="One surface over time is not built yet" description="The seismograph, cost track, freeze ledger and compare drawer. Built next from GET /surface/:id, /batches and /epoch." />
    </div>
  );
}
