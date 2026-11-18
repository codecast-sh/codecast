// A goal's environments with their latest attempt and link (contracts/envs.ts).
// The level and note live on the goal row (initiatives.envs); each env's
// standing lives in envStandings, fed once per workspace by the sync host
// (envs.workspaceStandings). A goal page joins the two at render.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { EnvStanding, GoalEnv } from "@codecast/shared/contracts/envs";
import { useSyncCollection } from "./useSyncCollection";
import { useOpsScope } from "./useSyncOps";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const api = _api as any;
type StandingRow = Omit<EnvStanding, "level" | "note"> & { _id: string; workspace: string };

/** Keep the workspace's env standings fed. Mount once, in HostFeeders. */
export function useSyncEnvStandings() {
  const scope = useOpsScope();
  return useSyncCollection("envStandings", api.envs.workspaceStandings, scope === "skip" ? "skip" : scope);
}

const sig = (r: StandingRow) => `${r.env}|${r.title ?? ""}|${r.attempt?.short_id ?? ""}|${r.attempt?.mean ?? ""}|${r.attempt?.ci95?.join(",") ?? ""}|${r.link?.measured_at ?? ""}|${r.link?.value ?? ""}`;

/** The goal's envs in its order, each with the standing the store holds (none yet: the env alone). */
export function useGoalEnvLevels(envs: readonly GoalEnv[] | undefined, workspace: string | undefined): EnvStanding[] {
  const rows = useWorkspaceCollection<StandingRow>("envStandings", sig, workspace);
  return useMemo(() => {
    const byEnv = new Map(rows.map((r) => [r.env, r]));
    return (envs ?? []).map((e) => {
      const { _id: _i, workspace: _w, ...s } = byEnv.get(e.env) ?? ({ env: e.env } as StandingRow);
      return { ...s, env: e.env, level: e.level, ...(e.note ? { note: e.note } : {}) };
    });
  }, [rows, envs]);
}
