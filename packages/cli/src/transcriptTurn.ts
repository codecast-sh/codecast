// Whether a Claude transcript's last turn still waits on the agent, read from
// the tail of the JSONL alone (the caller reads the tail; this never touches a
// file). A turn is unanswered when the last thing the main thread recorded is a
// prompt or tool result nobody has replied to, or an assistant message that ends
// in a tool call whose result has not come back.

type Block = { type?: string; text?: string };
type Entry = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { role?: string; content?: string | Block[] };
};

/** What Claude Code records for a local slash command, not for a turn. */
const LOCAL_COMMAND = /^\s*<(command-name|command-message|local-command-)/;
/** What it records when the person interrupts: the turn ended, unanswered by design. */
const INTERRUPTED = /^\s*\[Request interrupted by user/;

/**
 * true: the last turn is unanswered; false: it was answered or ended; null: the
 * tail holds no turn to judge (empty, or no complete line).
 */
export function turnUnanswered(tail: string): boolean | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue; // the cut first line of a tail, or a line mid-write
    }
    if (entry.isSidechain) continue;
    const role = entry.message?.role ?? (entry.type === "user" || entry.type === "assistant" ? entry.type : undefined);
    const content = entry.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    if (role === "assistant") return blocks.at(-1)?.type === "tool_use";
    if (role !== "user" || entry.isMeta) continue;
    const text = typeof content === "string" ? content : blocks.find((b) => b.type === "text")?.text ?? "";
    if (INTERRUPTED.test(text)) return false;
    if (typeof content === "string" && LOCAL_COMMAND.test(content)) continue;
    return true;
  }
  return null;
}
