// The device half of managed policy (shared/contracts/managedPolicy.ts): what
// an organization locks on this machine, from its MDM configuration profile and
// from the team policy the daemon caches off the heartbeat (`team_policy` in
// config.json). One resolver, so the config readers, the sync scope, the
// command guards, `cast mdm` and the desktop app cannot disagree.
//
// The profile is read on every call but parsed only when its file changes: a
// stat per path, and a plutil spawn only for a new mtime. The daemon reads
// config constantly, and this sits on the stable-context fast path through
// readAuthConfig, so keep it to node builtins, proc.ts (main.ts loads it
// already) and the contract.

import { execFileSync } from "../proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MANAGED_PREFS_LINUX_PATH,
  MANAGED_PREFS_MAC_PATH,
  managedPrefsMacUserPath,
  mergePolicies,
  parseManagedProfile,
  parseTeamPolicy,
  policyBlockedMessage,
  type DevicePolicy,
  type EffectivePolicy,
  type ManagedPolicyKey,
  type PolicyLayer,
  type PolicySource,
  type TeamPolicyKey,
} from "@codecast/shared/contracts/managedPolicy";
import { folderCovers } from "@codecast/shared/team/folderLists";
import type { Config } from "./types.js";
import { defaultConfigDir } from "./configDir.js";

export type RestrictionKey = Extract<TeamPolicyKey, `${string}_disabled`>;

/** Points the resolver at one profile file instead of the system paths (tests, a dry run). A .json file is read as JSON, anything else through plutil. */
export const MANAGED_PREFS_ENV = "CODECAST_MANAGED_PREFS";

/** The effective policy, written by the daemon for the desktop app, which reads it rather than merging again in JS. */
export const EFFECTIVE_POLICY_FILE = "managed-policy.json";

/** Profile files in authority order: device-wide, then the current user's. */
export function managedProfilePaths(): string[] {
  const override = process.env[MANAGED_PREFS_ENV];
  if (override) return [override];
  if (process.platform === "darwin") {
    let user = process.env.USER;
    try { user = os.userInfo().username; } catch { /* keep $USER */ }
    return user ? [MANAGED_PREFS_MAC_PATH, managedPrefsMacUserPath(user)] : [MANAGED_PREFS_MAC_PATH];
  }
  // Linux, and WSL with it. Windows native has no managed store.
  return process.platform === "win32" ? [] : [MANAGED_PREFS_LINUX_PATH];
}

