// Stub until its wave-2 unit builds it (docs/architecture/evals-ui.md section 8).
// It keeps the route, the props and the shell working end to end meanwhile.

import { EmptyState } from "../../EmptyState";
import type { EvalsView } from "../evalsPaths";

export function RunPage(_props: { view: Extract<EvalsView, { view: "run" }> }) {
  return (
    <div data-evals-page="run" data-evals-stub>
      <EmptyState title="One run in full is not built yet" description="Verdict, moment and reply, calls, agent turns, guard log and files for one rep. Built next from GET /run/:id." />
    </div>
  );
}
