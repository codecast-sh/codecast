"use client";
// The sidebar Org row's count: what waits on you in the active workspace's
// org, the same total the strip above the Org conversation leads with. Zero
// shows nothing. Violet is a proposal's colour: the count wears it only when
// everything it counts is a proposal, and is neutral otherwise.
import { memo } from "react";
import { NavCount } from "../sidebar/navPrimitives";
import { useOrgNeedsYouCount, useOrgNeedsYouProposals } from "./useNeedsYou";

export const OrgNeedsYouBadge = memo(function OrgNeedsYouBadge() {
  const n = useOrgNeedsYouCount();
  const proposals = useOrgNeedsYouProposals();
  if (n <= 0) return null;
  return (
    <span data-org-nav-count={n} title={`${n} wait${n === 1 ? "s" : ""} on you in the org`} className="contents">
      <NavCount n={n} tone={proposals === n ? "bg-sol-violet text-white" : "bg-sol-bg-highlight text-sol-text"} />
    </span>
  );
});
