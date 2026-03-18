import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { OrchestrationDashboard } from "../../components/OrchestrationDashboard";

export default function OrchestrationPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="max-w-4xl mx-auto px-6 py-6">
          <OrchestrationDashboard />
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
