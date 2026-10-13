"use client";
import { AuthGuard } from "../../../components/AuthGuard";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { LinePage } from "../../../components/line/LinePage";

// /line/settings?project=<p>&graph=<line>: the settings of a line, a page of
// the line app (LineWorkspace `settings`), in the workspace /line reads and
// with its nav and switchers. lineSettingsHref links here, with a ?section= or
// ?station= to land on; with no project, the line names it, else the page
// lists the lines.
export default function LineSettingsRoute() {
  return (
    <AuthGuard>
      <ErrorBoundary name="Line settings">
        <LinePage settings />
      </ErrorBoundary>
    </AuthGuard>
  );
}
