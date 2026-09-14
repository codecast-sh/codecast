import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { BrowserPane } from "../../components/browser/BrowserPane";

export default function BrowserPage() {
  return (
    <AuthGuard>
      <ErrorBoundary name="BrowserPane" level="panel">
        <BrowserPane />
      </ErrorBoundary>
    </AuthGuard>
  );
}
