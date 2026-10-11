"use client";
import { useParams } from "next/navigation";
import { AuthGuard } from "../../../components/AuthGuard";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { LineWorkspaceRoute } from "../../../components/line/workspace/LineWorkspaceRoute";

// /line/<project>: one project's line workspace (docs/architecture/line-workspace.md LW1).
export default function LineProjectRoute() {
  const { project } = useParams<{ project: string }>();
  return (
    <AuthGuard>
      <ErrorBoundary name="Line workspace">
        <LineWorkspaceRoute param={project ?? ""} />
      </ErrorBoundary>
    </AuthGuard>
  );
}
