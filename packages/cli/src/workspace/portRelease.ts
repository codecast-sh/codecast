// A workspace giving up its port reservation while keeping its tree, branch and setup (ct-101923).
import { readState, writeState, type PersistedWorkspaceState } from "./contract.js";
import { portsToEnv } from "./ports.js";
import { withPortReservations, withWorkspaceOperation } from "./portReservations.js";

/**
 * Give up a workspace's port reservation and keep everything else: its tree, branch and setup. For a tree kept
 * after the run that made it ended (workflow/runWorktree.ts releaseEndedRunTree), whose dev server, if it ever ran
 * one, ended with the run: 40 such trees of unlanded change runs held every port slot of a laptop on Nov 26
 * (ct-101923). A later `cast dev` there takes a free port as it starts. False when it held none.
 */
export async function releaseWorkspacePorts(repoRoot: string, name: string): Promise<boolean> {
  return withWorkspaceOperation(repoRoot, name, () => withPortReservations(repoRoot, async () => {
    const state = readState(repoRoot, name);
    if (!state || state.noPorts || Object.keys(state.ports).length === 0) return false;
    writeState(repoRoot, withoutPorts(state));
    return true;
  }));
}

/** What an acquire that finds every port slot taken frees first (workflow/runWorktree.ts releaseEndedRunTreePorts); a test replaces it. */
export const portExhaustion = {
  sweep: async (repoRoot: string): Promise<string[]> => (await import("../workflow/runWorktree.js")).releaseEndedRunTreePorts(repoRoot),
};

/** A record that holds no port, as `--no-ports` makes one: no port in its manifest, its ports or its env. */
export function withoutPorts(state: PersistedWorkspaceState): PersistedWorkspaceState {
  const portVars = new Set(Object.keys(portsToEnv(state.ports)));
  return {
    ...state,
    manifest: { ...state.manifest, ports: {} },
    ports: {},
    env: Object.fromEntries(Object.entries(state.env).filter(([key]) => !portVars.has(key))),
    noPorts: true,
    updatedAt: new Date().toISOString(),
  };
}
