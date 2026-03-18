import { Component, ReactNode } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { QueuePageClient } from "./QueuePageClient";

class InboxErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch() {
    const url = new URL(window.location.href);
    const sessionId = url.searchParams.get("s");
    if (sessionId) {
      window.location.replace(`/conversation/${sessionId}`);
    }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="h-screen flex items-center justify-center text-sol-text-dim">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-sm">Redirecting to session...</span>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function QueuePage() {
  return (
    <AuthGuard>
      <InboxErrorBoundary>
        <QueuePageClient />
      </InboxErrorBoundary>
    </AuthGuard>
  );
}
