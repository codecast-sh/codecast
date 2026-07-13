// Human-readable cadence for `cast schedule add` commands, rendered inline in the
// conversation view. Parses the three mutually-exclusive timing flags the CLI accepts
// (`--every`, `--on`, `--in`) directly from the command args.

// Display labels for `--on <event>` triggers (mirrors EVENT_SHORTHANDS in the CLI).
export const SCHEDULE_EVENT_LABELS: Record<string, string> = {
  pr_comment: "PR comment",
  pr_opened: "PR opened",
  pr_merged: "PR merged",
  push: "push",
};

// Compact duration for countdowns and intervals: "45s", "12m", "2h 30m", "3d 4h".
export function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

// Absolute wall-clock label: "9:58 PM" today, "Jul 12 9:58 PM" otherwise.
// Pairs with fmtDuration: countdown answers "how long", this answers "when".
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

const DURATION_RE = /^(\d+)\s*(s|sec|m|min|h|hr|hour|d|day)s?$/i;
const DURATION_UNIT_NAMES: Record<string, string> = { s: "second", m: "minute", h: "hour", d: "day" };

// "8h" -> "8 hours", "30m" -> "30 minutes", "1d" -> "1 day". Falls back to the raw token if unrecognized.
export function humanizeDurationToken(token: string): string {
  const m = token.trim().match(DURATION_RE);
  if (!m) return token;
  const num = parseInt(m[1], 10);
  const unit = DURATION_UNIT_NAMES[m[2][0].toLowerCase()];
  if (!unit) return token;
  return `${num} ${unit}${num === 1 ? "" : "s"}`;
}

// Cadence label straight from an agent_tasks record (the authoritative fields,
// not command-line args): "every 8h", "on PR comment", "once". Used by the
// schedule strip above the conversation; parseScheduleCadence below stays for
// rendering `cast schedule add` command cards, where only args are available.
export function describeTaskCadence(task: {
  schedule_type: "once" | "recurring" | "event";
  interval_ms?: number;
  event_filter?: { event_type: string } | null;
}): string {
  if (task.schedule_type === "recurring" && task.interval_ms) {
    return `every ${fmtDuration(task.interval_ms)}`;
  }
  if (task.schedule_type === "event") {
    const ev = task.event_filter?.event_type;
    return ev ? `on ${SCHEDULE_EVENT_LABELS[ev] ?? ev.replace(/_/g, " ")}` : "on event";
  }
  return "once";
}

// A schedule due for more than this without being claimed is stuck — the
// daemon normally picks work up within ~30s, so minutes of overdue means no
// eligible device is listening (daemon down, wrong machine, laptop asleep).
export const TASK_OVERDUE_MS = 2 * 60_000;

// Live state label for a schedule row: a countdown that reads as a sentence
// ("in 2h 6m"), or the state word when there's no ticking clock ("due",
// "paused", "running", "event"). Once a due task sits unclaimed past the
// overdue threshold the label says HOW stuck it is ("due 12m") — that's an
// operational signal, not a countdown. Shared by every schedule row surface
// so the wording can't drift between the dock, the rows, and the strip.
export function taskStateLabel(
  task: { status: string; run_at?: number },
  now: number
): string {
  if (task.status === "paused") return "paused";
  if (task.status === "running") return "running";
  if (task.run_at === undefined) return "event";
  const ms = task.run_at - now;
  if (ms > 0) return `in ${fmtDuration(ms)}`;
  return -ms >= TASK_OVERDUE_MS ? `due ${fmtDuration(-ms)}` : "due";
}

// True when a scheduled task has sat unclaimed past the overdue threshold.
export function isTaskOverdue(
  task: { status: string; run_at?: number },
  now: number
): boolean {
  return task.status === "scheduled" && task.run_at !== undefined && now - task.run_at >= TASK_OVERDUE_MS;
}

// Extract the human-readable cadence from `cast schedule add` args. The three timing flags are
// mutually exclusive; absent all of them the task runs immediately ("now").
export function parseScheduleCadence(args: string): string | null {
  // The first positional is the prompt (usually quoted). Strip it so flag-like words inside the
  // prompt (e.g. "review --in depth") can't be mistaken for real timing flags.
  const flags = args.replace(/^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/, "");
  const grab = (name: string) => {
    const m = flags.match(new RegExp(`(?:^|\\s)--${name}[=\\s]+("[^"]*"|'[^']*'|\\S+)`));
    return m ? m[1].replace(/^['"]|['"]$/g, "").trim() : null;
  };
  const isDuration = (v: string) => DURATION_RE.test(v);

  const every = grab("every");
  if (every && isDuration(every)) return `every ${humanizeDurationToken(every)}`;
  const on = grab("on");
  if (on) return `on ${SCHEDULE_EVENT_LABELS[on] ?? on.replace(/_/g, " ")}`;
  const delay = grab("in");
  if (delay && isDuration(delay)) return `in ${humanizeDurationToken(delay)}`;
  return "now";
}
