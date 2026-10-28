"use client";
import { useParams } from "next/navigation";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { DecisionsPage } from "../../../components/decisions/DecisionsPage";

// A decision's document page (docs/architecture/decisions-as-documents.md
// D4): /decisions/<sd-N> or /decisions/<convex id>, drawn over the Decisions
// list the way a task opens over the task list, so Esc returns to the list.
export default function DecisionPage() {
  const params = useParams();
  const id = String(params.id ?? "");
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="Decisions" level="panel">
          <DecisionsPage id={id} />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
