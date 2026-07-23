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
//   "You've hit your monthly spend limit. Run /usage-credits to manage your
//    limit and keep using Fable 5 or switch models to continue this chat."
//   "Claude usage limit reached. Your limit will reset at 3am (America/New_York)"
// The `[·∙]`-or-end-of-line requirement after "limit" is what rejects prose
// that merely starts with the same words. The one sentence-shaped variant is
// admitted only by its "Run /usage-credits" tail — a CLI slash-command
// reference prose doesn't produce in that position.
const LIMIT_BANNER_RE =
  /^(?:you['’]ve hit your [\w -]{1,40}limit(?:\s*[·∙][^\n]*|\.\s*run \/usage-credits\b[^\n]*)?|claude (?:ai )?usage limit reached\b[^\n]*)$/i;

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

// Non-Claude clients surface a failed turn differently — not as a "Login expired"
// banner the CLI rewinds, but as a real message carrying the provider's own error
// text (opencode records it on the assistant message's `error` field; pi's daemon
// pane-scrape emits it). The per-client parser/scraper — which alone knows the
// message IS a structured error, not a normal reply that merely mentions keys —
// stamps that message with this exact leading marker. The classifier keys on the
// marker (never on raw phrasing), so a normal opencode/pi reply can never be
// mistaken for a banner. The marker is stripped before the card renders.
export const CLIENT_ERROR_BANNER_PREFIX = "⚠ Turn stopped:";

// Within a marked client-error message, does the provider text point at something
// the user fixes by setting up the account (a missing/invalid key, an
// unauthenticated provider, a missing provider config like GOOGLE_VERTEX_LOCATION)?
// Then it's kind "auth" and gets the "Authentication required" card with the
// client-correct remedy; otherwise it's an informative "error".
const CLIENT_AUTH_ERROR_RE =
  /\b(?:api[\s_-]?key|apikey|authenticat|unauthori[sz]|not logged in|\/login\b|invalid.{0,12}(?:key|token|credential)|missing.{0,20}(?:key|token|credential|api|location)|no .{0,16}(?:api key|credential)|credential|GOOGLE_VERTEX_LOCATION|location setting is missing|oauth|permission denied|forbidden|\b401\b|\b403\b)/i;

export function classifyApiErrorBanner(
  content: string | null | undefined,
): ApiErrorBannerKind | null {
  if (!content) return null;
  const trimmed = content.trim();
  // Marked client-error messages (opencode/pi) — gate on the exact marker, then
  // split auth vs generic by the provider text. Length-uncapped: provider errors
  // can be long, and the marker already guarantees it's a real error, not prose.
  if (trimmed.startsWith(CLIENT_ERROR_BANNER_PREFIX)) {
    const body = trimmed.slice(CLIENT_ERROR_BANNER_PREFIX.length);
    return CLIENT_AUTH_ERROR_RE.test(body) ? "auth" : "error";
  }
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
