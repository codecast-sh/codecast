"use client";
import { ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Maximize2, X } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { hasOpenModal } from "../shortcuts/registry";
import { useTabContext } from "./TabContent";

// List + peek. The list always owns the full width; selecting an item slides
// the detail in OVER it as a peek. One gesture in, one gesture out:
//   click/enter → peek · "full" → 100% width · Esc/✕ → retreat one step
// There is no pinned split, no layout mode, no divider to manage — side by
// side exists exactly while a peek is open, then the surface returns to a
// clean list. Selection stays URL-driven, so /docs/<id> deep-links straight
// into the peek and closing is a plain navigation back to the list route.
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
  // run peek behavior (especially the document-level Esc listener, which
  // would navigate the ACTIVE tab). Null context = outside the tab shell.
  const tabCtx = useTabContext();
  const isTabActive = (tabCtx as { isActive?: boolean } | null)?.isActive !== false;
  const hasDetail = children != null && children !== false;
  // Transient by design: "full" is a property of THIS peek, not a stored
  // arrangement — it resets when the peek closes.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!hasDetail) setFull(false);
  }, [hasDetail]);

  const peeking = hasDetail && isTabActive;

  // Esc retreats one step: full → peek, peek → list. Never from an editable
  // (editors own Esc), never under a modal or the shortcuts panel.
  useEffect(() => {
    if (!peeking) return;
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
  }, [peeking, closeHref, router]);

  return (
    <div className="relative h-full overflow-hidden">
      <div className="h-full cq-container">{list}</div>
      {hasDetail && (
        <div
          className={`peek-overlay absolute inset-y-0 right-0 z-30 bg-sol-bg flex flex-col transition-[width] duration-200 ease-out ${
            full ? "w-full border-l-0" : "w-[62%] min-w-[min(480px,100%)] max-w-full border-l border-sol-border/40"
          }`}
        >
          {/* The mockup's peek header: one slim strip, controls together.
              ← appears only in full (retreat to peek width), matching the
              demo's "← back". */}
          <div className="flex items-center gap-1 px-2 py-1 border-b border-sol-border/20 bg-sol-bg-alt/50 flex-shrink-0">
            {full && (
              <button
                onClick={() => setFull(false)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-sol-border/40 bg-sol-bg text-[10.5px] text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors"
                title="Back to peek (Esc)"
              >
                <ArrowLeft className="w-3 h-3" /> back
              </button>
            )}
            <span className="flex-1" />
            <button
              onClick={() => setFull((f) => !f)}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10.5px] transition-colors ${
                full
                  ? "border-sol-cyan/50 text-sol-cyan bg-sol-cyan/10"
                  : "border-sol-border/40 bg-sol-bg text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/40"
              }`}
              title={full ? "Back to peek width (Esc)" : "Take the full width"}
            >
              <Maximize2 className="w-3 h-3" /> full
            </button>
            <button
              onClick={() => router.push(closeHref)}
              className="inline-flex items-center px-1.5 py-0.5 rounded-md border border-sol-border/40 bg-sol-bg text-sol-text-dim hover:text-sol-red hover:border-sol-red/40 transition-colors"
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
