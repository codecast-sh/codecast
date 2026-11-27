"use client";

// The route entry for /priorities. The surface lives in components/priorities/PrioritiesPage.tsx;
// every entry point is hidden while no workspace the viewer holds has Priorities on, so the gate only meets a direct URL or a stale tab.

import PrioritiesPage from "@/components/priorities/PrioritiesPage";
import { TeamFeatureOff } from "@/components/TeamFeatureOff";
import { useAnyWorkspaceFeature } from "@/lib/teamFeatures";

export default function Page() {
  return useAnyWorkspaceFeature("priorities") ? <PrioritiesPage /> : <TeamFeatureOff feature="priorities" />;
}
