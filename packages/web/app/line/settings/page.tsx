import { AuthGuard } from "../../../components/AuthGuard";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { LineSettingsPage } from "../../../components/line/settings/LineSettingsPage";

// /line/settings: one project's line, read and edited (plan pl-838).
export default function LineSettingsRoute() {
  return (
    <AuthGuard>
      <ErrorBoundary name="Line settings">
        <LineSettingsPage />
      </ErrorBoundary>
    </AuthGuard>
  );
}
