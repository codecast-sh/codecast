// Per-team opt-in features. A team feature is OFF unless the team's admins
// turned it on: `teams.features` holds only the flags that were set, and an
// absent flag reads as off. Convex enforces the flag at each feature's access
// chokepoint, the web and mobile hide every surface of an off feature, and the
// daemon-side agent snippets that teach a feature follow the flag on the
// devices of the team's members.
//
// One catalog, so the settings toggle, the server guard, the client gate and
// the snippet fan-out can never disagree about which features exist or which
// snippet belongs to which. PURE isomorphic data — no Node or DOM APIs.

export type TeamFeatureKey = "chat" | "calls";

export interface TeamFeatureDescriptor {
  key: TeamFeatureKey;
  /** Human label on the team settings toggle. */
  name: string;
  /** One line under the toggle: what turning it on gives the team. */
  desc: string;
  /**
   * Agent-feature snippet slugs (see ./snippets) that only make sense while this
   * feature is on. Turning the feature on installs them on every member's
   * devices; turning it off removes them, unless another of the member's teams
   * still has the feature on.
   */
  snippets: string[];
}

export const TEAM_FEATURES: TeamFeatureDescriptor[] = [
  {
    key: "chat",
    name: "Team chat",
    desc: "Channels, DMs and threads for the team; agents can post with cast chat.",
    snippets: ["chat"],
  },
  {
    key: "calls",
    name: "Calls",
    desc: "Huddles from a channel, a session or a teammate, with live transcription.",
    snippets: ["calls"],
  },
];

export const TEAM_FEATURE_KEYS: TeamFeatureKey[] = TEAM_FEATURES.map((f) => f.key);

/** The stored shape on a team row: only flags that were ever set. */
export type TeamFeatures = Partial<Record<TeamFeatureKey, boolean>>;

/** Is `key` on for this team? Absent flag, absent team, absent bag: off. */
export function teamFeatureEnabled(
  team: { features?: TeamFeatures | null } | null | undefined,
  key: TeamFeatureKey,
): boolean {
  return team?.features?.[key] === true;
}

/** Every catalog entry that names `snippet` in its snippet list. */
export function teamFeaturesForSnippet(snippet: string): TeamFeatureDescriptor[] {
  return TEAM_FEATURES.filter((f) => f.snippets.includes(snippet));
}

/**
 * Is `snippet` gated behind a team feature, and if so, does at least one of
 * `teams` have that feature on? Ungated snippets are always available.
 */
export function snippetAvailableForTeams(
  snippet: string,
  teams: Array<{ features?: TeamFeatures | null } | null | undefined>,
): boolean {
  const gates = teamFeaturesForSnippet(snippet);
  if (gates.length === 0) return true;
  return gates.some((f) => teams.some((t) => teamFeatureEnabled(t, f.key)));
}
