import { Component, ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { captureError } from "@/lib/analytics";
import { describeError, errorSummary, rootError } from "@/lib/errorCause";
import { showErrorToast } from "@/lib/errorToast";
import { isChunkLoadError, tryReloadForStaleChunk } from "../lib/chunkReloadGuard";
import { isCallPanelWindow } from "@/lib/desktop";
import { scheduleVoiceHostReload } from "../lib/voiceHostRecovery";

interface ErrorBoundaryProps {
  children: ReactNode;
  name?: string;
  level?: "panel" | "inline";
  onReset?: () => void;
  /** A node, or a render prop when the fallback needs the boundary's retry
   *  (e.g. a floating surface offering both "retry" and a destructive exit). */
  fallback?: ReactNode | ((ctx: { error: Error; retry: () => void }) => ReactNode);
}

interface ErrorBoundaryState {
  error: Error | null;
  showDetails: boolean;
  isChunk: boolean;
}

const _recentErrors = new Set<string>();

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, showDetails: false, isChunk: false };

  static getDerivedStateFromError(error: Error) {
    // Read through `cause`: a stale-chunk rejection reaches a boundary wrapped
    // by whatever rethrew it, and only the innermost message names it.
    return { error, isChunk: isChunkLoadError(errorSummary(error)) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const label = this.props.name || "Component";
    // A thrown error may only wrap the real one (React's recovery wrappers, and
    // any `new Error(msg, { cause })` rethrow) — report what actually failed.
    const summary = errorSummary(error);
    console.error(`[ErrorBoundary:${label}]`, error, info.componentStack);
    captureError(rootError(error), { component: this.props.name, componentStack: info.componentStack ?? undefined });

    const dedupKey = `${label}:${summary}`;
    if (!_recentErrors.has(dedupKey)) {
      _recentErrors.add(dedupKey);
      setTimeout(() => _recentErrors.delete(dedupKey), 30_000);

      const fullTrace = `${describeError(error)}\n\nComponent: ${label}${info.componentStack || ""}`;
      showErrorToast(`${label}: ${summary}`, fullTrace);
    }

    // The shell's voice window has nobody in it to press Retry: it reloads
    // itself, backed off, whatever the error (lib/voiceHostRecovery).
    if (isCallPanelWindow()) {
      scheduleVoiceHostReload();
      return;
    }

    // A stale tab reloads itself onto the current build; if the budget is
    // already spent the error UI stays up so the user can see what happened.
    if (isChunkLoadError(summary)) tryReloadForStaleChunk();
  }

  reset = () => {
    this.setState({ error: null, showDetails: false, isChunk: false });
    this.props.onReset?.();
  };

  // A stale-chunk error can't be cleared by re-rendering — the browser caches
  // the failed dynamic import, so a soft reset re-hits the same rejection.
  // Only a full reload fetches the current chunk hashes.
  retry = () => {
    if (this.state.isChunk) {
      window.location.reload();
    } else {
      this.reset();
    }
  };

  toggleDetails = () => {
    this.setState((s) => ({ showDetails: !s.showDetails }));
  };

  render() {
    if (!this.state.error) return this.props.children;

    if (this.props.fallback) {
      return typeof this.props.fallback === "function"
        ? this.props.fallback({ error: this.state.error, retry: this.retry })
        : this.props.fallback;
    }

    const level = this.props.level ?? "panel";
    const name = this.props.name;

    if (level === "inline") {
      return (
        <div className="relative px-3 py-2 text-xs text-gray-400">
          <div className="flex items-center gap-2">
            <button onClick={this.toggleDetails} className="hover:text-gray-300 cursor-pointer" title="Show error details">
              Failed to load{name ? ` ${name}` : ""}
            </button>
            <button onClick={this.retry} className="text-sol-cyan hover:underline">{this.state.isChunk ? "reload" : "retry"}</button>
          </div>
          {this.state.showDetails && this.state.error && (
            <div className="absolute bottom-full left-2 right-2 mb-1 z-50 rounded-lg border border-sol-border bg-sol-bg shadow-xl shadow-black/40 max-w-lg">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-sol-border/60">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  {name || "Error"} Stack Trace
                </span>
                <button onClick={this.toggleDetails} className="text-gray-500 hover:text-gray-300 text-xs">x</button>
              </div>
              <div className="p-3 max-h-64 overflow-auto">
                <p className="text-xs text-sol-red font-mono break-all mb-2">{errorSummary(this.state.error)}</p>
                <pre className="text-[10px] text-gray-500 font-mono whitespace-pre-wrap break-all">
                  {describeError(this.state.error)}
                </pre>
              </div>
            </div>
          )}
        </div>
      );
    }

    return (
      <div data-error-boundary={name || "app"} className="h-full flex items-center justify-center p-4">
        <div className="text-center space-y-2">
          <p className="text-sm text-gray-400">
            {name ? `${name} crashed` : "Something went wrong"}
          </p>
          <button
            onClick={this.retry}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-sol-bg-alt text-sol-cyan border border-sol-cyan/20 hover:bg-sol-cyan/10 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            {this.state.isChunk ? "Reload" : "Retry"}
          </button>
        </div>
      </div>
    );
  }
}
