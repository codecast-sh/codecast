// Per-team opt-in features (chat, calls) on mobile. Same contract as web:
// @codecast/shared/contracts/teamFeatures — a feature is off unless the team
// turned it on, and an off feature has no UI. Screens reached by deep link
// (a channel, a thread) ask here before subscribing, because the server
// refuses chat queries for an off team and a thrown query takes the screen
// down with it.
//
// The hooks are @platform/flags' factory over one injected source: mobile's
// source is the two live queries below, so the resolver, the catalog and the
// "still loading = undefined" rule are the same ones the web and the Convex
// guard use.
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { TEAM_FEATURES, type TeamFeatureKey } from "@codecast/shared/contracts";
import { createFeatureHooks, defineFeatures, type FeatureSource } from "@platform/flags";

const TEAM_FEATURE_CATALOG = defineFeatures(TEAM_FEATURES);

/** The active team and every team the viewer belongs to; undefined until both
 *  queries have answered, which is what makes the hooks report undefined
 *  rather than a premature false. */
function useTeamSource(): FeatureSource<TeamFeatureKey> | undefined {
  const currentUser = useQuery(api.users.getCurrentUser);
  const teams = useQuery(api.teams.getUserTeams);
  if (currentUser === undefined || teams === undefined) return undefined;
  const activeTeamId = currentUser?.active_team_id || currentUser?.team_id;
  const active = teams?.find((t: any) => t && String(t._id) === String(activeTeamId));
  return { active: active as any, all: (teams ?? []) as any };
}

const hooks = createFeatureHooks(TEAM_FEATURE_CATALOG, useTeamSource);

/** true/false once the teams list has loaded; undefined while unknown. */
export const useActiveTeamFeature: (key: TeamFeatureKey) => boolean | undefined =
  hooks.useFeatureState;
