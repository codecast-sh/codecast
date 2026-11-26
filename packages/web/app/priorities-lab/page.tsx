"use client";

// The route entry for /priorities-lab: a throwaway prototype of the redesigned
// Priorities list (components/priorities/lab). Not registered in src/App.tsx;
// components/priorities/lab/mountLab.tsx mounts it over /priorities in dev.

import PrioritiesLab from "@/components/priorities/lab/PrioritiesLab";
import { TeamFeatureOff } from "@/components/TeamFeatureOff";
import { useWorkspaceFeature } from "@/lib/teamFeatures";

export default function Page() {
  const on = useWorkspaceFeature("priorities");
  // A lab pinned to a workspace (`?ws=`) renders whatever the active one's switch says.
  const pinned = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("ws");
  return on || pinned ? <PrioritiesLab /> : <TeamFeatureOff feature="priorities" />;
}
