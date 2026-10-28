// Managed policy: what an organization's IT admin locks on the devices and in
// the workspace of a team, for companies that deploy codecast through an MDM
// (Jamf, Kandji, Intune, Mosyle, ...).
//
// A policy reaches a device from two sources:
//   - the MDM configuration profile, which macOS writes to
//     /Library/Managed Preferences/sh.codecast.plist (Linux:
//     /etc/codecast/managed.json, same keys). Read by the CLI and daemon.
//   - the team's policy, set by a team admin on the web. The server enforces it
//     for anything in the team's workspace and for every device enrolled in the
//     team, and sends it to those devices on the heartbeat (`team_policy`).
// The two merge per key by the key's rule (`mergePolicies`); a device applies
// the result, the server enforces the team half on its own.
//
// One catalog, so the profile reader, the team settings page, the server
// guards, the heartbeat and the generated .mobileconfig cannot disagree about
// which keys exist. PURE isomorphic data and functions: no Node or DOM APIs.

/** The preference domain the profile payload targets. */
export const MANAGED_PROFILE_DOMAIN = "sh.codecast";
/** Where macOS puts a device-wide managed profile for that domain. */
export const MANAGED_PREFS_MAC_PATH = `/Library/Managed Preferences/${MANAGED_PROFILE_DOMAIN}.plist`;
/** The per-user copy macOS writes for a user-scoped profile. */
export const managedPrefsMacUserPath = (user: string) => `/Library/Managed Preferences/${user}/${MANAGED_PROFILE_DOMAIN}.plist`;
/** Linux has no profile store; config management drops this file. */
export const MANAGED_PREFS_LINUX_PATH = "/etc/codecast/managed.json";

/** Keys a team admin can set and the server enforces. A profile may set them too. */
export type TeamPolicyKey =
  | "public_sharing_disabled"
  | "browser_control_disabled"
  | "computer_control_disabled"
  | "cloud_hosts_disabled"
  | "auto_update"
  | "excluded_paths";

/** Keys only a device profile carries: where the device connects and how it enrolls. */
export type DevicePolicyKey = "web_url" | "convex_url" | "enrollment_token" | "user_email";

export type ManagedPolicyKey = TeamPolicyKey | DevicePolicyKey;

export interface TeamPolicy {
  /** No published pages and no public share links. */
  public_sharing_disabled?: boolean;
  /** Agents may not drive a browser (cast browser). */
  browser_control_disabled?: boolean;
  /** Agents may not drive desktop apps (cast computer). */
  computer_control_disabled?: boolean;
  /** No cloud hosts: no --cloud sessions, no cloud mirror. */
  cloud_hosts_disabled?: boolean;
  /** Force the CLI's and the desktop app's own updates on or off. Unset leaves it to the person. */
  auto_update?: "on" | "off";
  /** Folders whose sessions never leave the device. `~` expands per user. */
  excluded_paths?: string[];
}

export interface DevicePolicy extends TeamPolicy {
  web_url?: string;
  convex_url?: string;
  /** A team enrollment token (cc_enr_...): enrolls the device into the team. */
  enrollment_token?: string;
  /** The person this device belongs to; the MDM fills it ($EMAIL). Sign-in must match. */
  user_email?: string;
}

type Kind = "restriction" | "choice" | "paths" | "string";

export interface ManagedPolicyDescriptor {
  key: ManagedPolicyKey;
  /** The key's name in a configuration profile. */
  profileKey: string;
  kind: Kind;
  /** A team admin can set it on the web (and the server enforces it). */
  team: boolean;
  /** Label on the team settings page. */
  name: string;
  /** For a restriction: what it turns off, as a refusal names it. */
  subject?: string;
  /** For a restriction: the agent feature (snippet slug) it holds off on a device. */
  feature?: string;
}

