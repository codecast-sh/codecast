import { Component, ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { captureError } from "@/lib/analytics";

interface ErrorBoundaryProps {
  children: ReactNode;
  name?: string;
  level?: "page" | "panel" | "inline";
  onReset?: () => void;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  showDetails: boolean;
}

const HMR_ERROR_PATTERNS = [
  "Failed to fetch dynamically imported module",
  "Failed to reload",
  "does not provide an export named",
  "is not a function",
  "Cannot read properties of undefined",
];

function isHmrRelatedError(msg: string): boolean {
  return HMR_ERROR_PATTERNS.some((p) => msg.includes(p));
}

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
            navigator.clipboard.writeText(fullTrace);
            toast.success("Stack trace copied to clipboard");
          },
        },
      });
    }

    if (error.message && isHmrRelatedError(error.message)) {
      const key = "eb_reload_" + window.location.pathname;
      const last = sessionStorage.getItem(key);
      if (!last || Date.now() - Number(last) > 10_000) {
        sessionStorage.setItem(key, String(Date.now()));
        window.location.reload();
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

    const level = this.props.level ?? "page";
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

    if (level === "panel") {
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

    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="text-center space-y-3 max-w-sm">
          <p className="text-sm text-gray-400">
            {name ? `${name} hit an error` : "Something went wrong"}
          </p>
          <p className="text-xs text-gray-500 font-mono break-all">
            {this.state.error.message}
          </p>
          {this.state.error.stack && (
            <div className="text-left">
              <pre className="mt-1 text-[10px] text-gray-600 font-mono whitespace-pre-wrap break-all p-2 rounded bg-black/5">
                {this.state.error.stack}
              </pre>
            </div>
          )}
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={this.reset}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-md bg-sol-bg-alt text-sol-cyan border border-sol-cyan/20 hover:bg-sol-cyan/10 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center px-4 py-2 text-sm rounded-md text-gray-400 hover:text-gray-300 transition-colors"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
