// The hooks codecast registers in Claude Code (~/.claude/settings.json), and
// what each one is for. One list for both ends: the CLI installs and removes
// exactly these files for these events, and the web harness page explains
// them from the same entries, so the page can never describe a hook the CLI
// does not install or miss one it does.
//
// All of them are one feature with one switch, `hooks_enabled` in the device
// config. Off means the CLI removes every entry below and never installs one
// again until the switch is turned back on; every other codecast write to the
// harness is recorded in the change history either way.

export interface HarnessHook {
  /** Script under ~/.claude/hooks/, or the statusLine command. */
  file: string;
  /** Claude Code events it is registered for. Empty: script on disk only. */
  events: readonly string[];
  kind: "hook" | "statusLine";
  name: string;
  /** What it does, in one sentence. */
  purpose: string;
  /** What stops working without it. */
  withoutIt: string;
}

export const HARNESS_HOOKS: readonly HarnessHook[] = [
  {
    file: "codecast-status.sh",
    events: ["PreToolUse", "PreCompact", "PostCompact", "Stop", "PermissionRequest", "Notification", "SessionStart"],
    kind: "hook",
    name: "Session status",
    purpose: "Tells codecast when an agent starts a turn, finishes, compacts, or waits for a permission or an answer.",
    withoutIt: "The inbox guesses status from the transcript and the terminal instead, so sessions can show as working after they stopped, and permission prompts and questions arrive late or not at all.",
  },
  {
    file: "session-register.sh",
    events: ["SessionStart"],
    kind: "hook",
    name: "Session registration",
    purpose: "Records which terminal and process each agent session runs in.",
    withoutIt: "Codecast cannot find the terminal of a session you started yourself, so messages sent from the web or phone to that session cannot be delivered, and resume, fork and move are unreliable for it.",
  },
  {
    file: "codecast-prompt.sh",
    events: ["UserPromptSubmit"],
    kind: "hook",
    name: "Prompt submitted",
    purpose: "Runs the status, registration, task and thread state jobs in one process each time a prompt is sent.",
    withoutIt: "Codecast does not learn that a message reached the agent, so a sent message can show as not delivered, and task and state reminders stop.",
  },
  {
    file: "thread-state.sh",
    events: ["Stop"],
    kind: "hook",
    name: "Thread state reminder",
    purpose: "Asks the agent to update the pinned state of its session before it stops.",
    withoutIt: "Pinned states go stale, so the inbox cannot tell which sessions need you and which are done.",
  },
  {
    file: "task-pulse.sh",
    events: [],
    kind: "hook",
    name: "Task reminder",
    purpose: "Reminds the agent now and then which task or plan it is bound to. It runs inside the prompt hook.",
    withoutIt: "Agents bound to a task forget to post progress on it.",
  },
  {
    file: "codecast-statusline.sh",
    events: [],
    kind: "statusLine",
    name: "Status line",
    purpose: "Draws a line under the Claude Code composer and passes your live usage limits to codecast. It is installed only when you have no status line of your own.",
    withoutIt: "Usage meters and automatic account switching update every few minutes instead of on every turn.",
  },
];

export function harnessHookByFile(file: string): HarnessHook | undefined {
  return HARNESS_HOOKS.find((h) => h.file === file);
}
