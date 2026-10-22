import { autonomyOn, defaultTrustFor } from "./roleAutonomy";

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

// ── the role's deploy allowance (deploys.md DP4) ──────────────────────────────

export const DEPLOY_AUTHORITY_ID = "deploy";
export const DEPLOY_AUTHORITY_KIND = "publish";
export const DEPLOY_AUTHORITY_LABEL = "Deploy the line's shipped fixes through the project's [line.deploy] path; the daily limit counts deploys only";

type AuthorityGrant = { id: string; kind: string; label?: string; limit?: { per_day?: number }; expires_at?: number };
type DeployRole = {
  authority?: AuthorityGrant[] | null;
  counters?: { day: string; deploys?: number } | null;
  status?: string;
  trust?: string | null;
  handle?: string;
};

export type DeployAllowance = {
  allowed: boolean;
  /** Why not, in the words the Deploys view and the stage print. */
  reason: string | null;
  used: number;
  limit: number | null;
  grant: AuthorityGrant | null;
};

/** The role's deploy grant when it holds one that has not expired. */
export function deployGrantOf(role: DeployRole, now: number): AuthorityGrant | null {
  const g = (role.authority ?? []).find((a) => a.id === DEPLOY_AUTHORITY_ID && a.kind === DEPLOY_AUTHORITY_KIND);
  if (!g) return null;
  return g.expires_at !== undefined && g.expires_at <= now ? null : g;
}

/**
 * Whether this role may ask for a deploy right now, read from the role row
 * alone: active, starting work on its own, holding a deploy grant with a
 * daily limit, and room in that limit today. The trigger and every surface
 * that shows the stage read this one answer.
 */
export function deployAllowance(role: DeployRole, now: number): DeployAllowance {
  const grant = deployGrantOf(role, now);
  const today = new Date(now).toISOString().slice(0, 10);
  const used = role.counters?.day === today ? role.counters.deploys ?? 0 : 0;
  const limit = grant?.limit?.per_day ?? null;
  const base = { used, limit, grant };
  if (role.status && role.status !== "active") return { ...base, allowed: false, reason: `the role is ${role.status}` };
  if (!autonomyOn(role.trust ?? defaultTrustFor(role))) return { ...base, allowed: false, reason: "the role does not start work on its own" };
  if (!grant) {
    const expired = (role.authority ?? []).some((a) => a.id === DEPLOY_AUTHORITY_ID);
    return { ...base, allowed: false, reason: expired ? "its deploy authority has expired" : "it holds no deploy authority" };
  }
  // A deploy grant always carries a daily limit: one without is read as none left.
  if (limit === null) return { ...base, allowed: false, reason: "its deploy authority has no daily limit" };
  if (used >= limit) return { ...base, allowed: false, reason: `it has used today's deploys (${used} of ${limit})` };
  return { ...base, allowed: true, reason: null };
}
