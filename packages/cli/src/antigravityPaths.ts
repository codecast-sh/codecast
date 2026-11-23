/**
 * Where Antigravity CLI (`agy`) keeps a conversation on disk, as pure path
 * functions with no parser behind them, so the watcher and the scan worker can
 * use them without loading the transcript parser.
 *
 *   ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl
 *   ~/.gemini/antigravity-cli/conversation_summaries.db  (workspace_uris per conversation)
 */

/** The conversation uuid a transcript path belongs to:
 *  …/<uuid>/.system_generated/logs/transcript_full.jsonl (under brain/ in a real
 *  install; callers check the root). Anything else (transcript.jsonl, a chunk
 *  file, a non-uuid directory) is refused, which also keeps a crafted directory
 *  name out of the resume command. */
export function antigravitySessionIdFromPath(filePath: string): string | null {
  const parts = filePath.split(/[\\/]/);
  const n = parts.length;
  if (n < 4) return null;
  if (parts[n - 1] !== "transcript_full.jsonl" || parts[n - 2] !== "logs" || parts[n - 3] !== ".system_generated") return null;
  const id = parts[n - 4]!;
  return ANTIGRAVITY_CONVERSATION_ID_RE.test(id) ? id : null;
}

export const ANTIGRAVITY_CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** agy's per-user data directory, from a transcript path: the parent of brain/. */
export function antigravityDataDirFromTranscript(filePath: string): string | null {
  const parts = filePath.split(/[\\/]/);
  if (!antigravitySessionIdFromPath(filePath) || parts[parts.length - 5] !== "brain") return null;
  return parts.slice(0, parts.length - 5).join("/") || null;
}

/** A workspace_uris value (`["file:///Users/a/My%20Dir"]`) → its first local path. */
export function antigravityCwdFromWorkspaceUris(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  let uris: unknown;
  try {
    uris = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(uris)) return undefined;
  for (const uri of uris) {
    if (typeof uri !== "string" || !uri.startsWith("file://")) continue;
    try {
      const pathname = decodeURIComponent(new URL(uri).pathname);
      if (pathname.startsWith("/")) return pathname;
    } catch {}
  }
  return undefined;
}
