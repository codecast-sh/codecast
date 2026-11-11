"use client";

import type { ReactNode } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { hasOpenModal } from "../../shortcuts/registry";
import { useTabActive } from "../../hooks/usePagePresence";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useNavClose } from "../../hooks/useNavTrail";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";
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

  // Esc closes the item. Never from an editable (editors own Esc), never
  // under a modal or the shortcuts panel.
  useWatchEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || hasOpenModal()) return;
      if (useInboxStore.getState().shortcutsPanelOpen) return;
      if (keyBelongsElsewhere(e.target)) return;
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, close]);

  return (
    <div className="cc-dsplit" data-cc-split={hasDetail ? "open" : "list"}>
      <div className="cc-dsplit__list cq-container">
        <DetailListCtx.Provider value={hasDetail}>{list}</DetailListCtx.Provider>
      </div>
      {hasDetail && (
        <div className="cc-dsplit__detail" data-cc-split-detail>
          <div className="min-h-0 flex-1">{children}</div>
        </div>
      )}
    </div>
  );
}
