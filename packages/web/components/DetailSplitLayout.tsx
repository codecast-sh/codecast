"use client";
import { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useInboxStore } from "../store/inboxStore";
import { hasOpenModal } from "../shortcuts/registry";
import { useTabContext } from "../lib/tabParams";

import { useWatchEffect } from "../hooks/useWatchEffect";
// List, then detail — each taking the full stage:
//   click/enter → the detail covers the list
//   Esc / ✕     → back to the list
// The list stays mounted underneath (inert, so nothing in it can take focus)
// and keeps its scroll position for the return. Side by side is not this
// component's job any more: it is the stage's split layout, entered by a
// drag (components/stage), the same gesture for every surface.
// Selection stays URL-driven: /docs/<id> deep-links straight into the detail.
export function DetailSplitLayout({
  list,
  closeHref,
  children,
}: {
  list: ReactNode;
  /** List-root route that close (✕ / Esc) navigates back to. */
  closeHref: string;
  children?: ReactNode;
}) {
  const router = useRouter();
  // Background tab panes stay mounted (display:none) — a hidden pane must not
  // run the document-level Esc listener, which would navigate the ACTIVE tab.
  // Null context = outside the tab shell.
  const tabCtx = useTabContext();
  const isTabActive = (tabCtx as { isActive?: boolean } | null)?.isActive !== false;
  const hasDetail = children != null && children !== false;
  const active = hasDetail && isTabActive;

  // Esc returns to the list. Never from an editable (editors own Esc), never
  // under a modal or the shortcuts panel.
  useWatchEffect(() => {
    if (!active) return;
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
  }, [active, closeHref, router]);

  return (
    <div className="relative h-full overflow-hidden">
      <div className="h-full cq-container" inert={hasDetail}>{list}</div>
      {hasDetail && (
        <div className="absolute inset-0 z-30 bg-sol-bg flex flex-col">
          <div className="flex-1 min-h-0">{children}</div>
        </div>
      )}
    </div>
  );
}
