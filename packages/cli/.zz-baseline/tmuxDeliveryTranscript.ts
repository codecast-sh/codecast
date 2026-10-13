import { stripPastedContent, type AgentClientId } from "@codecast/shared/contracts";
import { parseTranscriptFor } from "./parser.js";

export function transcriptContainsDelivery(transcript: string, agent: AgentClientId, payload: string, pasteAt: number): boolean {
  const normalize = (text: string) => stripPastedContent(text).replace(/\r\n?/g, "\n").trim();
  const expected = normalize(payload);
  return !!expected && parseTranscriptFor(agent, transcript).some(message =>
    message.role === "user" && message.timestamp >= pasteAt && normalize(message.content) === expected);
}
