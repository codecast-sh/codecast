"use client";

import { useState, type ReactNode } from "react";

// Chat and Tasks are doors in the sidebar: their lists (every room, every saved
// view) are a level of their own that slides over the app nav, with a back row
// to slide out. The level follows the page: on a chat room the sidebar is the
// room list, and leaving Chat brings the nav back. Backing out while you stay
// on the page holds until you go somewhere else or open the door again.

export type DrillLevel = "chat" | "tasks";

export function useSidebarDrill(section: DrillLevel | null) {
  const [s, set] = useState<{ section: DrillLevel | null; out: boolean; shown: DrillLevel | null }>({
    section,
    out: false,
    shown: section,
  });
  // Moving to another section clears a back-out: render-phase, so the first
  // paint on a new page already has the right level.
  if (s.section !== section) set({ section, out: false, shown: section ?? s.shown });
  const level = section && !(s.section === section && s.out) ? section : null;
  return {
    level,
    // The pane keeps its content while it slides out.
    shown: level ?? s.shown,
    back: () => set((p) => ({ ...p, out: true })),
    open: () => set((p) => ({ ...p, out: false })),
  };
}

/** The app nav (`children`) with one level slid over it. */
export function SidebarDrillStack({
  level,
  shown,
  label,
  peek,
  onBack,
  pane,
  children,
}: {
  level: DrillLevel | null;
  shown: DrillLevel | null;
  label: string;
  /** What still needs you outside this level (the inbox count), so going in
   *  never hides it. */
  peek?: ReactNode;
  onBack: () => void;
  pane: ReactNode;
  children: ReactNode;
}) {
  const motion = "transition-[transform,opacity] duration-300 ease-[cubic-bezier(.3,.7,.2,1)] motion-reduce:transition-none";
  return (
    <div className="flex-1 min-h-0 relative overflow-hidden">
      <div
        data-sidebar-scroll
        inert={!!level}
        className={`absolute inset-0 overflow-y-auto scrollbar-auto pt-3 sm:pt-4 ${motion} ${level ? "-translate-x-[35%] opacity-0" : ""}`}
      >
        {children}
      </div>
      {/* Mounted even with nothing in it, so the first time a level opens
          the pane is already off to the side and slides in. */}
      <div
        data-sidebar-drill={shown ?? ""}
        inert={!level}
        className={`absolute inset-0 overflow-y-auto scrollbar-auto pt-2 pb-3 bg-sol-bg-alt ${motion} ${level ? "" : "translate-x-full"}`}
      >
        {shown && (
          <button
            type="button"
            onClick={onBack}
            className="w-[calc(100%-12px)] mx-1.5 mb-1 flex items-center gap-2 pl-2.5 pr-2 py-2 rounded-md text-sm font-semibold text-sol-text hover:bg-sol-bg-highlight/60"
            title="Back to the menu"
          >
            <svg className="w-3.5 h-3.5 text-sol-text-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            <span className="flex-1 text-left">{label}</span>
            {peek}
          </button>
        )}
        {pane}
      </div>
    </div>
  );
}
