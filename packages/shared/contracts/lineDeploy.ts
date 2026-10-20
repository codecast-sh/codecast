/** The triggers a line profile may name; only `person` starts a deploy today (deploys.md DP4). */
export const LINE_DEPLOY_TRIGGERS = ["person", "role", "schedule", "count"] as const;
export type LineDeployTrigger = (typeof LINE_DEPLOY_TRIGGERS)[number];

/** The `[line.deploy]` section of a line profile (line-profile.md LP2). */
export type LineDeployProfile = {
  /** The team's deploy path, run from the checkout's root. $sha, $deploy and $actor expand. */
  command: string | null;
  /** The surface or environment its markers report ("backend", "production"): how the marker finds the deploy it finishes. */
  target: string | null;
  trigger: LineDeployTrigger;
};

export const LINE_DEPLOY_KEYS = ["command", "target", "trigger"] as const;
export const LINE_DEPLOY_DEFAULTS: LineDeployProfile = { command: null, target: null, trigger: "person" };

/** A target's name as a marker writes it: the surface or the environment, lowercased. */
export const normalizeDeployTarget = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim().toLowerCase();
  return t || null;
};
