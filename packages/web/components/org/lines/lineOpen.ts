// How a line opens what it names, and how a proposal's line sends the reader
// to answer it: both are plain addresses. A line's link keeps its click to
// itself, so the row around it never also takes it.
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { objectHref, type OrgObjectKind } from "@codecast/shared/entities";
import type { ProposalRef } from "../../company/companyModel";

export type LineTarget = { kind: OrgObjectKind; ref: string };

/** The address of a proposal's change on the Org screen: the card scrolled to and lit. */
export const proposalChangeHref = (p: ProposalRef): string => `/org?proposal=${encodeURIComponent(p.short_id)}&focus=${p.seq}`;

const stopClick = (e: React.MouseEvent) => e.stopPropagation();

/** Opens a line's object at its address. */
export function useLineOpen(): { open: (t: LineTarget) => void; onLinkClick: (t: LineTarget) => (e: React.MouseEvent) => void } {
  const router = useRouter();
  const open = useCallback((t: LineTarget) => router.push(objectHref(t.kind, t.ref)), [router]);
  const onLinkClick = useCallback((_t: LineTarget) => stopClick, []);
  return { open, onLinkClick };
}

/** Sends the reader to a proposal's card: the link lands on the Org screen
 *  with the card lit. */
export function useProposalOpen(): (p: ProposalRef) => (e: React.MouseEvent) => void {
  return useCallback((_p: ProposalRef) => stopClick, []);
}
