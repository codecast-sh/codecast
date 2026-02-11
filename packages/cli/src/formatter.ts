import { c, fmt, icons } from "./colors.js";

interface SearchMatch {
  line: number;
  role: string;
  content: string;
  timestamp: string;
  tool_calls_count?: number;
  tool_results_count?: number;
}

interface ContextMessage {
  line: number;
  role: string;
  content: string;
  tool_calls_count?: number;
  tool_results_count?: number;
}

interface SearchConversation {
  id: string;
  title: string;
  project_path: string | null;
  updated_at: string;
  message_count: number;
  user?: { name: string | null; email: string | null };
  matches: SearchMatch[];
  context: ContextMessage[];
}

interface SearchResult {
  total_matches: number;
  conversations: SearchConversation[];
  search_scope?: string;
}

interface SearchOptions {
  projectPath?: string;
}

interface ReadMessage {
  line: number;
  role: string;
  content: string;
  timestamp: string;
  tool_calls?: unknown[];
  tool_results?: unknown[];
}

interface ReadResult {
  conversation: {
    id: string;
    title: string;
    project_path: string | null;
    message_count: number;
    updated_at: string;
  };
  messages: ReadMessage[];
}

function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return date.toLocaleDateString("en-US", { weekday: "short" });
  } else {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
}

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / (1000 * 60));
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) {
    return "just now";
  } else if (diffMin < 60) {
    return `${diffMin} min ago`;
  } else if (diffHour < 24) {
    return diffHour === 1 ? "1 hour ago" : `${diffHour} hours ago`;
  } else if (diffDay === 1) {
    return "yesterday";
  } else if (diffDay < 7) {
    return `${diffDay} days ago`;
  } else {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
}

function truncatePath(path: string | null, maxLen: number = 38): string {
  if (!path) return "";
  const home = process.env.HOME || "";
  if (home && path.startsWith(home)) {
    path = "~" + path.slice(home.length);
  }
  if (path.length > maxLen) {
    const parts = path.split("/");
    if (parts.length > 3) {
      const prefix = parts[0];
      const suffix = parts.slice(-2).join("/");
      if ((prefix + "/.../" + suffix).length <= maxLen) {
        return prefix + "/.../" + suffix;
      }
      return ".../" + suffix;
    }
  }
  return path;
}

function truncateId(id: string): string {
  return id.slice(0, 7);
}

function formatRole(role: string): string {
  return `[${role}]`;
}

function wrapText(text: string, indent: string, maxWidth: number = 72): string {
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }

    if (paragraph.startsWith("```") || paragraph.startsWith("   ") || paragraph.startsWith("\t")) {
      lines.push(paragraph);
      continue;
    }

    let currentLine = "";
    const words = paragraph.split(/\s+/);

    for (const word of words) {
      if (currentLine.length + word.length + 1 > maxWidth) {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = indent + word;
        } else {
          lines.push(word);
        }
      } else {
        currentLine = currentLine ? currentLine + " " + word : word;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.join("\n");
}

export function formatSearchResults(result: SearchResult, options: SearchOptions = {}): string {
  const lines: string[] = [];

  lines.push("<SEARCHRESULTS>");

  if (result.total_matches === 0) {
    lines.push("No matches found.");
    if (options.projectPath) {
      lines.push(`\nSearching: ${truncatePath(options.projectPath)}`);
      lines.push("Use -g to search all sessions globally.");
    }
    lines.push("</SEARCHRESULTS>");
    return lines.join("\n");
  }

  lines.push(`Found ${result.total_matches} match${result.total_matches === 1 ? "" : "es"} in ${result.conversations.length} conversation${result.conversations.length === 1 ? "" : "s"}\n`);

  for (const conv of result.conversations) {
    lines.push(""); // Extra spacing before each conversation
    const header = `${c.bold}── ${conv.title} ${c.reset}`;
    const padding = "─".repeat(Math.max(0, 60 - conv.title.length - 4));
    lines.push(header + padding);

    const userDisplay = conv.user?.name || conv.user?.email;
    const meta = [
      `${c.cyan}${truncateId(conv.id)}${c.reset}`,
      `${c.dim}${formatDate(conv.updated_at)}${c.reset}`,
      `${c.dim}${conv.message_count} msgs${c.reset}`,
      truncatePath(conv.project_path) ? `${c.dim}${truncatePath(conv.project_path)}${c.reset}` : "",
      userDisplay ? `${c.yellow}${userDisplay}${c.reset}` : "",
    ].filter(Boolean).join(" | ");
    lines.push(meta);
    lines.push("");

    for (const msg of conv.matches) {
      const lineNum = `${c.dim}${String(msg.line).padStart(3)}:${c.reset}`;
      const role = msg.role === "user"
        ? `${c.blue}[user]${c.reset}`
        : `${c.green}[assistant]${c.reset}`;
      if (msg.content) {
        lines.push(`${lineNum} ${role} ${msg.content}`);
      }
      lines.push("");
    }
  }

  if (result.conversations.length > 0) {
    lines.push("To explore:");
    lines.push("  codecast read <id> <line>:<line>   # read message range");
    lines.push("  codecast read <id>                 # read all messages");
    lines.push("  codecast summary <id>              # get session summary");
  }

  if (options.projectPath) {
    lines.push(`\nSearching: ${truncatePath(options.projectPath)}`);
    lines.push("Use -g to search all sessions globally.");
  }

  lines.push("</SEARCHRESULTS>");

  return lines.join("\n");
}

interface FormatOptions {
  full?: boolean;
}

