import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { QueuePageClient } from "./QueuePageClient";

export default function QueuePage() {
  return (
    <AuthGuard>
      <ErrorBoundary name="Inbox">
        <QueuePageClient />
      </ErrorBoundary>
    </AuthGuard>
  );
}
