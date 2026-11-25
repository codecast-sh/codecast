"use client";

// The route entry for /priorities. The surface lives in components/priorities/PrioritiesPage.tsx;
// every entry point is hidden while the workspace has Priorities off, so the gate only meets a direct URL or a stale tab.

import PrioritiesPage from "@/components/priorities/PrioritiesPage";
import { TeamFeatureOff } from "@/components/TeamFeatureOff";
import { useWorkspaceFeature } from "@/lib/teamFeatures";

export default function Page() {
  return useWorkspaceFeature("priorities") ? <PrioritiesPage /> : <TeamFeatureOff feature="priorities" />;
}
