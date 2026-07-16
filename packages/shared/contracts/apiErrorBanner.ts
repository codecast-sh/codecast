// Recognizes the Claude Code API-error *banner* turns — the one-liners the CLI
// emits as an assistant message (isApiErrorMessage in the JSONL) when a request
// fails: expired OAuth token, bad key, overload, or a usage/session limit. They
// are transient TUI state, not real conversation turns: when the CLI's next
// attempt succeeds it rewinds the banner out of its transcript and replays the
// turn for real, so synced copies go stale and the backend supersedes them.
//
// Single source of truth shared by the Convex backend (pending_api_error
// flag + banner supersession in messages.ts) and the web client (ApiErrorCard /
// session-pill rendering). Anchored prefixes + a length cap + single-line shape
// keep a real assistant message that merely *discusses* an error or limit
// (e.g. "You've hit your usage limit on the free plan, so video generation is
// paused…") from being mistaken for a banner.

export type ApiErrorBannerKind = "auth" | "limit" | "error" | "connection";

// Auth subset — the user can act by re-running /login. "Login expired" covers
// the CLI's expired-grant banner forms ("Login expired · Please run /login",
// "Login expired · run /login").
const AUTH_BANNER_RE =
  /^(?:please run \/login|login expired\b|not logged in|invalid api key|credit balance is too low|oauth (?:token|authentication))/i;

// Usage/session/spend limit banners. Real-world forms:
//   "You've hit your session limit · resets 11:30pm (America/New_York)"
//   "You've hit your session limit"
//   "You've hit your monthly spend limit · raise it at claude.ai/settings/usage"
//   "Claude usage limit reached. Your limit will reset at 3am (America/New_York)"
// The `[·∙]`-or-end-of-line requirement after "limit" is what rejects prose
// that merely starts with the same words.
const LIMIT_BANNER_RE =
  /^(?:you['’]ve hit your [\w -]{1,40}limit(?:\s*[·∙][^\n]*)?|claude (?:ai )?usage limit reached\b[^\n]*)$/i;

// Generic provider failure, split by whether the provider actually replied:
// a status code ("API Error: 529 Overloaded", "API Error: 500 {...}") means an
// HTTP response came back — the CLI usually retries these itself, so kind
// "error" stays out of the blocked/revive set. No status code ("API Error:
// Connection closed mid-response. The response above may be incomplete.",
// "API Error: Connection error.", "API Error: Request timed out.") means the
// connection itself failed and the turn died at the prompt — kind
// "connection" joins the blocked set: a plain "continue" resumes it, same as
// a limit banner after the window resets.
const GENERIC_BANNER_RE = /^api error\b/i;
const STATUSFUL_BANNER_RE = /^api error:?\s*\(?\d{3}\b/i;

export function classifyApiErrorBanner(
  content: string | null | undefined,
): ApiErrorBannerKind | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > 400) return null;
  if (AUTH_BANNER_RE.test(trimmed)) return "auth";
  if (LIMIT_BANNER_RE.test(trimmed)) return "limit";
  if (STATUSFUL_BANNER_RE.test(trimmed)) return "error";
  if (GENERIC_BANNER_RE.test(trimmed)) return "connection";
  return null;
}

export function isApiErrorBanner(content: string | null | undefined): boolean {
  return classifyApiErrorBanner(content) !== null;
}
