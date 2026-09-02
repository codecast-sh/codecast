/** The shape of latest.json. One entry per platform key, each with a URL and
 *  the SHA-256 of the bytes at that URL. Produced by release/build-binaries.sh
 *  plus release/upload-binaries.sh and by the finalize workflow. */
export interface ReleaseManifest {
  version: string;
  released: string;
  /** Source commit the binaries were built from, when the pipeline records it. */
  sourceCommit?: string;
  binaries: Record<string, { url: string; sha256: string }>;
}

export function isReleaseManifest(value: unknown): value is ReleaseManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  if (typeof m.version !== "string") return false;
  if (!m.binaries || typeof m.binaries !== "object") return false;
  for (const entry of Object.values(m.binaries as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.url !== "string" || typeof e.sha256 !== "string") return false;
  }
  return true;
}
