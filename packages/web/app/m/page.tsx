import { useParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ModPanePage } from "../../components/mods/ModPanePage";

// /m/<mod>/<pane>: one pane of a codecast mod (components/mods).
export default function ModPaneRoute() {
  const params = useParams<{ mod: string; pane?: string }>();
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="ModPane">
          <ModPanePage mod={params.mod} pane={params.pane || undefined} />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
