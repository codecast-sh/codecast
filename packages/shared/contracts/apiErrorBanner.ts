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

export type ApiErrorBannerKind = "auth" | "limit" | "error" | "connection" | "fatal";

// The kinds that park a session — it won't heal itself, so the row earns the
// amber badge, the fleet banner, and the revive actions. kind "error" is the
// one deliberate exclusion: the CLI is still retrying those on its own.
export const BLOCKED_BANNER_KINDS: ReadonlySet<string> = new Set([
  "auth",
  "limit",
  "connection",
  "fatal",
]);

// The blocked subset a plain "continue" un-parks (auth needs /login or an
// account switch — continuing a signed-out session just re-fails). Default
// selection for continueAllBlocked and the web's continue-all button.
export const CONTINUE_BANNER_KINDS: readonly string[] = ["limit", "connection", "fatal"];

// Auth subset — the user can act by re-running /login. "Login expired" covers
// the CLI's expired-grant banner forms ("Login expired · Please run /login",
// "Login expired · run /login").
const AUTH_BANNER_RE =
  /^(?:please run \/login|login expired\b|not logged in|invalid api key|credit balance is too low|oauth (?:token|authentication))/i;

// Usage/session/spend limit banners. Real-world forms:
//   "You've hit your session limit · resets 11:30pm (America/New_York)"
//   "You've hit your session limit"
//   "You've hit your monthly spend limit · raise it at claude.ai/settings/usage"
//   "You've hit your org's monthly spend limit · ask your admin to raise it at
//    claude.ai/settings/usage?from=cc_cli_limit_message · your session limit
//    resets 7:40pm (America/New_York)" (the org-billed form carries an
//    apostrophe between "your" and "limit")
//   "You've hit your monthly spend limit. Run /usage-credits to manage your
//    limit and keep using Fable 5 or switch models to continue this chat."
//   "You've reached your Fable 5 limit. Run /usage-credits to continue or
//    switch models with /model."
//   "Claude usage limit reached. Your limit will reset at 3am (America/New_York)"
// The `[·∙]`-or-end-of-line requirement after "limit" is what rejects prose
// that merely starts with the same words. The sentence-shaped variants are
// admitted only by their "Run /usage-credits" tail — a CLI slash-command
// reference prose doesn't produce in that position.
const LIMIT_BANNER_RE =
  /^(?:you['’]ve (?:hit|reached) your [\w '’-]{1,40}limit(?:\s*[·∙][^\n]*|\.\s*run \/usage-credits\b[^\n]*)?|claude (?:ai )?usage limit reached\b[^\n]*)$/i;

// Generic provider failure. No status code ("API Error: Connection closed
// mid-response. The response above may be incomplete.", "API Error:
// Connection error.", "API Error: Request timed out.") means the connection
// itself failed and the turn died at the prompt — kind "connection" joins the
// blocked set: a plain "continue" resumes it, same as a limit banner after
// the window resets.
//
// A status code ("API Error: 529 Overloaded", "API Error: 400 {...}") means
// an HTTP response came back, and the kind follows the cure. Statuses the CLI
// retries on its own (408/409/429/5xx) are kind "error" and stay out of the
// blocked set — badging them paints a mid-retry session as blocked. 401/403
// are the provider refusing the credential — /login is the cure, kind "auth".
// Every other status (400 invalid request, 404, 413…) is terminal: the CLI
// gives up and the turn dies at the prompt exactly like a connection drop, so
// kind "fatal" joins the blocked set and a plain "continue" retries it.
const GENERIC_BANNER_RE = /^api error\b/i;
const STATUSFUL_BANNER_RE = /^api error:?\s*\(?(\d{3})\b/i;
const RETRYABLE_STATUS = (status: number): boolean =>
  status === 408 || status === 409 || status === 429 || status >= 500;

// One 429 is not like another. A transient 429 (burst throttling) is retried
// by the CLI and stays kind "error". A subscription-limit 429 carries the
// usage payload — `"type":"exceeded_limit"` with the 5h/7d windows and a
// resets_at — and retrying it is pure waste until the window rolls: it is a
// limit park in JSON clothing, kind "limit". The marker must be the payload's
// own quoted key, never a bare word, so prose that discusses the error type
// can't match; and the body may run past the prose length cap (the payload is
// ~600 chars), so this is judged before it, gated on the statusful prefix and
// the single-line shape a raw dumped response has.
const EXCEEDED_LIMIT_BODY_RE = /"type"\s*:\s*"exceeded_limit"/;

function isExceededLimit429(trimmed: string): boolean {
  const m = trimmed.match(STATUSFUL_BANNER_RE);
  return !!m && Number(m[1]) === 429 && !trimmed.includes("\n") && EXCEEDED_LIMIT_BODY_RE.test(trimmed);
}

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
  if (isExceededLimit429(trimmed)) return "limit";
  if (trimmed.length === 0 || trimmed.length > 400) return null;
  if (AUTH_BANNER_RE.test(trimmed)) return "auth";
  if (LIMIT_BANNER_RE.test(trimmed)) return "limit";
  const statusMatch = trimmed.match(STATUSFUL_BANNER_RE);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 401 || status === 403) return "auth";
    return RETRYABLE_STATUS(status) ? "error" : "fatal";
  }
  if (GENERIC_BANNER_RE.test(trimmed)) return "connection";
  return null;
}

