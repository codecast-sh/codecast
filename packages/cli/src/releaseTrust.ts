// What a release must carry for this CLI to install it: where releases come
// from, the Apple team that signs every darwin binary, and the keys that may
// vouch for latest.json. Side-effect free, so the compiled updater (update.ts),
// the watchdog's shell fallback (supervision.ts) and host installs
// (hosts/installRelease.ts) read one definition.

import { isManifestSignatureFile, verifyDetached, type ManifestSigningPolicy } from "@platform/cli-kit/update";

export const RELEASE_BASE_URL = "https://dl.codecast.sh";

/** The Apple team every darwin release is signed by (CI and the laptop path). */
export const DARWIN_SIGNING_TEAM = "WRG9THCK9Q";

/**
 * Public keys that may vouch for latest.json, by key id. Every publish signs
 * with cli-release-2026, the finalize workflow and scripts/deploy.sh alike
 * (custody in docs/architecture/release-signing.md), so a manifest no pinned
 * key vouches for is refused: whoever can write the release bucket still
 * cannot choose what this client installs.
 */
export const RELEASE_MANIFEST_SIGNING: ManifestSigningPolicy = {
  keys: { "cli-release-2026": "4f1kzY89/uJGGB+hvoONtVag56qy1gOkVxhMzLdEc5M=" },
  required: true,
};

/**
 * Whether latest.json's exact bytes carry a valid signature by a pinned key,
 * given the text of latest.json.sig (null when there is none). The sync form
 * of the updater's check, for callers that read the manifest with curl.
 */
export function manifestSignedByPinnedKey(manifestBytes: Uint8Array, signatureText: string | null, policy: ManifestSigningPolicy = RELEASE_MANIFEST_SIGNING): boolean {
  if (!signatureText) return false;
  let file: unknown;
  try {
    file = JSON.parse(signatureText);
  } catch {
    return false;
  }
  if (!isManifestSignatureFile(file)) return false;
  return file.signatures.some((s) => policy.keys[s.keyId] !== undefined && verifyDetached(manifestBytes, s.sig, policy.keys[s.keyId]!));
}

const shQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const pinned = Object.entries(RELEASE_MANIFEST_SIGNING.keys).map(([id, key]) => shQuote(`${id}=${key}`)).join(" ");

/** The same check in sh, for scripts that run where this binary does not: \`manifest_signed DIR\` (and its \`b64decode\` helper). */
export const MANIFEST_SIGNED_SH = `b64decode() { base64 -d 2>/dev/null || base64 -D; }

# Is DIR/latest.json signed by a pinned key, per DIR/latest.json.sig? Needs an
# openssl that speaks Ed25519 (OpenSSL 3; macOS's LibreSSL does not).
manifest_signed() {
  for ENTRY in ${pinned}; do
    KEY_ID="\$(printf '%s' "\$ENTRY" | cut -d= -f1)"; KEY_B64="\$(printf '%s' "\$ENTRY" | cut -d= -f2-)"
    SIG_B64="\$(tr -d ' \\t\\r\\n' < "\$1/latest.json.sig" | tr '}' '\\n' | grep -F "\\"keyId\\":\\"\$KEY_ID\\"" | sed -n 's|.*"sig":"\\([A-Za-z0-9+/=]*\\)".*|\\1|p' | head -n 1)"
    [ -n "\$SIG_B64" ] || continue
    printf '%s' "\$SIG_B64" | b64decode > "\$1/sig.bin" 2>/dev/null || continue
    # The DER prefix of an Ed25519 public key, then its 32 raw bytes.
    { printf '\\060\\052\\060\\005\\006\\003\\053\\145\\160\\003\\041\\000'; printf '%s' "\$KEY_B64" | b64decode; } > "\$1/key.der" 2>/dev/null || continue
    openssl pkeyutl -verify -pubin -keyform DER -inkey "\$1/key.der" -rawin -in "\$1/latest.json" -sigfile "\$1/sig.bin" >/dev/null 2>&1 && return 0
  done
  return 1
}`;

/**
 * \`not_older_than A B\`: succeeds when A is a dotted numeric version and not
 * older than B, compared field by field as cmpVersions does
 * (packages/electron/updatePolicy.js, which the parity test runs it against).
 * The sh form is for scripts that run where this binary cannot.
 */
export const VERSION_FLOOR_SH = `not_older_than() {
  printf '%s' "\$1" | grep -Eq '^[0-9]+(\\.[0-9]+)*\$' || return 1
  awk -v a="\$1" -v b="\$2" 'BEGIN { n = split(a, x, "."); m = split(b, y, "."); k = n > m ? n : m; for (i = 1; i <= k; i++) { p = x[i] + 0; q = y[i] + 0; if (p > q) exit 0; if (p < q) exit 1 } exit 0 }'
}`;
