"use client";
import { useParams } from "next/navigation";
import { AuthGuard } from "../../../../components/AuthGuard";
import { ErrorBoundary } from "../../../../components/ErrorBoundary";
import { LineRefRedirect } from "../../../../components/line/workspace/LineRefRedirect";

// /flows/trace/<ref>: any ref a flow knows opens its place in the flows app (line-workspace.md LW1).
export default function FlowTraceRoute() {
  const { ref } = useParams<{ ref: string }>();
  return (
    <AuthGuard>
      <ErrorBoundary name="Flows">
        <LineRefRedirect refParam={ref ?? ""} />
      </ErrorBoundary>
    </AuthGuard>
  );
}