function stampOf(file: string): string | null {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

function plutil(args: string[], input?: string): string {
  return execFileSync("/usr/bin/plutil", args, { encoding: "utf-8", timeout: 5000, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
}

function readProfileRaw(file: string): unknown {
  if (file.endsWith(".json")) return JSON.parse(fs.readFileSync(file, "utf-8"));
  try {
    return JSON.parse(plutil(["-convert", "json", "-o", "-", file]));
  } catch {
    // plutil refuses the whole file when any value has no JSON form (a date or
    // data entry an MDM adds beside ours): drop those entries and convert again.
    const xml = plutil(["-convert", "xml1", "-o", "-", file]).replace(/<key>[^<]*<\/key>\s*<(date|data)>[\s\S]*?<\/\1>/g, "");
    return JSON.parse(plutil(["-convert", "json", "-o", "-", "-"], xml));
  }
}

const profileCache = new Map<string, { stamp: string; policy: DevicePolicy }>();

function readProfileFile(file: string): DevicePolicy | null {
  const stamp = stampOf(file);
  if (!stamp) {
    profileCache.delete(file);
    return null;
  }
  const hit = profileCache.get(file);
  if (hit?.stamp === stamp) return hit.policy;
  let raw: unknown = null;
  try { raw = readProfileRaw(file); } catch { /* unreadable: an empty policy */ }
  const policy = parseManagedProfile(raw);
  profileCache.set(file, { stamp, policy });
  return policy;
}

/** The profile's layers, device-wide first. Empty when no profile is installed. */
export function profileLayers(): PolicyLayer[] {
  const layers: PolicyLayer[] = [];
  for (const file of managedProfilePaths()) {
    const policy = readProfileFile(file);
    if (policy) layers.push({ source: { kind: "profile" }, policy });
  }
  return layers;
}

/** The installed profile as one policy (enrollment and device keys). */
export function readManagedProfile(): DevicePolicy {
  return mergePolicies(profileLayers()).values;
}

let rawConfigCache: { stamp: string; config: Config } | null = null;

/** config.json as written, memoized by mtime, for callers that have no config in hand. */
function rawConfig(): Config {
  const file = path.join(defaultConfigDir(), "config.json");
  const stamp = stampOf(file);
  if (!stamp) return {};
  if (rawConfigCache?.stamp === stamp) return rawConfigCache.config;
  let config: Config = {};
  try { config = JSON.parse(fs.readFileSync(file, "utf-8")) ?? {}; } catch { /* torn write: empty until the next stamp */ }
  rawConfigCache = { stamp, config };
  return config;
}

/**
 * Profile first, then the team policy the heartbeat cached. Pass the config
 * a caller already read; without one the cached file is used.
 */
export function effectivePolicy(config?: Config | null): EffectivePolicy {
  const layers = profileLayers();
  const team = (config ?? rawConfig()).team_policy;
  if (team?.team_id) {
    layers.push({ source: { kind: "team", team_id: team.team_id, team_name: team.team_name }, policy: parseTeamPolicy(team.policy) });
  }
  return mergePolicies(layers);
}

/** The refusal for a turned-off capability, or null when it is allowed. */
export function policyRefusal(key: RestrictionKey, config?: Config | null): string | null {
  const eff = effectivePolicy(config);
  return eff.values[key] === true ? policyBlockedMessage(key, eff.sources[key]) : null;
}

/** For a command line: print the refusal and exit 1 when the capability is off. */
export function exitIfPolicyBlocks(key: RestrictionKey): void {
  const refusal = policyRefusal(key);
  if (!refusal) return;
  console.error(refusal);
  process.exit(1);
}

function expandHome(p: string): string {
  const home = process.env.HOME || os.homedir();
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/** Folders the policy keeps on this device, `~` expanded. */
export function managedExcludedPaths(config?: Config | null): string[] {
  return (effectivePolicy(config).values.excluded_paths ?? []).map(expandHome);
}

/** Whether a folder sits in (or is) one the policy keeps on the device. The sync scope adds worktrees (syncScope.ts). */
export function isManagedExcludedPath(projectPath: string, config?: Config | null): boolean {
  const managed = managedExcludedPaths(config);
  if (managed.length === 0) return false;
  const target = path.resolve(projectPath);
  return managed.some((p) => folderCovers(target, path.resolve(p)));
}

/** What a create refuses with for a session under a policy-excluded folder; the
 *  sync paths treat it as a refusal for good (retryQueue isSessionRefusal). */
export const POLICY_EXCLUDED_SESSION = "Session folder is kept on this device by your organization's policy";

function splitPaths(list: string | undefined): string[] {
  return (list ?? "").split(",").map((p) => p.trim()).filter(Boolean);
}

// ── The config overlay ─────────────────────────────────────────────────────
//
// A config reader hands back the file with the policy laid over it, so every
// caller that reads convex_url, auto_update or excluded_paths sees the managed
// value without knowing policy exists. The overlay remembers what it replaced,
// and a writer strips it again, so a read-modify-write never bakes a managed
// value into config.json (where it would outlive the profile).

const OVERLAY = Symbol("managedPolicyOverlay");
type Overlay = { original: Record<string, unknown>; applied: Record<string, unknown>; policyPaths: string[] };

/** Which config key each managed key decides, and the value it stores. */
function overlayValues(eff: EffectivePolicy, config: Config): Record<string, unknown> {
  const v = eff.values;
  const out: Record<string, unknown> = {};
  if (v.convex_url) out.convex_url = v.convex_url;
  if (v.web_url) out.web_url = v.web_url;
  if (v.auto_update) {
    out.auto_update = v.auto_update === "on";
    out.desktop_auto_update = v.auto_update === "on";
  }
  if (v.cloud_hosts_disabled) out.cloud_mirror_enabled = false;
  const policyPaths = (v.excluded_paths ?? []).map(expandHome);
  if (policyPaths.length > 0) {
    const own = splitPaths(config.excluded_paths);
    out.excluded_paths = [...own, ...policyPaths.filter((p) => !own.includes(p))].join(",");
  }
  return out;
}

/** The config with the effective policy laid over it, in place. */
export function applyManagedPolicy<T extends Config>(config: T, eff: EffectivePolicy = effectivePolicy(config)): T {
  const applied = overlayValues(eff, config);
  if (Object.keys(applied).length === 0) return config;
  const bag = config as Record<string, unknown>;
  const original: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(applied)) {
    original[k] = bag[k];
    bag[k] = value;
  }
  const overlay: Overlay = { original, applied, policyPaths: (eff.values.excluded_paths ?? []).map(expandHome) };
  Object.defineProperty(config, OVERLAY, { value: overlay, enumerable: false, configurable: true });
  return config;
}

/** A copy fit to write: overlaid values the caller left alone go back to what the file held. */
export function stripManagedPolicy<T extends Config>(config: T): T {
  const overlay = (config as unknown as Record<symbol, Overlay | undefined>)[OVERLAY];
  if (!overlay) return config;
  const out = { ...config } as Record<string, unknown>;
  for (const [k, value] of Object.entries(overlay.applied)) {
    if (JSON.stringify(out[k]) !== JSON.stringify(value)) {
      // The caller changed it. Only the person's own excluded paths are theirs to write.
      if (k === "excluded_paths") out[k] = splitPaths(out[k] as string).filter((p) => !overlay.policyPaths.includes(p)).join(",") || undefined;
      continue;
    }
    if (overlay.original[k] === undefined) delete out[k];
    else out[k] = overlay.original[k];
  }
  if (out.excluded_paths === undefined) delete out.excluded_paths;
  return out as T;
}

/** Config keys a policy key decides, for `cast config`. excluded_paths is absent: the person may add their own. */
const LOCKED_CONFIG_KEYS: Record<string, ManagedPolicyKey> = {
  convex_url: "convex_url",
  web_url: "web_url",
  auto_update: "auto_update",
  desktop_auto_update: "auto_update",
  cloud_mirror_enabled: "cloud_hosts_disabled",
};

/** Whether a config key is decided by policy right now, and by whom. */
export function lockedConfigKey(configKey: string, eff: EffectivePolicy = effectivePolicy()): { key: ManagedPolicyKey; source: PolicySource | undefined; message: string } | null {
  const key = LOCKED_CONFIG_KEYS[configKey];
  if (!key) return null;
  const value = (eff.values as Record<string, unknown>)[key];
  if (value === undefined || value === false) return null;
  return { key, source: eff.sources[key], message: policyBlockedMessage(key, eff.sources[key]) };
}

/** "managed by your device's management profile" / "managed by Acme's admins". */
export function managedByLabel(source: PolicySource | undefined): string {
  if (!source) return "managed";
  return source.kind === "profile" ? "managed by device profile" : `managed by ${source.team_name}`;
}

// ── Snippets and the desktop app ───────────────────────────────────────────

const SNIPPET_RESTRICTIONS: Record<string, RestrictionKey> = {
  publish: "public_sharing_disabled",
  browser: "browser_control_disabled",
  computer: "computer_control_disabled",
};

/**
 * Snippet availability the policy implies, in the shape the heartbeat's
 * team-gated reconcile takes: off while the restriction is on, back on once
 * it lifts (only for a snippet the policy itself turned off).
 */
export function policySnippetAvailability(eff: EffectivePolicy, prev: Record<string, boolean> | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [slug, key] of Object.entries(SNIPPET_RESTRICTIONS)) {
    if (eff.values[key] === true) out[slug] = false;
    else if (prev?.[slug] === false) out[slug] = true;
  }
  return out;
}

/** The slug's refusal when policy turns its capability off. */
export function snippetPolicyRefusal(slug: string, config?: Config | null): string | null {
  const key = SNIPPET_RESTRICTIONS[slug];
  return key ? policyRefusal(key, config) : null;
}

/** Write ~/.codecast/managed-policy.json when it changed. Returns whether it wrote. */
export function writeEffectivePolicyFile(eff: EffectivePolicy = effectivePolicy()): boolean {
  const file = path.join(defaultConfigDir(), EFFECTIVE_POLICY_FILE);
  // The enrollment token stays out: this file is world-readable and the app needs none of it.
  const { enrollment_token: _token, ...values } = eff.values;
  const sources = { ...eff.sources };
  delete sources.enrollment_token;
  const body = JSON.stringify({ values, sources }, null, 2) + "\n";
  try {
    if (fs.readFileSync(file, "utf-8") === body) return false;
  } catch { /* absent */ }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget memoized reads. */
export function resetManagedPolicyCache(): void {
  profileCache.clear();
  rawConfigCache = null;
}
