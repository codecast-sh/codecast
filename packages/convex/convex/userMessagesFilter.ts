// Pure filter/merge/map logic for getUserMessages.
//
// Split out so we can unit-test the merge of user + assistant messages
// without standing up a Convex ctx. The query handler in conversations.ts
// owns the auth + index queries and then hands both arrays here.

export type FilterableMessage = {
  _id: string;
  message_uuid?: string;
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  tool_calls?: Array<unknown> | null;
  tool_results?: Array<unknown> | null;
  subtype?: string;
  timestamp: number;
};

export type FilteredUserMessage = {
  _id: string;
  message_uuid?: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

const USER_NOISE_PREFIXES = [
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "[Request interrupted",
  "[Request cancelled",
  "This session is being continued",
  "Your task is to create a detailed summary",
  "Please continue the conversation",
  "Read the output file to retrieve the result:",
  "Caveat:",
];

const SUMMARY_MARKER =
  "Your task is to create a detailed summary of the conversation so far";

export function stripContextTags(s: string): string {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .trim();
}

export function filterAndMergeUserMessages(
  userMsgs: FilterableMessage[],
  assistantMsgs: FilterableMessage[],
): FilteredUserMessage[] {
  return [...userMsgs, ...assistantMsgs]
    .filter((m) => {
      if (m.subtype === "compact_boundary") return false;
      if (!m.content || !m.content.trim()) return false;
      const t = stripContextTags(m.content);
      if (!t) return false;
      if (m.role === "user") {
        if (USER_NOISE_PREFIXES.some((p) => t.startsWith(p))) return false;
        if (t.includes(SUMMARY_MARKER)) return false;
        if (m.tool_results && m.tool_results.length > 0 && t.length < 5) return false;
      }
      if (m.role === "assistant") {
        if (m.tool_calls && m.tool_calls.length > 0 && t.length < 30) return false;
      }
      return true;
    })
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((m) => ({
      _id: m._id,
      message_uuid: m.message_uuid,
      role: m.role as "user" | "assistant",
      content: (stripContextTags(m.content!) || m.content!).slice(0, 500),
      timestamp: m.timestamp,
    }));
}
