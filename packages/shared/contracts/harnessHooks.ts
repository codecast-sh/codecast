// The hooks codecast registers in Claude Code (~/.claude/settings.json), and
// what each one is for. One list for both ends: the CLI installs and removes
// exactly these files for these events, and the web harness page explains
// them from the same entries, so the page can never describe a hook the CLI
// does not install or miss one it does.
//
// Two kinds. The functional hooks only report to codecast what a session is
// doing and print nothing the model reads; they follow one switch,
// `hooks_enabled` in the device config (Settings > Harness). A hook that puts
// text in front of the agent belongs to the Agent Features entry it serves
// (`feature`, a SNIPPET_CATALOG slug or "stable"), so that one switch adds or
// removes the section and its hook together. Every write either way lands in
// the change history.

export interface HarnessHook {
  /** Script under ~/.claude/hooks/, or the statusLine command. */
  file: string;
  /** Claude Code events it is registered for. Empty: script on disk only. */
  events: readonly string[];
  kind: "hook" | "statusLine";
  /** The Agent Features entry this hook belongs to: installed only while that
   *  feature is on (and the hooks switch is on). Absent: a functional hook. */
  feature?: string;
  /** Installed by its feature's own installer (stable context), not by the
   *  hooks installer; listed here so the Harness page shows every hook. */
  installedElsewhere?: boolean;
  /** Does it put text in front of the agent, or hold a turn open? */
  affectsAgent?: boolean;
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
    feature: "state",
    affectsAgent: true,
    name: "Thread state reminder",
    purpose: "Asks the agent to update the pinned state of its session before it stops. It can hold a turn open for one more step, and adds a short note to a prompt when the state is old.",
    withoutIt: "Pinned states go stale, so the inbox cannot tell which sessions need you and which are done.",
  },
  {
    file: "task-pulse.sh",
    events: [],
    kind: "hook",
    feature: "tasks",
    affectsAgent: true,
    name: "Task reminder",
    purpose: "Every 8 prompts, reminds an agent bound to a task or plan which one it is on. It runs inside the prompt hook.",
    withoutIt: "Agents bound to a task forget to post progress on it.",
  },
  {
    file: "stable-feed.sh",
    events: ["SessionStart"],
    kind: "hook",
    feature: "stable",
    installedElsewhere: true,
    affectsAgent: true,
    name: "Stable context feed",
    purpose: "Adds a feed of your recent sessions to the start of every new session.",
    withoutIt: "New sessions start without the recent history of your other sessions.",
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

/**
 * Should `hook` be installed, given the hooks switch and which Agent Features
 * are on? One rule for the CLI installer and the Harness page, so the page's
 * "Installed" is what the machine actually has. A hook its feature installs
 * itself (stable context) follows that feature alone.
 */
export function harnessHookWanted(
  hook: HarnessHook,
  hooksOn: boolean,
  featureOn: (feature: string) => boolean,
): boolean {
  if (hook.installedElsewhere) return hook.feature ? featureOn(hook.feature) : true;
  return hooksOn && (!hook.feature || featureOn(hook.feature));
}