export function formatReadResult(result: ReadResult, options: FormatOptions = {}): string {
  const lines: string[] = [];

  const conv = result.conversation;
  const header = `── ${conv.title} `;
  const padding = "─".repeat(Math.max(0, 60 - header.length));
  lines.push(header + padding);

  const meta = [
    truncateId(conv.id),
    formatDate(conv.updated_at),
    `${conv.message_count} msgs`,
    truncatePath(conv.project_path),
  ].filter(Boolean).join(" | ");
  lines.push(`   ${meta}\n`);

  for (const msg of result.messages) {
    // Skip empty messages (streaming artifacts)
    const hasContent = msg.content && msg.content.trim();
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
    if (!hasContent && !hasToolCalls && !hasToolResults) {
      continue;
    }

    const lineNum = String(msg.line).padStart(4);
    const role = formatRole(msg.role);
    lines.push(`${lineNum}: ${role}`);

    if (hasContent) {
      const indentedContent = msg.content.split("\n").map((l) => "       " + l).join("\n");
      lines.push(indentedContent);
    }

    if (hasToolCalls && msg.tool_calls) {
      if (options.full) {
        lines.push(`       <TOOL_CALLS>`);
        for (const tc of msg.tool_calls as Array<{ name?: string; input?: unknown }>) {
          lines.push(`       - ${tc.name || "unknown"}`);
          if (tc.input) {
            const inputStr = JSON.stringify(tc.input, null, 2);
            const indented = inputStr.split("\n").map((l) => "         " + l).join("\n");
            lines.push(indented);
          }
        }
        lines.push(`       </TOOL_CALLS>`);
      } else {
        lines.push(`       [${msg.tool_calls.length} tool call${msg.tool_calls.length === 1 ? "" : "s"}]`);
      }
    }

    if (hasToolResults && msg.tool_results) {
      if (options.full) {
        lines.push(`       <TOOL_RESULTS>`);
        for (const tr of msg.tool_results as Array<{ content?: string; isError?: boolean }>) {
          const prefix = tr.isError ? "[ERROR] " : "";
          const content = tr.content || "(empty)";
          const truncated = content.length > 2000 ? content.slice(0, 2000) + "\n... (truncated)" : content;
          const indented = truncated.split("\n").map((l) => "         " + prefix + l).join("\n");
          lines.push(indented);
        }
        lines.push(`       </TOOL_RESULTS>`);
      } else {
        lines.push(`       [${msg.tool_results.length} tool result${msg.tool_results.length === 1 ? "" : "s"}]`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

interface FeedPreviewMessage {
  line: number;
  role: string;
  content: string;
  tool_calls_count?: number;
  tool_results_count?: number;
}

interface FeedConversation {
  id: string;
  title: string;
  project_path: string | null;
  updated_at: string;
  message_count: number;
  user?: { name: string | null; email: string | null };
  preview: FeedPreviewMessage[];
}

interface FeedResult {
  conversations: FeedConversation[];
  scope: string;
}

interface FeedOptions {
  projectPath?: string;
  page?: number;
}

interface SummaryMessage {
  line: number;
  role: string;
  content: string;
  timestamp: string;
  tool_calls?: Array<{ name?: string; input?: unknown }>;
  tool_results?: Array<{ content?: string; isError?: boolean }>;
}

interface SummaryResult {
  conversation: {
    id: string;
    title: string;
    project_path: string | null;
    message_count: number;
    updated_at: string;
  };
  messages: SummaryMessage[];
}

interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

function parseToolInput(input: unknown): Record<string, unknown> | null {
  if (!input) return null;
  if (typeof input === "object") return input as Record<string, unknown>;
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }
  return null;
}

function extractFileChanges(messages: SummaryMessage[]): FileChange[] {
  const fileChanges = new Map<string, { additions: number; deletions: number }>();

  for (const msg of messages) {
    if (!msg.tool_calls) continue;

    for (const tc of msg.tool_calls) {
      const input = parseToolInput(tc.input);
      if (!input) continue;

      if (tc.name === "Edit" || tc.name === "Write") {
        const filePath = input.file_path as string;
        if (!filePath) continue;

        const existing = fileChanges.get(filePath) || { additions: 0, deletions: 0 };

        if (tc.name === "Edit") {
          const oldStr = (input.old_string as string) || "";
          const newStr = (input.new_string as string) || "";
          existing.additions += newStr.split("\n").length;
          existing.deletions += oldStr.split("\n").length;
        } else {
          const content = (input.content as string) || "";
          existing.additions += content.split("\n").length;
        }

        fileChanges.set(filePath, existing);
      }
    }
  }

  return Array.from(fileChanges.entries())
    .map(([path, stats]) => ({ path, ...stats }))
    .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));
}

function extractGoal(messages: SummaryMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content);
  if (!firstUser) return "No user message found";

  const content = firstUser.content.trim();
  const lines = content.split("\n");
  if (lines.length <= 3) return content;

  return lines.slice(0, 3).join("\n") + "...";
}

function extractApproach(messages: SummaryMessage[]): string[] {
  const approaches: string[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.content) continue;

    const content = msg.content.trim();
    if (content.length < 20) continue;

    const firstLine = content.split("\n")[0].slice(0, 100);
    if (seen.has(firstLine)) continue;
    seen.add(firstLine);

    if (content.includes("I'll ") || content.includes("I will ") ||
        content.includes("Let me ") || content.includes("I'm going to ")) {
      const sentences = content.match(/[^.!?]+[.!?]+/g) || [];
      for (const sentence of sentences.slice(0, 2)) {
        const trimmed = sentence.trim();
        if (trimmed.length > 20 && trimmed.length < 150) {
          approaches.push("- " + trimmed);
          break;
        }
      }
    }

    if (approaches.length >= 5) break;
  }

  return approaches.slice(0, 5);
}

function extractKeyDecisions(messages: SummaryMessage[]): string[] {
  const decisions: string[] = [];

  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.content) continue;

    const content = msg.content.toLowerCase();
    if (content.includes("chose ") || content.includes("decided ") ||
        content.includes("instead of ") || content.includes("rather than ") ||
        content.includes("better to ") || content.includes("approach is ")) {
      const sentences = msg.content.match(/[^.!?]+[.!?]+/g) || [];
      for (const sentence of sentences) {
        const lower = sentence.toLowerCase();
        if (lower.includes("chose") || lower.includes("decided") ||
            lower.includes("instead") || lower.includes("rather than") ||
            lower.includes("better to") || lower.includes("approach")) {
          const trimmed = sentence.trim();
          if (trimmed.length > 20 && trimmed.length < 200) {
            decisions.push("- " + trimmed);
            break;
          }
        }
      }
    }

    if (decisions.length >= 3) break;
  }

  return decisions;
}

