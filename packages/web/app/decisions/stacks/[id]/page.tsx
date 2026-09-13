"use client";
import { useParams } from "next/navigation";
import { AuthGuard } from "../../../../components/AuthGuard";
import { DashboardLayout } from "../../../../components/DashboardLayout";
import { ErrorBoundary } from "../../../../components/ErrorBoundary";
import { StackPage } from "../../../../components/decisions/StackPage";

// A decision stack (D5): /decisions/stacks/<ds-N>.
export default function DecisionStackPage() {
  const params = useParams();
  const id = String(params.id ?? "");
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="DecisionStack" level="panel">
          <StackPage id={id} />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
