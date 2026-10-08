import { createContext } from "react";

/**
 * True inside a surface that must open nothing on hover: hover cards, tooltips
 * and previews stay shut, since each portals to the page's body, outside the
 * surface. The marketing hero sets it (app/(marketing)/heroFly/sandbox.tsx),
 * where the views sit on a moving 3D plane a portal cannot follow.
 */
export const HoverCardsOff = createContext(false);

/**
 * Closes the hover card a body sits in. Each host (HoverCard, the reference
 * pill's popover) provides its own; a card that opens its object calls it, by
 * click or by Enter, so the card never floats over what it opened.
 */
export const HoverCardClose = createContext<(() => void) | null>(null);