function summarizeOutcome(messages: SummaryMessage[]): string {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.content);
  if (!lastAssistant) return "Session ended";

  const content = lastAssistant.content.trim();

  if (content.toLowerCase().includes("successfully") ||
      content.toLowerCase().includes("complete") ||
      content.toLowerCase().includes("done") ||
      content.toLowerCase().includes("finished")) {
    const sentences = content.match(/[^.!?]+[.!?]+/g) || [];
    for (const sentence of sentences) {
      if (sentence.toLowerCase().includes("success") ||
          sentence.toLowerCase().includes("complete") ||
          sentence.toLowerCase().includes("done") ||
          sentence.toLowerCase().includes("finished")) {
        return sentence.trim().slice(0, 150);
      }
    }
  }

  const firstSentence = content.match(/^[^.!?]+[.!?]+/);
  return firstSentence ? firstSentence[0].trim().slice(0, 150) : "Session ended";
}

export function formatSummary(result: SummaryResult): string {
  const lines: string[] = [];
  const conv = result.conversation;
  const sessionId = truncateId(conv.id);

  lines.push(`<SUMMARY session="${sessionId}">`);
  lines.push(`# ${conv.title}`);
  lines.push("");

  lines.push("## Goal");
  lines.push(extractGoal(result.messages));
  lines.push("");

  const approaches = extractApproach(result.messages);
  if (approaches.length > 0) {
    lines.push("## Approach");
    lines.push(approaches.join("\n"));
    lines.push("");
  }

  lines.push("## Outcome");
  lines.push(summarizeOutcome(result.messages));
  lines.push("");

  const fileChanges = extractFileChanges(result.messages);
  if (fileChanges.length > 0) {
    lines.push("## Files Changed");
    for (const fc of fileChanges.slice(0, 10)) {
      const shortPath = truncatePath(fc.path);
      lines.push(`- ${shortPath} (+${fc.additions} -${fc.deletions})`);
    }
    if (fileChanges.length > 10) {
      lines.push(`  ... and ${fileChanges.length - 10} more files`);
    }
    lines.push("");
  }

  const decisions = extractKeyDecisions(result.messages);
  if (decisions.length > 0) {
    lines.push("## Key Decisions");
    lines.push(decisions.join("\n"));
    lines.push("");
  }

  lines.push("</SUMMARY>");

  return lines.join("\n");
}

export function formatFeedResults(result: FeedResult, options: FeedOptions = {}): string {
  const lines: string[] = [];

  lines.push("<FEED>");

  if (result.conversations.length === 0) {
    lines.push("No conversations found.");
    if (options.projectPath) {
      lines.push(`\nScope: ${truncatePath(options.projectPath)}`);
      lines.push("Use -g to view all sessions globally.");
    }
    lines.push("</FEED>");
    return lines.join("\n");
  }

  const pageInfo = options.page && options.page > 1 ? ` (page ${options.page})` : "";
  lines.push(`Recent conversations (${result.conversations.length})${pageInfo}\n`);

  for (const conv of result.conversations) {
    const header = `── ${conv.title} `;
    const padding = "─".repeat(Math.max(0, 60 - header.length));
    lines.push(header + padding);

    const userDisplay = conv.user?.name || conv.user?.email;
    const meta = [
      truncateId(conv.id),
      formatDate(conv.updated_at),
      `${conv.message_count} msgs`,
      truncatePath(conv.project_path),
      userDisplay ? `${c.yellow}${userDisplay}${c.reset}` : "",
    ].filter(Boolean).join(" | ");
    lines.push(`   ${meta}\n`);

    for (const msg of conv.preview) {
      const lineNum = String(msg.line).padStart(4);
      const role = formatRole(msg.role);

      if (msg.role === "user") {
        lines.push(`  ${lineNum}: ${role} ${msg.content}`);
      } else {
        const toolInfo: string[] = [];
        if (msg.tool_calls_count) {
          toolInfo.push(`${msg.tool_calls_count} tool${msg.tool_calls_count === 1 ? "" : "s"}`);
        }
        const suffix = toolInfo.length > 0 ? ` [${toolInfo.join(", ")}]` : "";
        lines.push(`       ${lineNum}: ${role} ${msg.content}${suffix}`);
      }
    }

    lines.push("");
  }

  if (result.conversations.length > 0) {
    const firstId = truncateId(result.conversations[0].id);
    const page = options.page ?? 1;
    lines.push(`Use: codecast read ${firstId} <range>        # read messages by line range`);
    lines.push(`     codecast feed -p ${page + 1}                  # next page`);
  }

  if (options.projectPath) {
    lines.push(`\nScope: ${truncatePath(options.projectPath)}`);
  }

  lines.push("</FEED>");

  return lines.join("\n");
}

interface HandoffMessage {
  line: number;
  role: string;
  content: string;
  timestamp: string;
  tool_calls?: Array<{ name?: string; input?: unknown }>;
  tool_results?: Array<{ content?: string; isError?: boolean }>;
}

interface HandoffResult {
  conversation: {
    id: string;
    title: string;
    project_path: string | null;
    message_count: number;
    updated_at: string;
  };
  messages: HandoffMessage[];
}

