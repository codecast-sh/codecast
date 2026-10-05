// A record opened by its address may live outside the active workspace (a
// link from another team's run, a project named by id). Its page reads its
// lists from the active workspace's feeds, so those lists would read empty:
// this names the workspace it lives in and switches there, the way the org
// page does for a proposal from another workspace.
import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import { activeWorkspaceKeyOf, inWorkspace, workspaceDisplayName, workspaceRefOf } from "../lib/workspaceScope";
import { useSwitchWorkspace } from "./useSwitchWorkspace";

/** `switchTo` is null for another person's personal workspace, which no switch reaches. */
export type ForeignWorkspace = { name: string; switchTo: (() => void) | null };

/** Null while the row is in the active workspace, or its workspace is unknown. */
export function useForeignWorkspace(row: { workspace?: string | null; team_id?: string | null } | null | undefined): ForeignWorkspace | null {
  const switchWorkspace = useSwitchWorkspace();
  const ws = row ? workspaceRefOf(row) : null;
  const foreign = useInboxStore((s) => {
    const key = activeWorkspaceKeyOf(s);
    return !!row && !!ws && !!key && !inWorkspace(row, key);
  });
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const name = useInboxStore((s) => (ws ? workspaceDisplayName(ws, s.teams as any, viewerId) : ""));
  const switchTo = useCallback(() => { if (ws) void switchWorkspace(ws.kind === "team" ? ws.id : null); }, [ws?.kind, ws?.id, switchWorkspace]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!foreign || !ws) return null;
  return { name, switchTo: ws.kind === "team" || ws.id === viewerId ? switchTo : null };
}
