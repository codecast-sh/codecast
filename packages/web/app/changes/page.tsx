"use client";
// /changes: a daily edition of what the team shipped and why
// (docs/proposals/changes-page.md). The page owns its states, the flag-off
// and teamless ones included, so this entry only frames it.
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ChangesPage } from "../../components/changes/ChangesPage";

export default function ChangesRoute() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="Changes">
          <ChangesPage />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
