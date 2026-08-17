"use client";
/**
 * Client side of per-team opt-in features (chat, calls). The store's `teams`
 * list (from teams.getUserTeams) carries each team's `features`; a feature is
 * OFF unless the ACTIVE team turned it on, and an off feature has no UI at
 * all — no nav row, no palette entry, no shortcut, no dock. The server
 * enforces the same flag at each feature's access chokepoint; this hook only
 * decides what to render. Contract: @codecast/shared/contracts/teamFeatures.
 */
import { useInboxStore } from "../store/inboxStore";
import { teamFeatureEnabled, type TeamFeatureKey } from "@codecast/shared/contracts";

/** Is `key` on for the team with id `teamId`, out of the store's teams list? */
export function teamHasFeature(teams: any[], teamId: string | null | undefined, key: TeamFeatureKey): boolean {
  if (!teamId) return false;
  const team = (teams || []).find((t: any) => String(t._id) === String(teamId));
  return teamFeatureEnabled(team, key);
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
  return useInboxStore((s) => (s.teams || []).some((t: any) => teamFeatureEnabled(t, key)));
}
