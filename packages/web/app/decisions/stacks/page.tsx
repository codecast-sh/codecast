"use client";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { StacksIndex } from "../../../components/decisions/StackPage";

// The stacks index (the-line.md L10): /decisions/stacks lists every stack,
// open first with progress and due, done ones folded.
export default function DecisionStacksPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <ErrorBoundary name="DecisionStacks" level="panel">
          <StacksIndex />
        </ErrorBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}
