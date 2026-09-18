"use client";
// A conversation with one panel beside it (docs/architecture/scopes-and-feed.md
// F4.1): the layout a scope opens in, and an initiative after it
// (initiatives-projects-role-page.md I1). Where the panel sits is decided once,
// here: its own column on a wide window, an overlay over the conversation on a
// narrow one, and a bottom sheet on the phone that the conversation hands to
// and takes back. The page owns whether the panel is open; this owns where.
import type { ReactNode } from "react";
import { useIsPhone, useMinWidth } from "../../../hooks/useIsPhone";

export type PanelLayout = "side" | "overlay" | "sheet";

/** The width of the panel's own column and of the overlay. */
export const PANEL_W = 440;

/** The conversation needs this much beside the panel's column before the
 *  panel gets one; narrower windows get the panel as an overlay. */
const WIDE_MIN_W = PANEL_W + 620;

export function usePanelLayout(): { layout: PanelLayout; phone: boolean } {
  const phone = useIsPhone();
  const wide = useMinWidth(WIDE_MIN_W);
  return { layout: phone ? "sheet" : wide ? "side" : "overlay", phone };
}

const BORDER = "color-mix(in srgb, var(--sol-border) 30%, transparent)";

export function ConversationWithPanel({ conversation, panel, open, layout }: {
  /** The left side, already wrapped by the page (it carries the page's own
   *  data attributes and any note above the conversation). */
  conversation: ReactNode;
  panel: ReactNode;
  open: boolean;
  layout: PanelLayout;
}) {
  return (
    <div className="flex-1 min-h-0 relative flex">
      {conversation}
      {open && layout === "side" && (
        <aside className="shrink-0 border-l min-h-0" style={{ width: PANEL_W, borderColor: BORDER, background: "var(--sol-bg)" }} data-scope-aside="side">
          {panel}
        </aside>
      )}
      {open && layout === "overlay" && (
        <aside className="absolute right-0 top-0 bottom-0 z-20 border-l min-h-0 org-panel-in shadow-[-16px_0_40px_-24px_rgba(0,0,0,0.45)]" style={{ width: `min(${PANEL_W}px, 92vw)`, borderColor: BORDER, background: "var(--sol-bg)" }} data-scope-aside="overlay">
          {panel}
        </aside>
      )}
      {open && layout === "sheet" && (
        <div
          className="absolute inset-x-0 bottom-0 z-20 rounded-t-2xl border-t shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.45)] org-sheet-in"
          style={{ height: "90%", background: "var(--sol-bg)", borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }}
          data-scope-aside="sheet"
        >
          <div className="flex justify-center pt-2"><span className="w-10 h-1 rounded-full" style={{ background: "color-mix(in srgb, var(--sol-border) 60%, transparent)" }} /></div>
          <div className="h-[calc(100%-12px)]">{panel}</div>
        </div>
      )}
    </div>
  );
}
