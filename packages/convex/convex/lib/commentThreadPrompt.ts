// The prompt a comment thread's hidden fork receives when a teammate presses
// "Ask agent to reply" (comments.askAgentInThread): the thread so far, what it
// is anchored to, and a bias toward a short chat-sized answer.

export type ThreadAnchor =
  | { kind: "message"; snippet: string }
  | { kind: "file"; filePath: string; lineNumber?: number };

export function buildAgentThreadPrompt(
  entries: Array<{ name: string; content: string; isAgent: boolean }>,
  anchor: ThreadAnchor | undefined,
  followUp: boolean,
): string {
  const lines: string[] = [];
  if (followUp) {
    lines.push(
      "New replies arrived in the same COMMENT THREAD you're already in. " +
        "Continue the conversation — answer the latest, concisely.",
    );
  } else {
    lines.push(
      "A teammate asked you to reply inside a COMMENT THREAD on this conversation. " +
        "These are side-channel comments between teammates (and you), not the main task.",
    );
    if (anchor?.kind === "message") {
      lines.push("");
      lines.push("The thread is anchored to this message in the transcript:");
      lines.push(`> ${anchor.snippet}`);
    } else if (anchor?.kind === "file") {
      lines.push("");
      lines.push(
        `The thread is anchored to ${anchor.filePath}${anchor.lineNumber ? `:${anchor.lineNumber}` : ""} ` +
          "— a line of code from this session's changes. Read that spot before replying. " +
          "If the thread asks for a change there, make the change, then reply confirming what you did.",
      );
    }
  }
  lines.push("");
  lines.push(followUp ? "New comments since your last reply:" : "Comment thread so far (oldest first):");
  for (const e of entries) {
    if (!e.content.trim()) continue;
    lines.push(`- ${e.isAgent ? "You (earlier)" : e.name}: ${e.content.trim()}`);
  }
  lines.push("");
  lines.push(
    "Write a reply to post back into this thread. Keep it concise and conversational — " +
      "a short, direct comment a colleague would send in chat, not a report. " +
      "Lead with the answer; skip preamble and restating the question. " +
      "Markdown is fine. Don't run tools unless the thread truly requires it.",
  );
  return lines.join("\n");
}