export function isApiErrorBanner(content: string | null | undefined): boolean {
  return classifyApiErrorBanner(content) !== null;
}

// Claude Code's usage/billing interstitials arrive as a MENU, not a banner:
// "What do you want to do?" over rows like "Stop and wait for limit to reset",
// "Switch to usage credits", "Switch to Team plan", "Adjust monthly spend
// limit". The daemon already converts the monthly-spend variant into a banner
// (spendLimitDialogBanner) precisely because answering it is dangerous — the
// keypress that "picks an option" is committing a BILLING change.
//
// The other variants still surface as ordinary AskUserQuestion polls, and the
// decision queue must not offer them as decisions: they are an infrastructure
// park (wait, pay, or switch model), not a judgment call about the work, and a
// queue that advances on a digit press would put a plan change one keystroke
// away. Recognized by the OPTION ROWS rather than the question, which is the
// generic "What do you want to do?" — and requiring TWO matches so a real
// question that merely mentions switching models is not swallowed.
const USAGE_DIALOG_OPTION_RE =
  /(?:wait (?:for|until) (?:the )?limit(?:\s+to)?\s+reset|limit (?:will )?reset|usage credits|monthly spend limit|spend limit|upgrade to (?:max|pro|team)|switch to (?:the )?(?:max|pro|team) plan|switch (?:to )?(?:a (?:different|another) )?model|\/usage-credits|\/upgrade)/i;

export function isUsageLimitDialog(
  optionLabels: readonly string[] | null | undefined
): boolean {
  if (!optionLabels || optionLabels.length === 0) return false;
  let hits = 0;
  for (const label of optionLabels) {
    if (USAGE_DIALOG_OPTION_RE.test(label ?? "")) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

// The client_id every "continue" sent to un-park a blocked session carries,
// whoever sends it: the web's fleet buttons, the server's continueAllBlocked
// (the CLI path), and the daemon's post-switch revive. One shared key is what
// lets the web paint the bubble the instant the user clicks and still have the
// server echo REPLACE it rather than double it — the optimistic prune matches
// on client_id alone. Minute-bucketed: a double-click can't double-queue, a
// deliberate retry a minute later still can.
export function blockedContinueClientId(conversationId: string, at: number): string {
  return `continue-blocked-${conversationId}-${Math.floor(at / 60_000)}`;
}

// Claude Code's no-op assistant row. When a prompt reaches the CLI and no
// model call follows — the resume hook's "Continue from where you left off."
// landing on a session still parked at a limit, or a turn the model declined
// — the CLI writes a `<synthetic>` assistant row with this exact text, at the
// same timestamp as the prompt. It is not a real turn: it says nothing about
// whether a park lifted, and the timeline renders it as nothing. One
// predicate so the park flag (isRealTurn) and the web agree on the row.
export const NO_RESPONSE_STUB = "No response requested.";
export function isNoResponseStub(content: string | null | undefined): boolean {
  return (content ?? "").trim() === NO_RESPONSE_STUB;
}
