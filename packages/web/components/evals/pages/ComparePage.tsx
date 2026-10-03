// Stub until its wave-2 unit builds it (docs/architecture/evals-ui.md section 8).
// It keeps the route, the props and the shell working end to end meanwhile.

import { EmptyState } from "../../EmptyState";
import type { EvalsView } from "../evalsPaths";

export function ComparePage(_props: { view: Extract<EvalsView, { view: "compare" }> }) {
  return (
    <div data-evals-page="compare" data-evals-stub>
      <EmptyState title="Two runs side by side is not built yet" description="Gate flips, check moves of 0.2 or more, both replies and both prompts diffed. Built next from GET /compare." />
    </div>
  );
}
