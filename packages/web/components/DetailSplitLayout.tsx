"use client";
import { ReactNode } from "react";
import { useTabActive } from "../hooks/usePagePresence";

import { useDetailEscClose } from "../hooks/useDetailEscClose";
import { useIsModernStyle } from "../hooks/useVisualStyle";
import { useNavClose } from "../hooks/useNavTrail";
import { ModernDetailSplit } from "./nav/ModernDetailSplit";
// List, then detail — each taking the full stage:
//   click/enter → the detail covers the list
//   Esc / ✕     → back where the item was opened from (the list, a project,
//                 a conversation: hooks/useNavTrail useNavClose), the list
//                 when there is no trail
// The list stays mounted underneath (inert, so nothing in it can take focus)
// and keeps its scroll position for the return. Side by side is not this
// component's job any more: it is the stage's split layout, entered by a
// drag (components/stage), the same gesture for every surface.
// Selection stays URL-driven: /docs/<id> deep-links straight into the detail.
//
// Modern draws the list beside its open item when the pane is wide enough,
// and closes along the trail (components/nav/ModernDetailSplit).
export function DetailSplitLayout(props: {
  list: ReactNode;
  /** List-root route that close (✕ / Esc) navigates back to with no trail. */
  closeHref: string;
  children?: ReactNode;
}) {
  return useIsModernStyle() ? <ModernDetailSplit {...props} /> : <ClassicDetailSplit {...props} />;
}

function ClassicDetailSplit({
  list,
  closeHref,
  children,
}: {
  list: ReactNode;
  closeHref: string;
  children?: ReactNode;
}) {
  const close = useNavClose(closeHref);
  // Background tab panes stay mounted (display:none) — a hidden pane must not
  // run the document-level Esc listener, which would navigate the ACTIVE tab.
  const isTabActive = useTabActive();
  const hasDetail = children != null && children !== false;
  const active = hasDetail && isTabActive;

  const detailRef = useDetailEscClose(active, close);

  return (
    <div className="relative h-full overflow-hidden">
      <div className="h-full cq-container" inert={hasDetail}>{list}</div>
      {hasDetail && (
        <div className="absolute inset-0 z-30 bg-sol-bg flex flex-col">
          <div ref={detailRef} className="flex-1 min-h-0">{children}</div>
        </div>
      )}
    </div>
  );
}
