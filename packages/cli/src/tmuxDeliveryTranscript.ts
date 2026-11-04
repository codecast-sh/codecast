import { canonicalSlashCommand, stripPastedContent, type AgentClientId } from "@codecast/shared/contracts";
import { parseTranscriptFor } from "./parser.js";

export function transcriptContainsDelivery(transcript: string, agent: AgentClientId, payload: string, pasteAt: number): boolean {
  const normalize = (text: string) => {
    const plain = stripPastedContent(text).replace(/\r\n?/g, "\n").trim();
    // A slash command is recorded as Claude Code's tagged invocation, not as typed.
    return canonicalSlashCommand(plain) ?? plain;
  };
  const expected = normalize(payload);
  return !!expected && parseTranscriptFor(agent, transcript).some(message =>
    message.role === "user" && message.timestamp >= pasteAt && normalize(message.content) === expected);
}
