"use client";
// A surface that reads one workspace of its own, whatever the app's active
// one is (/line reads the workspace its lines live in, so a flip of the app to
// Personal never empties it). Inside the provider, the active-workspace hooks
// (useActiveWorkspaceKey, useWorkspaceCollection, useWorkspaceArgs and the
// feeders built on them) read the scope's key; outside it nothing changes. It
// never writes the active pointer: switching the app is useSwitchWorkspace.
import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceKey } from "../lib/workspaceScope";

const WorkspaceScope = createContext<WorkspaceKey | null>(null);

export function WorkspaceScopeProvider({ value, children }: { value: WorkspaceKey | null; children: ReactNode }) {
  return <WorkspaceScope.Provider value={value}>{children}</WorkspaceScope.Provider>;
}

/** The surrounding surface's own workspace key, or null where the app's active one holds. */
export function useWorkspaceScope(): WorkspaceKey | null {
  return useContext(WorkspaceScope);
}
