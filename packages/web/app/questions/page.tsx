import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { QuestionsPageClient } from "./QuestionsPageClient";

export default function QuestionsPage() {
  return (
    <AuthGuard>
      <ErrorBoundary name="Questions">
        <QuestionsPageClient />
      </ErrorBoundary>
    </AuthGuard>
  );
}
