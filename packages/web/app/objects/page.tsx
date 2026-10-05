import { useParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ObjectsPage } from "../../components/mods/ObjectsPage";

// /objects/<prefix>: every object of one mod-declared kind (components/mods).
export default function ModObjectsRoute() {
  const params = useParams<{ prefix: string }>();
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="ModObjects">
          <ObjectsPage prefix={params.prefix} />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
