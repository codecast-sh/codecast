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

export function useSwitchWorkspace(): (teamId: Id<"teams"> | string | null) => Promise<void> {
  const saveActiveTeam = useInboxStore((s) => s.setActiveTeamPointer);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);

  return useCallback(
    async (teamId) => {
      const id = (teamId || undefined) as Id<"teams"> | undefined;
      // Both halves in this tick (local-first is the law): the mirror web
      // reads, and the canonical pointer the phone and the CLI read, which the
      // store's dispatch carries to the server.
      updateClientUI({ active_team_id: id });
      saveActiveTeam(id ?? null);
    },
    [saveActiveTeam, updateClientUI],
  );
}
