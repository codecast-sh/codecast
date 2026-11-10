import { Component, ReactNode } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { captureError } from "@/lib/analytics";
import { describeError, errorSummary, rootError } from "@/lib/errorCause";
import { showErrorToast } from "@/lib/errorToast";
import { isChunkLoadError, tryReloadForStaleChunk } from "../lib/chunkReloadGuard";
import { isCallPanelWindow } from "@/lib/desktop";
import { scheduleVoiceHostReload } from "../lib/voiceHostRecovery";
// lib/visualStyle reads the root class, not the store: a share page that
// shows nothing of the app (SharedMessageView) mounts this boundary too.
import { isModernStyle } from "../lib/visualStyle";
import { Button } from "./ui/button";
import { EmptyState } from "./ui/empty-state";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { focusRing } from "./ui/styles";

interface ErrorBoundaryProps {
  children: ReactNode;
  name?: string;
  level?: "panel" | "inline";
  onReset?: () => void;
  /** A node, or a render prop when the fallback needs the boundary's retry
   *  (e.g. a floating surface offering both "retry" and a destructive exit). */
  fallback?: ReactNode | ((ctx: { error: Error; retry: () => void }) => ReactNode);
  /** Report the error but show no toast: for a surface a visitor sees and
   *  cannot act on (the homepage hero). */
  silent?: boolean;
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
    if (!this.props.silent && !_recentErrors.has(dedupKey)) {
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
    if (isModernStyle()) return this.renderModern(level, name);

    if (level === "inline") {
      return (
        <div className="relative px-3 py-2 text-xs text-sol-text-dim">
          <div className="flex items-center gap-2">
            <button onClick={this.toggleDetails} className="hover:text-sol-text cursor-pointer" title="Show error details">
              Failed to load{name ? ` ${name}` : ""}
            </button>
            <button onClick={this.retry} className="text-sol-cyan hover:underline">{this.state.isChunk ? "reload" : "retry"}</button>
          </div>
          {this.state.showDetails && this.state.error && (
            <div className="absolute bottom-full left-2 right-2 mb-1 z-50 rounded-lg border border-sol-border bg-sol-bg shadow-xl shadow-black/40 max-w-lg">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-sol-border/60">
                <span className="text-mark font-semibold uppercase tracking-wider text-sol-text-dim">
                  {name || "Error"} Stack Trace
                </span>
                <button onClick={this.toggleDetails} className="text-sol-text-dim hover:text-sol-text" aria-label="Close error details">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="p-3 max-h-64 overflow-auto">
                <p className="text-xs text-sol-red font-mono break-all mb-2">{errorSummary(this.state.error)}</p>
                <pre className="text-meta text-sol-text-dim font-mono whitespace-pre-wrap break-all">
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
          <p className="text-sm text-sol-text-dim">
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

  // The Modern style: the panel is the shared empty state (components/ui/
  // empty-state) with Retry and the trace behind a "Details" disclosure; the
  // inline row opens its trace in a popover that flips to whichever side has
  // room (a boundary in the header would open one above the window).
  renderModern(level: "panel" | "inline", name: string | undefined) {
    const error = this.state.error!;
    const retryLabel = this.state.isChunk ? "Reload" : "Retry";
    const details = (
      <>
        <p className="mb-2 font-mono text-meta text-sol-red [overflow-wrap:anywhere]">{errorSummary(error)}</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-meta text-sol-text-dim">
          {describeError(error)}
        </pre>
      </>
    );
    if (level === "inline") {
      return (
        <div className="flex min-h-control-sm items-center gap-1.5 px-3 py-1 text-meta text-sol-text-dim">
          <AlertTriangle className="size-3.5 shrink-0 text-sol-red" aria-hidden />
          <Popover open={this.state.showDetails} onOpenChange={(open) => this.setState({ showDetails: open })}>
            <PopoverTrigger asChild>
              <button type="button" className={`min-w-0 truncate rounded-control hover:text-sol-text ${focusRing}`} title="Show error details">
                Failed to load{name ? ` ${name}` : ""}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" collisionPadding={8} className="w-[min(32rem,calc(100vw-16px))]">
              {details}
            </PopoverContent>
          </Popover>
          <Button variant="ghost" size="xs" className="text-sol-cyan" onClick={this.retry}>
            {retryLabel}
          </Button>
        </div>
      );
    }
    return (
      <div data-error-boundary={name || "app"} className="h-full flex items-center justify-center p-4">
        <EmptyState
          icon={AlertTriangle}
          title={name ? `Couldn't load ${name}` : "Something went wrong"}
          action={{ label: retryLabel, onClick: this.retry, icon: RefreshCw }}
        >
          <details className="w-full max-w-md text-left text-meta text-sol-text-dim">
            <summary className={`mx-auto w-fit cursor-pointer select-none list-none rounded-control px-1 hover:text-sol-text [&::-webkit-details-marker]:hidden ${focusRing}`}>
              Details
            </summary>
            <div className="mt-2 rounded-card border border-sol-border bg-sol-bg-inset p-3">{details}</div>
          </details>
        </EmptyState>
      </div>
    );
  }
}
