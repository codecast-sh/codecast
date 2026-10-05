// What a session parked on an unresolved API-error banner shows on its row:
// a short label and the explanation behind it, per banner kind. Web's
// AuthErrorBadge and the phone's session row both draw from this table.

export type ApiErrorBadgeKind = "context" | "safety" | "throttle" | "fatal" | "connection" | "limit" | "auth";

export type ApiErrorBadge = { kind: ApiErrorBadgeKind; label: string; title: string };

/** Signed out: each agent signs in again its own way. */
function authTitle(agentType?: string | null): string {
  if (agentType === "opencode") return "Provider not authenticated — run `opencode auth login` in a terminal, then retry";
  if (agentType === "grok") return "Signed out — run `grok login` in a terminal (browser OAuth), then retry";
  if (agentType === "muse") return "Signed out — run `muse login` in a terminal (device flow), then retry";
  return "Signed out — run /login in the terminal to re-authenticate";
}

/** The badge for a banner kind, or null for kinds with no recovery behind them (a marked client "error"). */
export function apiErrorBadge(kind?: string | null, agentType?: string | null): ApiErrorBadge | null {
  switch (kind) {
    case "context":
      return { kind, label: "context full", title: "The conversation no longer fits the model's context window — send /compact (or /clear) in the session to continue; a plain continue re-fails" };
    case "safety":
      return { kind, label: "safety", title: "OpenAI stopped this conversation for safety review. Automatic retries and account switching cannot resolve it." };
    case "throttle":
      return { kind, label: "throttled", title: "The provider's per-minute rate limit rejected a request burst — codecast retries a few sessions at a time; send continue to retry now" };
    case "fatal":
      return { kind, label: "failed", title: "API request failed and won't auto-retry — send continue (or any message) to retry the turn" };
    case "connection":
      return { kind, label: "dropped", title: "Connection dropped mid-response — send continue (or any message) to resume" };
    case "limit":
      return { kind, label: "limit", title: "Usage limit reached — the session can resume once the limit resets" };
    case "auth":
      return { kind, label: "login", title: authTitle(agentType) };
    default:
      return null;
  }
}
