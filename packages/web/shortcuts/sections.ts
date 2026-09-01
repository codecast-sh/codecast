// The "?" shortcuts panel renders one section per binding context, in this
// order. Every `when` a def in registry.ts carries must have a row here — the
// panel shows only these sections, so a missing row silently hides that
// context's shortcuts (registry.test.ts enforces the pairing).
export const HELP_SECTIONS: { when: string | undefined; label: string; accent: string }[] = [
  { when: undefined, label: "Global", accent: "bg-sol-cyan" },
  { when: "conversation", label: "Conversation", accent: "bg-sol-blue" },
  { when: "chat.dm", label: "Chat", accent: "bg-sol-magenta" },
  { when: "diff", label: "Diff", accent: "bg-sol-green" },
  { when: "list", label: "List", accent: "bg-sol-orange" },
  { when: "tasks", label: "Tasks", accent: "bg-sol-red" },
  { when: "docs", label: "Documents", accent: "bg-sol-yellow" },
  { when: "review", label: "Review", accent: "bg-sol-violet" },
  { when: "desktop", label: "Desktop", accent: "bg-sol-cyan" },
];
