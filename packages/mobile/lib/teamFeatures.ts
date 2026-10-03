// Per-team opt-in features (chat, calls) on mobile. Same contract as web:
// @codecast/shared/contracts/teamFeatures — a feature is off unless the team
// turned it on, and an off feature has no UI. Screens reached by deep link
// (a channel, a thread) ask here before subscribing, because the server
// refuses chat queries for an off team and a thrown query takes the screen
// down with it.
//
// The hooks are @platform/flags' factory over one injected source: the
// store's persisted user record and teams list, so a cached answer paints on
// the first frame. The resolver, the catalog and the "still unknown =
// undefined" rule are the same ones the web and the Convex guard use.
import { useMemo } from "react";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { TEAM_FEATURES, workspaceFeatureEnabled, type TeamFeatureKey } from "@codecast/shared/contracts";
import { createFeatureHooks, defineFeatures, type FeatureSource } from "@platform/flags";

const TEAM_FEATURE_CATALOG = defineFeatures(TEAM_FEATURES);

/** The active team (the store's workspace mirror; unset = personal)
 *  and every team the viewer belongs to. undefined while the user is unknown,
 *  or while the active team is missing from the list (never fed, or a team
 *  created this tick), which keeps the hooks from reporting a premature false. */
function useTeamSource(): FeatureSource<TeamFeatureKey> | undefined {
  const userKnown = useInboxStore((s) => !!s.currentUser?._id);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id ?? undefined) as string | undefined;
  const teams = useInboxStore((s) => s.teams) as any[];
  return useMemo(() => {
    if (!userKnown) return undefined;
    const all = (teams ?? []).filter(Boolean);
    const active = activeTeamId ? all.find((t: any) => String(t._id) === String(activeTeamId)) : undefined;
    if (activeTeamId && !active) return undefined;
    return { active, all } as FeatureSource<TeamFeatureKey>;
  }, [userKnown, activeTeamId, teams]);
}

const hooks = createFeatureHooks(TEAM_FEATURE_CATALOG, useTeamSource);

/** true/false once the teams list has loaded; undefined while unknown. */
export const useActiveTeamFeature: (key: TeamFeatureKey) => boolean | undefined =
  hooks.useFeatureState;

/** Is `key` on in the active WORKSPACE, personal included (the personal
 *  workspace borrows a `personal` feature from any of the viewer's teams,
 *  shared rule workspaceFeatureEnabled). undefined while unknown. */
export function useWorkspaceFeatureState(key: TeamFeatureKey): boolean | undefined {
  const src = useTeamSource();
  if (!src) return undefined;
  return workspaceFeatureEnabled(src.all as any[], src.active ? String((src.active as any)._id) : null, key);
}
