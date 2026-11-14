// Pure helpers that pull a session summary (goal, approach, decisions, outcome,
// files touched) out of its messages. Split out of formatter.ts.

export interface SummaryMessage {
  line: number;
  role: string;
  content: string;
  timestamp: string;
  tool_calls?: Array<{ name?: string; input?: unknown }>;
  tool_results?: Array<{ content?: string; isError?: boolean }>;
}

interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

export function parseToolInput(input: unknown): Record<string, unknown> | null {
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

export function extractFileChanges(messages: SummaryMessage[]): FileChange[] {
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

export function extractGoal(messages: SummaryMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content);
  if (!firstUser) return "No user message found";

  const content = firstUser.content.trim();
  const lines = content.split("\n");
  if (lines.length <= 3) return content;

  return lines.slice(0, 3).join("\n") + "...";
}

export function extractApproach(messages: SummaryMessage[]): string[] {
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

export function extractKeyDecisions(messages: SummaryMessage[]): string[] {
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

export function summarizeOutcome(messages: SummaryMessage[]): string {
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