export const MANAGED_POLICY: ManagedPolicyDescriptor[] = [
  { key: "public_sharing_disabled", profileKey: "PublicSharingDisabled", kind: "restriction", team: true, name: "Block public pages and share links", subject: "Public sharing" },
  { key: "browser_control_disabled", profileKey: "BrowserControlDisabled", kind: "restriction", team: true, name: "Block agent browser control", subject: "Agent browser control", feature: "browser" },
  { key: "computer_control_disabled", profileKey: "ComputerControlDisabled", kind: "restriction", team: true, name: "Block agent desktop control", subject: "Agent desktop control", feature: "computer" },
  { key: "cloud_hosts_disabled", profileKey: "CloudHostsDisabled", kind: "restriction", team: true, name: "Block cloud hosts", subject: "Cloud hosting" },
  { key: "auto_update", profileKey: "AutoUpdate", kind: "choice", team: true, name: "Automatic updates" },
  { key: "excluded_paths", profileKey: "ExcludedPaths", kind: "paths", team: true, name: "Never sync these folders" },
  { key: "web_url", profileKey: "WebURL", kind: "string", team: false, name: "Web URL" },
  { key: "convex_url", profileKey: "ServerURL", kind: "string", team: false, name: "Server URL" },
  { key: "enrollment_token", profileKey: "EnrollmentToken", kind: "string", team: false, name: "Enrollment token" },
  { key: "user_email", profileKey: "UserEmail", kind: "string", team: false, name: "User email" },
];

export const TEAM_POLICY_KEYS = MANAGED_POLICY.filter((d) => d.team).map((d) => d.key as TeamPolicyKey);

const byProfileKey = new Map(MANAGED_POLICY.map((d) => [d.profileKey, d]));
const byKey = new Map(MANAGED_POLICY.map((d) => [d.key, d]));

export function managedPolicyDescriptor(key: ManagedPolicyKey): ManagedPolicyDescriptor {
  return byKey.get(key)!;
}

/** One value checked against its key's kind; undefined when it does not fit. */
function coerce(kind: Kind, value: unknown): unknown {
  switch (kind) {
    case "restriction":
      return typeof value === "boolean" ? value : undefined;
    case "choice":
      // A profile writes AutoUpdate as a boolean; the team setting stores on/off.
      if (typeof value === "boolean") return value ? "on" : "off";
      return value === "on" || value === "off" ? value : undefined;
    case "paths":
      if (!Array.isArray(value)) return undefined;
      return value.filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => p.trim());
    case "string":
      return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  }
}

/** A configuration profile's payload (plist converted to JSON, or managed.json) as a DevicePolicy. Unknown keys and mistyped values are dropped. */
export function parseManagedProfile(raw: unknown): DevicePolicy {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // Accept the profile's PascalCase names and the snake_case keys alike, so
    // a hand-written managed.json can use either.
    const d = byProfileKey.get(k) ?? byKey.get(k as ManagedPolicyKey);
    if (!d) continue;
    const value = coerce(d.kind, v);
    if (value !== undefined) out[d.key] = value;
  }
  return out as DevicePolicy;
}

/** A team policy as stored or sent, reduced to valid team keys. */
export function parseTeamPolicy(raw: unknown): TeamPolicy {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of TEAM_POLICY_KEYS) {
    const value = coerce(managedPolicyDescriptor(key).kind, (raw as Record<string, unknown>)[key]);
    if (value !== undefined) out[key] = value;
  }
  return out as TeamPolicy;
}

/** Where an effective value came from, for "Managed by ..." labels. */
export type PolicySource = { kind: "profile" } | { kind: "team"; team_id: string; team_name: string };

export interface PolicyLayer {
  source: PolicySource;
  policy: DevicePolicy;
}

export interface EffectivePolicy {
  values: DevicePolicy;
  /** Which source decided each key that has a value. */
  sources: Partial<Record<ManagedPolicyKey, PolicySource>>;
}

/**
 * Merge layers, most authoritative first (the device profile, then each team).
 * A restriction is on when any layer turns it on; paths are the union; a
 * choice or a string comes from the first layer that sets it.
 */
