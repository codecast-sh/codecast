// `cast notify`: how loudly the person hears one session (convex
// sessionWatch). The same four levels as the session menu's Notifications
// submenu on the web and the phone.

export type NotifyLevel = "default" | "all" | "needs_input" | "muted";

const WORDS: Record<string, NotifyLevel> = {
  all: "all",
  every: "all",
  "needs-input": "needs_input",
  needs_input: "needs_input",
  input: "needs_input",
  mute: "muted",
  muted: "muted",
  default: "default",
  unmute: "default",
  off: "default",
};

export const NOTIFY_LEVEL_LABEL: Record<NotifyLevel, string> = {
  default: "default (the usual rules and your mutes)",
  all: "every message",
  needs_input: "every time it needs input",
  muted: "muted",
};

/** The level a typed word names, or null for a word that names none. */
export function parseNotifyLevel(word: string): NotifyLevel | null {
  return WORDS[word.trim().toLowerCase()] ?? null;
}

export type NotifyRow = { conversation_id: string; level: Exclude<NotifyLevel, "default">; updated_at: number };

/** One line per session setting, newest first. */
export function formatNotifyList(rows: NotifyRow[], titleOf: (id: string) => string): string[] {
  if (rows.length === 0) return ["No session has its own notification setting: every one follows the default."];
  return [...rows]
    .sort((a, b) => b.updated_at - a.updated_at)
    .map((r) => `${r.conversation_id.slice(0, 7)}  ${NOTIFY_LEVEL_LABEL[r.level].padEnd(26)}  ${titleOf(r.conversation_id)}`);
}
