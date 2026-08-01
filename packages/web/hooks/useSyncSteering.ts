import { useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs, type WorkspaceArgs } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";

const api = _api as any;

// Steering entities are workspace-scoped, never project-path-scoped — drop the
// path so the webList validators (which take no project_path) accept the args.
function steeringArgs(args: WorkspaceArgs): Record<string, any> | "skip" {
  if (args === "skip") return "skip";
  const { project_path: _path, ...rest } = args as Record<string, any>;
  return rest;
}

// Live subscriptions for the Steering collections (Organizational Steering
// Phase 1). Same shape as useSyncProjects: a workspace-scoped webList
// subscription feeding the store's delta cache via syncTable. Mounted by the
// Steering surfaces that render these collections (Phase 2); the global
// change feed (useSyncChangeFeed) keeps an away client caught up — including
// hard deletions — regardless of which pages were open.

export function useSyncStrategies() {
  const workspaceArgs = steeringArgs(useWorkspaceArgs());
  const result = useQuery(
    api.strategies.webList,
    workspaceArgs === "skip" ? "skip" : workspaceArgs,
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useConvexSync(
    result,
    useCallback(
      (data: any) => {
        syncTable("strategies", data as any, { isDelta: true } as any);
      },
      [syncTable],
    ),
  );
  return { loading: workspaceArgs !== "skip" && result === undefined };
}

export function useSyncSteeringItems() {
  const workspaceArgs = steeringArgs(useWorkspaceArgs());
  const result = useQuery(
    api.steeringItems.webList,
    workspaceArgs === "skip" ? "skip" : workspaceArgs,
  );
  const syncTable = useInboxStore((s) => s.syncTable);
  useConvexSync(
    result,
    useCallback(
      (data: any) => {
        syncTable("steeringItems", data as any, { isDelta: true } as any);
      },
      [syncTable],
    ),
  );
  return { loading: workspaceArgs !== "skip" && result === undefined };
}
