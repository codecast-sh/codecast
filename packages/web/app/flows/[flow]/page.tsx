"use client";
import { useParams } from "next/navigation";
import { AuthGuard } from "../../../components/AuthGuard";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { FlowPage } from "../../../components/line/FlowPage";

// /flows/<owner>: one flow's page, named by the handle of the role that owns it (flows.md FL0).
export default function FlowRoute() {
  const { flow } = useParams<{ flow: string }>();
  return (
    <AuthGuard>
      <ErrorBoundary name="Flow">
        <FlowPage owner={decodeURIComponent(flow ?? "")} />
      </ErrorBoundary>
    </AuthGuard>
  );
}
