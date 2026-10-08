"use client";
// A conversation with one panel beside it (docs/architecture/scopes-and-feed.md
// F4.1): the org screen, a role's page and a goal's page all open in it
// (initiatives-projects-role-page.md I1). Where the panel sits is decided once,
// here: its own side of a seam the person drags on a wide window, an overlay
// over the conversation on a narrow one, and a bottom sheet on the phone that
// the conversation hands to and takes back. The page owns whether the panel is
// open; this owns where.
//
// The seam is one react-resizable-panels Group, and the split is one value,
// `clientState.layouts.org`, shared by every screen that uses it: the seam
// stays where it was put as the person moves between the company, a goal and
// a role. The Group renders in every mode, so the conversation keeps its place
// in the tree whatever the width; a side that should not show folds to
// nothing, still mounted, and the seam hides with it.
import { useRef, type ReactNode } from "react";
import { Group, Panel, Separator, useGroupRef, type Layout } from "react-resizable-panels";
import type { PanelLayout } from "../../../hooks/usePanelLayout";
import { CONVERSATION_MIN_W, PANEL_MIN_W, PANEL_W } from "../../../hooks/usePanelLayout";
import { useDragGatedLayoutPersist } from "../../../hooks/useDragGatedLayoutPersist";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useInboxStore } from "../../../store/inboxStore";
import { cn } from "../../../lib/utils";
import { ORG_RULE } from "../orgFrame";
import { EVEN_SPLIT, SEAM_LEFT, SEAM_RIGHT, seamLayout, splitOf, type SeamSide } from "./seamModel";

export type { SeamSide } from "./seamModel";

const LEFT = SEAM_LEFT;
const RIGHT = SEAM_RIGHT;

const round = (n: number) => Math.round(n * 100) / 100;
const near = (a: Layout, b: Layout) => Math.abs((a[LEFT] ?? 0) - (b[LEFT] ?? 0)) < 0.1 && Math.abs((a[RIGHT] ?? 0) - (b[RIGHT] ?? 0)) < 0.1;

export function ConversationWithPanel({ conversation, panel, open, layout, hide = null }: {
  /** The left side, already wrapped by the page (it carries the page's own
   *  data attributes and any note above the conversation). Null draws the
   *  panel alone, with no seam. */
  conversation: ReactNode | null;
  panel: ReactNode;
  open: boolean;
  layout: PanelLayout;
  /** A page that shows one side at a time (the org screen under its stack
   *  width) names the side to fold: it stays mounted at no width, and the
   *  seam hides. */
  hide?: SeamSide | null;
}) {
  const split = splitOf(useInboxStore((s) => s.clientState.layouts?.org));
  const beside = open && layout === "side";
  const alone = conversation == null;
  const hidden: SeamSide | null = alone ? "conversation" : !beside ? "panel" : hide;
  const target = seamLayout(hidden, split);

  const groupRef = useGroupRef();
  const groupEl = useRef<HTMLDivElement | null>(null);
  // The Group reads its layout once, at mount; every later change is driven
  // through the handle below.
  const initial = useRef(target).current;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const targetRef = useRef(target);
  targetRef.current = target;
  // The live Group takes the person's split wherever the width allows. A
  // Group with no width yet (a hidden tab) ignores setLayout, so it waits.
  const apply = () => {
    const group = groupRef.current;
    const el = groupEl.current;
    if (!group || !el || el.offsetWidth === 0 || near(group.getLayout(), targetRef.current)) return;
    group.setLayout(targetRef.current);
  };

  // A fold, an unfold, or a split that arrived from elsewhere (another
  // window, the reset) moves the live Group. A drag's own write lands here
  // as its echo and is already the live layout, so it moves nothing.
  // Imperative moves fire onLayoutChange too; the drag gate below keeps them
  // from being written back. A side is collapsible only while it is folded
  // (so a drag stops at the minimums instead of snapping a side shut), and
  // the Group takes a panel's new constraints on its own next render, which
  // lands in this same task: the move waits one microtask for it.
  useWatchEffect(() => queueMicrotask(apply), [hidden, split.conversation, split.company]);

  // The width changed (the first measure, a rail folding beside the screen,
  // a window resize). The library keeps the percentages it last had, and a
  // split it clamped to a minimum on a narrow pane would stay clamped once
  // the pane is wide again; the person's split is put back instead. Only a
  // drag of this Group's own seam is persisted (the gate is scoped to
  // groupEl), so a clamp caused by another seam narrowing the page is never
  // stored and the re-apply here can always restore the person's split. The library
  // learns the new width from its own observer, which may run after this
  // one in the same batch, so the move waits a task for it.
  useMountEffect(() => {
    const el = groupEl.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth === width) return;
      width = el.offsetWidth;
      setTimeout(apply, 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  const persist = useDragGatedLayoutPersist((next) => {
    const c = next[LEFT];
    const p = next[RIGHT];
    if (hiddenRef.current || !(c >= 5) || !(p >= 5)) return;
    useInboxStore.getState().updateClientLayout("org", { conversation: round(c), company: round(p) });
  }, groupEl);
  // The library's double-click puts the seam back at the panels' default
  // (50%); that happens after the pointer is up, outside the drag gate, so
  // the even split is written here.
  const reset = () => {
    if (hiddenRef.current) return;
    useInboxStore.getState().updateClientLayout("org", EVEN_SPLIT);
  };

  // A folded side has no seam to drag. The library hit-tests every boundary
  // between panels from their rectangles, rendered separator or not, so a
  // hidden hairline alone would still grab the pointer at the folded edge
  // and drag an empty side open. A disabled Group takes no pointer or key
  // drags, while the fold and unfold above still move it through setLayout.
  return (
    <div className="flex-1 min-h-0 min-w-0 relative flex" data-seam={hidden ? `hide-${hidden}` : "split"}>
      <Group orientation="horizontal" disabled={hidden != null} groupRef={groupRef} elementRef={groupEl} defaultLayout={initial} onLayoutChange={persist} className="flex-1 min-w-0">
        <Panel id={LEFT} minSize={CONVERSATION_MIN_W} defaultSize="50%" collapsible={hidden === "conversation"} collapsedSize={0} className="flex min-h-0 min-w-0" style={{ overflow: "hidden" }}>
          {conversation}
        </Panel>
        {!alone && <Separator className={cn("cc-split", hidden && "is-hidden")} onDoubleClick={reset} />}
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
