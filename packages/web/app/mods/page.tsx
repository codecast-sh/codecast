import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ModsPage } from "../../components/mods/ModsPage";

export default function ModsRoute() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="Mods">
          <ModsPage />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
