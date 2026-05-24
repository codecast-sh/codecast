import { Component, ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { captureError } from "@/lib/analytics";
import { copyToClipboard } from "@/lib/utils";

interface ErrorBoundaryProps {
  children: ReactNode;
  name?: string;
  level?: "panel" | "inline";
  onReset?: () => void;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  showDetails: boolean;
}

// Narrowly-scoped: errors that mean "the JS the browser has is incompatible
// with what the server is serving" — typically a stale tab whose chunk hashes
// no longer exist after a deploy, or a Vite dev-server HMR boundary failure.
// Generic TypeErrors ("is not a function", "Cannot read properties of undefined")
// are NOT included: they are ordinary code bugs, and auto-reloading on them
// hides the real failure and produces the "needs multiple reloads to load"
// symptom (the throttle then suppresses subsequent reloads, leaving a blank app).
const CHUNK_LOAD_ERROR_PATTERNS = [
  "Failed to fetch dynamically imported module",
  "Importing a module script failed",
  "error loading dynamically imported module",
  "ChunkLoadError",
  "Loading chunk",
  "Loading CSS chunk",
];

function isChunkLoadError(msg: string): boolean {
  return CHUNK_LOAD_ERROR_PATTERNS.some((p) => msg.includes(p));
}

// Hard cap on auto-reloads per tab session. Even if a chunk-load error
// recurs (e.g. the deploy is mid-rollout), we never silently reload more
// than once — instead we surface the error UI so the user can see what's
// happening.
const RELOAD_COUNT_KEY = "eb_reload_count";
const MAX_AUTO_RELOADS = 1;

const _recentErrors = new Set<string>();

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, showDetails: false };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const label = this.props.name || "Component";
    console.error(`[ErrorBoundary:${label}]`, error, info.componentStack);
    captureError(error, { component: this.props.name, componentStack: info.componentStack ?? undefined });

    const dedupKey = `${label}:${error.message}`;
    if (!_recentErrors.has(dedupKey)) {
      _recentErrors.add(dedupKey);
      setTimeout(() => _recentErrors.delete(dedupKey), 30_000);

      const fullTrace = `${error.message}\n\n${error.stack || ""}\n\nComponent: ${label}${info.componentStack || ""}`;
      toast.error(`${label}: ${error.message}`, {
        duration: 15_000,
        action: {
          label: "Copy stack",
          onClick: () => {
            copyToClipboard(fullTrace).then(() => toast.success("Stack trace copied to clipboard"));
          },
        },
      });
    }

    if (error.message && isChunkLoadError(error.message)) {
      try {
        const count = Number(sessionStorage.getItem(RELOAD_COUNT_KEY) ?? "0");
        if (count < MAX_AUTO_RELOADS) {
          sessionStorage.setItem(RELOAD_COUNT_KEY, String(count + 1));
          window.location.reload();
        }
      } catch {
        // sessionStorage unavailable (private mode quota etc.) — fall through
        // to showing the error UI rather than risking an unbounded loop.
      }
    }
  }

  reset = () => {
    this.setState({ error: null, showDetails: false });
    this.props.onReset?.();
  };

  toggleDetails = () => {
    this.setState((s) => ({ showDetails: !s.showDetails }));
  };

  render() {
    if (!this.state.error) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    const level = this.props.level ?? "panel";
    const name = this.props.name;

    if (level === "inline") {
      return (
        <div className="relative px-3 py-2 text-xs text-gray-400">
          <div className="flex items-center gap-2">
            <button onClick={this.toggleDetails} className="hover:text-gray-300 cursor-pointer" title="Show error details">
              Failed to load{name ? ` ${name}` : ""}
            </button>
            <button onClick={this.reset} className="text-sol-cyan hover:underline">retry</button>
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
                <p className="text-xs text-sol-red font-mono break-all mb-2">{this.state.error.message}</p>
                {this.state.error.stack && (
                  <pre className="text-[10px] text-gray-500 font-mono whitespace-pre-wrap break-all">
                    {this.state.error.stack}
                  </pre>
                )}
              </div>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="h-full flex items-center justify-center p-4">
        <div className="text-center space-y-2">
          <p className="text-sm text-gray-400">
            {name ? `${name} crashed` : "Something went wrong"}
          </p>
          <button
            onClick={this.reset}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-sol-bg-alt text-sol-cyan border border-sol-cyan/20 hover:bg-sol-cyan/10 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      </div>
    );
  }
}
