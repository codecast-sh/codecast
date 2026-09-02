"use client";
/**
 * Client side of per-team opt-in features (chat, calls). The store's `teams`
 * list (from teams.getUserTeams) carries each team's `features`; a feature is
 * OFF unless the ACTIVE team turned it on, and an off feature has no UI at
 * all — no nav row, no palette entry, no shortcut, no dock. The server
 * enforces the same flag at each feature's access chokepoint; this hook only
 * decides what to render. Contract: @codecast/shared/contracts/teamFeatures.
 *
 * The resolver comes from @platform/flags, so the web, mobile, the CLI and the
 * Convex guard all read a stored bag by the same rule. The package's hook
 * factory is deliberately not used here: it takes the flag source as one
 * object, and a selector that builds an object re-renders every subscriber on
 * every store tick. Each hook below subscribes to a BOOLEAN instead, so a
 * teams-list refresh that changes nothing re-renders nobody.
 */
import { useInboxStore } from "../store/inboxStore";
import { TEAM_FEATURES, type TeamFeatureKey } from "@codecast/shared/contracts";
import { anyHolderHasFeature, defineFeatures, holderHasFeature } from "@platform/flags";

/** codecast's catalog as a @platform/flags catalog. Shared with the off-feature
 *  landing (TeamFeatureOff), so the toggle, the gate and the copy agree. */
export const TEAM_FEATURE_CATALOG = defineFeatures(TEAM_FEATURES);

/** Is `key` on for the team with id `teamId`, out of the store's teams list? */
export function teamHasFeature(teams: any[], teamId: string | null | undefined, key: TeamFeatureKey): boolean {
  if (!teamId) return false;
  const team = (teams || []).find((t: any) => String(t._id) === String(teamId));
  return holderHasFeature(TEAM_FEATURE_CATALOG, team, key);
}

/** Is `key` on for the ACTIVE team? Personal workspace = off. Subscribes to a
 *  boolean, so a teams-list refresh that changes nothing re-renders nobody. */
export function useTeamFeature(key: TeamFeatureKey): boolean {
  return useInboxStore((s) => teamHasFeature(s.teams, s.clientState.ui?.active_team_id, key));
}

/** Is `key` on for ANY of the viewer's teams? For surfaces that span teams
 *  (the calls history page, an incoming ring), where hiding per active team
 *  would drop a teammate's ring from another team. */
export function useAnyTeamFeature(key: TeamFeatureKey): boolean {
  return useInboxStore((s) => anyHolderHasFeature(TEAM_FEATURE_CATALOG, s.teams || [], key));
}

/** Calls affordances (huddle buttons, occupancy chips, palette entry): the
 *  deployment must be configured AND the active team must have calls on. The
 *  ring pipeline deliberately does not use this — a ring from a teammate in
 *  another team must still reach you (see useCallSync). */
export function useCallsAvailable(): boolean {
  return useInboxStore((s) =>
    !!s.callConfig?.enabled && teamHasFeature(s.teams, s.clientState.ui?.active_team_id, "calls"));
}
