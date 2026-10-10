"use client";
// A scope's conversation with one panel beside it (docs/architecture/
// scopes-and-feed.md F4.1): the root scope and a role's own page open in it.
// Where the panel sits is decided once, here: its own side of a seam the
// person drags on a wide window, an overlay over the conversation on a narrow
// one, and a bottom sheet on the phone that the conversation hands to and
// takes back. The page owns whether the panel is open; this owns where.
//
// The seam is one react-resizable-panels Group, and the split is one value,
// `clientState.layouts.org`. The Group renders in every mode, so the
// conversation keeps its place in the tree whatever the width; a side that
// should not show folds to nothing, still mounted, and the seam hides with it.
import type { ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { PanelLayout } from "../../../hooks/usePanelLayout";
import { CONVERSATION_MIN_W, PANEL_MIN_W, PANEL_W } from "../../../hooks/usePanelLayout";
import { useFoldingSplit } from "../../../hooks/useFoldingSplit";
import { useInboxStore } from "../../../store/inboxStore";
import { cn } from "../../../lib/utils";
import { ORG_RULE } from "../orgFrame";
import { EVEN_SPLIT, SEAM_LEFT, SEAM_RIGHT, seamLayout, splitOf, type SeamSide } from "./seamModel";

export type { SeamSide } from "./seamModel";

const LEFT = SEAM_LEFT;
const RIGHT = SEAM_RIGHT;

const round = (n: number) => Math.round(n * 100) / 100;

export function ConversationWithPanel({ conversation, panel, open, layout, hide = null }: {
  /** The left side, already wrapped by the page (it carries the page's own
   *  data attributes and any note above the conversation). Null draws the
   *  panel alone, with no seam. */
  conversation: ReactNode | null;
  panel: ReactNode;
  open: boolean;
  layout: PanelLayout;
  /** A page that shows one side at a time names the side to fold: it stays
   *  mounted at no width, and the seam hides. */
  hide?: SeamSide | null;
}) {
  const split = splitOf(useInboxStore((s) => s.clientState.layouts?.org));
  const beside = open && layout === "side";
  const alone = conversation == null;
  const hidden: SeamSide | null = alone ? "conversation" : !beside ? "panel" : hide;
  // The fold, the drag-gated persist and the double-click reset are the
  // shared split's (hooks/useFoldingSplit.ts).
  const seam = useFoldingSplit({
    target: seamLayout(hidden, split),
    folded: hidden != null,
    onPersist: (next) => {
      const c = next[LEFT];
      const p = next[RIGHT];
      if (!(c >= 5) || !(p >= 5)) return;
      useInboxStore.getState().updateClientLayout("org", { conversation: round(c), company: round(p) });
    },
    onReset: () => useInboxStore.getState().updateClientLayout("org", EVEN_SPLIT),
  });

  // A folded side has no seam to drag. The library hit-tests every boundary
  // between panels from their rectangles, rendered separator or not, so a
  // hidden hairline alone would still grab the pointer at the folded edge
  // and drag an empty side open. A disabled Group takes no pointer or key
  // drags, while the fold and unfold above still move it through setLayout.
  return (
    <div className="flex-1 min-h-0 min-w-0 relative flex" data-seam={hidden ? `hide-${hidden}` : "split"}>
      <Group orientation="horizontal" disabled={hidden != null} groupRef={seam.groupRef} elementRef={seam.elementRef} defaultLayout={seam.defaultLayout} onLayoutChange={seam.onLayoutChange} className="flex-1 min-w-0">
        <Panel id={LEFT} minSize={CONVERSATION_MIN_W} defaultSize="50%" collapsible={hidden === "conversation"} collapsedSize={0} className="flex min-h-0 min-w-0" style={{ overflow: "hidden" }}>
          {conversation}
        </Panel>
        {!alone && <Separator className={cn("cc-split", hidden && "is-hidden")} onDoubleClick={seam.onSeparatorDoubleClick} />}
        <Panel id={RIGHT} minSize={PANEL_MIN_W} defaultSize="50%" collapsible={hidden === "panel"} collapsedSize={0} className="flex min-h-0 min-w-0" style={{ overflow: "hidden" }}>
          {(beside || alone) && (
            <aside className="flex-1 min-w-0 min-h-0" style={{ background: "var(--sol-bg)" }} data-scope-aside="side">
              {panel}
            </aside>
          )}
        </Panel>
      </Group>
      {open && layout === "overlay" && !alone && (
        <aside className="absolute right-0 top-0 bottom-0 z-20 border-l min-h-0 org-panel-in shadow-[-16px_0_40px_-24px_rgba(0,0,0,0.45)]" style={{ width: `min(${PANEL_W}px, 92vw)`, borderColor: ORG_RULE, background: "var(--sol-bg)" }} data-scope-aside="overlay">
          {panel}
        </aside>
      )}
      {open && layout === "sheet" && !alone && (
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
