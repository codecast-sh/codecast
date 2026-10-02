import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { LinePage } from "../../components/line/LinePage";

// /line: the whole factory as one live flow (the-line-end-to-end.md LE13).
export default function LineRoute() {
  return (
    <AuthGuard>
      <ErrorBoundary name="Line">
        <LinePage />
      </ErrorBoundary>
    </AuthGuard>
  );
}
