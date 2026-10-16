"use client";

import { useCallback, type ReactNode } from "react";
import type { DrillLevel } from "../../hooks/useSidebarDrill";
import { KeyCap } from "../KeyCap";
import { useShortcutAction, useShortcutParts } from "../../shortcuts";

// The sidebar's Chat or Tasks level slid over the app nav (useSidebarDrill
// decides which is open).

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
  const backKeys = useShortcutParts("sidebar.back");
  useShortcutAction("sidebar.back", useCallback(() => {
    if (!level) return false;
    onBack();
  }, [level, onBack]));
  const motion = "transition-[transform,opacity] duration-300 [transition-timing-function:cubic-bezier(.3,.7,.2,1)] motion-reduce:transition-none";
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
            className="group/back w-[calc(100%-12px)] mx-1.5 mb-1 flex items-center gap-2 pl-2.5 pr-2 py-2 rounded-md text-sm font-semibold text-sol-text hover:bg-sol-bg-highlight/60"
            title="Back to the menu"
          >
            <svg className="w-3.5 h-3.5 text-sol-text-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            <span className="flex-1 text-left">{label}</span>
            <span className="hidden group-hover/back:flex gap-0.5">
              {backKeys?.map((k) => <KeyCap key={k} size="xs">{k}</KeyCap>)}
            </span>
            {peek}
          </button>
        )}
        {pane}
      </div>
    </div>
  );
}
