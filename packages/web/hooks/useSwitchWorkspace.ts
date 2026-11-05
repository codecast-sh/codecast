// The ONE way the web app changes the active workspace.
//
// The active team lives in two places by design: `users.active_team_id` is the
// CANONICAL pointer (the CLI and mobile read it), and `clientState.ui
// .active_team_id` is a local MIRROR so the UI can re-scope instantly without
// waiting for a round trip. A switch must write BOTH — a mirror-only write
// leaves the CLI operating in the team you left, which is how `cast chat new`
// creates a channel in a team the web app is not even showing.
//
// Two of the three call sites used to write the mirror alone (creating a team,
// and following a link into a channel outside the active workspace). Both go
// through here now, and lib/__tests__/activeTeamPointer.guard.test.ts fails if
// a new one writes `active_team_id` through updateClientUI directly.
import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

/** The workspace_seen_at key: a team id, or "personal". */
export function workspaceSeenKey(teamId: string | null | undefined): string {
  return teamId ? String(teamId) : "personal";
}

export function useSwitchWorkspace(): (teamId: Id<"teams"> | string | null) => Promise<void> {
  const saveActiveTeam = useInboxStore((s) => s.setActiveTeamPointer);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);

  return useCallback(
    async (teamId) => {
      const id = (teamId || undefined) as Id<"teams"> | undefined;
      // Both halves in this tick (local-first is the law): the mirror web
      // reads, and the canonical pointer the phone and the CLI read, which the
      // store's dispatch carries to the server. The visit stamp marks both the
      // workspace left and the one entered as seen now: the switcher's dot
      // lights only for what waits on the person after it.
      const ui = useInboxStore.getState().clientState.ui;
      const now = Date.now();
      const workspace_seen_at = {
        ...ui?.workspace_seen_at,
        [workspaceSeenKey(ui?.active_team_id)]: now,
        [workspaceSeenKey(id)]: now,
      };
      updateClientUI({ active_team_id: id, workspace_seen_at });
      saveActiveTeam(id ?? null);
    },
    [saveActiveTeam, updateClientUI],
  );
}
