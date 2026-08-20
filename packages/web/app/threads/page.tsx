import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ThreadsPageClient } from "./ThreadsPageClient";

export default function ThreadsPage() {
  return (
    <AuthGuard>
      <ErrorBoundary name="Threads">
        <ThreadsPageClient />
      </ErrorBoundary>
    </AuthGuard>
  );
}
