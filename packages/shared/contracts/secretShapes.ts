// The shapes a credential takes in text: vendor tokens with their prefix,
// PEM private key blocks, and an opaque value after a strongly secret-named
// label (`SESSION_SECRET=…`, `Bearer …`). Transcript redaction
// (cli/src/secretRedaction.ts) replaces each with `[redacted:<id>]`, and the
// web composer offers to move one into the Vault before a message carries it
// (components/secrets/ComposerCatch.tsx), so both recognise exactly the same
// strings. Pure and isomorphic.
//
// Every regex is global. Callers either reset lastIndex before using one
// (redaction's replace loop) or go through matchAll, which copies it.
//
// Every regex is linear in its input: redaction runs on each transcript line
// and tool output, and the composer on each send, so a minified bundle or a
// long query string must not stall them. A pattern that tries a start inside
// a long unspaced run and scans to the run's end before failing is quadratic,
// so each such scan is bounded, or a start inside a run is refused
// (secretShapes.test.ts times the shapes that once were).

export type SecretShape = {
  /** The redaction marker's kind, `[redacted:<id>]`. */
  id: string;
  re: RegExp;
  /** What a person calls it: "Stripe secret key". */
  label: string;
  /** A Vault name for the matched value: `stripe-test`. */
  name: (value: string) => string;
  /** The env var `cast vault run` should set for it. */
  env?: string;
};

// Order matters only for clean labeling of overlapping shapes (more specific
// first); correctness does not depend on it.
export const SECRET_SHAPES: SecretShape[] = [
  // PEM private key blocks: highest value, effectively zero false positives.
  // The body stops at the next BEGIN, so a run of BEGIN lines with no END
  // scans each stretch once.
  {
    id: "private-key",
    re: /-----BEGIN [A-Z0-9 ]{0,40}?PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z0-9 ]{0,40}?PRIVATE KEY-----/g,
    label: "Private key",
    name: () => "private-key",
  },
  // JSON Web Tokens: header.payload.signature, each a base64url segment.
  // Requires two dots, which base64 image data / hashes never contain. It
  // starts only where a base64url run starts, so `-eyJ…` repeated without a
  // dot is one failed scan, not one per repeat.
  {
    id: "jwt",
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    label: "JSON web token",
    name: () => "jwt",
  },
  // AWS access key id (long-term AKIA / temporary ASIA). Exactly 20 chars,
  // bounded both sides so it can't match a slice of a longer base64 blob.
  {
    id: "aws-access-key",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    label: "AWS access key ID",
    name: () => "aws-access-key",
    env: "AWS_ACCESS_KEY_ID",
  },
  // GitHub fine-grained PAT.
  {
    id: "github-token",
    re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
    label: "GitHub token",
    name: () => "github-token",
    env: "GITHUB_TOKEN",
  },
  // GitHub classic PAT + OAuth / user-to-server / server / refresh tokens (36-char body).
  {
    id: "github-token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g,
    label: "GitHub token",
    name: () => "github-token",
    env: "GITHUB_TOKEN",
  },
  // Slack bot / user / app / refresh / legacy tokens.
  {
    id: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    label: "Slack token",
    name: () => "slack-token",
    env: "SLACK_TOKEN",
  },
  {
    id: "slack-webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\/+-]{10,}/g,
    label: "Slack webhook URL",
    name: () => "slack-webhook",
    env: "SLACK_WEBHOOK_URL",
  },
  {
    id: "discord-webhook",
    re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{10,}\/[A-Za-z0-9_-]{10,}/g,
    label: "Discord webhook URL",
    name: () => "discord-webhook",
    env: "DISCORD_WEBHOOK_URL",
  },
  // Stripe secret key, live or test mode.
  {
    id: "stripe-secret-key",
    re: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}/g,
    label: "Stripe secret key",
    name: (v) => (v.startsWith("sk_live_") ? "stripe-live" : "stripe-test"),
    env: "STRIPE_SECRET_KEY",
  },
  {
    id: "google-api-key",
    re: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    label: "Google API key",
    name: () => "google-api-key",
    env: "GOOGLE_API_KEY",
  },
  // Anthropic API key: sk-ant-api03- and a base64url body, so `_` and `-`
  // fall anywhere in it.
  {
    id: "anthropic-key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    label: "Anthropic API key",
    name: () => "anthropic",
    env: "ANTHROPIC_API_KEY",
  },
  {
    id: "openrouter-key",
    re: /\bsk-or-v1-[A-Za-z0-9]{32,}/g,
    label: "OpenRouter API key",
    name: () => "openrouter",
    env: "OPENROUTER_API_KEY",
  },
  // OpenAI project, service account and admin keys.
  {
    id: "openai-key",
    re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/g,
    label: "OpenAI API key",
    name: () => "openai",
    env: "OPENAI_API_KEY",
  },
  // OpenAI legacy key: sk- followed by exactly 48 alnum chars. The strict
  // length avoids eating short `sk-...` fragments that appear in prose.
  {
    id: "openai-key",
    re: /\bsk-[A-Za-z0-9]{48}\b/g,
    label: "OpenAI API key",
    name: () => "openai",
    env: "OPENAI_API_KEY",
  },
  // Any other `sk-` key with an unbroken 20+ character body (DeepSeek and the
  // other OpenAI-style APIs). The vendor shapes above label theirs first.
  {
    id: "api-key",
    re: /\bsk-[A-Za-z0-9]{20,}/g,
    label: "API key",
    name: () => "api-key",
  },
];

