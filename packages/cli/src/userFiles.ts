/**
 * How a file the agent sends reaches the conversation.
 *
 * The harness's `SendUserFile` tool hands a file to whatever client the person
 * is sitting in front of, and reports "delivered" — but the bytes never leave
 * the agent's machine, so codecast showed the call as a bare tool block and the
 * file was nowhere. An agent then told the human its card "does not show in the
 * codecast view of this thread", which is exactly the surface they read.
 *
 * This closes that gap on the path images already take: the parser lifts each
 * sent file onto the message as `{ localPath, toolUseId }`, sync uploads it to
 * storage, and the web and mobile clients render a card bound back to the tool
 * call. No second delivery channel, no new transport.
 */

import * as path from "node:path";
import { fileBasename, mediaTypeForFile } from "@codecast/shared/files";

export const SEND_USER_FILE_TOOL = "SendUserFile";

/** More files than one turn can meaningfully deliver — the rest are ignored. */
const MAX_FILES_PER_CALL = 10;

/**
 * A file the agent handed to the human with SendUserFile, on its way to the
 * conversation. The parser fills in the path, the name and the tool call it
 * belongs to; sync reads the path once, replaces it with a storage id, and the
 * path never reaches the wire. What the client gets is what its card shows.
 */
export type SyncFile = {
  /** Absolute path on the agent's machine, read at sync time. */
  localPath?: string;
  name: string;
  mediaType?: string;
  size?: number;
  storageId?: string;
  toolUseId?: string;
  /** The sender's one-line context, shown above the card. */
  caption?: string;
  /** "render" (preview inline) or "attach" (save and open elsewhere). */
  display?: string;
  /** Why there is nothing to download: "missing" | "too_large" | "upload_failed". */
  error?: string;
};

/** Wire shape: snake_case, no local path, capped and ready for the mutation. */
export function filesForWire(files: SyncFile[] | undefined) {
  if (!files || files.length === 0) return undefined;
  const wire = files.slice(0, MAX_FILES_PER_CALL).map((file) => ({
    name: file.name,
    media_type: file.mediaType || mediaTypeForFile(file.name),
    size: file.size,
    storage_id: file.storageId,
    tool_use_id: file.toolUseId,
    caption: file.caption,
    display: file.display,
    error: file.error,
  }));
  return wire.length > 0 ? wire : undefined;
}

/**
 * Pull the files out of one `SendUserFile` call.
 *
 * `cwd` is the transcript entry's working directory: the tool accepts relative
 * paths, and resolving them anywhere else points at whatever directory the sync
 * process happens to be in.
 */
export function extractSentFiles(
  block: { id?: string; name?: string; input?: unknown },
  cwd?: string,
): SyncFile[] {
  if (block.name !== SEND_USER_FILE_TOOL || !block.id) return [];
  const input = block.input as { files?: unknown; caption?: unknown; display?: unknown } | undefined;
  if (!input) return [];
  const raw = Array.isArray(input.files)
    ? input.files
    : typeof input.files === "string"
      ? [input.files]
      : [];
  const caption = typeof input.caption === "string" && input.caption.trim() ? input.caption.trim() : undefined;
  const display = input.display === "render" || input.display === "attach" ? input.display : undefined;

  const files: SyncFile[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const candidate = entry.trim();
    const abs = path.isAbsolute(candidate)
      ? path.normalize(candidate)
      : cwd
        ? path.resolve(cwd, candidate)
        : null;
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    files.push({ localPath: abs, name: fileBasename(abs), toolUseId: block.id, caption, display });
    if (files.length >= MAX_FILES_PER_CALL) break;
  }
  return files;
}
