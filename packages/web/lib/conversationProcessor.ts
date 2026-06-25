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
import { stripTeammateFraming } from "../components/sessionMessage";

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

/** Synthetic truncation notice the CLI injects into imported sessions for the
 * model's context. Context-only — hide it from every user-facing surface. */
export const IMPORT_NOTICE_PREFIX = "[Codecast import]";

export function isImportNotice(content: string | null | undefined): boolean {
  return !!content && content.trimStart().startsWith(IMPORT_NOTICE_PREFIX);
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
      if (isImportNotice(m.cleanContent)) return false;
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

// ── Structured / machine user-messages ──────────────────────────────────────
// Many "user" role messages aren't things a person typed: task-completion pings,
// compaction prompts, session continuations, tool-output pointers, skill dumps,
// interrupts, slash-command expansions. They're context for the model. Every
// list/preview surface (the message feed, conversation cards) needs the SAME
// decision about what counts as a real message, so it lives here once.

const TOOL_OUTPUT_POINTER_PREFIXES = [
  "Read the output file to retrieve the result:",
  "Full transcript available at:",
];
const CONTINUATION_PREFIXES = [
  "This session is being continued",
  "Please continue the conversation",
];
const INTERRUPT_PREFIXES = ["[Request interrupted", "[Request cancelled"];

/** Strip the machine wrappers (reminders, command tags, caveats) for display
 * while preserving the human's prose/markdown. Shared with the conversation
 * view so a message reads the same wherever it's shown. */
export function stripSystemTags(content: string): string {
  return content
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<\/?(?:command-(?:name|message|args)|antml:[a-z_]+)[^>]*>/g, "")
    .replace(/^\s*Caveat:.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isTaskNotification(content: string): boolean {
  return content.trim().startsWith("<task-notification>");
}

export function isCompactionPrompt(content: string): boolean {
  return content.trim().startsWith("Your task is to create a detailed summary");
}

// Claude Code injects a synthetic user-role notice when a background agent (a Task
// tool subagent run in the background) is stopped: `Background agent "<name>" was
// stopped by the user.` It carries no isMeta flag, so without special handling it
// renders as a real user turn (avatar + bubble). It's a control event like an
// interrupt — hide it from previews, render it as a status line in the thread.
const BACKGROUND_AGENT_STOPPED_RE = /^Background agent "(.*)" was stopped by the user\.?$/;

/** The agent's name if `content` is a background-agent-stopped notice, else null. */
export function backgroundAgentStoppedName(content: string | null | undefined): string | null {
  if (!content) return null;
  const m = content.trim().match(BACKGROUND_AGENT_STOPPED_RE);
  return m ? m[1] : null;
}

export function isBackgroundAgentStoppedNotice(content: string | null | undefined): boolean {
  return !!content && BACKGROUND_AGENT_STOPPED_RE.test(content.trim());
}

/** True when a user-role message is machine-generated noise that no person
 * typed — so feeds and previews hide it instead of dumping the raw XML. */
export function isNoiseUserMessage(content: string | null | undefined): boolean {
  if (!content) return true;
  const raw = content.trim();
  if (!raw) return true;
  if (isImportNotice(raw)) return true;
  if (isTaskNotification(raw)) return true;
  if (/^<scheduled-task[\s>]/.test(raw)) return true;
  if (isSkillExpansion(raw)) return true;
  if (isCompactionPrompt(raw)) return true;
  if (raw.startsWith("<turn_aborted>")) return true;
  if (isBackgroundAgentStoppedNotice(raw)) return true;
  if (INTERRUPT_PREFIXES.some((p) => raw.startsWith(p))) return true;
  if (TOOL_OUTPUT_POINTER_PREFIXES.some((p) => raw.startsWith(p))) return true;
  const noReminders = stripSystemTags(raw);
  if (CONTINUATION_PREFIXES.some((p) => noReminders.startsWith(p))) return true;
  // Nothing a person wrote survives stripping the wrappers/tags.
  if (!cleanContent(raw)) return true;
  if (isSystemMessage(noReminders)) return true;
  return false;
}

export type FeedDisplay = { kind: "hidden" } | { kind: "text"; text: string };

/** Single classifier for list/preview surfaces: returns the cleaned text to
 * show, or `hidden` for machine noise. Slash commands collapse to "/cmd args".
 * (Session→session messages are handled separately by their own renderer.) */
export function classifyFeedMessage(content: string | null | undefined): FeedDisplay {
  if (isNoiseUserMessage(content)) return { kind: "hidden" };
  const raw = (content || "").trim();
  if (isCommandMessage(raw)) return { kind: "text", text: cleanTitle(raw) };
  const text = stripTeammateFraming(stripSystemTags(raw)
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/<teammate-message\s+[^>]*>[\s\S]*?<\/teammate-message>/g, "")
    .replace(/\[Image[:\s][^\]]*\]/gi, "")
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
    .trim());
  return text ? { kind: "text", text } : { kind: "hidden" };
}

/** Compact display name for a model id: "claude-opus-4-8" → "opus-4-8",
 * "claude-sonnet-4-5-20250929" → "sonnet-4-5-'250929". Non-claude ids pass through. */
export function formatModel(model?: string): string {
  if (!model) return "";
  if (model.startsWith("claude-")) {
    return model.slice("claude-".length).replace("-20", "-'");
  }
  return model;
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
