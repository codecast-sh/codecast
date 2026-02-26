import type { Doc } from "@codecast/convex/convex/_generated/dataModel";
import { getApplyPatchInput, parseApplyPatchSections } from "./applyPatchParser";

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

type Message = Doc<"messages">;

export function extractFileChanges(messages: Message[]): FileChange[] {
  const changes: FileChange[] = [];
  let sequenceIndex = 0;

  const sortedMessages = [...messages].sort((a, b) => a.timestamp - b.timestamp);

  for (const message of sortedMessages) {
    if (!message.tool_calls || message.tool_calls.length === 0) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      if (
        toolCall.name !== "Edit" &&
        toolCall.name !== "Write" &&
        toolCall.name !== "file_edit" &&
        toolCall.name !== "file_write" &&
        toolCall.name !== "apply_patch" &&
        toolCall.name !== "Bash"
      ) {
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
  toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> | undefined,
  toolCallId: string
): string | undefined {
  if (!toolResults) {
    return undefined;
  }

  const result = toolResults.find((r) => r.tool_use_id === toolCallId);
  if (!result || result.is_error) {
    return undefined;
  }

  const hashMatch = result.content.match(/\[([a-f0-9]{7,40})\]/);
  if (hashMatch) {
    return hashMatch[1];
  }

  return undefined;
}
