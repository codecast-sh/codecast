// `cast mdm`: what an organization's device management decides on this
// machine, and enrolling it into the team its profile names. The policy itself
// is resolved by config/managedPolicy.ts; this is the report and the
// enrollment request. index.ts registers the command, because enrolling ends
// in its browser sign-in.

import * as fs from "node:fs";
import * as os from "node:os";
import {
  MANAGED_POLICY,
  isEnrollmentToken,
  parseTeamPolicy,
  type EffectivePolicy,
  type EnrollRequest,
  type EnrollResponse,
  type PolicySource,
} from "@codecast/shared/contracts/managedPolicy";
import type { Config } from "./config/types.js";
import { effectivePolicy, managedProfilePaths, readManagedProfile } from "./config/managedPolicy.js";
import { isManagedInstall } from "./managedInstall.js";
import { MANAGED_UPDATE_NOTE } from "./update.js";

export interface MdmStatus {
  profile: { paths: Array<{ path: string; installed: boolean }>; installed: boolean };
  team: { team_id: string; team_name: string; enrolled: boolean } | null;
  enrollment: NonNullable<Config["managed_enrollment"]> | null;
  signed_in: boolean;
  policy: Array<{ key: string; name: string; value: unknown; source: string }>;
  /** The binary is the organization's (Codecast.pkg): updates come from the MDM. */
  managed_install: boolean;
}

function sourceLabel(source: PolicySource | undefined): string {
  if (!source) return "unknown";
  return source.kind === "profile" ? "device profile" : `team ${source.team_name}`;
}

export function mdmStatus(config: Config | null, eff: EffectivePolicy = effectivePolicy(config)): MdmStatus {
  const paths = managedProfilePaths().map((p) => ({ path: p, installed: fs.existsSync(p) }));
  const team = config?.team_policy;
  // Folder lists are a union, so name every source that adds to it, not only the first.
  const pathSources = [
    ...(readManagedProfile().excluded_paths?.length ? ["device profile"] : []),
    ...(team && parseTeamPolicy(team.policy).excluded_paths?.length ? [`team ${team.team_name}`] : []),
  ];
  return {
    profile: { paths, installed: paths.some((p) => p.installed) },
    team: team ? { team_id: team.team_id, team_name: team.team_name, enrolled: team.enrolled } : null,
    enrollment: config?.managed_enrollment ?? null,
    signed_in: !!(config?.auth_token && config.user_id),
    managed_install: isManagedInstall(),
    policy: MANAGED_POLICY.flatMap((d) => {
      const value = (eff.values as Record<string, unknown>)[d.key];
      if (value === undefined) return [];
      // The token is a credential: say it is there, never print it.
      const source = d.kind === "paths" && pathSources.length > 0 ? pathSources.join(" + ") : sourceLabel(eff.sources[d.key]);
      return [{ key: d.key, name: d.name, value: d.key === "enrollment_token" ? "(set)" : value, source }];
    }),
  };
}

export function formatMdmStatus(s: MdmStatus): string {
  const lines: string[] = [];
  const profile = s.profile.paths.find((p) => p.installed);
  lines.push(`Profile     ${profile ? profile.path : "none installed"}`);
  const team = s.team ? `${s.team.team_name}${s.team.enrolled ? " (enrolled)" : ""}` : s.enrollment ? `${s.enrollment.team_name} (enrolled, awaiting first heartbeat)` : "none";
  lines.push(`Team        ${team}`);
  lines.push(`Signed in   ${s.signed_in ? "yes" : "no"}`);
  if (s.managed_install) lines.push(`Updates     ${MANAGED_UPDATE_NOTE}`);
  if (s.policy.length === 0) {
    lines.push("", "Nothing on this machine is managed.");
    return lines.join("\n");
  }
  lines.push("");
  const nameWidth = Math.max(...s.policy.map((p) => p.name.length));
  const sourceWidth = Math.max(...s.policy.map((p) => p.source.length));
  for (const p of s.policy) {
    const value = Array.isArray(p.value) ? p.value.join(", ") : typeof p.value === "boolean" ? (p.value ? "on" : "off") : String(p.value);
    lines.push(`${p.name.padEnd(nameWidth)}  ${p.source.padEnd(sourceWidth)}  ${value}`);
  }
  return lines.join("\n");
}

/** What `cast mdm enroll` should do next on this machine. */
export type EnrollStep =
  | { kind: "unmanaged" }
  | { kind: "invalid_token" }
  | { kind: "done" }
  | { kind: "waiting" }
  | { kind: "enroll"; token: string; signIn: boolean };

/** How long an opened sign-in page is left to the person before enroll opens another. */
export const ENROLL_SIGN_IN_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * The login LaunchAgent runs this at every login and on every profile change,
 * so the steady state (enrolled and signed in) and a sign-in already waiting in
 * the browser both answer from config alone: no network, no new browser tab.
 */
export function nextEnrollStep(config: Config | null, profile = readManagedProfile(), now = Date.now(), force = false): EnrollStep {
  const token = profile.enrollment_token;
  if (!token) return { kind: "unmanaged" };
  if (!isEnrollmentToken(token)) return { kind: "invalid_token" };
  const signedIn = !!(config?.auth_token && config.user_id);
  const pending = config?.managed_enrollment?.token_prefix === token.slice(0, 16) ? config.managed_enrollment : undefined;
  const enrolled = !!pending || config?.team_policy?.enrolled === true;
  if (enrolled && signedIn) return { kind: "done" };
  const askedAt = pending?.sign_in_at ? Date.parse(pending.sign_in_at) : NaN;
  if (!signedIn && !force && now - askedAt < ENROLL_SIGN_IN_COOLDOWN_MS) return { kind: "waiting" };
  return { kind: "enroll", token, signIn: !signedIn };
}

/** POST <site>/cli/enroll. */
export async function requestEnrollment(
  siteUrl: string,
  req: EnrollRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<EnrollResponse> {
  try {
    const res = await fetchImpl(`${siteUrl}/cli/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    const body = (await res.json().catch(() => null)) as EnrollResponse | null;
    if (body && typeof body === "object" && "ok" in body) return body;
    return { ok: false, error: `Enrollment failed (HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, error: `Could not reach ${siteUrl}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function enrollRequest(token: string, deviceId: string, email: string | undefined): EnrollRequest {
  return { enrollment_token: token, device_id: deviceId, email, hostname: os.hostname(), platform: process.platform };
}

/**
 * Why this machine's sign-in stopped working, when its team's admins took it
 * out: the team's name, asked of /cli/enroll with the profile's token (the
 * enrollment refuses a removed device and names the team). Null for anything
 * else, including a machine with no enrollment token.
 */
export async function removedByTeam(
  siteUrl: string,
  deviceId: string,
  profile = readManagedProfile(),
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const token = profile.enrollment_token;
  if (!token || !isEnrollmentToken(token)) return null;
  const result = await requestEnrollment(siteUrl, enrollRequest(token, deviceId, profile.user_email), fetchImpl);
  return !result.ok && result.removed_by ? result.removed_by : null;
}
