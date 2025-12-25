import type { Doc } from "@codecast/convex/convex/_generated/dataModel";

export interface FileChange {
  id: string;
  sequenceIndex: number;
  messageId: string;
  filePath: string;
  changeType: "write" | "edit";
  oldContent?: string;
  newContent: string;
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
      if (toolCall.name !== "Edit" && toolCall.name !== "Write") {
        continue;
      }

      try {
        const params = JSON.parse(toolCall.input);

        if (toolCall.name === "Edit") {
          if (!params.file_path || !params.new_string) {
            continue;
          }

          changes.push({
            id: toolCall.id,
            sequenceIndex: sequenceIndex++,
            messageId: message._id,
            filePath: params.file_path,
            changeType: "edit",
            oldContent: params.old_string,
            newContent: params.new_string,
            timestamp: message.timestamp,
          });
        } else if (toolCall.name === "Write") {
          if (!params.file_path || !params.content) {
            continue;
          }

          changes.push({
            id: toolCall.id,
            sequenceIndex: sequenceIndex++,
            messageId: message._id,
            filePath: params.file_path,
            changeType: "write",
            newContent: params.content,
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
