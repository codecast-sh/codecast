"use client";
import { AuthGuard } from "../../../components/AuthGuard";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { LinePage } from "../../../components/line/LinePage";

// /flows/settings?project=<p>&graph=<steps>: the settings of a flow, a page of
// the flows app (LineWorkspace `settings`), in the workspace /flows reads and
// with its nav and switchers. lineSettingsHref links here, with a ?section= or
// ?station= to land on; with no project, the flow names it, else the page
// lists the flows.
export default function FlowSettingsRoute() {
  return (
    <AuthGuard>
      <ErrorBoundary name="Flow settings">
        <LinePage settings />
      </ErrorBoundary>
    </AuthGuard>
  );
}
