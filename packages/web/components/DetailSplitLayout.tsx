"use client";
import { ReactNode, createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Panel, Group, Separator, usePanelRef } from "react-resizable-panels";
import { Maximize2, Minimize2, Pin, PinOff } from "lucide-react";
import { useTrackedStore, useInboxStore } from "../store/inboxStore";
import { hasOpenModal } from "../shortcuts/registry";
import { useTabContext } from "./TabContent";

const separatorClass = "cc-split";

// List + peek, with pin as the one escalation (the prototype's Direction 1):
//   click/enter → peek over the full-width list
//   pin         → the peek becomes a STANDING resizable split (per-surface,
//                 per-device; selecting rows then swaps the detail in place)
//   full        → the detail takes 100% width for this selection
//   Esc / ✕     → retreat one step (full → normal, then close to the list)
// The pin/full controls render INSIDE the detail's own header row (via
// PeekLayoutCtx → PeekLayoutControls) so there is exactly one header and one
// close affordance — never a second chrome strip stacked above the detail's.
// Selection stays URL-driven in every state: /docs/<id> deep-links into
// whichever presentation the surface is pinned to.
export const PeekLayoutCtx = createContext<null | {
  pinned: boolean;
  full: boolean;
  togglePin: () => void;
  toggleFull: () => void;
}>(null);

// The pin/full cluster a detail header renders just before its own close
// button. Null outside a DetailSplitLayout (e.g. the task card inlined in a
// conversation), so consumers can render it unconditionally.
export function PeekLayoutControls() {
  const ctx = useContext(PeekLayoutCtx);
  if (!ctx) return null;
  return (
    <>
      <button
        onClick={ctx.togglePin}
        className={`p-1.5 rounded-md text-xs flex items-center gap-1 transition-colors ${
          ctx.pinned ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text"
        }`}
        title={ctx.pinned ? "Unpin — back to a peek over the full-width list" : "Pin — keep list and detail side by side"}
      >
        {ctx.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
      </button>
      <button
        onClick={ctx.toggleFull}
        className={`p-1.5 rounded-md text-xs flex items-center gap-1 transition-colors ${
          ctx.full ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text"
        }`}
        title={ctx.full ? "Back from full width (Esc)" : "Take the full width"}
      >
        {ctx.full ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
      </button>
    </>
  );
}

export function DetailSplitLayout({
  list,
  surface,
  closeHref,
  children,
}: {
  list: ReactNode;
  /** Pin-state slot ("docs" | "tasks" | "plans"). */
  surface: string;
  /** List-root route that close (✕ / Esc) navigates back to. */
  closeHref: string;
  children?: ReactNode;
}) {
  // Peek vs pinned is the PRESENTATION of the detail, not a per-surface mode
  // flag: "overlay" floats it over the full-width list, "split" makes both real
  // columns. One arrangement for every list surface — the point of the slots.
  const s = useTrackedStore([
    (st) => st.workspace.primary.presentation,
  ]);
  const pinned = s.workspace.primary.presentation === "split";
  const router = useRouter();
  // Background tab panes stay mounted (display:none) — a hidden pane must not
  // run peek behavior (especially the document-level Esc listener, which
  // would navigate the ACTIVE tab). Null context = outside the tab shell.
  const tabCtx = useTabContext();
  const isTabActive = (tabCtx as { isActive?: boolean } | null)?.isActive !== false;
  const listPanelRef = usePanelRef();
  const hasDetail = children != null && children !== false;
  // "full" is a property of the CURRENT selection, not a stored arrangement —
  // it resets when the detail closes.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!hasDetail) setFull(false);
  }, [hasDetail]);

  const active = hasDetail && isTabActive;

  // Esc retreats one step: full → normal, then close to the list. Never from
  // an editable (editors own Esc), never under a modal or the shortcuts panel.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || hasOpenModal()) return;
      if (useInboxStore.getState().shortcutsPanelOpen) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      setFull((f) => {
        if (f) return false;
        router.push(closeHref);
        return f;
      });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, closeHref, router]);

  const togglePin = () => {
    useInboxStore.getState().wsSetPresentation("primary", pinned ? "overlay" : "split");
    setFull(false);
  };
  const ctxValue = { pinned, full, togglePin, toggleFull: () => setFull((f) => !f) };

  // ONE stable tree across every state: the Group and the list Panel always
  // render in the same positions (so the list never re-mounts and keeps its
  // scroll); pinning just adds the separator + detail panel, and the peek /
  // full presentations render the detail as an overlay beside the Group.
  const splitDetail = hasDetail && pinned && !full;
  const overlayDetail = hasDetail && (!pinned || full);

  return (
    <div className="relative h-full overflow-hidden">
      <Group orientation="horizontal" className="h-full" defaultLayout={{ "detail-list": 30, "detail-content": 70 }}>
        <Panel
          id="detail-list"
          panelRef={listPanelRef}
          minSize={splitDetail ? 200 : 0}
          maxSize={splitDetail ? "80%" : "100%"}
          className="overflow-hidden"
        >
          <div className="h-full cq-container">{list}</div>
        </Panel>
        {splitDetail && <Separator className={separatorClass} />}
        {splitDetail && (
          <Panel id="detail-content" minSize={100} className="overflow-hidden">
            <PeekLayoutCtx.Provider value={ctxValue}>{children}</PeekLayoutCtx.Provider>
          </Panel>
        )}
      </Group>
      {overlayDetail && (
        <div
          className={`peek-overlay cc-panel-width absolute inset-y-0 right-0 z-30 bg-sol-bg flex flex-col ${
            full ? "w-full border-l-0" : "w-[62%] min-w-[min(480px,100%)] max-w-full border-l border-sol-border/40"
          }`}
        >
          <div className="flex-1 min-h-0">
            <PeekLayoutCtx.Provider value={ctxValue}>{children}</PeekLayoutCtx.Provider>
          </div>
        </div>
      )}
    </div>
  );
}
