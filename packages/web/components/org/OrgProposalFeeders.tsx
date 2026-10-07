"use client";

import { useSyncOrgProposal } from "../../hooks/useSyncOrgProposals";

/** One change feeder per proposal the screen shows totals for (the open
 *  ones of this workspace plus the linked one, `openProposalsToFeed`): each
 *  ref is its own subscription, so a proposal joining or leaving the strip
 *  touches one query, never the list. */
export function OrgProposalFeeders({ refs }: { refs: readonly string[] }) {
  return <>{refs.map((ref) => <OrgProposalFeeder key={ref} proposalRef={ref} />)}</>;
}

function OrgProposalFeeder({ proposalRef }: { proposalRef: string }) {
  useSyncOrgProposal(proposalRef);
  return null;
}
