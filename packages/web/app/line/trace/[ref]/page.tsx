"use client";
import { useParams } from "next/navigation";
import { AuthGuard } from "../../../../components/AuthGuard";
import { ErrorBoundary } from "../../../../components/ErrorBoundary";
import { LineRefRedirect } from "../../../../components/line/workspace/LineRefRedirect";

// /line/trace/<ref>: any ref the line knows opens its place in its project's workspace (line-workspace.md LW1).
export default function LineTraceRoute() {
  const { ref } = useParams<{ ref: string }>();
  return (
    <AuthGuard>
      <ErrorBoundary name="Line">
        <LineRefRedirect refParam={ref ?? ""} />
      </ErrorBoundary>
    </AuthGuard>
  );
}
