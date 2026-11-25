// Draws the blame card for the editor it sits beside. The gutter says which
// hunk is under the pointer (lib/code/blame/hover.ts); this renders inside
// the app tree, so the session reference in the card resolves and links like
// every other one. Renders nothing until a hunk is hovered.

import { useMemo, useSyncExternalStore } from "react";
import type { EditorHost } from "../../../lib/code/editorHost";
import { closeBlameHover, getBlameHover, keepBlameHover, leaveBlameHover, subscribeBlameHover } from "../../../lib/code/blame/hover";
import { Popover, PopoverAnchor, PopoverContent } from "../../ui/popover";
import { BlameHoverCard } from "./BlameHoverCard";

export function BlameCardHost({ hostRef }: { hostRef: React.MutableRefObject<EditorHost | null> }) {
  const hover = useSyncExternalStore(subscribeBlameHover, getBlameHover, () => null);
  const mine = hover && hostRef.current?.view === hover.view ? hover : null;
  const rect = mine?.rect;
  const anchor = useMemo(
    () => ({ current: { getBoundingClientRect: () => (rect ? new DOMRect(rect.left, rect.top, rect.width, rect.height) : new DOMRect()) } }),
    [rect],
  );
  if (!mine) return null;
  return (
    <Popover open onOpenChange={(open) => !open && closeBlameHover()}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        side="right"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-80 max-w-[calc(100vw-16px)] border border-sol-border bg-sol-bg p-0 shadow-xl"
        onMouseEnter={keepBlameHover}
        onMouseLeave={leaveBlameHover}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <BlameHoverCard hover={mine} />
      </PopoverContent>
    </Popover>
  );
}
