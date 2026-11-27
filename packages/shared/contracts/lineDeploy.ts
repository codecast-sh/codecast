/**
 * The triggers a line profile may name (deploys.md DP4): `person` (the Deploy
 * button, `cast line deploy --go`) and `role` (the profile's role asks for a
 * deploy whenever fixes wait, within its deploy grant's daily limit) start a
 * deploy; `schedule` and `count` are reserved.
 */
export const LINE_DEPLOY_TRIGGERS = ["person", "role", "schedule", "count"] as const;
export type LineDeployTrigger = (typeof LINE_DEPLOY_TRIGGERS)[number];

/**
 * A deploy's steps, in order (deploys.md DP8): each a station of the shipped
 * `line-deploy` graph and a command of `[line.deploy]`. `send` is the team's
 * deploy path (`command`); a step whose command is left out passes with a
 * note. `finish` runs once the deploy is live (a target's `finish`, deploys.md
 * DP15). `watch` is codecast's own: the deploy goes live and its fixes are
 * watched from then.
 */
export const LINE_DEPLOY_STEPS = ["ci", "send", "gate", "rollout", "live", "finish"] as const;
export type LineDeployStep = (typeof LINE_DEPLOY_STEPS)[number];
export const LINE_DEPLOY_STEP_LABELS: Record<LineDeployStep | "watch", string> = {
  ci: "CI",
  send: "Send",
  gate: "Gate",
  rollout: "Roll out",
  live: "Live",
  finish: "Finish",
  watch: "Watch",
};

/** The shipped graph a deploy runs on (cli workflow/templates/line-deploy.cast). */
export const LINE_DEPLOY_GRAPH = "line-deploy";

/** The `[line.deploy]` section of a line profile (line-profile.md LP2). */
export type LineDeployProfile = {
  /** The team's deploy path (the send step), run from the checkout's root. $sha, $deploy and $actor expand. */
  command: string | null;
  /** The surface or environment its markers report ("backend", "production"): how the marker finds the deploy it finishes. */
  target: string | null;
  trigger: LineDeployTrigger;
  /** The role (its handle, no @) that asks for deploys under `trigger = "role"`. */
  role?: string | null;
  /** Before the send: the deploy sha's CI verdict. */
  ci?: string | null;
  /** After the send: the eval gate's verdict on what went out. */
  gate?: string | null;
  /** After the gate: the rollout finishing. */
  rollout?: string | null;
  /** After the rollout: production answering with the deploy sha. */
  live?: string | null;
  /** Once live: what follows the deploy. A deploy target's `finish`; a line profile names none. */
  finish?: string | null;
};

export const LINE_DEPLOY_KEYS = ["command", "target", "trigger", "role", "ci", "gate", "rollout", "live"] as const;
export const LINE_DEPLOY_DEFAULTS: LineDeployProfile = { command: null, target: null, trigger: "person" };

/** The profile command each step runs. */
export const deployStepCommand = (d: Partial<LineDeployProfile> | null | undefined, step: LineDeployStep): string | null =>
  (step === "send" ? d?.command : d?.[step]) ?? null;

/** A target's name as a marker writes it: the surface or the environment, lowercased. */
export const normalizeDeployTarget = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim().toLowerCase();
  return t || null;
};

/** A role handle as a profile may write it (`release`, `@release`). */
export const normalizeRoleHandle = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim().replace(/^@/, "").toLowerCase();
  return t || null;
};

// A line that says nothing of why a step failed: a warning, a stack frame, a caret under a quoted line, a runtime's
// version banner, a cut marker, npm's boilerplate under its own error, the bare exit code.
const NOISE = /^(?:(?:npm )?warn\b|warning\b|at\s|\^+$|node\.js v\d|….*characters cut|exited \d+$|npm (?:err!?|error) (?:code|path|workspace|location|command|errno|syscall|a complete log)\b|<anonymous|\S+:\d+$|[-=_*#.\s]+$)/i;
// A line that names what the step needed and did not have.
const NEED = /\b(?:required|not found|denied|missing|unauthori[sz]ed|forbidden|permission|no such|not set|expired|already in flight|still waiting)\b/i;
const ERROR = /\b(?:error|failed|fatal|cannot|could not|refused)\b/i;
const CAUSE_MAX = 240;

/**
 * The one line of a failed step's output that says why (deploys.md DP9): the first that names what it needed (a
 * login, a token, a file), else the first error line, else the last line that is no warning or stack frame; never
 * the warnings and frames a tool prints around it. Cut to one line. Null for output with nothing to say.
 */
export function deployCauseLine(output: string | null | undefined): string | null {
  // eslint-disable-next-line no-control-regex
  const lines = (output ?? "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !NOISE.test(l));
  const line = lines.find((l) => NEED.test(l)) ?? lines.find((l) => ERROR.test(l)) ?? lines[lines.length - 1];
  if (!line) return null;
  return line.length > CAUSE_MAX ? `${line.slice(0, CAUSE_MAX - 1)}…` : line;
}

/**
 * A deploy note's headline: its first line when that already names the cause ("Stopped at Send: <cause>"), else
 * "Stopped at <step>: <cause>" from the log under it, for a note written before the stop named its cause.
 */
export function deployNoteHeadline(note: string | null | undefined): string | null {
  const text = (note ?? "").trim();
  if (!text) return null;
  const [first, ...rest] = text.split("\n");
  const stop = first.match(/^(Stopped at [^.:]+)\.?$/);
  if (!stop) return deployCauseLine(first) ?? first.trim();
  const cause = deployCauseLine(rest.join("\n"));
  return cause ? `${stop[1]}: ${cause}` : `${stop[1]}.`;
}
