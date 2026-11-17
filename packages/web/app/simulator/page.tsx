import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { SimulatorPane } from "../../components/simulator/SimulatorPane";

export default function SimulatorPage() {
  return (
    <AuthGuard>
      <ErrorBoundary name="SimulatorPane" level="panel">
        <SimulatorPane />
      </ErrorBoundary>
    </AuthGuard>
  );
}
