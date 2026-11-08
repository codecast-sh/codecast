// Which third-party vendors a regulated team's data (HIPAA, plan pl-990) may
// reach. Whether Codecast holds a signed BAA with a vendor is a fact about
// Codecast, not about any team, so it lives here in code and changes through
// review like any other change. A regulated team's content reaches a vendor
// only when the vendor is in BAA_COVERED_VENDORS; until then every feature
// that would send it there is off for that team. Teams that hold no regulated
// data are not affected. PURE isomorphic data: the server guard, the web and
// the phone all read it.
import { parseTeamPolicy } from "./managedPolicy";
import type { TeamFeatureKey } from "./teamFeatures";

/** Every vendor the server talks to, by what it receives. */
export const VENDORS = {
  anthropic: { name: "Anthropic", receives: "content", feature: "AI features" },
  openai: { name: "OpenAI", receives: "content", feature: "AI features" },
  livekit: { name: "LiveKit", receives: "content", feature: "Calls" },
  // Agent faces in calls (infra/call-face-worker): Tavus speaks the session's
  // replies; the live voice behind a face is OpenAI's realtime model.
  tavus: { name: "Tavus", receives: "content", feature: "Agent faces" },
  // The team's own accounts: the team's agreement with the vendor governs them.
  slack: { name: "Slack", receives: "team-account", feature: "Slack" },
  github: { name: "GitHub", receives: "team-account", feature: "GitHub" },
  linear: { name: "Linear", receives: "team-account", feature: "Linear" },
  // Push delivery: regulated teams' push bodies carry no transcript text (lib/pushPrivacy).
  expo: { name: "Expo push", receives: "no-content", feature: "Push notifications" },
} as const;

export type Vendor = keyof typeof VENDORS;
/** A vendor that receives a team's content from Codecast's own account, so it needs Codecast's BAA. */
export type ContentVendor = { [V in Vendor]: (typeof VENDORS)[V]["receives"] extends "content" ? V : never }[Vendor];

/**
 * Vendors Codecast holds a signed BAA with. Add a vendor only once its BAA is
 * signed and filed (task ct-87100); adding it turns its features back on for
 * every regulated team.
 */
export const BAA_COVERED_VENDORS: readonly ContentVendor[] = [];

export function vendorCovered(vendor: ContentVendor, covered: readonly ContentVendor[] = BAA_COVERED_VENDORS): boolean {
  return covered.includes(vendor);
}

/** The one line a refused request or a disabled control shows. */
export function vendorUncoveredMessage(vendor: ContentVendor, teamName?: string | null): string {
  const v = VENDORS[vendor];
  return `${v.feature} are off${teamName ? ` for ${teamName}` : ""}: no BAA with ${v.name} yet.`;
}

/** The team features that send a team's content to a vendor, and which. */
export const FEATURE_VENDORS: Partial<Record<TeamFeatureKey, readonly ContentVendor[]>> = {
  calls: ["livekit"],
  agent_faces: ["tavus"],
  agent_realtime: ["openai"],
};

/** The vendor a team feature still lacks a BAA with, or null when it has every one it needs. */
export function featureUncoveredVendor(key: TeamFeatureKey, covered: readonly ContentVendor[] = BAA_COVERED_VENDORS): ContentVendor | null {
  return FEATURE_VENDORS[key]?.find((v) => !covered.includes(v)) ?? null;
}

/** Why `key` is off for a regulated team (the line its control shows), or null when the team may use it. */
export function featureVendorBlock(
  team: { name?: string; policy?: unknown } | null | undefined,
  key: TeamFeatureKey,
  covered: readonly ContentVendor[] = BAA_COVERED_VENDORS,
): string | null {
  const vendor = featureUncoveredVendor(key, covered);
  return vendor ? teamVendorBlock(team, vendor, covered) : null;
}

/** Why this team's content may not go to `vendor` (the line a disabled control shows), or null when it may. */
export function teamVendorBlock(
  team: { name?: string; policy?: unknown } | null | undefined,
  vendor: ContentVendor,
  covered: readonly ContentVendor[] = BAA_COVERED_VENDORS,
): string | null {
  if (!team || vendorCovered(vendor, covered) || parseTeamPolicy(team.policy).regulated_data !== true) return null;
  return vendorUncoveredMessage(vendor, team.name);
}
