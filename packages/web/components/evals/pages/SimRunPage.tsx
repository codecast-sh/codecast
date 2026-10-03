// Stub until its wave-2 unit builds it (docs/architecture/evals-ui.md section 8).
// It keeps the route, the props and the shell working end to end meanwhile.

import { EmptyState } from "../../EmptyState";
import type { EvalsView } from "../evalsPaths";

export function SimRunPage(_props: { view: Extract<EvalsView, { view: "sim-run" }> }) {
  return (
    <div data-evals-page="sim-run" data-evals-stub>
      <EmptyState title="One Multiplayer sim run is not built yet" description="The failure card, swim lanes by window, the order strip and its shrink, and the replay lines. Built next from GET /sim/run/:session/:run." />
    </div>
  );
}
