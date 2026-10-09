// Patterns that mean a file holds a live credential, shared by the cloud
// mirror (cloud/mirror) and `cast ship checkout` (land/shipCheckout.ts).
// Only the unambiguous ones live here: a private key block, a vendor token
// with its prefix, a file named like a credential store.
import * as path from "node:path";

export const PRIVATE_KEY_RE = /^\s*-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/m;
export const VENDOR_TOKEN_RE = /\b(?:sk-ant-[A-Za-z0-9_-]{24,}|sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{24,}|(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{35})\b/;
const CREDENTIAL_FILE_NAMES = ["auth.json", ".credentials.json", "oauth_creds.json", "google_accounts.json", "hosts.yml", ".netrc", ".npmrc", ".pgpass", "pass.txt", "passwords.txt", "passwords.csv"];

/** A path named like a credential store: .env files, keys, token files. */
export function isCredentialFilePath(rel: string): boolean {
  return /(?:^|\/)\.env(?:\.[^/]*)?$/.test(rel)
    || /\.(?:pem|key|p8|p12|pfx|der|jks|keystore|kdbx|1password|keychain(?:-db)?)$/i.test(rel)
    || CREDENTIAL_FILE_NAMES.includes(path.posix.basename(rel).toLowerCase());
}

/** A vendor-shaped token written by hand for a test or a doc: an alphabet run, a repeated character, a placeholder word. */
export function isPlaceholderToken(token: string): boolean {
  const t = token.toLowerCase();
  return /abcdefgh|bcdefghi|01234567|12345678|(.)\1{5,}/.test(t) || /fake|example|dummy|redacted|placeholder|test|sample|your|xxxx|changeme/.test(t);
}

/** The first vendor token in `text` that looks live, or null. */
export function liveVendorToken(text: string): string | null {
  for (const m of text.matchAll(new RegExp(VENDOR_TOKEN_RE.source, "g"))) {
    if (!isPlaceholderToken(m[0])) return m[0];
  }
  return null;
}
