// Conservative, high-confidence secret redaction applied to transcript text
// BEFORE it syncs to the shared server / public share links. The local
// ~/.claude/**/*.jsonl source is never touched, so redaction is always
// recoverable for the local user; only the synced copy is scrubbed.
//
// Design: prefix/structure-anchored patterns for known vendor tokens (near-zero
// false positives), PLUS a tightly-guarded assignment matcher for the opaque
// .env-dump case (SESSION_SECRET=…, DB_PASSWORD=…, MY_ACCESS_TOKEN=…) that no
// vendor prefix catches — this is the primary secret-leak shape in transcripts,
// so dropping it would be a coverage regression. The assignment matcher avoids
// eating legitimate code two ways: the variable name must contain a STRONG
// secret word (SECRET/PASSWORD/TOKEN/CREDENTIAL/…_KEY) — never a bare `KEY`, so
// `FOREIGN_KEY: id` / `PRIMARY_KEY = col` are ignored — and the value must be a
// single token of 16+ chars that CONTAINS A DIGIT, which plain identifiers
// (`users_id`, `column_name`) don't. Every replacement is a fixed typed marker
// (the variable name/label is preserved), so the function is deterministic and
// idempotent (re-running over already-redacted text is a no-op — the markers
// contain no digit and don't start with an alnum value), keeping message_uuid
// dedup / re-sync stable.
//
// TODO: expose a per-project opt-out flag once config plumbing exists. On by
// default for now.

type SecretPattern = { re: RegExp; marker: string };

// Order matters only for clean labeling of overlapping shapes (more specific
// first); correctness does not depend on it. All regexes are global.
const SECRET_PATTERNS: SecretPattern[] = [
  // PEM private key blocks — highest value, effectively zero false positives.
  {
    re: /-----BEGIN [A-Z0-9 ]*?PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*?PRIVATE KEY-----/g,
    marker: "[redacted:private-key]",
  },
  // JSON Web Tokens: header.payload.signature, each a base64url segment.
  // Requires two dots, which base64 image data / hashes never contain.
  {
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    marker: "[redacted:jwt]",
  },
  // AWS access key id (long-term AKIA / temporary ASIA). Exactly 20 chars,
  // bounded both sides so it can't match a slice of a longer base64 blob.
  {
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    marker: "[redacted:aws-access-key]",
  },
  // GitHub fine-grained PAT.
  {
    re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
    marker: "[redacted:github-token]",
  },
  // GitHub classic PAT + OAuth / server / refresh tokens (36-char body).
  {
    re: /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{36}\b/g,
    marker: "[redacted:github-token]",
  },
  // Slack bot / user / app / refresh / legacy tokens.
  {
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    marker: "[redacted:slack-token]",
  },
  // Slack incoming webhook URL.
  {
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\/+-]{10,}/g,
    marker: "[redacted:slack-webhook]",
  },
  // Discord webhook URL.
  {
    re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{10,}\/[A-Za-z0-9_-]{10,}/g,
    marker: "[redacted:discord-webhook]",
  },
  // Stripe live secret key.
  {
    re: /\bsk_live_[A-Za-z0-9]{24,}/g,
    marker: "[redacted:stripe-secret-key]",
  },
  // Google API key.
  {
    re: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    marker: "[redacted:google-api-key]",
  },
  // Anthropic API key (distinctive sk-ant- prefix).
  {
    re: /\bsk-ant-[A-Za-z0-9-]{20,}/g,
    marker: "[redacted:anthropic-key]",
  },
  // OpenAI project key.
  {
    re: /\bsk-proj-[A-Za-z0-9_-]{40,}/g,
    marker: "[redacted:openai-key]",
  },
  // OpenAI legacy key: sk- followed by exactly 48 alnum chars. The strict
  // length avoids eating short `sk-...` fragments that appear in prose.
  {
    re: /\bsk-[A-Za-z0-9]{48}\b/g,
    marker: "[redacted:openai-key]",
  },
];

// Opaque secret assigned to a strongly secret-named variable — the .env-dump case
// that no vendor prefix above matches. Group 1 (name + operator + optional opening
// quote) is preserved; only the value is redacted. Guards against eating code: the
// name ends in a strong secret word (bare `KEY` is deliberately excluded, so
// FOREIGN_KEY/PRIMARY_KEY are ignored), and the value must be 16+ non-space chars
// that include a digit — plain identifiers (`users_id`) have none.
const SECRET_ASSIGNMENT_RE =
  /\b([A-Za-z0-9_-]{0,40}(?:SECRET|PASSWORD|PASSWD|CREDENTIALS?|TOKEN|ACCESS[_-]?KEY|API[_-]?KEY|PRIVATE[_-]?KEY)\s*[=:]\s*["'`]?)(?=[^\s"'`]*\d)[A-Za-z0-9][^\s"'`]{15,}/gi;
// `Bearer <token>` in a header/curl. Digit-guarded so `Bearer someVariable` in a
// code discussion (no digit) is left alone; real bearer tokens contain digits.
const BEARER_RE = /\b(Bearer\s+)(?=[A-Za-z0-9._-]*\d)[A-Za-z0-9._-]{20,}/g;

function redactAssignments(text: string): string {
  let out = text.replace(SECRET_ASSIGNMENT_RE, (_m, label) => `${label}[redacted:secret-assignment]`);
  out = out.replace(BEARER_RE, (_m, label) => `${label}[redacted:bearer-token]`);
  return out;
}

/** Replace high-confidence secrets in `text` with typed markers. Pure. */
export function redactSecrets(text: string): string {
  if (text == null) return "";
  let result = typeof text === "string" ? text : String(text);
  for (const { re, marker } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    result = result.replace(re, marker);
  }
  return redactAssignments(result);
}

/** True if `text` contains at least one high-confidence secret. */
export function containsSecrets(text: string): boolean {
  if (text == null) return false;
  const normalized = typeof text === "string" ? text : String(text);
  const prefixHit = SECRET_PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(normalized);
  });
  if (prefixHit) return true;
  SECRET_ASSIGNMENT_RE.lastIndex = 0;
  BEARER_RE.lastIndex = 0;
  return SECRET_ASSIGNMENT_RE.test(normalized) || BEARER_RE.test(normalized);
}