export function formatHandoff(result: HandoffResult): string {
  const lines: string[] = [];
  const conv = result.conversation;
  const now = new Date().toISOString();

  lines.push(`<HANDOFF generated="${now}">`);
  lines.push(`# Session Handoff: ${conv.title}`);
  lines.push("");

  const userRequests: Array<{ line: number; content: string; completed: boolean }> = [];
  const filesModified = new Set<string>();
  const filesRead = new Set<string>();
  let currentFile: string | null = null;

  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i];

    if (msg.role === "user" && msg.content) {
      const nextMsgs = result.messages.slice(i + 1);
      const hasResponse = nextMsgs.some(m => m.role === "assistant" && (m.content || m.tool_calls?.length));
      userRequests.push({
        line: msg.line,
        content: msg.content.slice(0, 200) + (msg.content.length > 200 ? "..." : ""),
        completed: hasResponse,
      });
    }

    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const input = parseToolInput(tc.input);
        if (tc.name === "Edit" || tc.name === "Write") {
          const filePath = input?.file_path as string | undefined;
          if (filePath) {
            filesModified.add(filePath);
            currentFile = filePath;
          }
        } else if (tc.name === "Read") {
          const filePath = input?.file_path as string | undefined;
          if (filePath) {
            filesRead.add(filePath);
            currentFile = filePath;
          }
        }
      }
    }
  }

  lines.push("## Current State");
  const completed = userRequests.filter(r => r.completed);
  const pending = userRequests.filter(r => !r.completed);

  if (completed.length > 0) {
    const recentCompleted = completed.slice(-3);
    for (const req of recentCompleted) {
      const shortContent = req.content.split("\n")[0].slice(0, 80);
      lines.push(`- COMPLETE: ${shortContent}`);
    }
  }

  if (pending.length > 0) {
    for (const req of pending) {
      const shortContent = req.content.split("\n")[0].slice(0, 80);
      lines.push(`- PENDING: ${shortContent}`);
    }
  }

  if (completed.length === 0 && pending.length === 0) {
    lines.push("- No tracked requests");
  }

  lines.push("");

  if (currentFile || filesModified.size > 0) {
    lines.push("## Active Work");
    if (currentFile) {
      const shortPath = truncatePath(currentFile);
      lines.push(`Current file: ${shortPath}`);
    }
    lines.push("");
  }

  lines.push("## Key Context");
  if (conv.project_path) {
    lines.push(`- Project: ${truncatePath(conv.project_path)}`);
  }
  lines.push(`- Session: ${truncateId(conv.id)} (${conv.message_count} messages)`);
  lines.push(`- Last activity: ${formatDate(conv.updated_at)}`);
  lines.push("");

  if (filesModified.size > 0) {
    lines.push("## Files Modified");
    const modifiedList = Array.from(filesModified).slice(-10);
    for (const f of modifiedList) {
      lines.push(`- ${truncatePath(f)}`);
    }
    lines.push("");
  }

  if (pending.length > 0) {
    lines.push("## Next Steps");
    for (let i = 0; i < Math.min(pending.length, 5); i++) {
      const req = pending[i];
      const shortContent = req.content.split("\n")[0].slice(0, 60);
      lines.push(`${i + 1}. ${shortContent}`);
    }
    lines.push("");
  }

  const recentFiles = Array.from(filesRead).slice(-5).concat(Array.from(filesModified).slice(-5));
  const uniqueFiles = [...new Set(recentFiles)].slice(-5);
  if (uniqueFiles.length > 0) {
    lines.push("## Files to Review");
    for (const f of uniqueFiles) {
      lines.push(`- ${truncatePath(f)}`);
    }
  }

  lines.push("</HANDOFF>");

  return lines.join("\n");
}

interface DiffMessage {
  line?: number;
  role?: string;
  content?: string;
  timestamp?: string;
  tool_calls?: unknown[];
  tool_results?: unknown[];
}

interface DiffSession {
  id: string;
  title: string;
  messages: DiffMessage[];
}

interface DiffInput {
  sessions: DiffSession[];
  aggregated: boolean;
  period?: "today" | "week";
}

interface FileStats {
  status: "M" | "A";
  additions: number;
  deletions: number;
}

interface CommitInfo {
  hash: string;
  message: string;
}

function extractDiffData(sessions: DiffSession[]): {
  files: Map<string, FileStats>;
  commits: CommitInfo[];
  toolCounts: Map<string, number>;
  duration: number;
  messageCount: number;
} {
  const files = new Map<string, FileStats>();
  const commits: CommitInfo[] = [];
  const toolCounts = new Map<string, number>();
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  let messageCount = 0;

  for (const session of sessions) {
    for (const msg of session.messages) {
      messageCount++;

      if (msg.timestamp) {
        const ts = new Date(msg.timestamp).getTime();
        if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
        if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
      }

      if (msg.tool_calls) {
        for (const tcRaw of msg.tool_calls) {
          const tc = tcRaw as { name?: string; input?: unknown } | null;
          if (!tc || !tc.name) continue;

          toolCounts.set(tc.name, (toolCounts.get(tc.name) || 0) + 1);

          const tcInput = parseToolInput(tc.input);
          if (!tcInput) continue;

          if (tc.name === "Edit") {
            const filePath = tcInput.file_path as string;
            if (!filePath) continue;

            const existing = files.get(filePath) || { status: "M" as const, additions: 0, deletions: 0 };
            const oldStr = (tcInput.old_string as string) || "";
            const newStr = (tcInput.new_string as string) || "";
            existing.additions += newStr.split("\n").length;
            existing.deletions += oldStr.split("\n").length;
            files.set(filePath, existing);
          } else if (tc.name === "Write") {
            const filePath = tcInput.file_path as string;
            if (!filePath) continue;

            const existing = files.get(filePath);
            const content = (tcInput.content as string) || "";
            const lineCount = content.split("\n").length;

            if (!existing) {
              files.set(filePath, { status: "A", additions: lineCount, deletions: 0 });
            } else {
              existing.additions += lineCount;
              files.set(filePath, existing);
            }
          } else if (tc.name === "Bash") {
            const command = (tcInput.command as string) || "";
            const commitMatch = command.match(/git commit\s+(?:-m\s+)?["']([^"']+)["']/);
            if (commitMatch) {
              commits.push({ hash: "pending", message: commitMatch[1].slice(0, 80) });
            }
          }
        }
      }

      if (msg.tool_results) {
        for (const trRaw of msg.tool_results) {
          const tr = trRaw as { content?: string; isError?: boolean } | null;
          if (!tr || !tr.content) continue;

          const contentLines = tr.content.split("\n");
          for (const line of contentLines) {
            const gitCommitMatch = line.match(/\[[\w-]+\s+([a-f0-9]{7,8})\]\s+(.+)/);
            if (gitCommitMatch && !commits.find(c => c.hash === gitCommitMatch[1])) {
              commits.push({ hash: gitCommitMatch[1], message: gitCommitMatch[2].slice(0, 80) });
            }
          }
        }
      }
    }
  }

  const duration = firstTimestamp && lastTimestamp
    ? Math.round((lastTimestamp - firstTimestamp) / 60000)
    : 0;

  return { files, commits, toolCounts, duration, messageCount };
}

