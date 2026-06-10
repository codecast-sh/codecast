import { getApplyPatchInput, parseApplyPatchSections } from "./applyPatchParser";
import { parseFileChangeSummary, parseUnifiedDiffSections } from "./unifiedDiffParser";

export interface FileChange {
  id: string;
  toolCallId?: string;
  sequenceIndex: number;
  messageId: string;
  filePath: string;
  changeType: "write" | "edit" | "commit";
  oldContent?: string;
  newContent: string;
  commitMessage?: string;
  commitHash?: string;
  timestamp: number;
}

/**
 * Minimal structural shape the extractor needs from a message. Both a full
 * Convex `Doc<"messages">` and the redacted fields built inside the message
 * ingest mutations are assignable to this, so the same extraction runs on the
 * web client and inside a server mutation with no type coupling either way.
 */
export interface ExtractableMessage {
  _id: string;
  timestamp: number;
  tool_calls?: Array<{ id: string; name: string; input: string }> | null;
  tool_results?: Array<{ tool_use_id: string; content: string; is_error?: boolean }> | null;
}

const EDIT_TOOL_NAMES = new Set([
  "Edit",
  "Write",
  "file_edit",
  "file_write",
  "apply_patch",
  "fileChange",
  "Bash",
]);

/** Cheap pre-filter: does this message carry any tool call that could produce a file change? */
export function hasFileChangeToolCall(message: ExtractableMessage): boolean {
  return !!message.tool_calls?.some((tc) => EDIT_TOOL_NAMES.has(tc.name));
}

export function extractFileChanges(messages: ExtractableMessage[]): FileChange[] {
  const changes: FileChange[] = [];
  let sequenceIndex = 0;

  const sortedMessages = [...messages].sort((a, b) => a.timestamp - b.timestamp);

  for (const message of sortedMessages) {
    if (!message.tool_calls || message.tool_calls.length === 0) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      if (!EDIT_TOOL_NAMES.has(toolCall.name)) {
        continue;
      }

      if (toolCall.name === "apply_patch") {
        const patchInput = getApplyPatchInput(toolCall.input);
        if (!patchInput) {
          continue;
        }

        const sections = parseApplyPatchSections(patchInput);
        if (sections.length === 0) {
          continue;
        }

        sections.forEach((section, sectionIndex) => {
          const isAdd = section.operation === "Add";
          changes.push({
            id: `${toolCall.id}:${sectionIndex}`,
            toolCallId: toolCall.id,
            sequenceIndex: sequenceIndex++,
            messageId: message._id,
            filePath: section.filePath,
            changeType: isAdd ? "write" : "edit",
            oldContent: section.oldContent || undefined,
            newContent: section.newContent,
            timestamp: message.timestamp,
          });
        });
        continue;
      }

      if (toolCall.name === "fileChange") {
        let summary = "";
        try {
          const params = JSON.parse(toolCall.input);
          summary = typeof params.changes === "string" ? params.changes : "";
        } catch {
          continue;
        }

        const result = message.tool_results?.find((item) => item.tool_use_id === toolCall.id);
        const sections = parseUnifiedDiffSections(result?.content || "", parseFileChangeSummary(summary));
        if (sections.length === 0) {
          continue;
        }

        sections.forEach((section, sectionIndex) => {
          changes.push({
            id: `${toolCall.id}:${sectionIndex}`,
            toolCallId: toolCall.id,
            sequenceIndex: sequenceIndex++,
            messageId: message._id,
            filePath: section.filePath,
            changeType: section.oldContent ? "edit" : "write",
            oldContent: section.oldContent || undefined,
            newContent: section.newContent,
            timestamp: message.timestamp,
          });
        });
        continue;
      }

      try {
        const params = JSON.parse(toolCall.input);

        if (toolCall.name === "Edit" || toolCall.name === "file_edit") {
          if (!params.file_path || !params.new_string) {
            continue;
          }

          changes.push({
            id: toolCall.id,
            toolCallId: toolCall.id,
            sequenceIndex: sequenceIndex++,
            messageId: message._id,
            filePath: params.file_path,
            changeType: "edit",
            oldContent: params.old_string,
            newContent: params.new_string,
            timestamp: message.timestamp,
          });
        } else if (toolCall.name === "Write" || toolCall.name === "file_write") {
          if (!params.file_path || !params.content) {
            continue;
          }

          changes.push({
            id: toolCall.id,
            toolCallId: toolCall.id,
            sequenceIndex: sequenceIndex++,
            messageId: message._id,
            filePath: params.file_path,
            changeType: "write",
            newContent: params.content,
            timestamp: message.timestamp,
          });
        } else if (toolCall.name === "Bash") {
          const command = params.command as string | undefined;
          if (!command || !command.includes("git commit")) {
            continue;
          }

          const commitMessage = extractCommitMessage(command);
          if (!commitMessage) {
            continue;
          }

          const commitHash = extractCommitHash(message.tool_results, toolCall.id);

          changes.push({
            id: toolCall.id,
            toolCallId: toolCall.id,
            sequenceIndex: sequenceIndex++,
            messageId: message._id,
            filePath: "git commit",
            changeType: "commit",
            newContent: commitMessage,
            commitMessage,
            commitHash,
            timestamp: message.timestamp,
          });
        }
      } catch (error) {
        continue;
      }
    }
  }

  return changes;
}

