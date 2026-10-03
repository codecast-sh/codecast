// Stub until its wave-2 unit builds it (docs/architecture/evals-ui.md section 8).
// It keeps the route, the props and the shell working end to end meanwhile.

import { EmptyState } from "../../EmptyState";
import type { EvalsView } from "../evalsPaths";

export function FreezePage(_props: { view: Extract<EvalsView, { view: "freeze" }> }) {
  return (
    <div data-evals-page="freeze" data-evals-stub>
      <EmptyState title="One freeze across time is not built yet" description="The label, the frozen moment, every rep of this freeze and the replies either side of its newest flip. Built next from GET /freeze/:id." />
    </div>
  );
}
