// Inside the Org screen a reference never leaves the screen: a goal, project,
// role or person named anywhere in it (a pill in the conversation, a line in
// the document, a node on the map) opens that object's sheet over the
// company pane instead of navigating. CompanyPane provides the opener; every
// reference reads it here. Outside the screen there is no provider, and the
// reference navigates to objectHref as any link does.
import { createContext, useContext } from "react";
import type { OrgObjectKind } from "@codecast/shared/entities";

export type OrgOpen = {
  /** Push the object's sheet onto the screen's stack (the in-screen open,
   *  which never swaps the conversation on the left). */
  open: (kind: OrgObjectKind, ref: string) => void;
  /** Scroll the conversation to a proposal's card, the change `seq` lit,
   *  swapping back to the Head of People first (D5e, D8). A proposal's line
   *  in the document and its Now line on a sheet answer through this. */
  openProposal?: (shortId: string, seq?: number) => void;
};

export const OrgOpenContext = createContext<OrgOpen | null>(null);

/** The screen's opener, or null outside the Org screen. */
export function useOrgOpen(): OrgOpen | null {
  return useContext(OrgOpenContext);
}

/** True for a plain left click, the only click a sheet takes over: a
 *  modified click (new tab, new window) keeps the link's own navigation. */
export function isPlainClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
