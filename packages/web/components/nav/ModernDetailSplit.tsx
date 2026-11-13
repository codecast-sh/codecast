"use client";

import type { ReactNode } from "react";
import { useTabActive } from "../../hooks/usePagePresence";
import { useNavClose } from "../../hooks/useNavTrail";
import { useDetailEscClose } from "../../hooks/useDetailEscClose";
import { DetailListCtx } from "../../lib/detailSplitContext";
import "./detailSplit.css";

// A list and the item open from it, in the Modern style (DetailSplitLayout
// draws this while Modern is on). Wide enough, the list stays on screen as a
// column beside the item, its open row lit, so where the item sits is plain
// and the next one is one click away. Narrow, the item takes the pane, with
// the same header: its back control and crumbs say where it came from, so
// narrowing never hides the way back. Closing (the item's ✕, Esc) follows the
// back control's rule (hooks/useNavTrail useNavClose): to the list it was
// opened from, the project, or the conversation.

export function ModernDetailSplit({ list, closeHref, children }: { list: ReactNode; closeHref: string; children?: ReactNode }) {
  const isTabActive = useTabActive();
  const hasDetail = children != null && children !== false;
  const active = hasDetail && isTabActive;
  const close = useNavClose(closeHref);

  const detailRef = useDetailEscClose(active, close);

  return (
    <div className="cc-dsplit" data-cc-split={hasDetail ? "open" : "list"}>
      <div className="cc-dsplit__list cq-container">
        <DetailListCtx.Provider value={hasDetail}>{list}</DetailListCtx.Provider>
      </div>
      {hasDetail && (
        <div className="cc-dsplit__detail" data-cc-split-detail>
          <div ref={detailRef} className="min-h-0 flex-1">{children}</div>
        </div>
      )}
    </div>
  );
}