export function formatDiffResults(input: DiffInput): string {
  const lines: string[] = [];
  const { sessions, aggregated, period } = input;

  if (sessions.length === 0) {
    return "No sessions to analyze";
  }

  const { files, commits, toolCounts, duration, messageCount } = extractDiffData(sessions);

  if (aggregated) {
    const periodLabel = period === "today" ? "Today" : "This Week";
    lines.push(`<DIFF period="${periodLabel}" sessions="${sessions.length}">`);
    lines.push(`Sessions: ${sessions.length}`);
  } else {
    const session = sessions[0];
    const sessionId = truncateId(session.id);
    lines.push(`<DIFF session="${sessionId}" title="${session.title}">`);
  }

  if (duration > 0) {
    const hours = Math.floor(duration / 60);
    const mins = duration % 60;
    const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins} minute${mins !== 1 ? "s" : ""}`;
    lines.push(`Duration: ${durationStr}`);
  }
  lines.push(`Messages: ${messageCount}`);
  lines.push("");

  if (files.size > 0) {
    lines.push(`## Files Changed (${files.size})`);

    const sortedFiles = Array.from(files.entries())
      .sort((a, b) => (b[1].additions + b[1].deletions) - (a[1].additions + a[1].deletions));

    for (const [filePath, stats] of sortedFiles.slice(0, 15)) {
      const shortPath = truncatePath(filePath);
      const paddedPath = shortPath.padEnd(40);
      const statusIcon = stats.status === "A" ? "A" : "M";

      if (stats.status === "A") {
        lines.push(` ${statusIcon} ${paddedPath} +${stats.additions} (new)`);
      } else if (stats.deletions > 0) {
        lines.push(` ${statusIcon} ${paddedPath} +${stats.additions} -${stats.deletions}`);
      } else {
        lines.push(` ${statusIcon} ${paddedPath} +${stats.additions}`);
      }
    }

    if (files.size > 15) {
      lines.push(`   ... and ${files.size - 15} more files`);
    }
    lines.push("");
  }

  const validCommits = commits.filter(c => c.hash !== "pending");
  if (validCommits.length > 0) {
    lines.push(`## Commits (${validCommits.length})`);
    for (const commit of validCommits.slice(0, 10)) {
      lines.push(`[${commit.hash}] ${commit.message}`);
    }
    if (validCommits.length > 10) {
      lines.push(`   ... and ${validCommits.length - 10} more commits`);
    }
    lines.push("");
  }

  if (toolCounts.size > 0) {
    lines.push("## Tools Used");
    const sortedTools = Array.from(toolCounts.entries())
      .sort((a, b) => b[1] - a[1]);

    for (const [tool, count] of sortedTools) {
      lines.push(`- ${tool}: ${count} call${count === 1 ? "" : "s"}`);
    }
    lines.push("");
  }

  lines.push("</DIFF>");

  return lines.join("\n");
}

interface Decision {
  id: string;
  title: string;
  rationale: string;
  alternatives?: string[];
  tags?: string[];
  session_id?: string;
  message_index?: number;
  project_path?: string;
  created_at: string;
}

interface DecisionsResult {
  decisions: Decision[];
  count: number;
}

export function formatDecisionsResults(result: DecisionsResult): string {
  const lines: string[] = [];

  lines.push(`<DECISIONS count=${result.count}>`);

  if (result.decisions.length === 0) {
    lines.push("No decisions found.");
    lines.push("</DECISIONS>");
    return lines.join("\n");
  }

  for (const decision of result.decisions) {
    const shortId = truncateId(decision.id);
    const date = new Date(decision.created_at).toISOString().split("T")[0];

    lines.push(`[${shortId}] ${date} - ${decision.title}`);
    lines.push(`  Why: ${decision.rationale}`);

    if (decision.tags && decision.tags.length > 0) {
      lines.push(`  Tags: ${decision.tags.join(", ")}`);
    }

    if (decision.session_id) {
      const sessionShort = truncateId(decision.session_id);
      const msgPart = decision.message_index !== undefined ? ` msg ${decision.message_index}` : "";
      lines.push(`  Session: [${sessionShort}]${msgPart}`);
    }

    lines.push(`  ID: ${decision.id}`);
    lines.push("");
  }

  lines.push("</DECISIONS>");

  return lines.join("\n");
}

interface Pattern {
  id: string;
  name: string;
  description: string;
  content?: string;
  tags?: string[];
  source_session_id?: string;
  source_range?: string;
  usage_count: number;
  created_at: string;
}

interface PatternsListResult {
  patterns: Pattern[];
  count: number;
}

export function formatPatternsResults(result: PatternsListResult): string {
  const lines: string[] = [];

  lines.push(`<PATTERNS count=${result.count}>`);

  if (result.patterns.length === 0) {
    lines.push("No patterns found.");
    lines.push("</PATTERNS>");
    return lines.join("\n");
  }

  for (let i = 0; i < result.patterns.length; i++) {
    const pattern = result.patterns[i];
    const num = String(i + 1).padStart(3, "0");

    lines.push(`[P${num}] ${pattern.name}`);
    lines.push(`  Description: ${pattern.description}`);

    if (pattern.tags && pattern.tags.length > 0) {
      lines.push(`  Tags: ${pattern.tags.join(", ")}`);
    }

    lines.push(`  Used: ${pattern.usage_count} time${pattern.usage_count === 1 ? "" : "s"}`);
    lines.push("");
  }

  lines.push("</PATTERNS>");

  return lines.join("\n");
}

