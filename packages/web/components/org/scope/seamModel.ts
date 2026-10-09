// The Org layer's one seam as numbers (cohesive build spec D2): the split the
// person dragged, stored once in `clientState.layouts.org`, and the Group
// layout a split takes with one side folded away.
import type { Layout } from "react-resizable-panels";
import type { ClientLayouts } from "../../../store/clientPrefsTypes";

type Split = NonNullable<ClientLayouts["org"]>;
export type SeamSide = "conversation" | "panel";

export const SEAM_LEFT = "org-left";
export const SEAM_RIGHT = "org-right";
export const EVEN_SPLIT: Split = { conversation: 50, company: 50 };

/** A stored split counts only when both sides had room: a value written by
 *  an older build, or half a write, falls back to even. */
export function splitOf(stored: Split | undefined): Split {
  return stored && stored.conversation >= 5 && stored.company >= 5 ? stored : EVEN_SPLIT;
}

/** The Group's layout for a split with one side folded, or none. */
export function seamLayout(hidden: SeamSide | null, split: Split): Layout {
  if (hidden === "panel") return { [SEAM_LEFT]: 100, [SEAM_RIGHT]: 0 };
  if (hidden === "conversation") return { [SEAM_LEFT]: 0, [SEAM_RIGHT]: 100 };
  return { [SEAM_LEFT]: split.conversation, [SEAM_RIGHT]: split.company };
}

