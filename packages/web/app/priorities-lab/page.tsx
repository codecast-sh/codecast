"use client";

// The route entry for /priorities-lab: a throwaway prototype of the redesigned
// Priorities list (components/priorities/lab). Not registered in src/App.tsx;
// components/priorities/lab/mountLab.tsx mounts it over /priorities in dev.

import PrioritiesLab from "@/components/priorities/lab/PrioritiesLab";
import { TeamFeatureOff } from "@/components/TeamFeatureOff";
import { useWorkspaceFeature } from "@/lib/teamFeatures";

export default function Page() {
  return useWorkspaceFeature("priorities") ? <PrioritiesLab /> : <TeamFeatureOff feature="priorities" />;
}