interface PatternShowResult {
  id: string;
  name: string;
  description: string;
  content: string;
  tags?: string[];
  source_session_id?: string;
  source_range?: string;
  usage_count: number;
  created_at: string;
}

export function formatPatternShow(result: PatternShowResult): string {
  const lines: string[] = [];

  lines.push(`<PATTERN name="${result.name}">`);
  lines.push(`# ${result.name}`);
  lines.push("");
  lines.push("## Description");
  lines.push(result.description);
  lines.push("");

  if (result.tags && result.tags.length > 0) {
    lines.push("## Tags");
    lines.push(result.tags.join(", "));
    lines.push("");
  }

  lines.push("## Content");
  lines.push(result.content);
  lines.push("");

  if (result.source_session_id) {
    lines.push("## Source");
    const sessionShort = truncateId(result.source_session_id);
    const rangePart = result.source_range ? ` lines ${result.source_range}` : "";
    lines.push(`Session [${sessionShort}]${rangePart}`);
    lines.push("");
  }

  lines.push(`Used: ${result.usage_count} time${result.usage_count === 1 ? "" : "s"}`);
  lines.push("</PATTERN>");

  return lines.join("\n");
}

interface SimilarSession {
  conversation_id: string;
  session_id?: string;
  title: string;
  project_path?: string;
  updated_at: string;
  message_count: number;
  match_type: string;
  match_detail?: string;
}

interface SimilarResult {
  sessions: SimilarSession[];
  count: number;
  query_type?: string;
  query_value?: string;
}

export function formatSimilarResults(result: SimilarResult, query: { file?: string; session?: string }): string {
  const lines: string[] = [];

  const queryStr = query.file ? `--file ${query.file}` : `--session ${query.session}`;
  lines.push(`<SIMILAR query="${queryStr}">`);

  if (result.count === 0) {
    if (query.file) {
      lines.push(`No sessions found that touched ${query.file}`);
      lines.push("");
      lines.push("Note: File touch data may be sparse for older sessions.");
    } else {
      lines.push(`No similar sessions found for ${query.session}`);
    }
    lines.push("</SIMILAR>");
    return lines.join("\n");
  }

  const queryLabel = query.file || query.session || "query";
  lines.push(`Found ${result.count} session${result.count === 1 ? "" : "s"} that touched ${queryLabel}\n`);

  for (const session of result.sessions) {
    const sessionId = session.session_id ? truncateId(session.session_id) : truncateId(session.conversation_id);
    const date = formatDate(session.updated_at);
    const title = session.title || "Untitled";

    lines.push(`[${sessionId}] ${date} - "${title}"`);

    if (session.match_detail) {
      const matchType = session.match_type === "file" ? "Modified" : "Related";
      lines.push(`  Match: ${matchType} ${session.match_detail}`);
    }

    lines.push(`  Messages: ${session.message_count}`);

    if (session.project_path) {
      lines.push(`  Project: ${truncatePath(session.project_path)}`);
    }

    lines.push("");
  }

  if (result.sessions.length > 0) {
    const firstId = result.sessions[0].session_id
      ? truncateId(result.sessions[0].session_id)
      : truncateId(result.sessions[0].conversation_id);
    lines.push(`Use: codecast read ${firstId} <range>  # read messages from a session`);
  }

  lines.push("</SIMILAR>");

  return lines.join("\n");
}

interface AskSessionDetail {
  id: string;
  title: string;
  messages: Array<{ line: number; role: string; content: string }>;
  matchLines: number[];
}

interface AskInput {
  query: string;
  sessions: AskSessionDetail[];
  searchTerms: string[];
}

function highlightTerms(text: string, terms: string[]): string {
  let result = text;
  for (const term of terms) {
    const regex = new RegExp(`\\b(${term})\\b`, "gi");
    result = result.replace(regex, "**$1**");
  }
  return result;
}