/**
 * "This text holds a vendor token": every shape above but the PEM block and
 * the JWT, which a file scan checks on its own terms or not at all. The cloud
 * mirror and `cast ship checkout` (cli/src/secretPatterns.ts) read it, so a
 * token transcript redaction knows is one they refuse to carry. Not global.
 */
export const VENDOR_TOKEN_RE = new RegExp(
  SECRET_SHAPES.filter((s) => s.id !== "private-key" && s.id !== "jwt").map((s) => `(?:${s.re.source})`).join("|"),
);

/** A secret that follows a label. Group 1 (the variable name and its
 *  operator, `Bearer `, a URL path prefix) is not part of the secret. */
export type LabeledSecretShape = Omit<SecretShape, "label" | "name" | "env"> & {
  label: (prefix: string) => string;
  name: (prefix: string) => string;
  env?: (prefix: string) => string | undefined;
};

const assignedVar = (prefix: string) => /^[A-Za-z0-9_-]+/.exec(prefix)?.[0] ?? "";

export const LABELED_SECRET_SHAPES: LabeledSecretShape[] = [
  // Opaque secret assigned to a strongly secret-named variable: the .env-dump
  // case no vendor prefix matches. Guards against eating code: the name ends
  // in a strong secret word (bare `KEY` is deliberately excluded, so
  // FOREIGN_KEY/PRIMARY_KEY are ignored), and the value must be 16+ non-space
  // chars that include a digit within the first 200; plain identifiers
  // (`users_id`) have none. The digit's bound keeps `TOKEN=` repeated over a
  // long unspaced run from scanning to its end from every start.
  {
    id: "secret-assignment",
    re: /\b([A-Za-z0-9_-]{0,40}(?:SECRET|PASSWORD|PASSWD|CREDENTIALS?|TOKEN|ACCESS[_-]?KEY|API[_-]?KEY|PRIVATE[_-]?KEY)\s*[=:]\s*["'`]?)(?=[^\s"'`]{0,200}\d)[A-Za-z0-9][^\s"'`]{15,}/gi,
    label: (p) => assignedVar(p),
    name: (p) => assignedVar(p).toLowerCase().replace(/[_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, ""),
    env: (p) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(assignedVar(p)) ? assignedVar(p) : undefined),
  },
  // `Bearer <token>` in a header/curl, in RFC 6750's token alphabet with its
  // trailing `=` padding. Digit-guarded so `Bearer someVariable` in a code
  // discussion (no digit) is left alone.
  {
    id: "bearer-token",
    re: /\b(Bearer\s+)(?=[A-Za-z0-9._~+\/-]{0,200}\d)[A-Za-z0-9._~+\/-]{20,}=*/g,
    label: () => "Bearer token",
    name: () => "bearer-token",
  },
  // The cast browser bridge token (32 random bytes as hex) in the two shapes
  // the CLI prints it: `token  <hex>` from `extension setup --show-token`,
  // and the bridge host's browser socket URL `/devtools/browser/<hex>`.
  // Chrome's own socket URLs end in a dashed UUID, which never matches.
  {
    id: "bridge-token",
    re: /\b(token\s+)[0-9a-f]{64}\b/gi,
    label: () => "Browser bridge token",
    name: () => "browser-bridge-token",
  },
  {
    id: "bridge-token",
    re: /(\/devtools\/browser\/)[0-9a-f]{64}\b/g,
    label: () => "Browser bridge token",
    name: () => "browser-bridge-token",
  },
];

export type FoundSecret = {
  id: string;
  label: string;
  /** The credential itself; a labeled shape's label is outside it. */
  value: string;
  start: number;
  end: number;
  name: string;
  env?: string;
};

/**
 * Every credential-shaped string in `text`, in order, none overlapping. A
 * vendor token assigned to a named variable (`STRIPE_SECRET_KEY=sk_test_…`)
 * is found once, as the vendor shape, and keeps the variable as its env var.
 */
export function findSecrets(text: string): FoundSecret[] {
  const found: FoundSecret[] = [];
  const overlaps = (s: number, e: number) => found.find((f) => s < f.end && f.start < e);
  for (const shape of SECRET_SHAPES) {
    for (const m of text.matchAll(shape.re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      found.push({ id: shape.id, label: shape.label, value: m[0], start, end, name: shape.name(m[0]), env: shape.env });
    }
  }
  for (const shape of LABELED_SECRET_SHAPES) {
    for (const m of text.matchAll(shape.re)) {
      const prefix = m[1] ?? "";
      const start = m.index! + prefix.length;
      const end = m.index! + m[0].length;
      const env = shape.env?.(prefix);
      const inner = overlaps(start, end);
      if (inner) {
        if (env && inner.start === start) inner.env = env;
        continue;
      }
      found.push({ id: shape.id, label: shape.label(prefix), value: m[0].slice(prefix.length), start, end, name: shape.name(prefix), env });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** What a message carries in place of a value saved to the Vault: enough for an agent to use it. */
export function vaultReference(name: string, vars: string[]): string {
  return `[vault secret ${name}: \`cast vault run ${name} -- <command>\` sets ${vars.join(" and ")}]`;
}

/** `text` with each found value replaced by its reference, back to front so offsets hold. */
export function replaceSecrets(text: string, swaps: { start: number; end: number; with: string }[]): string {
  let out = text;
  for (const s of [...swaps].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.with + out.slice(s.end);
  return out;
}
