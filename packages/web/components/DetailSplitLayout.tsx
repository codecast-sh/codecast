"use client";
import { ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Panel, Group, Separator, usePanelRef } from "react-resizable-panels";
import { PanelLeftOpen, Pin, PinOff, X } from "lucide-react";
import { useTrackedStore, useInboxStore, resolveLayoutMode } from "../store/inboxStore";
import { hasOpenModal } from "../shortcuts/registry";
import { useTabContext } from "./TabContent";

const separatorClass = "relative z-10 w-px bg-black/10 cursor-col-resize before:absolute before:inset-y-0 before:-left-[2px] before:-right-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan";

// A list+detail surface with a discrete layout mode (see LayoutMode):
// "focus"  — the list owns the full width; a selected item opens as a peek
//            OVERLAY the list keeps living under. Pin promotes it to a split.
// "split"/"triage" — the classic pinned side-by-side (triage additionally opens
//            the right session rail; that's driven by setLayoutMode, not here).
// Selection stays URL-driven in every mode, so peek/split/full are pure
// presentation — the same /docs/<id> URL renders all of them.
export function DetailSplitLayout({
  list,
  surface,
  closeHref,
  children,
}: {
  list: ReactNode;
  /** Layout-mode memory slot ("docs" | "tasks" | "plans"). */
  surface: string;
  /** List-root route the peek's close (and Esc) navigates back to. */
  closeHref: string;
  children?: ReactNode;
}) {
  const s = useTrackedStore([
    (st) => resolveLayoutMode(st.clientState.ui, surface),
  ]);
  const mode = resolveLayoutMode(s.clientState.ui, surface);
  const router = useRouter();
  // Background tab panes stay mounted (display:none) — this pane must not run
  // peek behavior (especially the document-level Esc listener, which would
  // navigate the ACTIVE tab) unless it is the visible tab. Null context =
  // rendered outside the tab shell = always active.
  const tabCtx = useTabContext();
  const isTabActive = (tabCtx as { isActive?: boolean } | null)?.isActive !== false;
  const listPanelRef = usePanelRef();
  const [isCollapsed, setIsCollapsed] = useState(false);
  // No detail (e.g. /tasks with nothing selected) → the list fills the width.
  // The list Panel is ALWAYS rendered in the same position — across selection
  // changes AND across mode switches — so neither ever re-mounts the list.
  const hasDetail = children != null && children !== false;
  const focusMode = mode === "focus";
  const peeking = focusMode && hasDetail && isTabActive;

  // Esc retreats one step: peek → list. Only while peeking in the visible tab,
  // never from an editable (editors own Esc), never under a modal, and never
  // while the shortcuts panel is up (its own Esc close comes first).
  useEffect(() => {
    if (!peeking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || hasOpenModal()) return;
      if (useInboxStore.getState().shortcutsPanelOpen) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      router.push(closeHref);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [peeking, closeHref, router]);

  const setMode = useInboxStore.getState().setLayoutMode;
  const showSplitDetail = hasDetail && !focusMode;

  // ONE stable tree for every mode: the Group and the list Panel render in the
  // same positions always; focus mode simply drops the separator/detail panel
  // (the list flexes to 100%) and shows the detail as an overlay beside the
  // Group. Switching modes must never re-mount the list.
  return (
    <div className="relative h-full overflow-hidden">
      <Group orientation="horizontal" className="h-full" defaultLayout={{ "detail-list": 30, "detail-content": 70 }}>
        <Panel
          id="detail-list"
          panelRef={listPanelRef}
          minSize={showSplitDetail ? 200 : 0}
          maxSize={showSplitDetail ? "80%" : "100%"}
          collapsible
          collapsedSize={0}
          onResize={(size) => setIsCollapsed(size.asPercentage === 0)}
          className="overflow-hidden"
        >
          <div className="h-full cq-container">{list}</div>
        </Panel>
        {showSplitDetail && (
          <Separator className={`${separatorClass} group/sep`}>
            {isCollapsed && (
              <button
                onClick={(e) => { e.stopPropagation(); listPanelRef.current?.expand(); }}
                className="absolute top-3 -right-px z-20 p-1.5 bg-sol-bg-alt border border-sol-border/40 border-l-0 rounded-r-md text-sol-text-dim hover:text-sol-cyan transition-colors shadow-sm"
                title="Show list"
              >
                <PanelLeftOpen className="w-3.5 h-3.5" />
              </button>
            )}
            {/* Hover-only: an always-visible control floating over the detail's
                content read as clutter. It appears when the pointer is at the
                divider — where a layout gesture starts anyway. */}
            <button
              onClick={(e) => { e.stopPropagation(); setMode(surface, "focus"); }}
              className="absolute top-12 -right-px z-20 p-1.5 bg-sol-bg-alt border border-sol-border/40 border-l-0 rounded-r-md text-sol-text-dim hover:text-sol-cyan opacity-0 group-hover/sep:opacity-100 focus-visible:opacity-100 transition-opacity shadow-sm"
              title="Unpin — full-width list with the item as a peek"
            >
              <PinOff className="w-3.5 h-3.5" />
            </button>
          </Separator>
        )}
        {showSplitDetail && (
          <Panel id="detail-content" minSize={100} className="overflow-hidden">
            {children}
          </Panel>
        )}
      </Group>
      {focusMode && hasDetail && (
        <div className="peek-overlay absolute inset-y-0 right-0 z-30 w-[62%] min-w-[min(420px,100%)] max-w-full bg-sol-bg border-l border-sol-border/40 flex flex-col">
          {/* Peek affordances ride the overlay's left EDGE (mirroring the
              split separator's buttons) so they never collide with the
              detail's own header controls. */}
          <div className="absolute top-3 left-0 z-40 flex flex-col gap-1.5">
            <button
              onClick={() => setMode(surface, "split")}
              className="p-1.5 bg-sol-bg-alt border border-sol-border/40 border-l-0 rounded-r-md text-sol-text-dim hover:text-sol-cyan transition-colors shadow-sm"
              title="Pin to a split"
            >
              <Pin className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => router.push(closeHref)}
              className="p-1.5 bg-sol-bg-alt border border-sol-border/40 border-l-0 rounded-r-md text-sol-text-dim hover:text-sol-red transition-colors shadow-sm"
              title="Close (Esc)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 min-h-0">{children}</div>
        </div>
      )}
    </div>
  );
}
