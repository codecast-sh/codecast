"use client";
// The split stage: a tab's layout tree rendered FLAT.
//
// Cells are absolutely positioned from percent rects computed by ONE pure
// walk (stageGeometry) — the same function the drop preview runs on a
// predicted tree, so preview and reality cannot disagree. Flat rendering is
// also what makes structure changes MORPH: a split or close changes only each
// cell's percent rect, so content never remounts and the cells animate to
// their new places (globals.css `.stage-cell`). Percent units mean a window
// resize costs nothing and animates nothing.
//
// Chrome follows the house duality: a route pane gets a slim strip (its
// window title, drag handle, expand and close); a conversation pane gets NO
// strip — ConversationView already draws a header that hosts close/expand,
// and stacking a second bar over it is the exact pattern the companion work
// rejected.

import { memo, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PaneControls } from "./PaneControls";
import { useInboxStore, useTrackedStore, type AppTab } from "../../store/inboxStore";
import {
  findBranch,
  stageGeometry,
  setBranchSizes,
  type StageHandleGeom,
  type StageNode,
} from "../../store/stageSplit";
import { paneSessionId, stageClose, stageExpand, stageFocus, stageNavigateLeaf, startPaneDrag } from "../../lib/stage";
import { pathLabel } from "../../lib/pathLabel";
import { browserPathLabel, isBrowserRoutePath, subscribeBrowserTitles } from "../../lib/browserPane";
import { chatTabTitle } from "../../lib/tabTitle";
import { RoutePane } from "../RoutePane";
import { SessionPane } from "./SessionPane";
import { PageIcon } from "../RecentVisitRow";
import { ErrorBoundary } from "../ErrorBoundary";

// What a pane's strip should CALL itself. A section pane is its section
// ("Tasks"); an entity pane is the entity — the doc's title, the task's
// title, the channel's name — because two panes both labeled "Docs" say
// nothing. Subscribes only to the one row it names.
function usePaneTitle(path: string): string {
  // A browser pane is titled by the page: its own title once a backend could
  // read one, else the host. That is learned, not stored, so it is subscribed
  // to rather than read once (lib/browserPane).
  const browser = useSyncExternalStore(
    subscribeBrowserTitles,
    () => (isBrowserRoutePath(path) ? browserPathLabel(path) : ""),
  );
  const clean = path.split("?")[0];
  const m = clean.match(/^\/(docs|tasks|plans|chat)\/([^/]+)/);
  const kind = m?.[1];
  const id = m?.[2] ?? "";
  const s = useTrackedStore([
    (st) =>
      kind === "docs" ? ((st.docs[id] as any)?.display_title ?? st.docs[id]?.title)
      : kind === "tasks" ? st.tasks[id]?.title
      : kind === "plans" ? st.plans[id]?.title
      : kind === "chat" ? chatTabTitle(path, st.chatChannels, st.teamMembers, (st as any).currentUser?._id)
      : null,
  ]);
  const entity =
    kind === "docs" ? ((s.docs[id] as any)?.display_title ?? s.docs[id]?.title)
    : kind === "tasks" ? s.tasks[id]?.title
    : kind === "plans" ? s.plans[id]?.title
    : kind === "chat" ? chatTabTitle(path, s.chatChannels, s.teamMembers, (s as any).currentUser?._id)
    : null;
  return browser || entity || pathLabel(path);
}

// A pane that draws its OWN header (a conversation, a browser pane) still
// needs somewhere to grab: a grip that surfaces on hover, in the corner the
// strip would have occupied.
function PaneGrip({ leafId, path }: { leafId: string; path: string }) {
  return (
    <div
      draggable
      onDragStart={(e) => startPaneDrag(e, { path, title: pathLabel(path), from: { kind: "leaf", leafId } })}
      className="stage-grip"
      title="Drag to move this pane"
      aria-label="Drag to move this pane"
    >
      <span />
    </div>
  );
}

