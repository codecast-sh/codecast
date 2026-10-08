"use client";
// /expectations: every project's document of how its product should behave
// (the-line-model.md LM5). The tab shell routes /expectations here too
// (components/RoutePane.tsx); this file gives a direct load the same page.
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ExpectationsOverview } from "../../components/expectations/ExpectationsOverview";

export default function ExpectationsPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="Expectations">
          <ExpectationsOverview />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
