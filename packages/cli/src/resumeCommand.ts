import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  estimateClaudeImportTokens,
  chooseClaudeTailMessagesForTokenBudget,
  type ExportResult,
} from "./jsonlGenerator.js";

export const CLAUDE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CLAUDE_AUTO_TRIM_THRESHOLD_TOKENS = 120_000;
export const CLAUDE_AUTO_TRIM_TARGET_TOKENS = 100_000;
export const CLAUDE_CONTEXT_LIMIT_TOKENS = 200_000;

export interface RewriteSubagentJsonlResult {
  resumeId: string;
  newJsonlPath?: string;
  rewrote: boolean;
}

/**
 * Copy a session JSONL next to itself under a new session id, rewriting the
 * per-line `sessionId` fields to match. Message content bytes are untouched,
 * so the resumed session's prompt prefix — and Claude's server-side prompt
 * cache — stay identical to the source. Trims any partially-flushed trailing
 * line (the source may be a LIVE session mid-append). Idempotent: an existing
 * target is returned as-is. Returns the new path, or null when the source is
 * missing.
 */
export function copyJsonlAsSession(
  sourceJsonlPath: string,
  sourceSessionId: string,
  targetSessionId: string,
): string | null {
  if (!fs.existsSync(sourceJsonlPath)) return null;
  const newPath = path.join(path.dirname(sourceJsonlPath), `${targetSessionId}.jsonl`);
  if (fs.existsSync(newPath)) return newPath;
  let raw = fs.readFileSync(sourceJsonlPath, "utf-8");
  // A live writer may have flushed a partial tail line. Drop it only if it
  // isn't complete JSON — a final line that merely lacks its newline is kept.
  const lastNewline = raw.lastIndexOf("\n");
  if (lastNewline !== raw.length - 1) {
    const tail = raw.slice(lastNewline + 1);
    try {
      JSON.parse(tail);
    } catch {
      raw = raw.slice(0, lastNewline + 1);
    }
  }
  const rewritten = raw.replace(
    new RegExp(`"sessionId"\\s*:\\s*"${sourceSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, "g"),
    `"sessionId":"${targetSessionId}"`,
  );
  fs.writeFileSync(newPath, rewritten);
  return newPath;
}

/**
 * Subagent sessions use non-UUID IDs that `claude --resume` rejects. Copy the
 * JSONL to a new UUID-named file with all `sessionId` fields rewritten so it
 * becomes resumable. Returns the original ID unchanged when it's already a UUID
 * or when the source JSONL is missing.
 */
export function rewriteSubagentJsonlToUuid(
  sessionId: string,
  sourceJsonlPath: string,
): RewriteSubagentJsonlResult {
  if (CLAUDE_UUID_RE.test(sessionId)) return { resumeId: sessionId, rewrote: false };
  const newUuid = crypto.randomUUID();
  const newPath = copyJsonlAsSession(sourceJsonlPath, sessionId, newUuid);
  if (!newPath) return { resumeId: sessionId, rewrote: false };
  return { resumeId: newUuid, newJsonlPath: newPath, rewrote: true };
}

/**
 * True for session ids minted by the server-side fork/handoff flow
 * (`forked-<originalSessionId>-<uuid>`, see convex conversations.ts). A JSONL
 * under such an id only ever exists locally as a daemon-written reconstitution
 * artifact — the live transcript is the UUID copy made for `claude --resume`.
 */
export function isForkArtifactSessionId(sessionId: string): boolean {
  return sessionId.startsWith("forked-");
}

/**
 * Delete the source JSONL left behind after copying a fork artifact to its
 * resumable UUID. Left on disk, the sync watcher rediscovers it as an unknown
 * session (its conversation mapping just moved to the UUID copy) and mints a
 * frozen doppelgänger conversation that receives input but never output.
 * Subagent (`agent-*`) sources are real transcripts and are left alone.
 */
export function removeForkArtifactJsonl(sessionId: string, sourceJsonlPath: string): boolean {
  if (!isForkArtifactSessionId(sessionId)) return false;
  try {
    fs.unlinkSync(sourceJsonlPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `flags` already specifies a Claude permission mode flag. Used to
 * avoid stacking conflicting permission settings.
 */
export function hasClaudePermissionFlag(flags: string): boolean {
  return flags.includes("--dangerously-skip-permissions")
    || flags.includes("--permission-mode")
    || flags.includes("--allow-dangerously-skip-permissions");
}

/**
 * Combine user-configured `claude_args` with permission flags into a single
 * flag string, skipping additions that would duplicate or conflict with what's
 * already present.
 *
 * @param baseArgs    User-configured base flags (e.g. config.claude_args).
 * @param permFlags   Permission flags to apply if none are already set.
 * @param jsonlBypass When true (e.g. the resumed JSONL was recorded under
 *                    bypassPermissions), force `--dangerously-skip-permissions`
 *                    before applying `permFlags`.
 */
export function combineClaudeResumeFlags(
  baseArgs: string | undefined | null,
  permFlags: string | null | undefined,
  jsonlBypass: boolean = false,
): string {
  let flags = baseArgs || "";
  if (jsonlBypass && !flags.includes("--dangerously-skip-permissions")) {
    flags = flags ? flags + " --dangerously-skip-permissions" : "--dangerously-skip-permissions";
  }
  if (permFlags && !hasClaudePermissionFlag(flags)) {
    flags = flags ? flags + " " + permFlags : permFlags;
  }
  return flags;
}

/**
 * Pick the auto-trim message count for reconstituting a Claude session from an
 * export. Returns undefined when the export already fits comfortably in
 * Claude's context window.
 */
export function chooseClaudeAutoTrim(data: ExportResult): number | undefined {
  const estimatedTokens = estimateClaudeImportTokens(data);
  if (estimatedTokens <= CLAUDE_AUTO_TRIM_THRESHOLD_TOKENS) return undefined;
  return chooseClaudeTailMessagesForTokenBudget(data, CLAUDE_AUTO_TRIM_TARGET_TOKENS);
}

/**
 * Extract the first user message's `permissionMode` from a JSONL transcript
 * head. Used by the daemon's auto-resume to preserve bypass when the original
 * session was launched in bypass mode.
 */
export function extractJsonlPermissionMode(jsonlContent: string): string | undefined {
  const firstUserLine = jsonlContent.split("\n").find(l => l.includes('"type":"user"'));
  if (!firstUserLine) return undefined;
  try {
    const parsed = JSON.parse(firstUserLine);
    return typeof parsed.permissionMode === "string" ? parsed.permissionMode : undefined;
  } catch {
    return undefined;
  }
}
