// Inside the Org screen a reference never leaves the screen: a goal, project,
// role, person, conversation or proposal named anywhere in it (a pill, a line,
// a card, a session row) opens in the screen's panel instead of navigating
// (essence spec §6.4). OrgScreen provides the opener; every reference reads it
// here. Outside the screen there is no provider, and the reference navigates
// as any link does.
import { createContext, useContext } from "react";
import type { OrgObjectKind } from "@codecast/shared/entities";
import type { PanelRef } from "../panelTarget";

export type OrgOpen = {
  /** Open it in the panel: an object, `{ kind: "session", id }` or
   *  `{ kind: "proposal", id }`. `open(kind, ref)` still reads as an object. */
  open(to: PanelRef | OrgObjectKind, ref?: string): void;
  /** Open a proposal in the panel, its change `seq` lit. */
  openProposal?: (shortId: string, seq?: number) => void;
};

export const OrgOpenContext = createContext<OrgOpen | null>(null);

/** The screen's opener, or null outside the Org screen. */
export function useOrgOpen(): OrgOpen | null {
  return useContext(OrgOpenContext);
}

/** True for a plain left click, the only click the panel takes over: a
 *  modified click (new tab, new window) keeps the link's own navigation. */
export function isPlainClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
