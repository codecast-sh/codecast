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
 * note. `watch` is codecast's own: the deploy goes live and its fixes are
 * watched from then.
 */
export const LINE_DEPLOY_STEPS = ["ci", "send", "gate", "rollout", "live"] as const;
export type LineDeployStep = (typeof LINE_DEPLOY_STEPS)[number];
export const LINE_DEPLOY_STEP_LABELS: Record<LineDeployStep | "watch", string> = {
  ci: "CI",
  send: "Send",
  gate: "Gate",
  rollout: "Roll out",
  live: "Live",
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
