"use client";
// The org routes (/org, /org/<id>, /anchor) behind the per-team org feature
// (teams.features.org, default off). Every entry point is hidden when it is
// off, so this only meets a direct URL or a stale tab: it shows the shared
// off landing instead of an empty tree.
import type { ReactNode } from "react";
import { TeamFeatureOff } from "../TeamFeatureOff";
import { useWorkspaceFeature } from "../../lib/teamFeatures";

export function OrgFeatureGate({ children }: { children: ReactNode }) {
  const on = useWorkspaceFeature("org");
  return on ? <>{children}</> : <TeamFeatureOff feature="org" />;
}
