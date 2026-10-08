"use client";
// The body every object hover card shares (cohesive build spec D14): the
// object's summary, and a click anywhere on it opens the object; the hover
// fill and the pointer say so, with no foot to repeat it. Inside the Org screen the click opens the
// object's sheet there (orgOpenContext); anywhere else it goes to its
// address. Click or Enter, opening closes the hover card it sits in
// (HoverCardClose), so the card never floats over what it opened. The names inside the summary (what it serves) open their own
// objects and keep their click to themselves.
import { useContext, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { objectHref, type OrgObjectKind } from "@codecast/shared/entities";
import { isPlainClick, useOrgOpen } from "../org/company/orgOpenContext";
import { HoverCardClose } from "../../lib/hoverCardsOff";

export function ObjectCardBody({ kind, refId, label, onOpen, children, ...data }: {
  kind: OrgObjectKind;
  /** The ref its address takes: a short id, a person's handle or id. */
  refId: string;
  /** What a click does, for assistive tech: "Open role", "Open profile". */
  label: string;
  /** Runs before the card's own open on a click (a pill passes its opener);
   *  preventing the click's default means it opened the object itself. */
  onOpen?: (e: React.MouseEvent) => void;
  children: ReactNode;
} & Record<`data-${string}`, string>) {
  const orgOpen = useOrgOpen();
  const router = useRouter();
  const closeCard = useContext(HoverCardClose);
  const href = objectHref(kind, refId);
  const go = (newTab: boolean) => {
    if (newTab) window.open(href, "_blank", "noopener");
    else if (orgOpen) orgOpen.open(kind, refId);
    else router.push(href);
  };
  const open = (e: React.MouseEvent) => {
    // A card floats over rows that are themselves clickable (an inbox card, a
    // menu item), and React bubbles a portal's click to them: the click stops
    // here so opening the object never also selects the row under it.
    e.stopPropagation();
    // A name inside the summary is a link of its own: its click is its own.
    if ((e.target as Element).closest?.("a")) return;
    closeCard?.();
    // A pill's opener goes first (it opens a sheet on the Org screen); what it
    // leaves undone, the card does.
    onOpen?.(e);
    if (e.defaultPrevented) return;
    const plain = isPlainClick(e);
    e.preventDefault();
    go(!plain);
  };
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={label}
      onClick={open}
      onKeyDown={(e) => { if (e.key !== "Enter" || e.target !== e.currentTarget) return; e.stopPropagation(); e.preventDefault(); closeCard?.(); go(e.metaKey || e.ctrlKey); }}
      className="block cursor-pointer rounded-[inherit] p-3 text-xs transition-colors hover:bg-sol-bg-highlight/30"
      data-object-card={kind}
      {...data}
    >
      {children}
    </div>
  );
}
