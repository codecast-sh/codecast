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

export type ApiErrorBannerKind = "auth" | "limit" | "throttle" | "error" | "connection" | "fatal" | "safety";

export const SAFETY_BANNER_PREFIX = "Safety stop:";
export const CODEX_SAFETY_ERROR_CODE = "misalignment_policy_violation";
export const SAFETY_BLOCK_HINT = "OpenAI stopped this conversation for safety review. Review the recent actions and intended scope. Automatic retries and account switching cannot resolve this block.";

export interface CodexTurnError {
  message?: string;
  code?: string;
  codexErrorInfo?: string | Record<string, unknown>;
  codex_error_info?: string | Record<string, unknown>;
}

// The prose codex shows when a turn is blocked for safety and carries no code.
const CODEX_SAFETY_MESSAGE = "This request was blocked by our safety systems. Reason: Potentially unintended activity.";

// Codex reports a failed turn with a STRUCTURED code — `codex_error_info`, the
// CodexErrorInfo enum in the codex binary (usage_limit_exceeded,
// rate_limit_exceeded, unauthorized, misalignment_policy_violation, …) — next
// to its prose. The code is what we classify on. Provider wording drifts
// release to release and a wording-matched park chain fails SILENTLY when it
// does: on 2026-09-03 an apostrophe in one Claude banner disabled the stamp,
// the switch loop and the pin rewrite at once. Codex's code is part of its wire
// protocol, so it cannot drift the same way. (It is also why the codex limit
// park was invisible: "You've hit your usage limit." — with the trailing period
// — does not match LIMIT_BANNER_RE, and never would have.)
//
// Only the codes whose cure codecast implements are mapped. Everything else
// falls through to the marked client-error path, which reads the prose and
// stays kind "auth" or "error" exactly as before.
const CODEX_ERROR_KIND: Readonly<Record<string, ApiErrorBannerKind>> = {
  // The plan window is spent. Retrying burns requests until it rolls, so this
  // is the park the recovery loop, the reset credit and the wait exist for.
  usage_limit_exceeded: "limit",
  // The per-minute cap, NOT the plan window — the same split Claude draws
  // between a quota park and a burst 429. Rotating accounts on this reproduces
  // the burst on the fresh account, so it must never be read as "limit".
  rate_limit_exceeded: "throttle",
  [CODEX_SAFETY_ERROR_CODE]: "safety",
  // CyberPolicy sits beside MisalignmentPolicyViolation in the same
  // CodexErrorInfo enum and stops the turn the same way: the provider refused
  // the request as possible security work. No retry and no account switch
  // clears it, which is exactly what kind "safety" means, so these rows earn
  // the badge and SAFETY_BLOCK_HINT instead of a silent "error".
  cyber_policy: "safety",
};

