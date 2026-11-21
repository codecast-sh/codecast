"use client";
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "../../../components/AuthGuard";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { LinePage } from "../../../components/line/LinePage";

// /flows/pipeline?repo=<owner/repo>: one repository's pipeline (docs/architecture/pipeline.md PL6), a page of the
// flows app in the workspace /flows reads, with its nav and switchers.
export default function PipelineRoute() {
  const repo = useSearchParams()?.get("repo")?.trim() ?? "";
  return (
    <AuthGuard>
      <ErrorBoundary name="Pipeline">
        <LinePage pipeline={repo} />
      </ErrorBoundary>
    </AuthGuard>
  );
}