export function mergePolicies(layers: PolicyLayer[]): EffectivePolicy {
  const values: Record<string, unknown> = {};
  const sources: EffectivePolicy["sources"] = {};
  for (const { source, policy } of layers) {
    for (const d of MANAGED_POLICY) {
      const value = (policy as Record<string, unknown>)[d.key];
      if (value === undefined) continue;
      if (d.kind === "restriction") {
        if (value === true && values[d.key] !== true) { values[d.key] = true; sources[d.key] = source; }
        else if (values[d.key] === undefined) { values[d.key] = value; sources[d.key] = source; }
      } else if (d.kind === "paths") {
        const prev = (values[d.key] as string[] | undefined) ?? [];
        const added = (value as string[]).filter((p) => !prev.includes(p));
        if (added.length > 0 || values[d.key] === undefined) {
          values[d.key] = [...prev, ...added];
          sources[d.key] ??= source;
        }
      } else if (values[d.key] === undefined) {
        values[d.key] = value;
        sources[d.key] = source;
      }
    }
  }
  return { values: values as DevicePolicy, sources };
}

/**
 * The team a conversation is visible to, if any. On conversations team_id is
 * routing, stamped even on private sessions; only a team-visible conversation
 * answers to its team (convex privacy.ts re-exports this for work items).
 */
export function teamVisibleConvTeam<T>(conv: {
  team_id?: T;
  is_private?: boolean;
  auto_shared?: boolean;
  team_visibility?: string;
} | null | undefined): T | undefined {
  if (!conv?.team_id) return undefined;
  if (!conv.is_private || conv.auto_shared) return conv.team_id;
  if (conv.team_visibility && conv.team_visibility !== "private") return conv.team_id;
  return undefined;
}

/**
 * The team whose policy governs a row: a conversation's is the team it is
 * visible to; any other row's is its workspace key's team, else its team tag.
 * The server's guard and the web's locked controls both read it here.
 */
export function policyTeamOf(table: string, row: any): string | null {
  if (!row) return null;
  if (table === "conversations") {
    const teamId = teamVisibleConvTeam(row);
    return teamId ? String(teamId) : null;
  }
  if (typeof row.workspace === "string" && row.workspace) {
    return row.workspace.startsWith("team:") ? row.workspace.slice("team:".length) : null;
  }
  return row.team_id ? String(row.team_id) : null;
}

/** Is a restriction on? */
export function policyBlocks(policy: TeamPolicy | null | undefined, key: Extract<TeamPolicyKey, `${string}_disabled`>): boolean {
  return policy?.[key] === true;
}

/** The words a refused action shows, on the CLI and the web alike. */
export function policyBlockedMessage(key: ManagedPolicyKey, source?: PolicySource): string {
  const who = !source ? "your organization" : source.kind === "profile" ? "your device's management profile" : `${source.team_name}'s admins`;
  const d = managedPolicyDescriptor(key);
  return d.subject ? `${d.subject} is turned off by ${who}.` : `${d.name} is set by ${who}.`;
}

// ── Enrollment wire ────────────────────────────────────────────────────────

export const ENROLLMENT_TOKEN_PREFIX = "cc_enr_";

export function isEnrollmentToken(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENROLLMENT_TOKEN_PREFIX) && value.length > ENROLLMENT_TOKEN_PREFIX.length + 16;
}

/** What a person reads about a machine its team's admins removed (CLI status, doctor). */
export const removedDeviceMessage = (team: string) => `${team}'s admins removed this machine. Ask them to allow it again, then run cast mdm enroll.`;

/** POST /cli/enroll: a managed device announces itself to its team. */
export interface EnrollRequest {
  enrollment_token: string;
  device_id: string;
  /** The person the profile names. The browser sign-in that follows must be this email. */
  email?: string;
  hostname?: string;
  platform?: string;
}

