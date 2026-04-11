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
  /^\/[a-z][\w-]*/i,
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
    .replace(/\x1b\[[0-9;]*m/g, "")
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
  // Extract command name first (before cleanContent strips it)
  const cmdNameMatch = title.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmdNameMatch) return `/${cmdNameMatch[1].replace(/^\//, "")}`;

  const cmdMsgMatch = title.match(/<command-message>([^<]*)<\/command-message>/);
  if (cmdMsgMatch) return `/${cmdMsgMatch[1].replace(/^\//, "")}`;

  // Strip complete tags, then also strip truncated/broken tags (e.g. "<command..." from title truncation)
  const cleaned = cleanContent(title).replace(/<[^>]*$/, "").trim();
  if (cleaned.length > 0) return cleaned;

  if (title.trim().startsWith("Caveat:")) return "System message";
  if (title.includes("<local-command-stdout>")) return "Command output";

  return title.replace(/<[^>]+>/g, "").replace(/<[^>]*$/, "").trim().slice(0, 50) || "Untitled";
}

/** Tailwind color class for message-count badges — warmer as count grows. */
export function msgCountColor(count: number): string {
  if (count >= 200) return "text-sol-orange";
  if (count >= 50) return "text-sol-yellow";
  if (count >= 10) return "text-sol-text-muted";
  return "text-sol-text-dim/50";
}

export type SkillItem = { name: string; description: string };

export function extractSkillsFromMessages(messages: Array<{ role: string; content?: string; tool_calls?: Array<{ name: string; input: string }> }>): SkillItem[] {
  const skills: SkillItem[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "system" || !msg.content) continue;
    const lines = msg.content.split("\n");
    let inSkillSection = false;
    for (const line of lines) {
      if (/following skills|available.*skills|available-deferred-tools/i.test(line)) {
        inSkillSection = true;
        continue;
      }
      if (inSkillSection) {
        const match = line.match(/^[-*]\s+`?\/?([\w:.-]+)`?\s*[-–—:]\s*(.+)/);
        if (match && !seen.has(match[1])) {
          seen.add(match[1]);
          skills.push({ name: match[1], description: match[2].trim() });
        } else if (line.trim() === "" || /^[#<]/.test(line.trim())) {
          inSkillSection = false;
        }
      }
    }
  }
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.name === "Skill") {
          try {
            const parsed = JSON.parse(tc.input);
            const name = parsed.skill;
            if (name && !seen.has(name)) {
              seen.add(name);
              skills.push({ name, description: "" });
            }
          } catch {}
        }
      }
    }
  }
  if (skills.length === 0) {
    for (const msg of messages) {
      if (msg.role !== "system" || !msg.content) continue;
      const skillMatches = msg.content.matchAll(/\"skill\":\s*\"([\w:.-]+)\"/g);
      for (const m of skillMatches) {
        if (!seen.has(m[1])) {
          seen.add(m[1]);
          skills.push({ name: m[1], description: "" });
        }
      }
      const nameMatches = msg.content.matchAll(/skill:\s*"([\w:.-]+)"/g);
      for (const m of nameMatches) {
        if (!seen.has(m[1])) {
          seen.add(m[1]);
          skills.push({ name: m[1], description: "" });
        }
      }
    }
  }
  return skills;
}

export function extractFilePaths(messages: Array<{ role: string; content?: string; tool_calls?: Array<{ name: string; input: string }> }>): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const addPath = (p: string) => {
    if (!p || seen.has(p) || p.length < 3) return;
    seen.add(p);
    paths.push(p);
  };
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (["Read", "Write", "Edit", "Glob"].includes(tc.name)) {
          try {
            const parsed = JSON.parse(tc.input);
            if (parsed.file_path) addPath(parsed.file_path);
            if (parsed.path) addPath(parsed.path);
          } catch {}
        }
        if (tc.name === "Bash") {
          try {
            const parsed = JSON.parse(tc.input);
            const cmd = parsed.command || "";
            const fileMatches = cmd.matchAll(/(?:^|\s)(\/[\w./-]+(?:\.\w+))/g);
            for (const m of fileMatches) addPath(m[1]);
          } catch {}
        }
      }
    }
  }
  return paths;
}
