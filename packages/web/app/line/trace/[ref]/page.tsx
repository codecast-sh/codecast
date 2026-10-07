"use client";
import { useParams } from "next/navigation";
import { AuthGuard } from "../../../../components/AuthGuard";
import { ErrorBoundary } from "../../../../components/ErrorBoundary";
import { LineTracePage } from "../../../../components/line/trace/LineTracePage";

// /line/trace/<ref>: one thing followed through the line (docs/architecture/line-map.md LX4).
export default function LineTraceRoute() {
  const { ref } = useParams<{ ref: string }>();
  return (
    <AuthGuard>
      <ErrorBoundary name="Line trace">
        <LineTracePage refParam={ref ?? ""} />
      </ErrorBoundary>
    </AuthGuard>
  );
}
