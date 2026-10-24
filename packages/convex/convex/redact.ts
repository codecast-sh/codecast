import { LABELED_SECRET_SHAPES, SECRET_SHAPES } from "@codecast/shared/contracts/secretShapes";

// The server's last pass over text from any client (messages, titles). Vendor
// tokens, private key blocks and labeled secrets are secretShapes', the list
// the CLI's transcript redaction and the composer read, so the three agree on
// every vendor token. On top sit broader nets only the server casts: any
// credential-named assignment of 8+ characters, an api_key label, a Bearer
// token without a digit, and public key blocks.
const MARKER = "[REDACTED_API_KEY]";

const NETS = [
  /api[_-]?key[=:]\s*["']?[a-zA-Z0-9_-]{20,}["']?/gi,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
  // A right hand side that is already a redaction marker (the CLI's
  // `[redacted:known:NAME]`, or this function's own output) is not a secret:
  // matching it would replace a labeled marker with an unlabeled one.
  /(?:^|[^a-zA-Z])[a-zA-Z_]*(?:_SECRET|_TOKEN|_KEY|_PASSWORD|_CREDENTIAL|API_KEY|SECRET_KEY)[a-zA-Z_]*[=:]\s*["']?(?!\[redacted:|\[REDACTED)[^\s"']{8,}["']?/gi,
  /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|PUBLIC)\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?(?:PRIVATE|PUBLIC)\s+KEY-----/g,
];

export function redactSecrets(content: string): string {
  let result = content;
  for (const { re } of SECRET_SHAPES) {
    re.lastIndex = 0;
    result = result.replace(re, MARKER);
  }
  // A labeled shape keeps its label (group 1); only the value goes.
  for (const { re } of LABELED_SECRET_SHAPES) {
    re.lastIndex = 0;
    result = result.replace(re, (_m, label) => `${label}${MARKER}`);
  }
  for (const re of NETS) {
    re.lastIndex = 0;
    result = result.replace(re, MARKER);
  }
  return result;
}
