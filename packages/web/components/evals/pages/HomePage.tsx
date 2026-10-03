// Stub until its wave-2 unit builds it (docs/architecture/evals-ui.md section 8).
// It keeps the route, the props and the shell working end to end meanwhile.

import { EmptyState } from "../../EmptyState";
import type { EvalsView } from "../evalsPaths";

export function HomePage(_props: { view: Extract<EvalsView, { view: "home" }> }) {
  return (
    <div data-evals-page="home" data-evals-stub>
      <EmptyState title="The surface wall is not built yet" description="Every surface's 30-day trend, latest verdict, staleness and spend, with what moved. Built next from GET /overview." />
    </div>
  );
}