function extractRelevantSnippet(content: string, terms: string[], maxLength: number = 200): string {
  if (!content) return "";

  const lower = content.toLowerCase();
  let bestStart = 0;
  let bestScore = 0;

  for (let i = 0; i < content.length; i += 50) {
    const window = lower.slice(i, i + maxLength);
    let score = 0;
    for (const term of terms) {
      if (window.includes(term.toLowerCase())) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  let snippet = content.slice(bestStart, bestStart + maxLength);
  if (bestStart > 0) snippet = "..." + snippet;
  if (bestStart + maxLength < content.length) snippet = snippet + "...";

  return snippet.replace(/\n+/g, " ").trim();
}

export function formatAskResults(input: AskInput): string {
  const lines: string[] = [];
  const { query, sessions, searchTerms } = input;

  lines.push(`<ANSWER query="${query}">`);

  if (sessions.length === 0) {
    lines.push("No relevant information found.");
    lines.push("</ANSWER>");
    return lines.join("\n");
  }

  const snippets: Array<{
    sessionId: string;
    title: string;
    line: number;
    endLine: number;
    role: string;
    content: string;
    relevance: number;
  }> = [];

  for (const session of sessions) {
    for (const msg of session.messages) {
      if (!msg.content) continue;

      const isMatch = session.matchLines.includes(msg.line);
      const termMatches = searchTerms.filter(t =>
        msg.content.toLowerCase().includes(t.toLowerCase())
      ).length;

      if (isMatch || termMatches > 0) {
        snippets.push({
          sessionId: session.id,
          title: session.title,
          line: msg.line,
          endLine: msg.line,
          role: msg.role,
          content: msg.content,
          relevance: (isMatch ? 2 : 0) + termMatches,
        });
      }
    }
  }

  snippets.sort((a, b) => b.relevance - a.relevance);
  const topSnippets = snippets.slice(0, 5);

  if (topSnippets.length === 0) {
    lines.push("Found sessions but no specific matches for the query terms.");
    lines.push("");
    lines.push("Related sessions:");
    for (const session of sessions.slice(0, 3)) {
      lines.push(`- [${truncateId(session.id)}] ${session.title}`);
    }
    lines.push("</ANSWER>");
    return lines.join("\n");
  }

  const grouped = new Map<string, typeof topSnippets>();
  for (const snippet of topSnippets) {
    const key = snippet.sessionId;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(snippet);
  }

  let firstSession = true;
  for (const [sessionId, sessionSnippets] of grouped) {
    const sessionTitle = sessionSnippets[0].title;
    const shortId = truncateId(sessionId);

    if (firstSession) {
      const mainSnippet = sessionSnippets[0];
      const excerpt = extractRelevantSnippet(mainSnippet.content, searchTerms, 300);
      const highlighted = highlightTerms(excerpt, searchTerms);
      lines.push(highlighted);
      lines.push("");
      firstSession = false;
    }

    const minLine = Math.min(...sessionSnippets.map(s => s.line));
    const maxLine = Math.max(...sessionSnippets.map(s => s.endLine));

    if (sessionSnippets.length > 1 || !firstSession) {
      const preview = extractRelevantSnippet(sessionSnippets[0].content, searchTerms, 100);
      lines.push(`- [${shortId}] ${sessionTitle}`);
      lines.push(`  msg ${minLine}${maxLine !== minLine ? `-${maxLine}` : ""}: ${preview}`);
    }
  }

  lines.push("");
  lines.push("Sources:");
  for (const [sessionId, sessionSnippets] of grouped) {
    const shortId = truncateId(sessionId);
    const minLine = Math.min(...sessionSnippets.map(s => s.line));
    const maxLine = Math.max(...sessionSnippets.map(s => s.endLine));
    const title = sessionSnippets[0].title;
    lines.push(`- [${shortId}] msg ${minLine}${maxLine !== minLine ? `-${maxLine}` : ""}: ${title}`);
  }

  lines.push("</ANSWER>");

  return lines.join("\n");
}

interface BlameTouch {
  conversation_id: string;
  session_id?: string;
  title: string;
  operation: string;
  line_range?: string;
  message_index: number;
  timestamp: string;
}

interface BlameResult {
  touches: BlameTouch[];
  count: number;
  file_path: string;
  line?: number;
}

export function formatBlameResults(result: BlameResult): string {
  const lines: string[] = [];

  const shortPath = truncatePath(result.file_path);
  const target = result.line ? `${shortPath}:${result.line}` : shortPath;

  lines.push(`<BLAME target="${target}">`);

  if (result.touches.length === 0) {
    lines.push("No sessions found that touched this file.");
    lines.push("</BLAME>");
    return lines.join("\n");
  }

  lines.push(`File touched by ${result.count} session${result.count === 1 ? "" : "s"}\n`);

  const groupedBySession = new Map<string, BlameTouch[]>();
  for (const touch of result.touches) {
    const key = touch.session_id || touch.conversation_id;
    const existing = groupedBySession.get(key) || [];
    existing.push(touch);
    groupedBySession.set(key, existing);
  }

  for (const [sessionKey, touches] of groupedBySession) {
    const first = touches[0];
    const sessionId = first.session_id || truncateId(first.conversation_id);
    const date = new Date(first.timestamp).toISOString().split("T")[0];

    lines.push(`[${truncateId(sessionId)}] ${date} - "${first.title}"`);

    const opCounts = new Map<string, number>();
    for (const t of touches) {
      opCounts.set(t.operation, (opCounts.get(t.operation) || 0) + 1);
    }

    const opSummary: string[] = [];
    for (const [op, count] of opCounts) {
      const opLabel = op === "write" ? "write (created)" : op;
      opSummary.push(count > 1 ? `${count}x ${opLabel}` : opLabel);
    }
    lines.push(`  Operations: ${opSummary.join(", ")}`);

    const lineRanges = touches.filter(t => t.line_range).map(t => t.line_range);
    if (result.line && lineRanges.length > 0) {
      const matching = lineRanges.filter(r => {
        if (!r) return false;
        const [start, end] = r.split("-").map(Number);
        return result.line! >= start && result.line! <= (end || start);
      });
      if (matching.length > 0) {
        lines.push(`  Line ranges: ${matching.slice(0, 3).join(", ")}`);
      }
    }

    lines.push("");
  }

  if (groupedBySession.size > 0) {
    const firstSession = result.touches[0];
    const firstId = truncateId(firstSession.session_id || firstSession.conversation_id);
    lines.push(`Use: codecast read ${firstId}                # read full session`);
  }

  lines.push("</BLAME>");

  return lines.join("\n");
}

interface ContextSession {
  id: string;
  title: string;
  project_path: string | null;
  updated_at: string;
  message_count: number;
  preview?: string;
  match_type: string;
  match_detail?: string;
  files?: string[];
}

interface ContextRelatedFile {
  path: string;
  session_count: number;
}

interface ContextInput {
  query?: string;
  sessions: ContextSession[];
  related_files: ContextRelatedFile[];
}

export function formatContextResults(input: ContextInput): string {
  const lines: string[] = [];
  const { query, sessions, related_files } = input;

  const queryDisplay = query || "(file-based search)";
  lines.push(`<CONTEXT query="${queryDisplay}">`);

  if (sessions.length === 0) {
    lines.push("No relevant sessions found.");
    lines.push("");
    lines.push("Try:");
    lines.push("  codecast context \"your task description\"");
    lines.push("  codecast context --file path/to/file.ts");
    lines.push("</CONTEXT>");
    return lines.join("\n");
  }

  lines.push(`Found ${sessions.length} relevant session${sessions.length === 1 ? "" : "s"}\n`);

  lines.push("## Most Relevant");
  for (const session of sessions.slice(0, 5)) {
    const shortId = truncateId(session.id);
    const date = formatDate(session.updated_at);
    const title = session.title || "Untitled";

    lines.push(`[${shortId}] ${date} - "${title}"`);

    if (session.preview) {
      const previewClean = session.preview.replace(/\n+/g, " ").trim();
      lines.push(`  Preview: ${previewClean}`);
    }

    if (session.files && session.files.length > 0) {
      lines.push(`  Files: ${session.files.join(", ")}`);
    }

    lines.push("");
  }

  if (sessions.length > 5) {
    lines.push(`... and ${sessions.length - 5} more sessions`);
    lines.push("");
  }

  if (related_files.length > 0) {
    lines.push("## Related Files");
    for (const file of related_files.slice(0, 10)) {
      const count = file.session_count;
      lines.push(`- ${file.path} (${count} session${count === 1 ? "" : "s"})`);
    }
    lines.push("");
  }

  if (sessions.length > 0) {
    const firstId = truncateId(sessions[0].id);
    lines.push(`Use: codecast read ${firstId} <range>  # read session messages`);
    lines.push(`     codecast summary ${firstId}        # get session summary`);
  }

  lines.push("</CONTEXT>");

  return lines.join("\n");
}

interface ResumeConversation {
  id: string;
  session_id?: string;
  title: string;
  subtitle?: string | null;
  project_path: string | null;
  updated_at: string;
  message_count: number;
  agent_type?: string;
  preview?: string;
  goal?: string;
  user?: { name: string | null; email: string | null };
}

interface ResumeResult {
  conversations: ResumeConversation[];
  query: string;
}

export function formatResumeResults(result: ResumeResult): string {
  const lines: string[] = [];
  const { conversations, query } = result;

  if (conversations.length === 0) {
    lines.push(`${c.dim}No sessions found matching "${query}"${c.reset}`);
    lines.push("");
    lines.push("Try:");
    lines.push("  codecast resume \"different query\"");
    lines.push("  codecast feed -g  # browse all sessions");
    return lines.join("\n");
  }

  const ownConvs = conversations.filter(cv => !cv.user);
  const teamConvs = conversations.filter(cv => cv.user);

  const getAgentLabel = (agentType?: string): string | null => {
    if (!agentType || agentType === "claude_code" || agentType === "claude") return "Claude";
    if (agentType === "codex" || agentType === "codex_cli") return "Codex";
    if (agentType === "cursor") return "Cursor";
    return agentType;
  };

  lines.push(`${c.dim}Found ${conversations.length} session${conversations.length === 1 ? "" : "s"} matching "${query}"${c.reset}`);
  lines.push("");

  const formatConv = (conv: ResumeConversation, idx: number) => {
    const num = `${c.bold}${c.cyan}[${idx + 1}]${c.reset}`;
    const title = conv.title || "Untitled";
    const relTime = formatRelativeTime(conv.updated_at);

    lines.push(`${num} ${c.bold}${title}${c.reset}`);

    const meta = [
      `${c.dim}${relTime}${c.reset}`,
      `${c.dim}${conv.message_count} msgs${c.reset}`,
    ];
    if (conv.user) {
      const name = conv.user.name || conv.user.email || "team member";
      meta.push(`${c.magenta}${name}${c.reset}`);
    }
    const label = getAgentLabel(conv.agent_type);
    if (label) {
      meta.push(`${c.yellow}${label}${c.reset}`);
    }
    if (conv.project_path) {
      meta.push(`${c.dim}${truncatePath(conv.project_path)}${c.reset}`);
    }
    lines.push(`    ${meta.join(" | ")}`);

    const firstMessage = conv.goal || conv.preview;
    if (firstMessage) {
      const msgLine = firstMessage.split("\n")[0].trim();
      const maxLen = 85;
      if (msgLine.length > maxLen) {
        lines.push(`    ${c.green}>${c.reset} ${msgLine.slice(0, maxLen)}...`);
      } else {
        lines.push(`    ${c.green}>${c.reset} ${msgLine}`);
      }
    }

    if (conv.subtitle) {
      const subtitleLines = conv.subtitle.split("\n").filter((l) => l.trim());
      const maxLines = 4;
      const maxLineLen = 83;

      for (let j = 0; j < Math.min(subtitleLines.length, maxLines); j++) {
        const rawLine = subtitleLines[j].trim();
        if (rawLine.length > maxLineLen) {
          lines.push(`      ${rawLine.slice(0, maxLineLen)}...`);
        } else {
          lines.push(`      ${rawLine}`);
        }
      }
      if (subtitleLines.length > maxLines) {
        lines.push(`      ${c.dim}... (${subtitleLines.length - maxLines} more)${c.reset}`);
      }
    }

    lines.push("");
  };

  for (let i = 0; i < ownConvs.length; i++) {
    formatConv(ownConvs[i], i);
  }

  if (teamConvs.length > 0) {
    lines.push(`${c.dim}── Team ──${c.reset}`);
    lines.push("");
    for (let i = 0; i < teamConvs.length; i++) {
      formatConv(teamConvs[i], ownConvs.length + i);
    }
  }

  lines.push(`${c.dim}Run: codecast resume "${query}" and use arrows to pick a session (q to quit)${c.reset}`);

  return lines.join("\n");
}

type TreeNode = {
  id: string;
  short_id?: string;
  title: string;
  message_count: number;
  parent_message_uuid?: string;
  started_at: number;
  status: string;
  is_current: boolean;
  children: TreeNode[];
};

export function formatTree(tree: TreeNode): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`${c.bold}Fork Tree${c.reset}`);
  lines.push("");

  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, isRoot: boolean) => {
    const connector = isRoot ? "" : isLast ? "+-- " : "+-- ";
    const marker = node.is_current ? `${c.bold}${c.magenta}*${c.reset} ` : "  ";
    const shortId = node.short_id || node.id.slice(0, 7);
    const title = node.title.length > 50 ? node.title.slice(0, 47) + "..." : node.title;
    const titleColor = node.is_current ? `${c.bold}${c.magenta}` : "";
    const titleReset = node.is_current ? c.reset : "";

    lines.push(
      `${prefix}${connector}${marker}${titleColor}${title}${titleReset} ${c.dim}(${shortId}, ${node.message_count} msgs)${c.reset}`
    );

    const childPrefix = isRoot ? "" : prefix + (isLast ? "    " : "|   ");
    for (let i = 0; i < node.children.length; i++) {
      renderNode(node.children[i], childPrefix, i === node.children.length - 1, false);
    }
  };

  renderNode(tree, "  ", true, true);
  lines.push("");

  return lines.join("\n");
}
