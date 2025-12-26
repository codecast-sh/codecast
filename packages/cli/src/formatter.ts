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
  matches: SearchMatch[];
  context: ContextMessage[];
}

interface SearchResult {
  total_matches: number;
  conversations: SearchConversation[];
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

function truncatePath(path: string | null): string {
  if (!path) return "";
  const home = process.env.HOME || "";
  if (home && path.startsWith(home)) {
    path = "~" + path.slice(home.length);
  }
  if (path.length > 40) {
    const parts = path.split("/");
    if (parts.length > 3) {
      return parts[0] + "/.../" + parts.slice(-2).join("/");
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

export function formatSearchResults(result: SearchResult): string {
  const lines: string[] = [];

  lines.push("<SEARCHRESULTS>");

  if (result.total_matches === 0) {
    lines.push("No matches found.");
    lines.push("</SEARCHRESULTS>");
    return lines.join("\n");
  }

  lines.push(`Found ${result.total_matches} match${result.total_matches === 1 ? "" : "es"} in ${result.conversations.length} conversation${result.conversations.length === 1 ? "" : "s"}\n`);

  for (const conv of result.conversations) {
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

    const allMsgs = [...conv.matches, ...conv.context].sort((a, b) => a.line - b.line);
    const matchLines = new Set(conv.matches.map((m) => m.line));

    for (const msg of allMsgs) {
      const lineNum = String(msg.line).padStart(4);
      const role = formatRole(msg.role);
      const prefix = matchLines.has(msg.line) ? "" : "-";

      const toolInfo: string[] = [];
      if (msg.tool_calls_count) {
        toolInfo.push(`${msg.tool_calls_count} tool call${msg.tool_calls_count === 1 ? "" : "s"}`);
      }
      if (msg.tool_results_count) {
        toolInfo.push(`${msg.tool_results_count} tool result${msg.tool_results_count === 1 ? "" : "s"}`);
      }

      if (msg.content) {
        lines.push(`${prefix}${lineNum}: ${role} ${msg.content}`);
        if (toolInfo.length > 0) {
          lines.push(`       [${toolInfo.join(", ")}]`);
        }
      } else if (toolInfo.length > 0) {
        lines.push(`${prefix}${lineNum}: ${role} [${toolInfo.join(", ")}]`);
      } else {
        lines.push(`${prefix}${lineNum}: ${role} (empty)`);
      }
    }

    lines.push("");
  }

  if (result.conversations.length > 0) {
    const firstId = truncateId(result.conversations[0].id);
    lines.push(`Use: codecast read ${firstId} <range>  # e.g., codecast read ${firstId} 10:20`);
  }

  lines.push("</SEARCHRESULTS>");

  return lines.join("\n");
}

export function formatReadResult(result: ReadResult): string {
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
    const lineNum = String(msg.line).padStart(4);
    const role = formatRole(msg.role);
    lines.push(`${lineNum}: ${role}`);

    if (msg.content) {
      const indentedContent = msg.content.split("\n").map((l) => "       " + l).join("\n");
      lines.push(indentedContent);
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      lines.push(`       [${msg.tool_calls.length} tool call${msg.tool_calls.length === 1 ? "" : "s"}]`);
    }

    if (msg.tool_results && msg.tool_results.length > 0) {
      lines.push(`       [${msg.tool_results.length} tool result${msg.tool_results.length === 1 ? "" : "s"}]`);
    }

    lines.push("");
  }

  return lines.join("\n");
}
