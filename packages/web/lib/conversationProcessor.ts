export type ProcessedMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  cleanContent: string;
  isCommand: boolean;
  commandType?: string;
  timestamp?: number;
};

export type MessageAlternate = {
  role: "user" | "assistant";
  content: string;
};

import { SYSTEM_MESSAGE_PREFIXES } from "./sessionFilters";

const COMMAND_PATTERNS = [
  /^<command-name>([^<]*)<\/command-name>/,
  /^<command-message>([^<]*)<\/command-message>/,
  /^<local-command-stdout>/,
  /^<local-command-stderr>/,
  /^Caveat:/,
];

const SKILL_EXPANSION_PATTERN = /Base directory for this skill:\s*([^\n]+)/;

export function isSkillExpansion(content: string): boolean {
  return SKILL_EXPANSION_PATTERN.test(content.trim());
}

export function extractSkillInfo(content: string): { name: string; path: string; preview: string } | null {
  const match = content.match(SKILL_EXPANSION_PATTERN);
  if (!match) return null;
  const fullPath = match[1].trim();
  const segments = fullPath.replace(/\/+$/, "").split("/");
  const name = segments[segments.length - 1] || "skill";
  const shortPath = fullPath.replace(/^\/Users\/[^/]+\//, "~/");
  const afterBase = content.slice((match.index || 0) + match[0].length).trim();
  const lines = afterBase.split("\n").filter(l => l.trim());
  const preview = lines.slice(0, 2).join(" ").slice(0, 120);
  return { name, path: shortPath, preview };
}

export function isSystemMessage(content: string): boolean {
  return SYSTEM_MESSAGE_PREFIXES.some(prefix => content.startsWith(prefix));
}

export function isCommandMessage(content: string): boolean {
  const trimmed = content.trim();
  return COMMAND_PATTERNS.some(pattern => pattern.test(trimmed));
}

export function getCommandType(content: string): string | undefined {
  const trimmed = content.trim();
  if (/^<command-name>/.test(trimmed)) return "cmd";
  if (/^<command-message>/.test(trimmed)) return "msg";
  if (/^<local-command-stdout>/.test(trimmed)) return "output";
  if (/^<local-command-stderr>/.test(trimmed)) return "error";
  if (trimmed.startsWith("Caveat:")) return "caveat";
  return undefined;
}

export function cleanContent(content: string): string {
  if (!content) return "";

  return content
    .replace(/<command-name>[^<]*<\/command-name>\s*/g, "")
    .replace(/<command-message>[^<]*<\/command-message>\s*/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^\s*Caveat:.*$/gm, "")
    .trim();
}

export function processMessage(msg: { role: string; content?: string; timestamp?: number }): ProcessedMessage {
  const content = msg.content || "";
  const isCmd = isCommandMessage(content);

  return {
    role: msg.role as "user" | "assistant" | "system",
    content,
    cleanContent: cleanContent(content),
    isCommand: isCmd,
    commandType: isCmd ? getCommandType(content) : undefined,
    timestamp: msg.timestamp,
  };
}

export function processMessageAlternates(alternates: MessageAlternate[] | undefined): ProcessedMessage[] {
  if (!alternates) return [];

  return alternates
    .map(m => processMessage(m))
    .filter(m => !m.isCommand && m.cleanContent.length > 0);
}

export function getConversationPreview(
  alternates: MessageAlternate[] | undefined,
  title: string,
  maxMessages: number = 4
): ProcessedMessage[] {
  const processed = processMessageAlternates(alternates);
  const titleNorm = title?.toLowerCase().trim().slice(0, 80) || "";

  return processed
    .filter(m => {
      if (isSystemMessage(m.cleanContent)) return false;
      if (m.role === "user") {
        const msgNorm = m.cleanContent.toLowerCase().trim().slice(0, 80);
        if (msgNorm === titleNorm) return false;
      }
      return true;
    })
    .slice(0, maxMessages);
}

export function cleanTitle(title: string): string {
  const cleaned = cleanContent(title);
  if (cleaned.length > 0) return cleaned;

  // If title was entirely a command, extract something useful
  const cmdMatch = title.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmdMatch) return `/${cmdMatch[1]}`;

  if (title.trim().startsWith("Caveat:")) return "System message";
  if (title.includes("<local-command-stdout>")) return "Command output";

  return title.replace(/<[^>]+>/g, "").slice(0, 50) || "Untitled";
}
