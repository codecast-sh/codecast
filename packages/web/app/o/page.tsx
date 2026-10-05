import { useParams } from "next/navigation";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ObjectPage } from "../../components/mods/ObjectPage";

// /o/<prefix>-<n>: one object of a mod-declared kind (components/mods).
export default function ModObjectRoute() {
  const params = useParams<{ id: string }>();
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="ModObject">
          <ObjectPage id={params.id} />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
