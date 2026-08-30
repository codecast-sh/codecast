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

import { lazy, memo, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { Maximize2, X } from "lucide-react";
import { useInboxStore, useTrackedStore, getSessionRenderKey, type AppTab } from "../../store/inboxStore";
import {
  findBranch,
  stageGeometry,
  setBranchSizes,
  type StageHandleGeom,
  type StageNode,
} from "../../store/stageSplit";
import { paneSessionId, stageClose, stageExpand, stageFocus, stageNavigateLeaf, startPaneDrag } from "../../lib/stage";
import { animatedHideSession } from "../../store/undoActions";
import { pathLabel } from "../../lib/pathLabel";
import { RoutePane } from "../RoutePane";
import { PageIcon } from "../RecentVisitRow";
import { ErrorBoundary } from "../ErrorBoundary";

// Loaded on first use: the conversation renderer lives in the session-panel
// module, and pulling it in at import time would hang the whole panel (and
// its analytics) off TabContent's import graph for every tab, split or not.
const InboxConversation = lazy(() =>
  import("../GlobalSessionPanel").then((m) => ({ default: m.InboxConversation })),
);

const noop = () => {};

// One conversation, as a pane. The row subscription mirrors StageCompanion's
// (this pane replaced it): only this session's row, never the whole map.
const SessionPane = memo(function SessionPane({ sessionId, leafId }: { sessionId: string; leafId: string }) {
  const s = useTrackedStore([(st) => st.sessions[sessionId]]);
  const session = s.sessions[sessionId] ?? null;
  const handleClose = useCallback(() => stageClose(leafId), [leafId]);
  const handleExpand = useCallback(() => stageExpand(leafId), [leafId]);
  const handleSendAndDismiss = useCallback(() => animatedHideSession(sessionId, "stash"), [sessionId]);
  if (!session) {
    // A pane for a row the store no longer holds (killed, pruned): say so
    // honestly instead of painting an empty column.
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-xs text-sol-text-dim">
        <span>This session is no longer available</span>
        <button onClick={handleClose} className="text-sol-cyan hover:underline">Close pane</button>
      </div>
    );
  }
  return (
    <ErrorBoundary name="StageSessionPane" level="panel">
      <Suspense fallback={null}>
        <InboxConversation
          key={getSessionRenderKey(session) || sessionId}
          sessionId={sessionId}
          isIdle={session.is_idle}
          onSendAndAdvance={noop}
          onSendAndDismiss={handleSendAndDismiss}
          lastUserMessage={session.last_user_message}
          sessionError={session.session_error}
          onExpandToMain={handleExpand}
          onClose={handleClose}
        />
      </Suspense>
    </ErrorBoundary>
  );
});

// The strip is the pane's window title AND its drag handle: grab it to move
// the pane to another position (the drop layer treats it as a move).
function PaneStrip({ leafId, path, focused }: { leafId: string; path: string; focused: boolean }) {
  const title = pathLabel(path);
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
      <button className="cc-panel__btn" title="Take the whole stage" onClick={() => stageExpand(leafId)}>
        <Maximize2 className="w-3 h-3" />
      </button>
      <button className="cc-panel__btn" title="Close pane" onClick={() => stageClose(leafId)}>
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

function StageCell({
  tabId,
  leafId,
  path,
  rect,
  focused,
  isTabActive,
}: {
  tabId: string;
  leafId: string;
  path: string;
  rect: { left: number; top: number; width: number; height: number };
  focused: boolean;
  isTabActive: boolean;
}) {
  const sessionId = paneSessionId(path);
  const navigate = useCallback(
    (p: string, mode: "push" | "replace") => stageNavigateLeaf(leafId, p, mode),
    [leafId],
  );
  const handleFocus = useCallback(() => {
    if (!focused) stageFocus(leafId);
  }, [focused, leafId]);
  return (
    <div
      data-stage-leaf={leafId}
      className={`stage-cell${focused ? " stage-cell--focused" : ""}`}
      style={{ left: `${rect.left}%`, top: `${rect.top}%`, width: `${rect.width}%`, height: `${rect.height}%` }}
      onPointerDownCapture={handleFocus}
    >
      {sessionId ? (
        <>
          {/* A conversation pane has no strip (its own header hosts close and
              expand), so its drag handle is a grip that surfaces on hover. */}
          <div
            draggable
            onDragStart={(e) => startPaneDrag(e, { path, title: pathLabel(path), from: { kind: "leaf", leafId } })}
            className="stage-grip"
            title="Drag to move this pane"
            aria-label="Drag to move this pane"
          >
            <span />
          </div>
          <SessionPane sessionId={sessionId} leafId={leafId} />
        </>
      ) : (
        <div className="h-full flex flex-col min-h-0">
          <PaneStrip leafId={leafId} path={path} focused={focused} />
          <div className="flex-1 min-h-0">
            <ErrorBoundary name="StagePane" level="panel">
              <RoutePane tabId={tabId} path={path} isActive={isTabActive && focused} navigate={navigate} />
            </ErrorBoundary>
          </div>
        </div>
      )}
    </div>
  );
}

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
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setActive(true);
      const box = el.getBoundingClientRect();
      const branchPx = horizontal
        ? (box.width * handle.branchRect.width) / 100
        : (box.height * handle.branchRect.height) / 100;
      if (branchPx <= 0) return;
      // A pane narrower than ~240px (shorter than ~160px) stops being a
      // surface, so the drag clamps in pixels converted to branch shares.
      const minPct = Math.min(45, Math.max(8, ((horizontal ? 240 : 160) / branchPx) * 100));
      const start = horizontal ? e.clientX : e.clientY;
      const startSizes = [...branch.sizes];
      const i = handle.index;
      const pair = startSizes[i] + startSizes[i + 1];
      document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      const move = (ev: PointerEvent) => {
        const d = (((horizontal ? ev.clientX : ev.clientY) - start) / branchPx) * 100;
        let a = Math.max(minPct, Math.min(pair - minPct, startSizes[i] + d));
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
          rect={l.rect}
          focused={tab.focusedLeafId === l.id}
          isTabActive={isTabActive}
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