export type EnrollResponse =
  | { ok: true; enrollment_id: string; team_id: string; team_name: string; policy: TeamPolicy }
  | { ok: false; error: string; /** The team whose admins took this device out. */ removed_by?: string };

/** What the heartbeat carries for a device: the team policy that applies to it. */
export interface HeartbeatTeamPolicy {
  team_id: string;
  team_name: string;
  policy: TeamPolicy;
  /** The device is enrolled in this team (versus a member's unenrolled device). */
  enrolled: boolean;
}

// ── Configuration profile ──────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function plistValue(value: unknown, indent: string): string {
  if (typeof value === "boolean") return `${indent}<${value}/>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}<array/>`;
    return [`${indent}<array>`, ...value.map((v) => plistValue(v, indent + "\t")), `${indent}</array>`].join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return [
      `${indent}<dict>`,
      ...entries.flatMap(([k, v]) => [`${indent}\t<key>${xmlEscape(k)}</key>`, plistValue(v, indent + "\t")]),
      `${indent}</dict>`,
    ].join("\n");
  }
  if (typeof value === "number") return `${indent}<integer>${Math.trunc(value)}</integer>`;
  return `${indent}<string>${xmlEscape(String(value))}</string>`;
}

/** An app the profile pre-approves for Accessibility (cast computer). */
export interface AccessibilityGrant {
  identifier: string;
  identifierType: "bundleID" | "path";
  /** The designated requirement (`codesign -dr - <app>`). */
  codeRequirement: string;
}

export interface MobileconfigInput {
  teamName: string;
  /** Reverse-DNS id for the profile, stable per team so a reinstall replaces it. */
  identifier: string;
  /** Payload UUIDs, passed in so this stays pure: [profile, settings, privacy]. */
  uuids: [string, string, string];
  policy: DevicePolicy;
  /** Pre-approve Accessibility for these apps. Screen Recording cannot be pre-approved by a profile. */
  accessibility?: AccessibilityGrant[];
}

/** A configuration profile an admin uploads to their MDM. `user_email` is usually the MDM's variable ($EMAIL in Jamf and Kandji, {{mail}} in Intune, %Email% in Mosyle). */
export function buildMobileconfig(input: MobileconfigInput): string {
  const settings: Record<string, unknown> = {};
  for (const d of MANAGED_POLICY) {
    const value = (input.policy as Record<string, unknown>)[d.key];
    if (value === undefined) continue;
    settings[d.profileKey] = d.kind === "choice" ? value === "on" : value;
  }
  const payloads: Record<string, unknown>[] = [
    {
      PayloadType: MANAGED_PROFILE_DOMAIN,
      PayloadVersion: 1,
      PayloadIdentifier: `${input.identifier}.settings`,
      PayloadUUID: input.uuids[1],
      PayloadDisplayName: "Codecast settings",
      ...settings,
    },
  ];
  if (input.accessibility && input.accessibility.length > 0) {
    payloads.push({
      PayloadType: "com.apple.TCC.configuration-profile-policy",
      PayloadVersion: 1,
      PayloadIdentifier: `${input.identifier}.privacy`,
      PayloadUUID: input.uuids[2],
      PayloadDisplayName: "Codecast privacy permissions",
      Services: {
        Accessibility: input.accessibility.map((g) => ({
          Identifier: g.identifier,
          IdentifierType: g.identifierType,
          CodeRequirement: g.codeRequirement,
          Allowed: true,
        })),
      },
    });
  }
  const profile = {
    PayloadType: "Configuration",
    PayloadVersion: 1,
    PayloadIdentifier: input.identifier,
    PayloadUUID: input.uuids[0],
    PayloadDisplayName: `Codecast for ${input.teamName}`,
    PayloadOrganization: input.teamName,
    PayloadScope: "System",
    PayloadContent: payloads,
  };
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    plistValue(profile, ""),
    `</plist>`,
    "",
  ].join("\n");
}
