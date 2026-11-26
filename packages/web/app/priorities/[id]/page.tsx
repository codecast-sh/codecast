"use client";

// The route entry for /priorities/<pri-N>: one priority's own page (components/priorities/PriorityPage.tsx),
// behind the priorities team feature like the list.

import { useParams } from "next/navigation";
import PriorityPage from "@/components/priorities/PriorityPage";
import { TeamFeatureOff } from "@/components/TeamFeatureOff";
import { useWorkspaceFeature } from "@/lib/teamFeatures";

export default function Page() {
  const id = String(useParams()?.id ?? "");
  return useWorkspaceFeature("priorities") ? <PriorityPage id={id} /> : <TeamFeatureOff feature="priorities" />;
}