/**
 * Merge server-materialized changes with client-extracted changes (from the
 * paginated message window). Server changes are authoritative and complete for
 * materialized conversations; the client set backfills conversations whose
 * edits predate materialization. Dedupe by the stable change id, order by
 * (timestamp, in-message sequence), then renumber sequenceIndex to the merged
 * position so cumulative-diff ordering stays correct across both sources.
 */
export function mergeFileChanges(
  serverChanges: FileChange[],
  clientChanges: FileChange[],
): FileChange[] {
  const byId = new Map<string, FileChange>();
  // Client first so server wins on conflict — except a git-commit hash, which
  // is parsed from the tool result and may land on a later message patch after
  // the row was already materialized hash-less; keep the client's if present.
  for (const c of clientChanges) byId.set(c.id, c);
  for (const c of serverChanges) {
    const prev = byId.get(c.id);
    byId.set(c.id, prev && !c.commitHash && prev.commitHash ? { ...c, commitHash: prev.commitHash } : c);
  }

  const merged = Array.from(byId.values()).sort(
    (a, b) => a.timestamp - b.timestamp || a.sequenceIndex - b.sequenceIndex,
  );

  return merged.map((c, i) => (c.sequenceIndex === i ? c : { ...c, sequenceIndex: i }));
}

function extractCommitMessage(command: string): string | undefined {
  const messageFlagMatch = command.match(/-m\s+["']([\s\S]+?)["']/);
  if (messageFlagMatch) {
    return messageFlagMatch[1];
  }

  const heredocMatch = command.match(/\$\(cat\s+<<'?EOF'?\s+([\s\S]+?)\s+EOF\s*\)/);
  if (heredocMatch) {
    return heredocMatch[1].trim();
  }

  return undefined;
}

function extractCommitHash(
  toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> | null | undefined,
  toolCallId: string
): string | undefined {
  if (!toolResults) {
    return undefined;
  }

  const result = toolResults.find((r) => r.tool_use_id === toolCallId);
  if (!result || result.is_error) {
    return undefined;
  }

  // git commit prints `[<branch> <short-hash>] <subject>` (with an optional
  // `(root-commit)` marker), so the hash is the last hex token before the `]`,
  // preceded by the `[` itself, whitespace, or the marker's closing paren.
  const hashMatch = result.content.match(/\[(?:[^\]\n]*[\s()])?([a-f0-9]{7,40})\]/);
  if (hashMatch) {
    return hashMatch[1];
  }

  return undefined;
}
