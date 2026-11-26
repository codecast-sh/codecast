import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { TriagePage } from "../../components/triageModel/TriagePage";

export default function TriageRoute() {
  return (
    <AuthGuard>
      <ErrorBoundary name="TriagePage" level="panel">
        <TriagePage />
      </ErrorBoundary>
    </AuthGuard>
  );
}