// The strip is the pane's window title AND its drag handle: grab it to move
// the pane to another position (the drop layer treats it as a move).
function PaneStrip({ leafId, path, focused }: { leafId: string; path: string; focused: boolean }) {
  const title = usePaneTitle(path);
  return (
    <div
      draggable
      onDragStart={(e) => startPaneDrag(e, { path, title, from: { kind: "leaf", leafId } })}
      className="flex items-center gap-1.5 h-[26px] px-2 flex-shrink-0 border-b cursor-grab active:cursor-grabbing select-none"
      style={{ background: "var(--cc-panel-head-bg)", borderColor: "var(--cc-panel-rule)" }}
    >
      <PageIcon path={path} className={`w-3 h-3 flex-shrink-0 ${focused ? "text-sol-text-dim" : "text-sol-text-dim/50"}`} />
      <span className={`text-[11px] truncate flex-1 leading-none ${focused ? "text-sol-text-muted" : "text-sol-text-dim/70"}`}>
        {title}
      </span>
      <PaneControls onExpand={() => stageExpand(leafId)} onClose={() => stageClose(leafId)} />
    </div>
  );
}

// Memoized on primitive props: a resize drag re-renders the view per
// pointermove, and without this every cell's whole page subtree re-ran even
// when its own rect hadn't moved.
//
// `solo`: the cell IS the whole stage (a plain, unsplit tab). It draws no
// strip, grip or focus ring and its route navigates the tab, not a leaf. The
// element shape is the SAME as a split cell's — the strip and grip occupy
// their slot as `false` — so when the tab splits, React keeps every element
// beneath and the page is not remounted (the whole point of rendering a plain
// tab through the stage).
const StageCell = memo(function StageCell({
  tabId,
  leafId,
  path,
  left,
  top,
  width,
  height,
  focused,
  isTabActive,
  solo,
}: {
  tabId: string;
  leafId: string;
  path: string;
  left: number;
  top: number;
  width: number;
  height: number;
  focused: boolean;
  isTabActive: boolean;
  solo: boolean;
}) {
  const sessionId = paneSessionId(path);
  // Panes that draw their own 32px header get no PaneStrip stacked on top.
  const ownsHeader = isBrowserRoutePath(path);
  const leafNavigate = useCallback(
    (p: string, mode: "push" | "replace") => stageNavigateLeaf(leafId, p, mode),
    [leafId],
  );
  const navigate = solo ? undefined : leafNavigate;
  const paneLeafId = solo ? undefined : leafId;
  const active = isTabActive && (solo || focused);
  const handleFocus = useCallback(() => {
    if (!focused) stageFocus(leafId);
  }, [focused, leafId]);
  const handleClose = useCallback(() => stageClose(leafId), [leafId]);
  const handleExpand = useCallback(() => stageExpand(leafId), [leafId]);
  return (
    <div
      data-stage-leaf={leafId}
      className={`stage-cell${!solo && focused ? " stage-cell--focused" : ""}`}
      style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
      onPointerDownCapture={solo ? undefined : handleFocus}
    >
      {sessionId ? (
        <>
          {/* A conversation pane has no strip: its own header hosts close and
              expand, so the drag handle is a grip that surfaces on hover. */}
          {!solo && <PaneGrip leafId={leafId} path={path} />}
          <SessionPane sessionId={sessionId} onClose={handleClose} onExpand={handleExpand} />
        </>
      ) : ownsHeader ? (
        <>
          {/* Same duality for a browser pane: its 32px address strip IS the
              header, and it hosts PaneControls (leafId reaches it through
              TabParamsCtx). A strip above that would be two bars. */}
          {!solo && <PaneGrip leafId={leafId} path={path} />}
          <div className="h-full min-h-0">
            <ErrorBoundary name="StagePane" level="panel">
              <RoutePane tabId={tabId} path={path} isActive={active} navigate={navigate} leafId={paneLeafId} />
            </ErrorBoundary>
          </div>
        </>
      ) : (
        <div className="h-full flex flex-col min-h-0">
          {!solo && <PaneStrip leafId={leafId} path={path} focused={focused} />}
          <div className="flex-1 min-h-0">
            <ErrorBoundary name="StagePane" level="panel">
              <RoutePane tabId={tabId} path={path} isActive={active} navigate={navigate} leafId={paneLeafId} />
            </ErrorBoundary>
          </div>
        </div>
      )}
    </div>
  );
});

