// How a line opens what it names, and how a proposal's line sends the reader
// to answer it. Inside the Org screen a line pushes a sheet and a proposal
// scrolls the conversation to its card (D5b, D8); anywhere else both are
// plain addresses.
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { objectHref, type OrgObjectKind } from "@codecast/shared/entities";
import { isPlainClick, useOrgOpen } from "../company/orgOpenContext";
import type { ProposalRef } from "../../company/companyModel";

export type LineTarget = { kind: OrgObjectKind; ref: string };

/** The address of a proposal's change on the Org screen: the card scrolled to and lit. */
export const proposalChangeHref = (p: ProposalRef): string => `/org?proposal=${encodeURIComponent(p.short_id)}&focus=${p.seq}`;

/** Opens a line's object: the sheet inside the screen, its address outside. */
export function useLineOpen(): { open: (t: LineTarget) => void; onLinkClick: (t: LineTarget) => (e: React.MouseEvent) => void } {
  const ctx = useOrgOpen();
  const router = useRouter();
  const open = useCallback((t: LineTarget) => (ctx ? ctx.open(t.kind, t.ref) : router.push(objectHref(t.kind, t.ref))), [ctx, router]);
  const onLinkClick = useCallback((t: LineTarget) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!ctx || !isPlainClick(e)) return;
    e.preventDefault();
    ctx.open(t.kind, t.ref);
  }, [ctx]);
  return { open, onLinkClick };
}

/** Sends the reader to a proposal's card: in the screen, the conversation
 *  scrolls to it (swapping back to the Head of People first); elsewhere the
 *  link lands on the Org screen with the card lit. */
export function useProposalOpen(): (p: ProposalRef) => (e: React.MouseEvent) => void {
  const ctx = useOrgOpen();
  return useCallback((p: ProposalRef) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!ctx?.openProposal || !isPlainClick(e)) return;
    e.preventDefault();
    ctx.openProposal(p.short_id, p.seq);
  }, [ctx]);
}