// codex spells the enum snake_case on the wire; some transports carry the Rust
// variant name instead. One normalization so the map has one key per code.
function normalizeCodexErrorCode(raw: string): string {
  return raw.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function carriedCodexErrorCode(error: CodexTurnError) {
  return error.codexErrorInfo ?? error.codex_error_info ?? error.code;
}

/** The normalized code codex carried, or null when it carried none (or carried
 *  a shape that is not a code). More than one code now means kind "safety", so
 *  a caller that NAMES the stop has to read the code that actually fired
 *  rather than assume the one safety code there used to be. */
export function codexErrorCode(error: CodexTurnError | null | undefined): string | null {
  const raw = error ? carriedCodexErrorCode(error) : undefined;
  return typeof raw === "string" ? normalizeCodexErrorCode(raw) : null;
}

/** The banner kind a codex turn error means, or null when codex reported
 *  something we have no cure for (the caller then falls back to the marked
 *  client-error banner, which classifies off the provider text). */
export function codexErrorKind(error: CodexTurnError | null | undefined): ApiErrorBannerKind | null {
  if (!error) return null;
  const raw = carriedCodexErrorCode(error);
  // A carried code is the whole answer. Never fall back to prose when codex
  // said what happened — not even for a code we do not map.
  if (raw != null) return CODEX_ERROR_KIND[codexErrorCode(error) ?? ""] ?? null;
  return error.message?.trim() === CODEX_SAFETY_MESSAGE ? "safety" : null;
}

export function isCodexSafetyError(error: CodexTurnError | null | undefined): boolean {
  return codexErrorKind(error) === "safety";
}

export function withSafetyBlock<T extends { session_error?: string | null; pending_api_error?: boolean | null; pending_api_error_kind?: string | null }>(session: T): T {
  if (!isCodexSafetyError({ message: session.session_error ?? undefined })) return session;
  if (session.pending_api_error === true && session.pending_api_error_kind === "safety") return session;
  return { ...session, pending_api_error: true, pending_api_error_kind: "safety" };
}

// The kinds that park a session — it won't heal itself, so the row earns the
// amber badge, the fleet banner, and the revive actions. kind "error" is the
// one deliberate exclusion: the CLI is still retrying those on its own.
export const BLOCKED_BANNER_KINDS: ReadonlySet<string> = new Set([
  "auth",
  "limit",
  "throttle",
  "connection",
  "fatal",
  "safety",
]);

// The blocked subset a plain "continue" un-parks (auth needs /login or an
// account switch — continuing a signed-out session just re-fails). Default
// selection for continueAllBlocked and the web's continue-all button.
export const CONTINUE_BANNER_KINDS: readonly string[] = ["limit", "throttle", "connection", "fatal"];

// Which park kinds each agent's recovery chain can actually act on. One rule
// rather than a per-agent branch: a row counts as blocked only when something
// downstream knows how to un-park it, so the badge, the fleet banner and the
// revive actions never name a session nothing will come back for.
//
// claude_code earns every blocked kind — the switch loop, the paced throttle
// continue and the revive actions are all built on its account inventory.
//
// codex earns the kinds whose cure needs no Claude credential. "limit" is the
// plan window: a plain continue once it rolls, or a reset credit redeemed on
// the same account (codex account SWITCHING does not exist yet, so the
// recovery loop runs the codex decision with switching off). "throttle" is the
// per-minute cap, healed by the same paced continue. "safety" is a park with
// no cure at all — it earns the badge and the hint, and every revive filters
// it out. Auth is deliberately absent: a codex login is not fixed by the
// Claude credential the auth branch swaps.
const BLOCKED_KINDS_BY_AGENT: Readonly<Record<string, ReadonlySet<string>>> = {
  claude_code: BLOCKED_BANNER_KINDS,
  codex: new Set(["limit", "throttle", "safety"]),
};
const NO_BLOCKED_KINDS: ReadonlySet<string> = new Set();

export function blockedKindsForAgent(agentType: string | null | undefined): ReadonlySet<string> {
  return BLOCKED_KINDS_BY_AGENT[agentType ?? ""] ?? NO_BLOCKED_KINDS;
}

// Burst throttle. Claude Code renders a transient 429 — the provider's "This
// request would exceed your account's rate limit. Please try again later."
// (a per-minute cap, hit when many sessions resume at once) — with the SAME
// words as a real weekly exhaustion: "You've reached your Fable limit. Run
// /usage-credits …" or "You've hit your monthly spend limit …". Read as kind
// "limit", that park sent the auto-switch loop rotating accounts and reviving
// every parked session in one burst, which reproduced the 429 on the fresh
// account (2026-09-04: 44 banners across two rotations while every account
// sat at 0%). The JSONL entry still carries the raw error (`apiErrorStatus`,
// `errorDetails`); only the daemon's parser sees it, so the parser rewrites
// the banner into this marked form and everything downstream — the server
// stamp, the switch loop, the web card — reads kind "throttle": blocked (the
// turn died at the prompt), healed by a plain continue after a short wait,
// never by an account switch.
export const THROTTLE_BANNER_PREFIX = "Rate limited ·";
const THROTTLE_BANNER_RE = /^rate limited ·/i;
// The provider's transient rate-limit wording. A quota exhaustion carries the
// exceeded_limit payload instead (see EXCEEDED_LIMIT_BODY_RE) and stays "limit".
const TRANSIENT_RATE_LIMIT_RE = /would exceed your account['’]s rate limit/i;

/** Is this API-error banner entry a burst throttle rather than a quota park?
 * Judged from the JSONL entry's own fields, never the rendered words. */
export function isTransientRateLimit429(
  status: number | null | undefined,
  errorDetails: string | null | undefined,
): boolean {
  if (status !== 429 || !errorDetails) return false;
  if (EXCEEDED_LIMIT_BODY_RE.test(errorDetails)) return false;
  return TRANSIENT_RATE_LIMIT_RE.test(errorDetails);
}

/** The marked banner the parser stores for a burst throttle. One line, under
 * the prose cap, keeps the CLI's own words as the tail so the card can still
 * say what the pane showed. */
export function throttleBannerContent(shownAs: string | null | undefined, shownBy = "Claude Code"): string {
  const shown = (shownAs ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return `${THROTTLE_BANNER_PREFIX} the request burst exceeded the account's per-minute rate limit · retried automatically${shown ? ` · ${shownBy} showed: ${shown}` : ""}`;
}

// The canonical limit-park banner. A provider that reports its quota park as a
// CODE rather than in codecast's banner words (codex: usage_limit_exceeded)
// gets rewritten into this form by the parser that saw the code, exactly as a
// burst 429 is rewritten into the throttle form above. Downstream — the server
// stamp, the recovery loop, the web card — then reads one shape for "the plan
// window is spent", whoever the provider was. The text is ours, so the regex
// that matches it (LIMIT_BANNER_RE) is matching a contract we control rather
// than prose that can drift.
export const LIMIT_BANNER_PREFIX = "You've hit your usage limit";

export function limitBannerContent(shownAs: string | null | undefined): string {
  const shown = (shownAs ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return shown ? `${LIMIT_BANNER_PREFIX} · ${shown}` : LIMIT_BANNER_PREFIX;
}

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

// A codex plan-window park recorded BEFORE codecast learned to read the
// structured code (ct-49676). Those turns kept only the provider's prose,
// wrapped in the marked client-error banner, so they classify as "error" and
// no recovery ever looks at them; they do not heal on a re-classify either,
// because the code they would need was never stored. This is the one form
// that can be recovered from the text alone.
//
// Matching prose is safe HERE and nowhere else: the marker above is written
// only by the client's own error parser for a failed turn, so the body is a
// provider error rather than a chat turn that merely mentions a limit. That
// is the same guarantee CLIENT_AUTH_ERROR_RE already leans on.
//
// The usage-limit sentence ALONE must not mean "limit": codex sends the very
// same "You've hit your usage limit." for rate_limit_exceeded, the per-minute
// cap, which has to stay "throttle" — reading a burst as a quota park is what
// sent the fleet rotating accounts on 2026-09-04. What separates them is the
// remedy. Only a spent plan window is cured by buying credits, and codex's own
// per-minute prose (read out of the 0.153.4 binary) offers "Try again in
// <duration>" or "Upgrade to Pro (openai.com/chatgpt/pricing)" — it never
// names credits. So the purchase clause, not the sentence, is the evidence.
const CODEX_PLAN_WINDOW_BODY_RE =
  /you['’]ve hit your usage limit\b[\s\S]{0,240}?purchase more credits/i;

export function classifyApiErrorBanner(
  content: string | null | undefined,
): ApiErrorBannerKind | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (trimmed.startsWith(SAFETY_BANNER_PREFIX) || isCodexSafetyError({ message: trimmed })) return "safety";
  if (/^api error:?\s*\(?403\b/i.test(trimmed) && /"code"\s*:\s*"misalignment_policy_violation"/.test(trimmed)) return "safety";
  // Marked client-error messages (opencode/pi) — gate on the exact marker, then
  // split auth vs generic by the provider text. Length-uncapped: provider errors
  // can be long, and the marker already guarantees it's a real error, not prose.
  if (trimmed.startsWith(CLIENT_ERROR_BANNER_PREFIX)) {
    const body = trimmed.slice(CLIENT_ERROR_BANNER_PREFIX.length);
    if (CODEX_PLAN_WINDOW_BODY_RE.test(body)) return "limit";
    return CLIENT_AUTH_ERROR_RE.test(body) ? "auth" : "error";
  }
  if (THROTTLE_BANNER_RE.test(trimmed) && !trimmed.includes("\n")) return "throttle";
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
