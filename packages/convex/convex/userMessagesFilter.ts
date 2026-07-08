// Pure filter/map logic for getUserMessages.
//
// Split out so we can unit-test the user-message filter without standing up a
// Convex ctx. The query handler in conversations.ts owns the auth + index
// query and then hands the user-message array here.
//
// IMPORTANT: this is user-prompt navigation data (message browser, rewind/fork
// navigator). It is user-only by construction — assistant messages must never
// be returned here. Keeping that invariant at the source means no client has to
// re-filter by role (a guard that has been silently dropped by refactors twice).

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
  role: "user";
  content: string;
  timestamp: number;
};

// Synthetic truncation notice the CLI injects into imported sessions for the
// model's context only. New CLIs never sync it; this hides rows older daemons
// already wrote (cleanup:deleteImportNoticeMessages drains them).
export const IMPORT_NOTICE_PREFIX = "[Codecast import]";

export function isImportNotice(content: string | null | undefined): boolean {
  return !!content && content.trimStart().startsWith(IMPORT_NOTICE_PREFIX);
}

const USER_NOISE_PREFIXES = [
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "[Request interrupted",
  "[Request cancelled",
  IMPORT_NOTICE_PREFIX,
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

export function filterUserMessages(
  userMsgs: FilterableMessage[],
): FilteredUserMessage[] {
  return userMsgs
    .filter((m) => {
      if (m.role !== "user") return false;
      if (m.subtype === "compact_boundary") return false;
      if (!m.content || !m.content.trim()) return false;
      const t = stripContextTags(m.content);
      if (!t) return false;
      if (USER_NOISE_PREFIXES.some((p) => t.startsWith(p))) return false;
      if (t.includes(SUMMARY_MARKER)) return false;
      if (m.tool_results && m.tool_results.length > 0 && t.length < 5) return false;
      return true;
    })
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((m) => ({
      _id: m._id,
      message_uuid: m.message_uuid,
      role: "user" as const,
      content: (stripContextTags(m.content!) || m.content!).slice(0, 500),
      timestamp: m.timestamp,
    }));
}
