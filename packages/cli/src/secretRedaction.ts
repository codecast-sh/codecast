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
// Shape is not enough for a secret with no recognizable form, so the last step
// replaces exact occurrences of this machine's real secret values
// (knownValueRedaction.ts; empty, and a no-op, outside the daemon).
//
// TODO: expose a per-project opt-out flag once config plumbing exists. On by
// default for now.

import { LABELED_SECRET_SHAPES, SECRET_SHAPES } from "@codecast/shared/contracts/secretShapes";
import { redactKnownValues } from "./knownValueRedaction.js";

type SecretPattern = { re: RegExp; marker: string };

// The shapes live in shared/contracts/secretShapes.ts, which the web composer
// reads too. Labeled shapes keep their group 1 (the label); only the value is
// redacted.
const SECRET_PATTERNS: SecretPattern[] = SECRET_SHAPES.map((s) => ({ re: s.re, marker: `[redacted:${s.id}]` }));
const LABELED_PATTERNS: SecretPattern[] = LABELED_SECRET_SHAPES.map((s) => ({ re: s.re, marker: `[redacted:${s.id}]` }));

function redactLabeled(text: string): string {
  let out = text;
  for (const { re, marker } of LABELED_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (_m, label) => `${label}${marker}`);
  }
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
  return redactKnownValues(redactLabeled(result));
}

/** True if `text` contains at least one high-confidence secret. */
export function containsSecrets(text: string): boolean {
  if (text == null) return false;
  const normalized = typeof text === "string" ? text : String(text);
  return [...SECRET_PATTERNS, ...LABELED_PATTERNS].some(({ re }) => {
    re.lastIndex = 0;
    return re.test(normalized);
  });
}
