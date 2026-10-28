"use client";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { DecisionsPage } from "../../components/decisions/DecisionsPage";

// The Decisions page: Mine and the team's, one list (components/decisions/DecisionsPage).
export default function DecisionsRoute() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="Decisions" level="panel">
          <DecisionsPage />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
