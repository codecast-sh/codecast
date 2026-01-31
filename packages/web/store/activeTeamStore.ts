import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

interface ActiveTeamState {
  activeTeamId: Id<"teams"> | null;
  setActiveTeam: (teamId: Id<"teams"> | null) => void;
}

export const useActiveTeamStore = create<ActiveTeamState>()(
  persist(
    (set) => ({
      activeTeamId: null,
      setActiveTeam: (teamId) => set({ activeTeamId: teamId }),
    }),
    {
      name: "codecast-active-team",
    }
  )
);
