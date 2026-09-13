"use client";
import { useParams } from "next/navigation";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { DecisionDocument } from "../../../components/decisions/DecisionDocument";

// The decision document page (docs/architecture/decisions-as-documents.md
// D4): /decisions/<sd-N> or /decisions/<convex id>.
export default function DecisionPage() {
  const params = useParams();
  const id = String(params.id ?? "");
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="Decision" level="panel">
          <DecisionDocument id={id} />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
