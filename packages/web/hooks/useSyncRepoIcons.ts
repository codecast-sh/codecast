// Each repository's drawn face in a workspace into the store (convex
// repoIcons.forWorkspace): one row per workspace and repository, its icon
// null until the server has drawn one. The surface that lists repositories
// mounts the feeder once; every RepoFace only reads the store.
import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useMutation } from "convex/react";
import { SESSION_ICON_RETRY_MS, type RoleIcon, type RoleIconAccent } from "@codecast/shared/contracts/roleIcon";
import { useWatchEffect } from "./useWatchEffect";
import { roleIconSig } from "../lib/sessionIdentity";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const api = _api as any;

/** A repository's face as the store holds it. `repository` is `owner/name`, lowercased; `accent` is settled at the first ask and the drawing wears it. */
export type RepoIconRow = { _id: string; workspace: string; repository: string; accent: RoleIconAccent | null; icon: RoleIcon | null };

/** Feeder: every repository face in `workspace` (`user:<id>` or `team:<id>`). */
export function useSyncRepoIcons(workspace: string | null | undefined): { ready: boolean } {
  const r = useSyncCollection("repoIcons", api.repoIcons.forWorkspace, workspace ? { workspace } : "skip", {
    // Each answer is the workspace's whole set.
    dropAbsent: useCallback((row: RepoIconRow) => row?.workspace === workspace, [workspace]),
  });
  return useMemo(() => ({ ready: r.ready || !!r.error || r.refused }), [r.ready, r.error, r.refused]);
}

// The faces this window has asked for, per retry window: a page that lists a
// repository in many rows asks once, and the server holds the window anyway.
const asked = new Set<string>();

/** Asks the server to draw a repository's face once while it has none (convex repoIcons.request). */
export function useRequestRepoIcon(workspace: string, repository: string, drawn: boolean): void {
  const request = useMutation(api.repoIcons.request);
  useWatchEffect(() => {
    if (drawn) return;
    const key = `${workspace}|${repository}|${Math.floor(Date.now() / SESSION_ICON_RETRY_MS)}`;
    if (asked.has(key)) return;
    asked.add(key);
    request({ workspace, repository }).catch(() => {});
  }, [drawn, workspace, repository]);
}

/** Test seam: forget which faces this window asked for. */
export function _resetRepoIconAsks(): void {
  asked.clear();
}

const repoIconRowSig = (r: RepoIconRow) => `${r._id}|${r.repository}|${r.accent ?? ""}|${roleIconSig(r.icon)}`;

/** Reader: one repository's face in `workspace` (`owner/name`, any case): its settled color and its drawing, or null before the server has a row. */
export function useRepoIcon(workspace: string | null | undefined, repository: string): RepoIconRow | null {
  const rows = useWorkspaceCollection<RepoIconRow>("repoIcons", repoIconRowSig, workspace ?? null);
  const key = repository.trim().toLowerCase();
  return useMemo(() => rows.find((r) => r.repository === key) ?? null, [rows, key]);
}
