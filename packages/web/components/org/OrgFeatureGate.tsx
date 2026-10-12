"use client";
// The per-team org feature (teams.features.org, default off) is the agents
// half of the Org screen: the Head of People, roles, proposals. Goals,
// projects and people need no agents, so /org renders the company for every
// workspace and gates only its conversation pane (D11): `useOrgFeatureOn`
// decides whether the left pane and the seam exist at all. Routes that ARE
// the agents (/anchor, the workspace scope page) still wrap their whole page
// in OrgFeatureGate, which shows the shared off landing for a direct URL or a
// stale tab.
import type { ReactNode } from "react";
import { TeamFeatureOff } from "../TeamFeatureOff";
import { useOrgFeatureOn } from "../../hooks/useOrgFeatureOn";

/** Children when the feature is on; `off` when it is not (the off landing by
 *  default, for a whole route; pass null to drop a pane). */
export function OrgFeatureGate({ children, off }: { children: ReactNode; off?: ReactNode }) {
  const on = useOrgFeatureOn();
  if (on) return <>{children}</>;
  return off === undefined ? <TeamFeatureOff feature="org" /> : <>{off}</>;
}
