// Stub until its wave-2 unit builds it (docs/architecture/evals-ui.md section 8).
// It keeps the route, the props and the shell working end to end meanwhile.

import { EmptyState } from "../../EmptyState";
import type { EvalsView } from "../evalsPaths";

export function SimCatalogPage(_props: { view: Extract<EvalsView, { view: "sim" }> }) {
  return (
    <div data-evals-page="sim" data-evals-stub>
      <EmptyState title="Multiplayer sim is not built yet" description="Scenarios by mode with their history, the invariants and what each caught, and the sessions. Built next from GET /sim/catalog and /sim/sessions." />
    </div>
  );
}
