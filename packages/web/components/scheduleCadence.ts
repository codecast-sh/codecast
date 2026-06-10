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
