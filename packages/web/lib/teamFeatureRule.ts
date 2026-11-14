/**
 * The per-team feature rule, out of a teams list. A leaf (no store, no React)
 * so the store's own slices can ask it; lib/teamFeatures builds the hooks on
 * top of it.
 */
import { featureVendorBlock, TEAM_FEATURES, type TeamFeatureKey } from "@codecast/shared/contracts";
import { defineFeatures, holderHasFeature } from "@platform/flags";

/** codecast's catalog as a @platform/flags catalog. Shared with the off-feature
 *  landing (TeamFeatureOff), so the toggle, the gate and the copy agree. */
export const TEAM_FEATURE_CATALOG = defineFeatures(TEAM_FEATURES);

/** Is `key` on for the team with id `teamId`, out of the store's teams list?
 *  A regulated team's feature whose vendor has no BAA yet is off however it
 *  is set (featureVendorBlock); the server refuses it the same way. */
export function teamHasFeature(teams: any[], teamId: string | null | undefined, key: TeamFeatureKey): boolean {
  if (!teamId) return false;
  const team = (teams || []).find((t: any) => String(t._id) === String(teamId));
  return holderHasFeature(TEAM_FEATURE_CATALOG, team, key) && !featureVendorBlock(team, key);
}