function StageHandle({
  handle,
  layout,
  containerRef,
  liveSizesRef,
  setLiveSizes,
}: {
  handle: StageHandleGeom;
  layout: StageNode;
  containerRef: React.RefObject<HTMLDivElement | null>;
  liveSizesRef: React.MutableRefObject<{ branchId: string; sizes: number[] } | null>;
  setLiveSizes: (v: { branchId: string; sizes: number[] } | null) => void;
}) {
  const [active, setActive] = useState(false);
  const horizontal = handle.dir === "row";

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const el = containerRef.current;
      const branch = findBranch(layout, handle.branchId);
      if (!el || !branch) return;
      e.preventDefault();
      // Capture is a nicety (keeps hover styling on the handle mid-drag); the
      // drag itself listens on window. It throws for an inactive pointer id
      // (synthetic events in tests) — never let that kill the drag setup.
      try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* no capture */ }
      setActive(true);
      const box = el.getBoundingClientRect();
      const branchPx = horizontal
        ? (box.width * handle.branchRect.width) / 100
        : (box.height * handle.branchRect.height) / 100;
      if (branchPx <= 0) return;
      // A pane narrower than ~240px (shorter than ~160px) stops being a
      // surface, so the drag clamps in pixels converted to branch shares —
      // but never past the pair's midpoint, or a pair smaller than two
      // minimums would invert the clamp and pin the seam off-pointer.
      const minPct = Math.min(45, Math.max(8, ((horizontal ? 240 : 160) / branchPx) * 100));
      const start = horizontal ? e.clientX : e.clientY;
      const startSizes = [...branch.sizes];
      const i = handle.index;
      const pair = startSizes[i] + startSizes[i + 1];
      const lo = Math.min(minPct, pair / 2);
      document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      const move = (ev: PointerEvent) => {
        const d = (((horizontal ? ev.clientX : ev.clientY) - start) / branchPx) * 100;
        const a = Math.max(lo, Math.min(pair - lo, startSizes[i] + d));
        const prev = liveSizesRef.current;
        if (prev && prev.branchId === branch.id && prev.sizes[i] === a) return;
        const sizes = [...startSizes];
        sizes[i] = a;
        sizes[i + 1] = pair - a;
        const next = { branchId: branch.id, sizes };
        liveSizesRef.current = next;
        setLiveSizes(next);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setActive(false);
        const final = liveSizesRef.current;
        liveSizesRef.current = null;
        setLiveSizes(null);
        if (final) useInboxStore.getState().stageSetSizes(final.branchId, final.sizes);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [containerRef, layout, handle, horizontal, liveSizesRef, setLiveSizes],
  );

  const r = handle.rect;
  return (
    <div
      className={`stage-handle${active ? " stage-handle--active" : ""}`}
      style={
        horizontal
          ? { left: `${r.left}%`, top: `${r.top}%`, height: `${r.height}%`, width: 9, transform: "translateX(-50%)", cursor: "col-resize" }
          : { left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: 9, transform: "translateY(-50%)", cursor: "row-resize" }
      }
      onPointerDown={onPointerDown}
    >
      <div
        className="stage-handle__line"
        style={horizontal ? { left: 4, top: 0, bottom: 0, width: 1 } : { top: 4, left: 0, right: 0, height: 1 }}
      />
    </div>
  );
}

export default memo(function StageSplitView({
  tab,
  layout,
  isTabActive,
}: {
  tab: AppTab;
  layout: StageNode;
  isTabActive: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Handle drags render from local state and commit to the store on release —
  // a live drag re-rendering through the store (and persisting each step)
  // would be churn for nothing.
  const [liveSizes, setLiveSizes] = useState<{ branchId: string; sizes: number[] } | null>(null);
  const liveSizesRef = useRef<{ branchId: string; sizes: number[] } | null>(null);
  const effective = liveSizes ? setBranchSizes(layout, liveSizes.branchId, liveSizes.sizes) : layout;
  const geo = useMemo(() => stageGeometry(effective), [effective]);
  const solo = geo.leaves.length === 1;

  return (
    <div
      ref={containerRef}
      className={`relative h-full overflow-hidden${liveSizes ? " stage-resizing" : ""}`}
    >
      {geo.leaves.map((l) => (
        <StageCell
          key={l.id}
          tabId={tab.id}
          leafId={l.id}
          path={l.path}
          left={l.rect.left}
          top={l.rect.top}
          width={l.rect.width}
          height={l.rect.height}
          focused={tab.focusedLeafId === l.id}
          isTabActive={isTabActive}
          solo={solo}
        />
      ))}
      {geo.handles.map((h) => (
        <StageHandle
          key={`${h.branchId}:${h.index}`}
          handle={h}
          layout={layout}
          containerRef={containerRef}
          liveSizesRef={liveSizesRef}
          setLiveSizes={setLiveSizes}
        />
      ))}
    </div>
  );
});
