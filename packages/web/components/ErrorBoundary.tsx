import { Component, ReactNode } from "react";
import { RefreshCw } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
  name?: string;
  level?: "page" | "panel" | "inline";
  onReset?: () => void;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.name ? `:${this.props.name}` : ""}]`, error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    const level = this.props.level ?? "page";
    const name = this.props.name;

    if (level === "inline") {
      return (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400">
          <span>Failed to load{name ? ` ${name}` : ""}</span>
          <button onClick={this.reset} className="text-sol-cyan hover:underline">retry</button>
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
