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

export type ApiErrorBannerKind = "auth" | "limit" | "error";

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

// Generic provider failure ("API Error: 529 Overloaded", "API Error: Connection error.").
const GENERIC_BANNER_RE = /^api error\b/i;

export function classifyApiErrorBanner(
  content: string | null | undefined,
): ApiErrorBannerKind | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > 400) return null;
  if (AUTH_BANNER_RE.test(trimmed)) return "auth";
  if (LIMIT_BANNER_RE.test(trimmed)) return "limit";
  if (GENERIC_BANNER_RE.test(trimmed)) return "error";
  return null;
}

export function isApiErrorBanner(content: string | null | undefined): boolean {
  return classifyApiErrorBanner(content) !== null;
}
