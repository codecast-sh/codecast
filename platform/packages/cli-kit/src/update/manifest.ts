/** The shape of latest.json. One entry per platform key, each with a URL and
 *  the SHA-256 of the bytes at that URL. Produced by release/build-binaries.sh
 *  plus release/upload-binaries.sh and by the finalize workflow. */
export interface ReleaseManifest {
  version: string;
  released: string;
  /** Source commit the binaries were built from, when the pipeline records it. */
  sourceCommit?: string;
  binaries: Record<string, BinaryEntry>;
}

export interface BinaryEntry {
  url: string;
  sha256: string;
  /** Byte length of the asset, when the pipeline records it. Bounded before download. */
  size?: number;
}

/** A version string the manifest may carry: dotted numerals with an optional
 *  prerelease tag. Short, so a version can be logged and compared and nothing
 *  else. "1.2.3", "1.2.3-beta.4". */
export const VERSION_PATTERN = /^\d{1,6}(\.\d{1,6}){0,3}(-[0-9A-Za-z.-]{1,32})?$/;

export function isReleaseManifest(value: unknown): value is ReleaseManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  if (typeof m.version !== "string" || !VERSION_PATTERN.test(m.version)) return false;
  if (!m.binaries || typeof m.binaries !== "object") return false;
  for (const entry of Object.values(m.binaries as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.url !== "string" || typeof e.sha256 !== "string") return false;
    if (e.size !== undefined && typeof e.size !== "number") return false;
  }
  return true;
}

// ── trust checks on one binary entry ────────────────────────────────────────
//
// The manifest names where the bytes are and what they hash to. Before any of
// it reaches a download, the entry has to be something the updater would have
// produced itself: an https URL on the release origin whose path is plain
// asset characters, a bare hex digest, and a size inside the bound. Anything
// else is data the manifest source chose, and the updater refuses to act on
// it rather than pass it to a transport.

export const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** Characters an asset path may contain: RFC 3986 unreserved plus "/".
 *  Percent escapes are refused too, so a path cannot smuggle a dot segment
 *  or a delimiter past the check. */
const SAFE_PATH = /^\/[A-Za-z0-9._~/-]*$/;

export type BinaryCheckError =
  | "url_not_https"
  | "url_wrong_origin"
  | "url_unsafe_path"
  | "digest_malformed"
  | "size_out_of_bounds";

export type BinaryCheck = { ok: true; url: URL } | { ok: false; error: BinaryCheckError };

/** The origin every asset must live on, derived from the release base URL. */
export function releaseOrigin(releaseBaseUrl: string): string {
  return new URL(releaseBaseUrl).origin;
}

export function checkBinaryEntry(entry: BinaryEntry, opts: { releaseBaseUrl: string; maxBytes: number }): BinaryCheck {
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return { ok: false, error: "url_not_https" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "url_not_https" };
  if (url.origin !== releaseOrigin(opts.releaseBaseUrl)) return { ok: false, error: "url_wrong_origin" };
  if (url.username || url.password || url.search || url.hash) return { ok: false, error: "url_unsafe_path" };
  // Check the raw string, not the parsed pathname: URL parsing percent-encodes
  // a quote or a space, and the encoded form is exactly what must not pass.
  const raw = entry.url.slice(url.origin.length);
  if (!SAFE_PATH.test(raw) || raw.includes("/../") || raw.endsWith("/..")) return { ok: false, error: "url_unsafe_path" };
  if (!SHA256_HEX.test(entry.sha256)) return { ok: false, error: "digest_malformed" };
  if (entry.size !== undefined) {
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > opts.maxBytes) {
      return { ok: false, error: "size_out_of_bounds" };
    }
  }
  return { ok: true, url };
}
